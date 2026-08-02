import type {
  ConsentState,
  Identifier,
  PermissionLevel,
  SafeGroupMember,
} from '@xmtp/browser-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  NotebookCollaboratorManager,
  type CollaboratorClientLike,
  type CollaboratorGroupLike,
} from './collaborators';

const MEMBER = 0 as PermissionLevel;
const ADMIN = 1 as PermissionLevel;
const SUPER_ADMIN = 2 as PermissionLevel;
const ALLOWED = 'allowed' as ConsentState;

const addresses = {
  alice: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bob: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  carol: '0xcccccccccccccccccccccccccccccccccccccccc',
};

const groupMember = (
  inboxId: string,
  address: string,
  permissionLevel = MEMBER,
): SafeGroupMember => ({
  inboxId,
  accountIdentifiers: [{ identifierKind: 'Ethereum', identifier: address }],
  installationIds: [`${inboxId}-installation`],
  consentState: ALLOWED,
  permissionLevel,
});

class FakeGroup implements CollaboratorGroupLike {
  readonly calls: Array<{ method: string; value?: unknown }> = [];
  membersState: SafeGroupMember[];
  failNextAddAdmin: Error | null = null;

  constructor(members: SafeGroupMember[]) {
    this.membersState = members.map((member) => ({
      ...member,
      accountIdentifiers: member.accountIdentifiers.map((identifier) => ({ ...identifier })),
      installationIds: [...member.installationIds],
    }));
  }

  async sync() {
    this.calls.push({ method: 'sync' });
  }

  async members() {
    this.calls.push({ method: 'members' });
    return this.membersState.map((member) => ({
      ...member,
      accountIdentifiers: member.accountIdentifiers.map((identifier) => ({ ...identifier })),
      installationIds: [...member.installationIds],
    }));
  }

  async listAdmins() {
    this.calls.push({ method: 'listAdmins' });
    return this.membersState
      .filter((member) => member.permissionLevel === ADMIN)
      .map((member) => member.inboxId);
  }

  async listSuperAdmins() {
    this.calls.push({ method: 'listSuperAdmins' });
    return this.membersState
      .filter((member) => member.permissionLevel === SUPER_ADMIN)
      .map((member) => member.inboxId);
  }

  async addMembersByIdentifiers(identifiers: Identifier[]) {
    this.calls.push({ method: 'addMembersByIdentifiers', value: identifiers });
    for (const identifier of identifiers) {
      const knownInboxId = Object.entries(addresses).find(
        ([, address]) => address.toLowerCase() === identifier.identifier.toLowerCase(),
      )?.[0];
      this.membersState.push(groupMember(
        knownInboxId ? `${knownInboxId}-inbox` : `inbox-${this.membersState.length + 1}`,
        identifier.identifier,
      ));
    }
  }

  async removeMembers(inboxIds: string[]) {
    this.calls.push({ method: 'removeMembers', value: inboxIds });
    const removed = new Set(inboxIds.map((inboxId) => inboxId.toLowerCase()));
    this.membersState = this.membersState.filter(
      (member) => !removed.has(member.inboxId.toLowerCase()),
    );
  }

  async addAdmin(inboxId: string) {
    this.calls.push({ method: 'addAdmin', value: inboxId });
    if (this.failNextAddAdmin) {
      const error = this.failNextAddAdmin;
      this.failNextAddAdmin = null;
      throw error;
    }
    this.setPermission(inboxId, ADMIN);
  }

  async removeAdmin(inboxId: string) {
    this.calls.push({ method: 'removeAdmin', value: inboxId });
    this.setPermission(inboxId, MEMBER);
  }

  async addSuperAdmin(inboxId: string) {
    this.calls.push({ method: 'addSuperAdmin', value: inboxId });
    this.setPermission(inboxId, SUPER_ADMIN);
  }

  async removeSuperAdmin(inboxId: string) {
    this.calls.push({ method: 'removeSuperAdmin', value: inboxId });
    this.setPermission(inboxId, MEMBER);
  }

  private setPermission(inboxId: string, permissionLevel: PermissionLevel) {
    const member = this.membersState.find(
      (candidate) => candidate.inboxId.toLowerCase() === inboxId.toLowerCase(),
    );
    if (!member) throw new Error(`Unknown inbox ${inboxId}`);
    member.permissionLevel = permissionLevel;
  }
}

const createClient = (
  inboxId = 'alice-inbox',
  canMessage: CollaboratorClientLike['canMessage'] = async (identifiers) =>
    new Map(identifiers.map((identifier) => [identifier.identifier, true])),
  findInboxIdByIdentifier: CollaboratorClientLike['findInboxIdByIdentifier'] = async (identifier) => {
    const knownInboxId = Object.entries(addresses).find(
      ([, address]) => address.toLowerCase() === identifier.identifier.toLowerCase(),
    )?.[0];
    return knownInboxId ? `${knownInboxId}-inbox` : undefined;
  },
): CollaboratorClientLike => ({ inboxId, canMessage, findInboxIdByIdentifier });

const createManager = (
  members: SafeGroupMember[] = [
    groupMember('alice-inbox', addresses.alice, SUPER_ADMIN),
    groupMember('bob-inbox', addresses.bob, ADMIN),
    groupMember('carol-inbox', addresses.carol),
  ],
) => {
  const group = new FakeGroup(members);
  const manager = new NotebookCollaboratorManager({
    client: createClient(),
    group,
  });
  return { group, manager };
};

const writes = (group: FakeGroup) => group.calls.filter((call) => ![
  'sync',
  'members',
  'listAdmins',
  'listSuperAdmins',
].includes(call.method));

describe('NotebookCollaboratorManager', () => {
  it('syncs native membership and projects XMTP roles with the current user first', async () => {
    const { group, manager } = createManager();

    const state = await manager.refresh();

    expect(group.calls.slice(0, 4).map((call) => call.method)).toEqual([
      'sync',
      'members',
      'listAdmins',
      'listSuperAdmins',
    ]);
    expect(state.currentUserRole).toBe('super-admin');
    expect(state.collaborators.map(({ inboxId, role, isCurrentUser }) => ({
      inboxId,
      role,
      isCurrentUser,
    }))).toEqual([
      { inboxId: 'alice-inbox', role: 'super-admin', isCurrentUser: true },
      { inboxId: 'bob-inbox', role: 'admin', isCurrentUser: false },
      { inboxId: 'carol-inbox', role: 'member', isCurrentUser: false },
    ]);
  });

  it('resolves ENS, verifies reachability, adds the Ethereum identifier, and refreshes', async () => {
    const group = new FakeGroup([
      groupMember('alice-inbox', addresses.alice, SUPER_ADMIN),
    ]);
    const canMessage = vi.fn<CollaboratorClientLike['canMessage']>(async (identifiers) =>
      new Map([[identifiers[0].identifier.toLowerCase(), true]]),
    );
    const findInboxId = vi.fn<CollaboratorClientLike['findInboxIdByIdentifier']>(
      async () => 'bob-inbox',
    );
    const resolver = vi.fn(async () => addresses.bob);
    const manager = new NotebookCollaboratorManager({
      client: createClient('alice-inbox', canMessage, findInboxId),
      group,
      ensResolver: resolver,
    });

    const result = await manager.add('bob.eth');

    expect(resolver).toHaveBeenCalledWith('bob.eth');
    expect(canMessage).toHaveBeenCalledWith([{
      identifierKind: 'Ethereum',
      identifier: result.contact.address,
    }]);
    expect(findInboxId).toHaveBeenCalledWith({
      identifierKind: 'Ethereum',
      identifier: result.contact.address,
    });
    expect(writes(group)).toEqual([{
      method: 'addMembersByIdentifiers',
      value: [{ identifierKind: 'Ethereum', identifier: result.contact.address }],
    }]);
    expect(result.contact.address.toLowerCase()).toBe(addresses.bob);
    expect(result.contact.ensName).toBe('bob.eth');
    expect(result.collaborator.inboxId).toBe('bob-inbox');
    expect(result.state.collaborators).toContainEqual(expect.objectContaining({
      address: result.contact.address,
      ensName: 'bob.eth',
      role: 'member',
    }));
  });

  it('rejects unreachable and duplicate addresses without changing membership', async () => {
    const { group, manager } = createManager();
    const unreachable = new NotebookCollaboratorManager({
      client: createClient('alice-inbox', async () => new Map()),
      group,
    });

    await expect(unreachable.add(addresses.carol)).rejects.toThrow('not reachable');
    await expect(manager.add(addresses.carol)).rejects.toThrow('already a notebook collaborator');
    expect(writes(group)).toEqual([]);
  });

  it('deduplicates a different Ethereum identity associated with an existing inbox', async () => {
    const { group } = createManager();
    const manager = new NotebookCollaboratorManager({
      client: createClient(
        'alice-inbox',
        undefined,
        async () => 'bob-inbox',
      ),
      group,
    });

    await expect(manager.add(addresses.carol)).rejects.toThrow('already a notebook collaborator');
    expect(writes(group)).toEqual([]);
  });

  it('uses the native role mutations and refreshes their resulting MLS state', async () => {
    const { group, manager } = createManager();

    let state = await manager.setRole('carol-inbox', 'admin');
    expect(state.collaborators.find(({ inboxId }) => inboxId === 'carol-inbox')?.role).toBe('admin');

    state = await manager.setRole('bob-inbox', 'super-admin');
    expect(state.collaborators.find(({ inboxId }) => inboxId === 'bob-inbox')?.role).toBe('super-admin');

    state = await manager.setRole('bob-inbox', 'admin');
    expect(state.collaborators.find(({ inboxId }) => inboxId === 'bob-inbox')?.role).toBe('admin');

    state = await manager.setRole('carol-inbox', 'member');
    expect(state.collaborators.find(({ inboxId }) => inboxId === 'carol-inbox')?.role).toBe('member');
    expect(writes(group).map((call) => call.method)).toEqual([
      'addAdmin',
      'addSuperAdmin',
      'removeSuperAdmin',
      'addAdmin',
      'removeAdmin',
    ]);
  });

  it('removes a collaborator by inbox ID instead of an associated address', async () => {
    const { group, manager } = createManager();

    const state = await manager.remove('bob-inbox');

    expect(writes(group)).toEqual([{ method: 'removeMembers', value: ['bob-inbox'] }]);
    expect(state.collaborators.map(({ inboxId }) => inboxId)).not.toContain('bob-inbox');
  });

  it('guards self-management and the final super admin before sending a mutation', async () => {
    const { group, manager } = createManager([
      groupMember('alice-inbox', addresses.alice, ADMIN),
      groupMember('bob-inbox', addresses.bob, SUPER_ADMIN),
    ]);

    await expect(manager.setRole('alice-inbox', 'member')).rejects.toThrow('your own notebook role');
    await expect(manager.remove('alice-inbox')).rejects.toThrow('remove yourself');
    await expect(manager.remove('bob-inbox')).rejects.toThrow('at least one XMTP super admin');
    expect(writes(group)).toEqual([]);
  });

  it('restores a super admin if the second half of a demotion fails', async () => {
    const { group, manager } = createManager([
      groupMember('alice-inbox', addresses.alice, SUPER_ADMIN),
      groupMember('bob-inbox', addresses.bob, SUPER_ADMIN),
    ]);
    group.failNextAddAdmin = new Error('commit failed');

    await expect(manager.setRole('bob-inbox', 'admin')).rejects.toThrow('commit failed');
    expect(writes(group).map((call) => call.method)).toEqual([
      'removeSuperAdmin',
      'addAdmin',
      'addSuperAdmin',
    ]);
    const refreshed = await manager.refresh();
    expect(refreshed.collaborators.find(({ inboxId }) => inboxId === 'bob-inbox')?.role)
      .toBe('super-admin');
  });

  it('continues processing refreshes after a queued mutation rejects', async () => {
    const { group, manager } = createManager();

    await expect(manager.setRole('missing-inbox', 'admin')).rejects.toThrow('not a notebook collaborator');
    await expect(manager.refresh()).resolves.toMatchObject({ currentUserRole: 'super-admin' });
    expect(group.calls.filter(({ method }) => method === 'sync')).toHaveLength(2);
  });
});
