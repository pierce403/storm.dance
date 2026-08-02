import type { CollaborationRole, NotebookCollaborator } from '@/lib/collaboration/types';

export const collaborationRoleLabel = (role: CollaborationRole) => {
  switch (role) {
    case 'super-admin':
      return 'Super admin';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
  }
};

export const canManageNotebookMembers = (role: CollaborationRole | null) =>
  role === 'admin' || role === 'super-admin';

export const canManageNotebookRoles = (role: CollaborationRole | null) =>
  role === 'super-admin';

export const shortIdentifier = (value: string) =>
  value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

export const collaboratorName = (collaborator: NotebookCollaborator) =>
  collaborator.ensName
    ?? (collaborator.address ? shortIdentifier(collaborator.address) : shortIdentifier(collaborator.inboxId));

export const collaboratorSecondaryIdentity = (collaborator: NotebookCollaborator) => {
  if (collaborator.ensName && collaborator.address) return shortIdentifier(collaborator.address);
  if (collaborator.address) return shortIdentifier(collaborator.inboxId);
  return collaborator.inboxId;
};
