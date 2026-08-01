import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  NotebookCrdt,
  REMOTE_CRDT_ORIGIN,
  applyMinimalStringDiff,
  computeMinimalStringDiff,
  rebaseStringEdit,
} from './crdt';

const notebook = {
  id: 'nb-1',
  name: 'Shared notebook',
  createdAt: 1,
  updatedAt: 1,
};

const note = {
  id: 'note-1',
  title: 'Plan',
  content: 'alpha beta',
  folderId: null,
  createdAt: 1,
  updatedAt: 1,
};

const synchronize = (left: NotebookCrdt, right: NotebookCrdt) => {
  const leftUpdate = left.encodeDiff(right.encodeStateVector());
  const rightUpdate = right.encodeDiff(left.encodeStateVector());
  left.applyUpdate(rightUpdate);
  right.applyUpdate(leftUpdate);
};

const hasMalformedSurrogate = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

describe('NotebookCrdt', () => {
  it('computes and applies a minimal single-splice text diff', () => {
    expect(computeMinimalStringDiff('hello old world', 'hello new world')).toEqual({
      index: 6,
      deleteCount: 3,
      insert: 'new',
    });

    const crdt = new NotebookCrdt('nb-1');
    crdt.seed(notebook, [{ ...note, content: 'hello old world' }]);
    const noteMap = crdt.doc.getMap<Y.Map<unknown>>('notes').get('note-1');
    const content = noteMap?.get('content');
    expect(content).toBeInstanceOf(Y.Text);
    if (!(content instanceof Y.Text)) throw new Error('expected Y.Text content');
    applyMinimalStringDiff(content, 'hello new world');
    expect(content.toString()).toBe('hello new world');

    expect(computeMinimalStringDiff('a😀b', 'a😃b')).toEqual({
      index: 1,
      deleteCount: 2,
      insert: '😃',
    });
  });

  it('rebases stale editor splices without deleting concurrent remote text', () => {
    expect(rebaseStringEdit('alpha beta', 'LOCAL alpha beta', 'alpha beta REMOTE'))
      .toBe('LOCAL alpha beta REMOTE');
    expect(rebaseStringEdit('abcdef', 'aQdef', 'abXYef')).toBe('aQXYef');
    expect(rebaseStringEdit('abcdef', 'abcQf', 'abXYef')).toBe('abXYQf');
    expect(rebaseStringEdit('abcdef', 'aQf', 'abXYef')).toBe('aQXYf');
    expect(rebaseStringEdit('abcdef', 'abXef', 'abcYdef')).toBe('abXYef');
    expect(rebaseStringEdit('abcdef', 'abef', 'aXbcdeYf')).toBe('aXbeYf');
    expect(rebaseStringEdit('a', 'ab', 'a')).toBe('ab');
    expect(rebaseStringEdit('a😀b', 'a😀LOCALb', 'REMOTE a😀b')).toBe('REMOTE a😀LOCALb');
    const emojiRebase = rebaseStringEdit('a😀b', 'a😃b', 'a😄b');
    expect(emojiRebase).toBe('a😃😄b');
    expect(hasMalformedSurrogate(emojiRebase)).toBe(false);

    const longBase = 'a'.repeat(600);
    const longCurrent = 'b'.repeat(600);
    expect(rebaseStringEdit(longBase, `LOCAL${longBase}`, longCurrent))
      .toBe(`LOCAL${longCurrent}`);
  });

  it('converges concurrent emoji replacements without malformed surrogates', () => {
    const left = new NotebookCrdt('nb-1');
    left.seed(notebook, [{ ...note, content: 'a😀b' }]);
    const right = new NotebookCrdt('nb-1');
    right.applyUpdate(left.encodeUpdate());

    left.upsertNote({ ...note, content: 'a😃b', updatedAt: 2 });
    right.upsertNote({ ...note, content: 'a😄b', updatedAt: 3 });
    synchronize(left, right);

    const leftContent = left.getNote('note-1')?.content ?? '';
    const rightContent = right.getNote('note-1')?.content ?? '';
    expect(leftContent).toBe(rightContent);
    expect(leftContent).toMatch(/^a(?:😃😄|😄😃)b$/u);
    expect(hasMalformedSurrogate(leftContent)).toBe(false);
  });

  it('converges concurrent edits made by two documents', () => {
    const left = new NotebookCrdt('nb-1');
    left.seed(notebook, [note]);
    const right = new NotebookCrdt('nb-1');
    right.applyUpdate(left.encodeUpdate());

    left.upsertNote({ ...note, content: 'LEFT alpha beta', updatedAt: 2 });
    right.upsertNote({ ...note, content: 'alpha beta RIGHT', updatedAt: 3 });

    synchronize(left, right);

    expect(left.snapshot()).toEqual(right.snapshot());
    const content = left.getNote('note-1')?.content;
    expect(content).toContain('LEFT');
    expect(content).toContain('RIGHT');
  });

  it('accepts duplicate and out-of-order updates idempotently', () => {
    const source = new NotebookCrdt('nb-1');
    const updates: Uint8Array[] = [];
    source.captureLocalUpdates((update) => updates.push(update));
    source.seed(notebook, [note]);
    source.upsertNote({ ...note, content: 'alpha beta gamma', updatedAt: 2 });
    source.upsertNote({ ...note, title: 'Updated plan', content: 'alpha beta gamma', updatedAt: 3 });

    const replica = new NotebookCrdt('nb-1');
    for (const update of [...updates].reverse()) replica.applyUpdate(update);
    for (const update of updates) replica.applyUpdate(update);

    expect(replica.snapshot()).toEqual(source.snapshot());
  });

  it('repairs an offline replica with a state-vector diff', () => {
    const online = new NotebookCrdt('nb-1');
    online.seed(notebook, [note]);
    const offline = new NotebookCrdt('nb-1');
    offline.applyUpdate(online.encodeUpdate());

    online.upsertNote({ ...note, content: 'online change', updatedAt: 2 });
    offline.upsertNote({ ...note, title: 'offline title', updatedAt: 3 });

    const missingForOffline = online.encodeDiff(offline.encodeStateVector());
    offline.applyUpdate(missingForOffline);
    const missingForOnline = offline.encodeDiff(online.encodeStateVector());
    online.applyUpdate(missingForOnline);

    expect(online.snapshot()).toEqual(offline.snapshot());
    expect(online.getNote('note-1')).toMatchObject({
      title: 'offline title',
      content: 'online change',
    });
  });

  it('keeps a deletion tombstone when a concurrent peer edits the note', () => {
    const deletingPeer = new NotebookCrdt('nb-1');
    deletingPeer.seed(notebook, [note]);
    const editingPeer = new NotebookCrdt('nb-1');
    editingPeer.applyUpdate(deletingPeer.encodeUpdate());

    deletingPeer.deleteNote('note-1', 2);
    editingPeer.upsertNote({ ...note, content: 'edited while offline', updatedAt: 3 });
    synchronize(deletingPeer, editingPeer);

    expect(deletingPeer.snapshot()).toEqual(editingPeer.snapshot());
    expect(deletingPeer.getNote('note-1')).toMatchObject({
      deleted: true,
      content: 'edited while offline',
    });
  });

  it('does not resurrect a persisted tombstone while seeding local rows', () => {
    const crdt = new NotebookCrdt('nb-1');
    crdt.seed(notebook, [note]);
    crdt.deleteNote('note-1', 2);

    crdt.seed({ ...notebook, updatedAt: 3 }, [{ ...note, content: 'stale local row', updatedAt: 3 }]);

    expect(crdt.getNote('note-1')).toMatchObject({
      content: 'stale local row',
      deleted: true,
      deletedAt: 2,
    });
  });

  it('captures only local updates when remote state is applied', () => {
    const source = new NotebookCrdt('nb-1');
    source.seed(notebook, [note]);
    const replica = new NotebookCrdt('nb-1');
    const origins: unknown[] = [];
    replica.captureLocalUpdates((_update, origin) => origins.push(origin));

    replica.applyUpdate(source.encodeUpdate());
    replica.upsertNote({ ...note, title: 'local', updatedAt: 2 });

    expect(origins).toHaveLength(1);
    expect(origins).not.toContain(REMOTE_CRDT_ORIGIN);
  });

  it('captures a Yrs-compatible native update as a local change', () => {
    const nativeReplica = new NotebookCrdt('nb-1');
    nativeReplica.seed(notebook, [note]);
    const browserReplica = new NotebookCrdt('nb-1');
    const outbound: Uint8Array[] = [];
    browserReplica.captureLocalUpdates((update) => outbound.push(update));

    browserReplica.applyLocalUpdate(nativeReplica.encodeUpdate());

    expect(browserReplica.snapshot()).toEqual(nativeReplica.snapshot());
    expect(outbound).toHaveLength(1);
  });
});
