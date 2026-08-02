import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIRROR_MANIFEST_FILE,
  MIRROR_SCHEMA,
  MIRROR_STATE_DIRECTORY,
  materializeMirror,
  obsidianPathFolderId,
  parseMirrorNote,
  readMirrorManifest,
  scanMirror,
  serializeMirrorNote,
  type MirrorFolder,
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

const folder = (overrides: Partial<MirrorFolder> = {}): MirrorFolder => ({
  id: 'folder-1',
  notebookId: 'notebook-1',
  name: 'Research',
  parentFolderId: null,
  createdAt: 100,
  updatedAt: 200,
  deleted: false,
  deletedAt: null,
  ...overrides,
});

describe('Markdown serialization', () => {
  it('round-trips strict metadata, title, and body', () => {
    const original = note({ folderId: 'folder-1' });
    const serialized = serializeMirrorNote(original);

    expect(serialized.split('\n')[0]).toBe(
      `<!-- stormdance:{"schema":${MIRROR_SCHEMA},"notebookId":"notebook-1","noteId":"12345678-90ab-cdef-1234-567890abcdef","folderId":"folder-1","createdAt":100,"updatedAt":200} -->`,
    );
    expect(parseMirrorNote(serialized)).toEqual(original);
    expect(parseMirrorNote(serialized.replace(`"schema":${MIRROR_SCHEMA}`, '"schema":1')))
      .toEqual(original);
  });

  it('rejects malformed storm.dance metadata instead of importing it as an unowned file', () => {
    expect(() => parseMirrorNote('<!-- stormdance:{"schema":1} -->\n# Bad\n\nbody')).toThrow(
      'Invalid storm.dance metadata fields',
    );
  });
});

describe('Markdown materialization', () => {
  it('writes atomically, suppresses unchanged writes, and keeps a stable path across title edits', async () => {
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
    expect(renamedPath).toBe(firstPath);
    expect(renamed.removedPaths).toEqual([]);
    expect(parseMirrorNote(await readFile(path.join(root, firstPath), 'utf8')).title).toBe('Renamed Note');
  });

  it('materializes browser-created folders and moves an owned note with its folderId', async () => {
    const root = await makeTemporaryDirectory();
    const initial = await materializeMirror(root, [note()]);
    const oldPath = initial.manifest.notes[note().id].path;
    const research = folder();

    const moved = await materializeMirror(
      root,
      [note({ folderId: research.id, updatedAt: 300 })],
      { folders: [research] },
    );
    const nextPath = moved.manifest.notes[note().id].path;

    expect(moved.manifest.folders[research.id]).toBe('Research');
    expect(nextPath).toBe(`Research/${path.posix.basename(oldPath)}`);
    expect(moved.removedPaths).toEqual([oldPath]);
    await expect(readFile(path.join(root, oldPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(parseMirrorNote(await readFile(path.join(root, nextPath), 'utf8')))
      .toMatchObject({ id: note().id, folderId: research.id });
  });

  it('creates empty nested browser folders without touching unowned directory content', async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, 'Archive'));
    await writeFile(path.join(root, 'Archive', 'attachment.png'), 'unowned', 'utf8');
    const parent = folder({ id: 'archive', name: 'Archive' });
    const child = folder({ id: 'ideas', name: 'Ideas', parentFolderId: parent.id });

    const result = await materializeMirror(root, [], { folders: [parent, child] });

    expect(result.manifest.folders).toEqual({ archive: 'Archive', ideas: 'Archive/Ideas' });
    expect(await readdir(path.join(root, 'Archive'))).toEqual(['Ideas', 'attachment.png']);
    expect(await readdir(path.join(root, 'Archive', 'Ideas'))).toEqual([]);

    const deleted = await materializeMirror(root, [], {
      folders: [{ ...parent, deleted: true, deletedAt: 400 }, { ...child, deleted: true, deletedAt: 400 }],
    });
    expect(deleted.manifest.folders).toEqual({});
    expect(await readFile(path.join(root, 'Archive', 'attachment.png'), 'utf8')).toBe('unowned');
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
  it('turns an empty CLI-created directory into a stable folder entity', async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, 'Research'));
    const researchId = obsidianPathFolderId('notebook-1', 'Research');

    const first = await scanMirror(root, 'notebook-1', { now: () => 500 });
    expect(first.upsertFolders).toEqual([{
      id: researchId,
      notebookId: 'notebook-1',
      name: 'Research',
      parentFolderId: null,
      createdAt: 500,
      updatedAt: 500,
      deleted: false,
      deletedAt: null,
    }]);
    expect(first.upserts).toEqual([]);

    await materializeMirror(root, [], {
      folders: first.upsertFolders,
      preferredFolderPaths: first.preferredFolderPaths,
    });
    const unchanged = await scanMirror(root, 'notebook-1', {
      knownFolders: first.upsertFolders,
      now: () => 600,
    });
    expect(unchanged.upsertFolders).toEqual([]);
    expect(unchanged.deletedFolderIds).toEqual([]);
  });

  it('scopes inferred Obsidian folder IDs to the notebook', async () => {
    const firstRoot = await makeTemporaryDirectory();
    const secondRoot = await makeTemporaryDirectory();
    await mkdir(path.join(firstRoot, 'Research'));
    await mkdir(path.join(secondRoot, 'Research'));

    const first = await scanMirror(firstRoot, 'notebook:one', { now: () => 500 });
    const second = await scanMirror(secondRoot, 'notebook:two', { now: () => 500 });
    const firstId = first.upsertFolders[0]?.id;
    const secondId = second.upsertFolders[0]?.id;

    expect(firstId).toBe('obsidian:path:notebook%3Aone:Research');
    expect(secondId).toBe('obsidian:path:notebook%3Atwo:Research');
    expect(firstId).not.toBe(secondId);
  });

  it('preserves a legacy path-only folder ID already owned by the manifest', async () => {
    const root = await makeTemporaryDirectory();
    const legacy = folder({ id: 'obsidian:path:Research' });
    await materializeMirror(root, [], { folders: [legacy] });

    const scan = await scanMirror(root, legacy.notebookId, {
      knownFolders: [legacy],
      now: () => 500,
    });

    expect(scan.upsertFolders).toEqual([]);
    expect(scan.deletedFolderIds).toEqual([]);
    expect(scan.preferredFolderPaths).toEqual({ [legacy.id]: 'Research' });
  });

  it('uses the actual parent directory when a managed note moves', async () => {
    const root = await makeTemporaryDirectory();
    const left = folder({ id: 'left', name: 'Left' });
    const right = folder({ id: 'right', name: 'Right' });
    const managed = note({ folderId: left.id });
    const initial = await materializeMirror(root, [managed], { folders: [left, right] });
    const oldPath = initial.manifest.notes[managed.id].path;
    const movedPath = `Right/${path.posix.basename(oldPath)}`;
    await rename(path.join(root, oldPath), path.join(root, movedPath));

    const scan = await scanMirror(root, managed.notebookId, {
      knownFolders: [left, right],
      now: () => 1_000,
    });

    expect(scan.deletedNoteIds).toEqual([]);
    expect(scan.upserts).toEqual([
      expect.objectContaining({ id: managed.id, folderId: right.id }),
    ]);
    expect(scan.preferredPaths).toEqual({ [managed.id]: movedPath });
  });

  it('preserves nested folder IDs through a directory rename and move', async () => {
    const root = await makeTemporaryDirectory();
    const parent = folder({ id: 'parent', name: 'Research' });
    const child = folder({ id: 'child', name: 'Drafts', parentFolderId: parent.id });
    const nestedNote = note({ folderId: child.id });
    const initial = await materializeMirror(root, [nestedNote], { folders: [parent, child] });
    const originalNotePath = initial.manifest.notes[nestedNote.id].path;
    await rename(path.join(root, 'Research'), path.join(root, 'Archive'));

    const renamed = await scanMirror(root, nestedNote.notebookId, {
      knownFolders: [parent, child],
      now: () => 1_000,
    });
    expect(renamed.deletedFolderIds).toEqual([]);
    expect(renamed.upsertFolders).toEqual([
      expect.objectContaining({ id: parent.id, name: 'Archive', parentFolderId: null }),
    ]);
    expect(renamed.upserts).toEqual([
      expect.objectContaining({ id: nestedNote.id, folderId: child.id }),
    ]);

    const renamedParent = { ...parent, name: 'Archive', updatedAt: 1_000 };
    const renamedNotePath = `Archive/Drafts/${path.posix.basename(originalNotePath)}`;
    await materializeMirror(root, renamed.upserts, {
      folders: [renamedParent, child],
      preferredPaths: renamed.preferredPaths,
      preferredFolderPaths: renamed.preferredFolderPaths,
      witnesses: renamed.witnesses,
    });
    expect((await readMirrorManifest(root)).folders).toEqual({
      child: 'Archive/Drafts',
      parent: 'Archive',
    });
    expect(parseMirrorNote(await readFile(path.join(root, renamedNotePath), 'utf8')).folderId)
      .toBe(child.id);

    await rename(path.join(root, 'Archive', 'Drafts'), path.join(root, 'Drafts'));
    const moved = await scanMirror(root, nestedNote.notebookId, {
      knownFolders: [renamedParent, child],
      now: () => 2_000,
    });
    expect(moved.deletedFolderIds).toEqual([]);
    expect(moved.upsertFolders).toEqual([
      expect.objectContaining({ id: child.id, name: 'Drafts', parentFolderId: null }),
    ]);
    expect(moved.upserts).toEqual([
      expect.objectContaining({ id: nestedNote.id, folderId: child.id }),
    ]);
  });

  it('returns external updates and user deletions while suppressing materializer writes', async () => {
    const root = await makeTemporaryDirectory();
    const materialized = await materializeMirror(root, [note()]);
    const relativePath = materialized.manifest.notes[note().id].path;

    expect(await scanMirror(root, 'notebook-1')).toEqual({
      upserts: [],
      deletedNoteIds: [],
      upsertFolders: [],
      deletedFolderIds: [],
      ignoredPaths: [],
      preferredPaths: {},
      preferredFolderPaths: {},
      witnesses: {},
      folderWitnesses: {},
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
      upsertFolders: [],
      deletedFolderIds: [],
      ignoredPaths: [],
      preferredPaths: {},
      preferredFolderPaths: {},
      witnesses: {},
      folderWitnesses: {},
    });
  });

  it('does not treat YAML comments or fenced headings as the note title', async () => {
    const root = await makeTemporaryDirectory();
    const source = [
      '---',
      '# YAML comment',
      'tags: [storm]',
      '---',
      '```md',
      '# Fenced heading',
      '```',
      '# Actual title',
      '',
      'Body',
    ].join('\n');
    await writeFile(path.join(root, 'fences.md'), source, 'utf8');

    const result = await scanMirror(root, 'notebook-1', {
      createId: () => 'fenced-note',
      now: () => 500,
    });

    expect(result.upserts[0]).toMatchObject({
      id: 'fenced-note',
      title: 'Actual title',
      content: '---\n# YAML comment\ntags: [storm]\n---\n```md\n# Fenced heading\n```\nBody',
    });
  });

  it('adopts nested Obsidian Markdown and preserves YAML, wikilinks, and folder identity', async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, 'Research'));
    const source = '---\ntags: [storm]\n---\n# Field notes\n\nSee [[Other note]] and ![[diagram.png]].\n';
    await writeFile(path.join(root, 'Research', 'Field notes.md'), source, 'utf8');

    const scan = await scanMirror(root, 'notebook-1', {
      createId: () => 'nested-note',
      now: () => 500,
    });
    const researchId = obsidianPathFolderId('notebook-1', 'Research');
    expect(scan.upserts).toEqual([
      expect.objectContaining({
        id: 'nested-note',
        title: 'Field notes',
        folderId: researchId,
        content: '---\ntags: [storm]\n---\nSee [[Other note]] and ![[diagram.png]].\n',
      }),
    ]);
    expect(scan.preferredPaths).toEqual({ 'nested-note': 'Research/Field notes.md' });
    expect(scan.upsertFolders).toEqual([
      expect.objectContaining({
        id: researchId,
        name: 'Research',
        parentFolderId: null,
      }),
    ]);

    const materialized = await materializeMirror(root, scan.upserts, {
      folders: scan.upsertFolders,
      preferredPaths: scan.preferredPaths,
      preferredFolderPaths: scan.preferredFolderPaths,
    });
    expect(materialized.manifest.notes['nested-note'].path).toBe('Research/Field notes.md');
    expect(materialized.manifest.folders[researchId]).toBe('Research');
    const canonical = await readFile(path.join(root, 'Research', 'Field notes.md'), 'utf8');
    expect(canonical).toContain(`<!-- stormdance:{"schema":${MIRROR_SCHEMA}`);
    expect(canonical).toContain('tags: [storm]');
    expect(canonical).toContain('[[Other note]]');
    expect(canonical).toContain('![[diagram.png]]');
    const unchanged = await scanMirror(root, 'notebook-1', {
      knownFolders: scan.upsertFolders,
    });
    expect(unchanged.upserts).toEqual([]);
    expect(unchanged.deletedNoteIds).toEqual([]);
    expect(unchanged.upsertFolders).toEqual([]);
    expect(unchanged.deletedFolderIds).toEqual([]);
    expect(unchanged.ignoredPaths).toEqual([]);
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

  it('does not let a stale scan acknowledgement overwrite a newer save', async () => {
    const root = await makeTemporaryDirectory();
    const materialized = await materializeMirror(root, [note()]);
    const relativePath = materialized.manifest.notes[note().id].path;
    await writeFile(
      path.join(root, relativePath),
      serializeMirrorNote(note({ content: 'first scanned save', updatedAt: 300 })),
      'utf8',
    );
    const scan = await scanMirror(root, 'notebook-1', { now: () => 1_000 });
    expect(scan.witnesses[note().id]).toEqual(expect.objectContaining({ path: relativePath }));

    const newer = serializeMirrorNote(note({ content: 'newer save after scan', updatedAt: 400 }));
    await writeFile(path.join(root, relativePath), newer, 'utf8');
    const result = await materializeMirror(root, scan.upserts, {
      preferredPaths: scan.preferredPaths,
      witnesses: scan.witnesses,
    });

    expect(result.protectedPaths).toEqual([relativePath]);
    expect(await readFile(path.join(root, relativePath), 'utf8')).toBe(newer);
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

  it.runIf(process.platform !== 'win32')('protects files when a managed parent is replaced by a symlink', async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const nested = note({ folderId: 'obsidian:path:Nested' });

    await mkdir(path.join(root, 'Nested'));
    await writeFile(path.join(root, 'Nested', 'note.md'), serializeMirrorNote(nested), 'utf8');
    const initial = await materializeMirror(root, [nested], {
      preferredPaths: { [nested.id]: 'Nested/note.md' },
    });
    expect(initial.manifest.notes[nested.id].path).toBe('Nested/note.md');

    await rm(path.join(root, 'Nested'), { recursive: true });
    await writeFile(path.join(outside, 'note.md'), 'outside data', 'utf8');
    await symlink(outside, path.join(root, 'Nested'), 'dir');

    const scan = await scanMirror(root, nested.notebookId);
    expect(scan.deletedNoteIds).not.toContain(nested.id);
    expect(scan.ignoredPaths).toContain('Nested');

    const tombstone = await materializeMirror(root, [{ ...nested, deleted: true }]);
    expect(tombstone.removedPaths).toEqual([]);
    expect(tombstone.protectedPaths).toEqual(['Nested/note.md']);
    expect(await readFile(path.join(outside, 'note.md'), 'utf8')).toBe('outside data');
  });
});
