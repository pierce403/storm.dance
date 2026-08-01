import * as Y from 'yjs';
import type { CrdtUpdatePayload } from './types.js';
import {
  NOTEBOOK_CRDT_GUID_PREFIX,
  NOTEBOOK_CRDT_METADATA_MAP,
  NOTEBOOK_CRDT_NOTES_MAP,
  NOTEBOOK_CRDT_SCHEMA_VERSION,
} from './compatibility.js';

export { NOTEBOOK_CRDT_SCHEMA_VERSION } from './compatibility.js';

/**
 * Transactions created through NotebookCrdt use this origin. Consumers can
 * capture these updates for transport without re-broadcasting remote updates.
 */
export const LOCAL_CRDT_ORIGIN = Symbol('stormdance-local-crdt-update');

/** Remote and persisted updates are applied with this origin to prevent echo. */
export const REMOTE_CRDT_ORIGIN = Symbol('stormdance-remote-crdt-update');

type NoteMap = Y.Map<unknown>;

export interface NotebookSeed {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface CrdtNoteInput {
  id: string;
  title: string;
  content: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
  deletedAt?: number | null;
}

export interface CrdtNoteProjection {
  id: string;
  title: string;
  content: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  deletedAt: number | null;
}

export interface NotebookCrdtProjection {
  schemaVersion: typeof NOTEBOOK_CRDT_SCHEMA_VERSION;
  notebook: NotebookSeed;
  notes: CrdtNoteProjection[];
}

export interface TextDiff {
  index: number;
  deleteCount: number;
  insert: string;
}

type AlignmentOperation = { kind: 'equal' | 'delete' | 'insert'; text: string };
type AlignmentSegment =
  | { kind: 'equal'; text: string; baseStart: number; baseEnd: number }
  | { kind: 'change'; text: string; baseStart: number; baseEnd: number };

const MAX_REBASE_EDIT_DISTANCE = 512;
const utf8Encoder = new TextEncoder();

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.byteLength - rightBytes.byteLength;
};

/** JavaScript string offsets are UTF-16, but edits must never split a code point. */
const codePoints = (value: string) => Array.from(value);

export type LocalUpdateHandler = (update: Uint8Array, origin: unknown) => void;

const requireNonEmptyString = (value: string, label: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
};

const requireTimestamp = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
};

const readString = (map: NoteMap | Y.Map<unknown>, key: string, fallback = '') => {
  const value = map.get(key);
  return typeof value === 'string' ? value : fallback;
};

const readNumber = (map: NoteMap | Y.Map<unknown>, key: string, fallback = 0) => {
  const value = map.get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const readNullableString = (map: NoteMap, key: string) => {
  const value = map.get(key);
  return typeof value === 'string' ? value : null;
};

const readNullableNumber = (map: NoteMap, key: string) => {
  const value = map.get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const getText = (note: NoteMap, key: 'title' | 'content') => {
  const value = note.get(key);
  return value instanceof Y.Text ? value : undefined;
};

const ensureText = (note: NoteMap, key: 'title' | 'content') => {
  const existing = getText(note, key);
  if (existing) return existing;

  const text = new Y.Text();
  note.set(key, text);
  return text;
};

/**
 * Computes a single-splice diff by retaining the longest common prefix and
 * suffix. This avoids replacing an entire Y.Text for normal typing, paste,
 * deletion, and CLI file rewrites.
 */
export function computeMinimalStringDiff(current: string, next: string): TextDiff | null {
  if (current === next) return null;

  const currentCharacters = codePoints(current);
  const nextCharacters = codePoints(next);
  const maxPrefix = Math.min(currentCharacters.length, nextCharacters.length);
  let prefix = 0;
  while (prefix < maxPrefix && currentCharacters[prefix] === nextCharacters[prefix]) {
    prefix += 1;
  }

  const maxSuffix = Math.min(
    currentCharacters.length - prefix,
    nextCharacters.length - prefix,
  );
  let suffix = 0;
  while (
    suffix < maxSuffix
    && currentCharacters[currentCharacters.length - 1 - suffix]
      === nextCharacters[nextCharacters.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const prefixText = currentCharacters.slice(0, prefix).join('');
  const currentMiddle = currentCharacters.slice(prefix, currentCharacters.length - suffix).join('');
  const nextMiddle = nextCharacters.slice(prefix, nextCharacters.length - suffix).join('');

  return {
    // Y.Text uses UTF-16 offsets, so expose code-unit counts at boundaries
    // selected using whole Unicode code points.
    index: prefixText.length,
    deleteCount: currentMiddle.length,
    insert: nextMiddle,
  };
}

export function applyMinimalStringDiff(text: Y.Text, next: string): TextDiff | null {
  const diff = computeMinimalStringDiff(text.toString(), next);
  if (!diff) return null;

  if (diff.deleteCount > 0) {
    text.delete(diff.index, diff.deleteCount);
  }
  if (diff.insert.length > 0) {
    text.insert(diff.index, diff.insert);
  }
  return diff;
}

const appendAlignmentOperation = (
  operations: AlignmentOperation[],
  kind: AlignmentOperation['kind'],
  text: string,
) => {
  if (!text) return;
  const previous = operations.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else operations.push({ kind, text });
};

/**
 * Produces a bounded Myers alignment. Normal collaboration edits are small,
 * while the fallback deliberately treats a huge replacement as one opaque
 * remote change so we preserve data rather than guessing an unsafe deletion.
 */
const alignStrings = (base: string, current: string): AlignmentOperation[] => {
  const baseCharacters = codePoints(base);
  const currentCharacters = codePoints(current);
  let prefix = 0;
  const maximumPrefix = Math.min(baseCharacters.length, currentCharacters.length);
  while (prefix < maximumPrefix && baseCharacters[prefix] === currentCharacters[prefix]) prefix += 1;

  let suffix = 0;
  const maximumSuffix = Math.min(
    baseCharacters.length - prefix,
    currentCharacters.length - prefix,
  );
  while (
    suffix < maximumSuffix
    && baseCharacters[baseCharacters.length - 1 - suffix]
      === currentCharacters[currentCharacters.length - 1 - suffix]
  ) suffix += 1;

  const baseMiddle = baseCharacters.slice(prefix, baseCharacters.length - suffix);
  const currentMiddle = currentCharacters.slice(prefix, currentCharacters.length - suffix);
  const operations: AlignmentOperation[] = [];
  appendAlignmentOperation(operations, 'equal', baseCharacters.slice(0, prefix).join(''));

  if (baseMiddle.length === 0) {
    appendAlignmentOperation(operations, 'insert', currentMiddle.join(''));
  } else if (currentMiddle.length === 0) {
    appendAlignmentOperation(operations, 'delete', baseMiddle.join(''));
  } else {
    const maximumDistance = Math.min(
      baseMiddle.length + currentMiddle.length,
      MAX_REBASE_EDIT_DISTANCE,
    );
    let frontier = new Map<number, number>([[1, 0]]);
    const trace: Array<Map<number, number>> = [];
    let completedDistance: number | null = null;

    for (let distance = 0; distance <= maximumDistance; distance += 1) {
      trace.push(new Map(frontier));
      const nextFrontier = new Map<number, number>();
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
        const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
        let x = diagonal === -distance || (diagonal !== distance && right < down)
          ? Math.max(0, down)
          : Math.max(0, right + 1);
        let y = x - diagonal;
        while (
          x < baseMiddle.length
          && y < currentMiddle.length
          && baseMiddle[x] === currentMiddle[y]
        ) {
          x += 1;
          y += 1;
        }
        nextFrontier.set(diagonal, x);
        if (x >= baseMiddle.length && y >= currentMiddle.length) {
          completedDistance = distance;
          frontier = nextFrontier;
          break;
        }
      }
      if (completedDistance !== null) break;
      frontier = nextFrontier;
    }

    if (completedDistance === null) {
      appendAlignmentOperation(operations, 'delete', baseMiddle.join(''));
      appendAlignmentOperation(operations, 'insert', currentMiddle.join(''));
    } else {
      const reversed: AlignmentOperation[] = [];
      let x = baseMiddle.length;
      let y = currentMiddle.length;
      for (let distance = completedDistance; distance >= 0; distance -= 1) {
        const previousFrontier = trace[distance];
        const diagonal = x - y;
        const down = previousFrontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
        const right = previousFrontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
        const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
          ? diagonal + 1
          : diagonal - 1;
        const previousX = Math.max(0, previousFrontier.get(previousDiagonal) ?? 0);
        const previousY = previousX - previousDiagonal;

        while (x > previousX && y > previousY) {
          appendAlignmentOperation(reversed, 'equal', baseMiddle[x - 1]);
          x -= 1;
          y -= 1;
        }
        if (distance === 0) break;
        if (x === previousX) {
          appendAlignmentOperation(reversed, 'insert', currentMiddle[y - 1]);
          y -= 1;
        } else {
          appendAlignmentOperation(reversed, 'delete', baseMiddle[x - 1]);
          x -= 1;
        }
      }

      for (const operation of reversed.reverse()) {
        appendAlignmentOperation(
          operations,
          operation.kind,
          codePoints(operation.text).reverse().join(''),
        );
      }
    }
  }

  appendAlignmentOperation(
    operations,
    'equal',
    baseCharacters.slice(baseCharacters.length - suffix).join(''),
  );
  return operations;
};

const alignmentSegments = (base: string, current: string): AlignmentSegment[] => {
  const segments: AlignmentSegment[] = [];
  let basePosition = 0;
  let pendingChange: { text: string; baseStart: number; baseEnd: number } | null = null;
  const flushChange = () => {
    if (!pendingChange) return;
    segments.push({ kind: 'change', ...pendingChange });
    pendingChange = null;
  };

  for (const operation of alignStrings(base, current)) {
    if (operation.kind === 'equal') {
      flushChange();
      segments.push({
        kind: 'equal',
        text: operation.text,
        baseStart: basePosition,
        baseEnd: basePosition + operation.text.length,
      });
      basePosition += operation.text.length;
      continue;
    }

    pendingChange ??= { text: '', baseStart: basePosition, baseEnd: basePosition };
    if (operation.kind === 'delete') {
      basePosition += operation.text.length;
      pendingChange.baseEnd = basePosition;
    } else {
      pendingChange.text += operation.text;
    }
  }
  flushChange();
  return segments;
};

/**
 * Rebase one full-value editor change onto text that changed remotely after
 * the editor rendered. Both changes are represented as minimal splices. Base
 * characters deleted by either side stay deleted, while concurrent inserted
 * text is preserved.
 */
export function rebaseStringEdit(base: string, next: string, current: string): string {
  if (base === current) return next;
  const local = computeMinimalStringDiff(base, next);
  if (!local) return current;
  const localStart = local.index;
  const localEnd = local.index + local.deleteCount;
  let inserted = false;
  let rebased = '';

  for (const segment of alignmentSegments(base, current)) {
    if (segment.kind === 'change') {
      // A local insertion at the leading edge of even an opaque fallback
      // replacement still has an exact position and belongs before it.
      if (!inserted && localStart === segment.baseStart) {
        rebased += local.insert;
        inserted = true;
      }
      rebased += segment.text;
      if (!inserted && localStart > segment.baseStart && localStart <= segment.baseEnd) {
        rebased += local.insert;
        inserted = true;
      }
      continue;
    }

    let baseIndex = segment.baseStart;
    for (const character of codePoints(segment.text)) {
      if (!inserted && baseIndex === localStart) {
        rebased += local.insert;
        inserted = true;
      }
      if (baseIndex < localStart || baseIndex >= localEnd) {
        rebased += character;
      }
      baseIndex += character.length;
    }
  }

  if (!inserted) rebased += local.insert;
  return rebased;
}

/**
 * A notebook is represented by exactly one Y.Doc. IndexedDB rows and Markdown
 * files should be treated as projections of this document once collaboration
 * is enabled.
 */
export class NotebookCrdt {
  readonly doc: Y.Doc;
  readonly notebookId: string;
  private readonly metadata: Y.Map<unknown>;
  private readonly notes: Y.Map<NoteMap>;

  constructor(notebookId: string, doc?: Y.Doc) {
    requireNonEmptyString(notebookId, 'notebookId');
    this.notebookId = notebookId;
    this.doc = doc ?? new Y.Doc({ guid: `${NOTEBOOK_CRDT_GUID_PREFIX}${notebookId}` });
    this.metadata = this.doc.getMap(NOTEBOOK_CRDT_METADATA_MAP);
    this.notes = this.doc.getMap<NoteMap>(NOTEBOOK_CRDT_NOTES_MAP);

    const storedNotebookId = this.metadata.get('id');
    if (typeof storedNotebookId === 'string' && storedNotebookId !== notebookId) {
      throw new Error(`Y.Doc belongs to notebook ${storedNotebookId}, not ${notebookId}`);
    }
  }

  /** Seeds a new document or idempotently upserts an existing local notebook. */
  seed(notebook: NotebookSeed, notes: CrdtNoteInput[] = []) {
    if (notebook.id !== this.notebookId) {
      throw new Error(`Cannot seed notebook ${notebook.id} into ${this.notebookId}`);
    }
    requireNonEmptyString(notebook.name, 'notebook.name');
    requireTimestamp(notebook.createdAt, 'notebook.createdAt');
    requireTimestamp(notebook.updatedAt, 'notebook.updatedAt');

    this.doc.transact(() => {
      this.metadata.set('schemaVersion', NOTEBOOK_CRDT_SCHEMA_VERSION);
      this.metadata.set('id', notebook.id);
      this.metadata.set('name', notebook.name);
      if (this.metadata.get('createdAt') === undefined) {
        this.metadata.set('createdAt', notebook.createdAt);
      }
      this.metadata.set('updatedAt', notebook.updatedAt);

      for (const note of notes) {
        this.upsertNoteInCurrentTransaction(note);
      }
    }, LOCAL_CRDT_ORIGIN);
  }

  updateNotebook(updates: { name?: string; updatedAt: number }) {
    requireTimestamp(updates.updatedAt, 'updatedAt');
    if (updates.name !== undefined) requireNonEmptyString(updates.name, 'name');

    this.doc.transact(() => {
      if (updates.name !== undefined) this.metadata.set('name', updates.name);
      this.metadata.set('updatedAt', updates.updatedAt);
    }, LOCAL_CRDT_ORIGIN);
  }

  /**
   * Creates or updates a note using minimal Y.Text splices. Omitting `deleted`
   * preserves an existing tombstone; callers must explicitly pass false to
   * restore a deleted note.
   */
  upsertNote(note: CrdtNoteInput) {
    this.doc.transact(() => {
      this.upsertNoteInCurrentTransaction(note);
    }, LOCAL_CRDT_ORIGIN);
  }

  private upsertNoteInCurrentTransaction(note: CrdtNoteInput) {
    requireNonEmptyString(note.id, 'note.id');
    requireTimestamp(note.createdAt, 'note.createdAt');
    requireTimestamp(note.updatedAt, 'note.updatedAt');
    if (note.deletedAt !== undefined && note.deletedAt !== null) {
      requireTimestamp(note.deletedAt, 'note.deletedAt');
    }

    let noteMap = this.notes.get(note.id);
    const isNew = !noteMap;
    if (!noteMap) {
      noteMap = new Y.Map<unknown>();
      this.notes.set(note.id, noteMap);
    }

    applyMinimalStringDiff(ensureText(noteMap, 'title'), note.title);
    applyMinimalStringDiff(ensureText(noteMap, 'content'), note.content);
    noteMap.set('folderId', note.folderId);
    if (isNew || noteMap.get('createdAt') === undefined) {
      noteMap.set('createdAt', note.createdAt);
    }
    noteMap.set('updatedAt', note.updatedAt);

    if (isNew) {
      noteMap.set('deleted', note.deleted ?? false);
      noteMap.set('deletedAt', note.deletedAt ?? null);
    } else if (note.deleted !== undefined) {
      noteMap.set('deleted', note.deleted);
      noteMap.set('deletedAt', note.deleted ? (note.deletedAt ?? note.updatedAt) : null);
    }
  }

  deleteNote(noteId: string, deletedAt: number) {
    requireNonEmptyString(noteId, 'noteId');
    requireTimestamp(deletedAt, 'deletedAt');

    this.doc.transact(() => {
      const note = this.notes.get(noteId);
      if (!note) return;
      note.set('deleted', true);
      note.set('deletedAt', deletedAt);
      note.set('updatedAt', deletedAt);
    }, LOCAL_CRDT_ORIGIN);
  }

  restoreNote(noteId: string, updatedAt: number) {
    requireNonEmptyString(noteId, 'noteId');
    requireTimestamp(updatedAt, 'updatedAt');

    this.doc.transact(() => {
      const note = this.notes.get(noteId);
      if (!note) return;
      note.set('deleted', false);
      note.set('deletedAt', null);
      note.set('updatedAt', updatedAt);
    }, LOCAL_CRDT_ORIGIN);
  }

  getNote(noteId: string): CrdtNoteProjection | undefined {
    const note = this.notes.get(noteId);
    return note ? this.projectNote(noteId, note) : undefined;
  }

  snapshot(): NotebookCrdtProjection {
    const storedNotebookId = readString(this.metadata, 'id', this.notebookId);
    if (storedNotebookId !== this.notebookId) {
      throw new Error(`Y.Doc notebook ID changed from ${this.notebookId} to ${storedNotebookId}`);
    }

    return {
      schemaVersion: NOTEBOOK_CRDT_SCHEMA_VERSION,
      notebook: {
        id: storedNotebookId,
        name: readString(this.metadata, 'name'),
        createdAt: readNumber(this.metadata, 'createdAt'),
        updatedAt: readNumber(this.metadata, 'updatedAt'),
      },
      notes: Array.from(this.notes.entries())
        .map(([id, note]) => this.projectNote(id, note))
        .sort((a, b) => compareUtf8(a.id, b.id)),
    };
  }

  private projectNote(id: string, note: NoteMap): CrdtNoteProjection {
    return {
      id,
      title: getText(note, 'title')?.toString() ?? '',
      content: getText(note, 'content')?.toString() ?? '',
      folderId: readNullableString(note, 'folderId'),
      createdAt: readNumber(note, 'createdAt'),
      updatedAt: readNumber(note, 'updatedAt'),
      deleted: note.get('deleted') === true,
      deletedAt: readNullableNumber(note, 'deletedAt'),
    };
  }

  encodeUpdate(remoteStateVector?: Uint8Array) {
    return Y.encodeStateAsUpdate(this.doc, remoteStateVector);
  }

  encodeStateVector() {
    return Y.encodeStateVector(this.doc);
  }

  encodeDiff(remoteStateVector: Uint8Array) {
    return Y.encodeStateAsUpdate(this.doc, remoteStateVector);
  }

  applyUpdate(update: Uint8Array) {
    if (!(update instanceof Uint8Array)) {
      throw new Error('Yjs update must be a Uint8Array');
    }
    Y.applyUpdate(this.doc, update, REMOTE_CRDT_ORIGIN);
  }

  /**
   * Apply a Yjs-compatible update produced by a local native vault. Unlike a
   * network update, this deliberately uses the local origin so an active
   * collaboration session persists and broadcasts it to the XMTP group.
   */
  applyLocalUpdate(update: Uint8Array) {
    if (!(update instanceof Uint8Array)) {
      throw new Error('Yjs update must be a Uint8Array');
    }
    Y.applyUpdate(this.doc, update, LOCAL_CRDT_ORIGIN);
  }

  /** Captures local transactions and returns an unsubscribe function. */
  captureLocalUpdates(handler: LocalUpdateHandler) {
    const listener = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_CRDT_ORIGIN) return;
      handler(update.slice(), origin);
    };
    this.doc.on('update', listener);
    return () => this.doc.off('update', listener);
  }

  destroy() {
    this.doc.destroy();
  }
}

export function mergeCrdtUpdates(updates: Uint8Array[]) {
  if (updates.length === 0) return new Uint8Array([0, 0]);
  return Y.mergeUpdates(updates);
}

// Legacy exports kept while the transport/UI migration lands. They are not a
// CRDT and must not be used by the new Yjs collaboration path.
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
