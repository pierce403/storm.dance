import type {
  ConsentState,
  Identifier,
  PermissionLevel,
} from '@xmtp/browser-sdk';

export interface CollaborationContact {
  address: string;
  label?: string;
  ensName?: string;
}

export type CollaborationRole = 'member' | 'admin' | 'super-admin';

/**
 * A notebook collaborator projected directly from XMTP MLS group membership.
 * `inboxId` is the durable identity used for role and removal mutations; an
 * inbox can have multiple associated account identifiers and installations.
 */
export interface NotebookCollaborator {
  inboxId: string;
  address: string | null;
  accountIdentifiers: Identifier[];
  installationIds: string[];
  consentState: ConsentState;
  permissionLevel: PermissionLevel;
  role: CollaborationRole;
  isCurrentUser: boolean;
  ensName?: string;
}

export interface CrdtUpdatePayload {
  notebookId: string;
  noteId: string;
  title: string;
  content: string;
  updatedAt: number;
  version: number;
  author?: string;
}

export interface InvitePayload {
  notebookId: string;
  notebookName: string;
  conversationId: string;
  env: 'dev' | 'production';
  inviterName?: string;
  inviterInboxId?: string;
}

export type CollaborationMessage =
  | { type: 'crdt-update'; payload: CrdtUpdatePayload }
  | { type: 'invite'; payload: InvitePayload };
