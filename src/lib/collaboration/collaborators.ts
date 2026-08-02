import type {
  Identifier,
  SafeGroupMember,
} from '@xmtp/browser-sdk';
import {
  resolveEnsOrAddress,
  type EnsResolver,
} from './contacts';
import type {
  CollaborationContact,
  CollaborationRole,
  NotebookCollaborator,
} from './types';

export interface CollaboratorClientLike {
  inboxId: string | undefined;
  canMessage: (identifiers: Identifier[]) => Promise<Map<string, boolean>>;
  findInboxIdByIdentifier: (identifier: Identifier) => Promise<string | undefined>;
}

/** The membership APIs exposed by an @xmtp/browser-sdk v5 Group. */
export interface CollaboratorGroupLike {
  sync: () => Promise<unknown>;
  members: () => Promise<SafeGroupMember[]>;
  listAdmins: () => Promise<string[]>;
  listSuperAdmins: () => Promise<string[]>;
  addMembersByIdentifiers: (identifiers: Identifier[]) => Promise<void>;
  removeMembers: (inboxIds: string[]) => Promise<void>;
  addAdmin: (inboxId: string) => Promise<void>;
  removeAdmin: (inboxId: string) => Promise<void>;
  addSuperAdmin: (inboxId: string) => Promise<void>;
  removeSuperAdmin: (inboxId: string) => Promise<void>;
}

export interface NotebookCollaboratorState {
  collaborators: NotebookCollaborator[];
  currentUserRole: CollaborationRole | null;
}

export interface AddNotebookCollaboratorResult {
  contact: CollaborationContact;
  collaborator: NotebookCollaborator;
  state: NotebookCollaboratorState;
}

export interface NotebookCollaboratorManagerOptions {
  client: CollaboratorClientLike;
  group: CollaboratorGroupLike;
  ensResolver?: EnsResolver;
}

const sameInbox = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

const ethereumAddress = (member: SafeGroupMember) =>
  member.accountIdentifiers.find(
    (identifier) => identifier.identifierKind === 'Ethereum',
  )?.identifier ?? null;

const roleRank: Record<CollaborationRole, number> = {
  'super-admin': 0,
  admin: 1,
  member: 2,
};

/**
 * Serializes collaborator reads and writes around the authoritative XMTP MLS
 * group. No role or membership data is stored in the notebook's Yjs document.
 */
export class NotebookCollaboratorManager {
  private readonly client: CollaboratorClientLike;
  private readonly group: CollaboratorGroupLike;
  private readonly ensResolver?: EnsResolver;
  private readonly ensNamesByAddress = new Map<string, string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: NotebookCollaboratorManagerOptions) {
    if (!options.client.inboxId) {
      throw new Error('Connect to XMTP before managing notebook collaborators');
    }
    this.client = options.client;
    this.group = options.group;
    this.ensResolver = options.ensResolver;
  }

  refresh() {
    return this.enqueue(() => this.refreshNow());
  }

  add(value: string) {
    return this.enqueue(async (): Promise<AddNotebookCollaboratorResult> => {
      const contact = await resolveEnsOrAddress(value, this.ensResolver);
      const identifier: Identifier = {
        identifierKind: 'Ethereum',
        identifier: contact.address,
      };
      const reachable = await this.client.canMessage([identifier]);
      const canReach = reachable.get(contact.address)
        ?? reachable.get(contact.address.toLowerCase());
      if (!canReach) {
        throw new Error('This address is not reachable on the selected XMTP network');
      }
      const resolvedInboxId = await this.client.findInboxIdByIdentifier(identifier);
      if (!resolvedInboxId) {
        throw new Error('XMTP could not resolve this address to an inbox on the selected network');
      }

      const current = await this.refreshNow();
      const existing = current.collaborators.find((collaborator) =>
        sameInbox(collaborator.inboxId, resolvedInboxId),
      );
      if (existing) {
        throw new Error('This address is already a notebook collaborator');
      }

      if (contact.ensName) {
        this.ensNamesByAddress.set(contact.address.toLowerCase(), contact.ensName);
      }
      await this.group.addMembersByIdentifiers([identifier]);
      const state = await this.refreshNow();
      const collaborator = this.requireCollaborator(state, resolvedInboxId);
      return { contact, collaborator, state };
    });
  }

  setRole(inboxId: string, role: CollaborationRole) {
    return this.enqueue(async () => {
      const state = await this.refreshNow();
      const collaborator = this.requireCollaborator(state, inboxId);
      if (collaborator.isCurrentUser && collaborator.role !== role) {
        throw new Error('You cannot change your own notebook role');
      }
      if (collaborator.role === role) return state;

      if (collaborator.role === 'super-admin' && role !== 'super-admin') {
        this.assertAnotherSuperAdmin(state, collaborator.inboxId);
      }

      if (role === 'super-admin') {
        await this.group.addSuperAdmin(collaborator.inboxId);
      } else if (role === 'admin') {
        if (collaborator.role === 'super-admin') {
          await this.group.removeSuperAdmin(collaborator.inboxId);
        }
        try {
          await this.group.addAdmin(collaborator.inboxId);
        } catch (error) {
          // Super-admin -> admin requires two native MLS commits. Restore the
          // stronger role if the second commit fails so a transient failure
          // does not silently strand the collaborator as a member.
          if (collaborator.role === 'super-admin') {
            try {
              await this.group.addSuperAdmin(collaborator.inboxId);
            } catch {
              // Preserve the actionable failure from the requested mutation.
            }
          }
          throw error;
        }
      } else if (collaborator.role === 'super-admin') {
        await this.group.removeSuperAdmin(collaborator.inboxId);
      } else {
        await this.group.removeAdmin(collaborator.inboxId);
      }

      return this.refreshNow();
    });
  }

  remove(inboxId: string) {
    return this.enqueue(async () => {
      const state = await this.refreshNow();
      const collaborator = this.requireCollaborator(state, inboxId);
      if (collaborator.isCurrentUser) {
        throw new Error('You cannot remove yourself from notebook settings');
      }
      if (collaborator.role === 'super-admin') {
        this.assertAnotherSuperAdmin(state, collaborator.inboxId);
      }

      // Remove by inbox ID, not an Ethereum address: one inbox can contain
      // multiple associated identities, and MLS membership is inbox-scoped.
      await this.group.removeMembers([collaborator.inboxId]);
      return this.refreshNow();
    });
  }

  private refreshNow = async (): Promise<NotebookCollaboratorState> => {
    await this.group.sync();
    const [members, admins, superAdmins] = await Promise.all([
      this.group.members(),
      this.group.listAdmins(),
      this.group.listSuperAdmins(),
    ]);
    const adminInboxIds = new Set(admins.map((inboxId) => inboxId.toLowerCase()));
    const superAdminInboxIds = new Set(
      superAdmins.map((inboxId) => inboxId.toLowerCase()),
    );
    const currentInboxId = this.client.inboxId as string;
    const seenInboxIds = new Set<string>();

    const collaborators = members.flatMap((member): NotebookCollaborator[] => {
      const normalizedInboxId = member.inboxId.toLowerCase();
      if (seenInboxIds.has(normalizedInboxId)) return [];
      seenInboxIds.add(normalizedInboxId);

      const address = ethereumAddress(member);
      const role: CollaborationRole = superAdminInboxIds.has(normalizedInboxId)
        ? 'super-admin'
        : adminInboxIds.has(normalizedInboxId)
          ? 'admin'
          : 'member';
      const ensName = address
        ? this.ensNamesByAddress.get(address.toLowerCase())
        : undefined;
      return [{
        inboxId: member.inboxId,
        address,
        accountIdentifiers: member.accountIdentifiers.map((identifier) => ({ ...identifier })),
        installationIds: [...member.installationIds],
        consentState: member.consentState,
        permissionLevel: member.permissionLevel,
        role,
        isCurrentUser: sameInbox(member.inboxId, currentInboxId),
        ...(ensName ? { ensName } : {}),
      }];
    });

    collaborators.sort((left, right) => {
      if (left.isCurrentUser !== right.isCurrentUser) return left.isCurrentUser ? -1 : 1;
      const roleDifference = roleRank[left.role] - roleRank[right.role];
      return roleDifference || left.inboxId.localeCompare(right.inboxId);
    });

    return {
      collaborators,
      currentUserRole: collaborators.find((collaborator) => collaborator.isCurrentUser)?.role ?? null,
    };
  };

  private requireCollaborator(
    state: NotebookCollaboratorState,
    inboxId: string,
  ) {
    const collaborator = state.collaborators.find((candidate) =>
      sameInbox(candidate.inboxId, inboxId),
    );
    if (!collaborator) {
      throw new Error(`XMTP inbox ${inboxId} is not a notebook collaborator`);
    }
    return collaborator;
  }

  private assertAnotherSuperAdmin(
    state: NotebookCollaboratorState,
    targetInboxId: string,
  ) {
    const hasAnother = state.collaborators.some((collaborator) =>
      collaborator.role === 'super-admin'
      && !sameInbox(collaborator.inboxId, targetInboxId),
    );
    if (!hasAnother) {
      throw new Error('A notebook must retain at least one XMTP super admin');
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
