import { CrdtUpdatePayload } from './types';

export class NotebookCrdtClock {
  private versions: Map<string, number> = new Map();

  nextVersion(noteId: string) {
    const current = this.versions.get(noteId) ?? 0;
    const next = current + 1;
    this.versions.set(noteId, next);
    return next;
  }

  shouldApply(update: CrdtUpdatePayload) {
    const current = this.versions.get(update.noteId) ?? 0;
    return update.version > current;
  }

  record(update: CrdtUpdatePayload) {
    this.versions.set(update.noteId, update.version);
  }
}

export function buildUpdatePayload(params: {
  notebookId: string;
  noteId: string;
  title: string;
  content: string;
  updatedAt: number;
  version: number;
  author?: string;
}): CrdtUpdatePayload {
  return { ...params };
}
