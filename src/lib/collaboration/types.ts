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
