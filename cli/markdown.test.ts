import { mkdtemp, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIRROR_MANIFEST_FILE,
  MIRROR_SCHEMA,
  MIRROR_STATE_DIRECTORY,
  materializeMirror,
  parseMirrorNote,
  readMirrorManifest,
  scanMirror,
  serializeMirrorNote,
  type MirrorNote,
} from './markdown.js';

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stormdance-markdown-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const note = (overrides: Partial<MirrorNote> = {}): MirrorNote => ({
  id: '12345678-90ab-cdef-1234-567890abcdef',
  notebookId: 'notebook-1',
  folderId: null,
  title: 'Hello / World',
  content: 'A UTF-8 body: café 🌩️\n\n- one\n- two\n',
  createdAt: 100,
  updatedAt: 200,
  ...overrides,
});

describe('Markdown serialization', () => {
  it('round-trips strict metadata, title, and body', () => {
    const original = note({ folderId: 'folder-1' });
    const serialized = serializeMirrorNote(original);

    expect(serialized.split('\n')[0]).toBe(
      '<!-- stormdance:{"schema":1,"notebookId":"notebook-1","noteId":"12345678-90ab-cdef-1234-567890abcdef","folderId":"folder-1","createdAt":100,"updatedAt":200} -->',
    );
    expect(parseMirrorNote(serialized)).toEqual(original);
  });

  it('rejects malformed storm.dance metadata instead of importing it as an unowned file', () => {
    expect(() => parseMirrorNote('<!-- stormdance:{"schema":1} -->\n# Bad\n\nbody')).toThrow(
      'Invalid storm.dance metadata fields',
    );
  });
});

describe('Markdown materialization', () => {
  it('writes atomically, suppresses unchanged writes, updates, and renames by title', async () => {
    const root = await makeTemporaryDirectory();
    const first = await materializeMirror(root, [note()]);
    const firstPath = first.manifest.notes[note().id].path;

    expect(firstPath).toMatch(/^hello-world--[a-z0-9]{12}\.md$/);
    expect(first.writtenPaths).toEqual([firstPath]);
    expect(parseMirrorNote(await readFile(path.join(root, firstPath), 'utf8'))).toEqual(note());

    const unchanged = await materializeMirror(root, [note()]);
    expect(unchanged.writtenPaths).toEqual([]);
    expect(unchanged.removedPaths).toEqual([]);

    const changed = note({ content: 'changed', updatedAt: 300 });
    const update = await materializeMirror(root, [changed]);
    expect(update.writtenPaths).toEqual([firstPath]);
    expect(parseMirrorNote(await readFile(path.join(root, firstPath), 'utf8'))).toEqual(changed);

    const renamedNote = note({ title: 'Renamed Note', content: 'changed', updatedAt: 400 });
    const renamed = await materializeMirror(root, [renamedNote]);
    const renamedPath = renamed.manifest.notes[note().id].path;
    expect(renamedPath).toMatch(/^renamed-note--[a-z0-9]{12}\.md$/);
    expect(renamed.removedPaths).toEqual([firstPath]);
    await expect(readFile(path.join(root, firstPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses collision-safe names and tombstones only manifest-owned files', async () => {
    const root = await makeTemporaryDirectory();
    const expectedPath = (await materializeMirror(root, [note()])).manifest.notes[note().id].path;
    await unlink(path.join(root, expectedPath));
    await writeFile(path.join(root, expectedPath), 'unowned collision', 'utf8');

    // Removing the manifest makes the colliding file unowned.
    await unlink(path.join(root, MIRROR_STATE_DIRECTORY, MIRROR_MANIFEST_FILE));
    const collision = await materializeMirror(root, [note()]);
    const ownedPath = collision.manifest.notes[note().id].path;
    expect(ownedPath).not.toBe(expectedPath);
    expect(await readFile(path.join(root, expectedPath), 'utf8')).toBe('unowned collision');

    await writeFile(path.join(root, 'personal.md'), '# Personal\n', 'utf8');
    const tombstone = await materializeMirror(root, [note({ deleted: true })]);
    expect(tombstone.removedPaths).toEqual([ownedPath]);
    expect(tombstone.manifest.notes[note().id]).toBeUndefined();
    expect(await readFile(path.join(root, 'personal.md'), 'utf8')).toBe('# Personal\n');
  });

  it('preserves a dirty owned file across remote updates and tombstones', async () => {
    const root = await makeTemporaryDirectory();
    const initial = await materializeMirror(root, [note()]);
    const relativePath = initial.manifest.notes[note().id].path;
    const replacement = '# Unsynced replacement\n\nkeep this exact file';
    await writeFile(path.join(root, relativePath), replacement, 'utf8');

    const update = await materializeMirror(root, [
      note({ content: 'remote replacement', updatedAt: 300 }),
    ]);
    expect(update.protectedPaths).toEqual([relativePath]);
    expect(update.writtenPaths).toEqual([]);
    expect(await readFile(path.join(root, relativePath), 'utf8')).toBe(replacement);
    expect((await readMirrorManifest(root)).notes[note().id]).toEqual(
      initial.manifest.notes[note().id],
    );

    const tombstone = await materializeMirror(root, [note({ deleted: true })]);
    expect(tombstone.protectedPaths).toEqual([relativePath]);
    expect(tombstone.removedPaths).toEqual([]);
    expect(await readFile(path.join(root, relativePath), 'utf8')).toBe(replacement);
  });

  it('does not recreate a missing owned file before its deletion scan is acknowledged', async () => {
    const root = await makeTemporaryDirectory();
    const initial = await materializeMirror(root, [note()]);
    const relativePath = initial.manifest.notes[note().id].path;
    await unlink(path.join(root, relativePath));

    const protectedResult = await materializeMirror(root, [note()]);
    expect(protectedResult.protectedPaths).toEqual([relativePath]);
    await expect(readFile(path.join(root, relativePath))).rejects.toMatchObject({ code: 'ENOENT' });

    const acknowledged = await materializeMirror(root, [note({ deleted: true })], {
      acknowledgedDeletionNoteIds: new Set([note().id]),
    });
    expect(acknowledged.protectedPaths).toEqual([]);
    expect(acknowledged.manifest.notes[note().id]).toBeUndefined();
  });
});

describe('Markdown scanning', () => {
  it('returns external updates and user deletions while suppressing materializer writes', async () => {
    const root = await makeTemporaryDirectory();
    const materialized = await materializeMirror(root, [note()]);
    const relativePath = materialized.manifest.notes[note().id].path;

    expect(await scanMirror(root, 'notebook-1')).toEqual({
      upserts: [],
      deletedNoteIds: [],
      ignoredPaths: [],
      preferredPaths: {},
    });

    const edited = note({ content: 'edited outside storm.dance', updatedAt: 250 });
    await writeFile(path.join(root, relativePath), serializeMirrorNote(edited), 'utf8');
    const update = await scanMirror(root, 'notebook-1', { now: () => 1_000 });
    expect(update.deletedNoteIds).toEqual([]);
    expect(update.upserts).toHaveLength(1);
    expect(update.upserts[0]).toMatchObject({ id: note().id, content: 'edited outside storm.dance', updatedAt: 1_000 });

    await unlink(path.join(root, relativePath));
    expect((await scanMirror(root, 'notebook-1')).deletedNoteIds).toEqual([note().id]);
  });

  it('discovers metadata-free files using H1 first and filename second', async () => {
    const root = await makeTemporaryDirectory();
    await writeFile(path.join(root, 'draft.md'), '# Better title\n\nBody text', 'utf8');
    await writeFile(path.join(root, 'second-idea.md'), 'No heading here', 'utf8');

    let nextId = 0;
    const result = await scanMirror(root, 'notebook-1', {
      createId: () => `new-note-${++nextId}`,
      now: () => 500,
    });

    expect(result.upserts).toEqual([
      expect.objectContaining({ id: 'new-note-1', title: 'Better title', content: 'Body text' }),
      expect.objectContaining({ id: 'new-note-2', title: 'second idea', content: 'No heading here' }),
    ]);
    expect(result.deletedNoteIds).toEqual([]);
    expect(result.preferredPaths).toEqual({
      'new-note-1': 'draft.md',
      'new-note-2': 'second-idea.md',
    });

    await materializeMirror(root, result.upserts, { preferredPaths: result.preferredPaths });
    expect(await scanMirror(root, 'notebook-1')).toEqual({
      upserts: [],
      deletedNoteIds: [],
      ignoredPaths: [],
      preferredPaths: {},
    });
  });

  it('recognizes a metadata-preserving user rename without reporting a deletion', async () => {
    const root = await makeTemporaryDirectory();
    const materialized = await materializeMirror(root, [note()]);
    const oldPath = materialized.manifest.notes[note().id].path;
    await rename(path.join(root, oldPath), path.join(root, 'manual-rename.md'));

    const result = await scanMirror(root, 'notebook-1', { now: () => 1_000 });
    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0].id).toBe(note().id);
    expect(result.deletedNoteIds).toEqual([]);
  });

  it('does not let an unowned duplicate steal a manifest-owned note by filename order', async () => {
    const root = await makeTemporaryDirectory();
    const materialized = await materializeMirror(root, [note()]);
    const ownedPath = materialized.manifest.notes[note().id].path;
    const duplicatePath = '000-duplicate.md';
    await writeFile(
      path.join(root, duplicatePath),
      serializeMirrorNote(note({ content: 'duplicate must not replace the owned note' })),
      'utf8',
    );

    const result = await scanMirror(root, 'notebook-1', { now: () => 1_000 });

    expect(result.upserts).toEqual([]);
    expect(result.deletedNoteIds).toEqual([]);
    expect(result.ignoredPaths).toEqual([duplicatePath]);
    expect((await readMirrorManifest(root)).notes[note().id].path).toBe(ownedPath);
  });

  it('ignores symlinks and never follows manifest paths outside the mirror root', async () => {
    const root = await makeTemporaryDirectory();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    await writeFile(outside, 'outside data', 'utf8');
    await mkdir(path.join(root, MIRROR_STATE_DIRECTORY), { mode: 0o700 });
    await writeFile(
      path.join(root, MIRROR_STATE_DIRECTORY, MIRROR_MANIFEST_FILE),
      `${JSON.stringify({
        schema: MIRROR_SCHEMA,
        notes: { danger: { path: `../${path.basename(outside)}`, hash: 'a'.repeat(64) } },
      })}\n`,
      'utf8',
    );

    expect((await readMirrorManifest(root)).notes).toEqual({});

    if (process.platform !== 'win32') {
      await symlink(outside, path.join(root, 'linked.md'));
      const scan = await scanMirror(root, 'notebook-1');
      expect(scan.upserts).toEqual([]);
      expect(scan.ignoredPaths).toEqual(['linked.md']);

      const owned = await materializeMirror(root, [note()]);
      const ownedPath = owned.manifest.notes[note().id].path;
      await unlink(path.join(root, ownedPath));
      await symlink(outside, path.join(root, ownedPath));
      const ownedSymlinkScan = await scanMirror(root, 'notebook-1');
      expect(ownedSymlinkScan.deletedNoteIds).not.toContain(note().id);
    }

    await materializeMirror(root, [note({ id: 'danger', deleted: true })]);
    expect(await readFile(outside, 'utf8')).toBe('outside data');
    await unlink(outside);
  });
});
