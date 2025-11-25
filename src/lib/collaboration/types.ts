export interface CollaborationContact {
  address: string;
  label?: string;
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
  inviterName?: string; // Optional display name
  inviterAddress: string;
}

export type CollaborationMessage =
  | { type: 'crdt-update'; payload: CrdtUpdatePayload }
  | { type: 'invite'; payload: InvitePayload };
