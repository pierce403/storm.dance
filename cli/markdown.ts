import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const MIRROR_SCHEMA = 1;
export const MIRROR_STATE_DIRECTORY = '.stormdance';
export const MIRROR_MANIFEST_FILE = 'manifest.json';

const METADATA_PREFIX = '<!-- stormdance:';
const METADATA_SUFFIX = ' -->';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface MirrorNote {
  id: string;
  notebookId: string;
  folderId: string | null;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface MirrorManifestEntry {
  path: string;
  hash: string;
}

export interface MirrorManifest {
  schema: typeof MIRROR_SCHEMA;
  notes: Record<string, MirrorManifestEntry>;
}

export interface ParseMirrorNoteOptions {
  notebookId?: string;
  noteId?: string;
  fileName?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface MaterializeResult {
  writtenPaths: string[];
  removedPaths: string[];
  protectedPaths: string[];
  manifest: MirrorManifest;
}

export interface MaterializeMirrorOptions {
  /** Safe, root-relative paths discovered by scanMirror that should be adopted in place. */
  preferredPaths?: Readonly<Record<string, string>>;
  /** Owned notes whose current files were parsed and incorporated into the CRDT by this scan. */
  acknowledgedUpsertNoteIds?: ReadonlySet<string>;
  /** Owned notes whose missing files were incorporated as deletion tombstones by this scan. */
  acknowledgedDeletionNoteIds?: ReadonlySet<string>;
}

export interface ScanMirrorOptions {
  createId?: () => string;
  now?: () => number;
}

export interface ScanMirrorResult {
  upserts: MirrorNote[];
  deletedNoteIds: string[];
  ignoredPaths: string[];
  preferredPaths: Record<string, string>;
}

interface MirrorMetadata {
  schema: typeof MIRROR_SCHEMA;
  notebookId: string;
  noteId: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
}

const emptyManifest = (): MirrorManifest => ({ schema: MIRROR_SCHEMA, notes: {} });

const isErrno = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === code;

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isSafeFlatMarkdownPath = (relativePath: string): boolean => {
  if (!relativePath || relativePath.startsWith('.') || path.isAbsolute(relativePath)) return false;
  if (relativePath.includes('/') || relativePath.includes('\\') || relativePath.includes('\0')) return false;
  if (path.basename(relativePath) !== relativePath || path.extname(relativePath) !== '.md') return false;
  return relativePath !== '.' && relativePath !== '..';
};

const resolveSafeMirrorPath = (root: string, relativePath: string): string | null => {
  if (!isSafeFlatMarkdownPath(relativePath)) return null;
  const resolved = path.resolve(root, relativePath);
  return path.dirname(resolved) === root ? resolved : null;
};

const validateMetadata = (value: unknown): MirrorMetadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid storm.dance metadata object');
  }

  const metadata = value as Record<string, unknown>;
  const expectedKeys = ['createdAt', 'folderId', 'noteId', 'notebookId', 'schema', 'updatedAt'];
  const actualKeys = Object.keys(metadata).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('Invalid storm.dance metadata fields');
  }
  if (metadata.schema !== MIRROR_SCHEMA) throw new Error('Unsupported storm.dance metadata schema');
  if (!isNonEmptyString(metadata.notebookId) || !isNonEmptyString(metadata.noteId)) {
    throw new Error('Invalid storm.dance note identity');
  }
  if (metadata.folderId !== null && !isNonEmptyString(metadata.folderId)) {
    throw new Error('Invalid storm.dance folder identity');
  }
  if (!isTimestamp(metadata.createdAt) || !isTimestamp(metadata.updatedAt)) {
    throw new Error('Invalid storm.dance timestamps');
  }

  return {
    schema: MIRROR_SCHEMA,
    notebookId: metadata.notebookId,
    noteId: metadata.noteId,
    folderId: metadata.folderId,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
};

const parseMetadataLine = (line: string): MirrorMetadata => {
  if (!line.startsWith(METADATA_PREFIX) || !line.endsWith(METADATA_SUFFIX)) {
    throw new Error('Invalid storm.dance metadata comment');
  }
  const json = line.slice(METADATA_PREFIX.length, -METADATA_SUFFIX.length);
  return validateMetadata(JSON.parse(json));
};

const normalizedTitle = (title: string): string => {
  const oneLine = title.replace(/[\r\n\0]+/g, ' ').trim();
  return oneLine || 'Untitled';
};

const parseCanonicalBody = (sourceAfterMetadata: string): { title: string; content: string } => {
  const headingEnd = sourceAfterMetadata.indexOf('\n');
  const headingLine = (headingEnd === -1 ? sourceAfterMetadata : sourceAfterMetadata.slice(0, headingEnd)).replace(/\r$/, '');
  const headingMatch = /^#\s+(.+)$/.exec(headingLine);
  if (!headingMatch) throw new Error('Storm.dance Markdown must contain an H1 immediately after metadata');

  let content = headingEnd === -1 ? '' : sourceAfterMetadata.slice(headingEnd + 1);
  if (content.startsWith('\r\n')) content = content.slice(2);
  else if (content.startsWith('\n')) content = content.slice(1);

  return { title: headingMatch[1], content };
};

const titleFromFileName = (fileName: string): string => {
  const baseName = path.basename(fileName, path.extname(fileName));
  const withoutStableSuffix = baseName.replace(/--[a-z0-9]{12}$/i, '');
  return normalizedTitle(withoutStableSuffix.replace(/[-_]+/g, ' '));
};

const parseUserMarkdown = (source: string, fileName: string): { title: string; content: string } => {
  const heading = /(^|\n)#\s+([^\r\n]+)(?:\r?\n|$)/.exec(source);
  if (!heading || heading.index === undefined) {
    return { title: titleFromFileName(fileName), content: source };
  }

  const headingStart = heading.index + heading[1].length;
  const headingEnd = heading.index + heading[0].length;
  let suffix = source.slice(headingEnd);
  if (suffix.startsWith('\r\n')) suffix = suffix.slice(2);
  else if (suffix.startsWith('\n')) suffix = suffix.slice(1);

  return {
    title: normalizedTitle(heading[2]),
    content: `${source.slice(0, headingStart)}${suffix}`,
  };
};

export function serializeMirrorNote(note: MirrorNote): string {
  if (note.deleted) throw new Error('Deleted notes do not have a Markdown representation');
  const metadata: MirrorMetadata = {
    schema: MIRROR_SCHEMA,
    notebookId: note.notebookId,
    noteId: note.id,
    folderId: note.folderId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  const safeMetadataJson = JSON.stringify(metadata).replace(/-->/g, '--\\u003e');
  return `${METADATA_PREFIX}${safeMetadataJson}${METADATA_SUFFIX}\n# ${normalizedTitle(note.title)}\n\n${note.content}`;
}

export function parseMirrorNote(source: string, options: ParseMirrorNoteOptions = {}): MirrorNote {
  const firstLineEnd = source.indexOf('\n');
  const firstLine = (firstLineEnd === -1 ? source : source.slice(0, firstLineEnd)).replace(/\r$/, '');

  if (firstLine.startsWith(METADATA_PREFIX)) {
    const metadata = parseMetadataLine(firstLine);
    const parsed = parseCanonicalBody(firstLineEnd === -1 ? '' : source.slice(firstLineEnd + 1));
    return {
      id: metadata.noteId,
      notebookId: metadata.notebookId,
      folderId: metadata.folderId,
      title: parsed.title,
      content: parsed.content,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    };
  }

  if (!options.notebookId || !options.fileName) {
    throw new Error('Notebook ID and file name are required for Markdown without storm.dance metadata');
  }

  const parsed = parseUserMarkdown(source, options.fileName);
  const timestamp = options.updatedAt ?? Date.now();
  return {
    id: options.noteId ?? randomUUID(),
    notebookId: options.notebookId,
    folderId: null,
    title: parsed.title,
    content: parsed.content,
    createdAt: options.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export function sanitizeMirrorTitle(title: string): string {
  const slug = normalizedTitle(title)
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

export function stableIdFragment(noteId: string): string {
  const visible = noteId.normalize('NFKD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return `${visible}${sha256(noteId)}`.slice(0, 12);
}

const candidateFileName = (note: MirrorNote, attempt: number): string => {
  const slug = sanitizeMirrorTitle(note.title);
  const collisionSuffix = attempt === 1 ? '' : `-${attempt}`;
  return `${slug}${collisionSuffix}--${stableIdFragment(note.id)}.md`;
};

const safeLstat = async (filePath: string) => {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
};

const readRegularFile = async (filePath: string): Promise<Buffer | null> => {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP')) return null;
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const existingRoot = async (rootDirectory: string): Promise<string | null> => {
  try {
    return await realpath(rootDirectory);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
};

const createRoot = async (rootDirectory: string): Promise<string> => {
  await mkdir(rootDirectory, { recursive: true });
  return realpath(rootDirectory);
};

const stateDirectoryPath = (root: string) => path.join(root, MIRROR_STATE_DIRECTORY);
const manifestPath = (root: string) => path.join(stateDirectoryPath(root), MIRROR_MANIFEST_FILE);

const ensureStateDirectory = async (root: string): Promise<void> => {
  const stateDirectory = stateDirectoryPath(root);
  const existing = await safeLstat(stateDirectory);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`${MIRROR_STATE_DIRECTORY} must be a real directory`);
    }
    return;
  }
  await mkdir(stateDirectory, { mode: 0o700 });
};

const parseManifest = (source: string): MirrorManifest => {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return emptyManifest();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyManifest();
  const object = raw as Record<string, unknown>;
  if (object.schema !== MIRROR_SCHEMA || !object.notes || typeof object.notes !== 'object' || Array.isArray(object.notes)) {
    return emptyManifest();
  }

  const notes: Record<string, MirrorManifestEntry> = {};
  const claimedPaths = new Set<string>();
  for (const [noteId, entryValue] of Object.entries(object.notes as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isNonEmptyString(noteId) || !entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) continue;
    const entry = entryValue as Record<string, unknown>;
    if (typeof entry.path !== 'string' || typeof entry.hash !== 'string') continue;
    if (!isSafeFlatMarkdownPath(entry.path) || !HASH_PATTERN.test(entry.hash) || claimedPaths.has(entry.path)) continue;
    notes[noteId] = { path: entry.path, hash: entry.hash };
    claimedPaths.add(entry.path);
  }
  return { schema: MIRROR_SCHEMA, notes };
};

export async function readMirrorManifest(rootDirectory: string): Promise<MirrorManifest> {
  const root = await existingRoot(rootDirectory);
  if (!root) return emptyManifest();

  const stateDirectory = stateDirectoryPath(root);
  const stateDirectoryStat = await safeLstat(stateDirectory);
  if (!stateDirectoryStat || stateDirectoryStat.isSymbolicLink() || !stateDirectoryStat.isDirectory()) return emptyManifest();

  const file = manifestPath(root);
  const manifestStat = await safeLstat(file);
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) return emptyManifest();

  try {
    const bytes = await readRegularFile(file);
    return bytes ? parseManifest(utf8Decoder.decode(bytes)) : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

const orderedManifest = (manifest: MirrorManifest): MirrorManifest => ({
  schema: MIRROR_SCHEMA,
  notes: Object.fromEntries(Object.entries(manifest.notes).sort(([left], [right]) => left.localeCompare(right))),
});

const atomicWriteUtf8 = async (destination: string, content: string, mode: number): Promise<void> => {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try {
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const regularFileHash = async (filePath: string): Promise<string | null> => {
  const stat = await safeLstat(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  const bytes = await readRegularFile(filePath);
  return bytes ? sha256(bytes) : null;
};

const removeOwnedFile = async (root: string, relativePath: string): Promise<boolean> => {
  const filePath = resolveSafeMirrorPath(root, relativePath);
  if (!filePath) return false;
  const stat = await safeLstat(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
  await unlink(filePath);
  return true;
};

const allocatePath = async (
  root: string,
  note: MirrorNote,
  owners: Map<string, string>,
): Promise<string> => {
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidate = candidateFileName(note, attempt);
    const owner = owners.get(candidate);
    if (owner && owner !== note.id) continue;

    const candidatePath = resolveSafeMirrorPath(root, candidate);
    if (!candidatePath) continue;
    const stat = await safeLstat(candidatePath);
    if (!stat) return candidate;
    if (owner === note.id && stat.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  throw new Error(`Could not allocate a collision-safe path for note ${note.id}`);
};

export async function materializeMirror(
  rootDirectory: string,
  notes: readonly MirrorNote[],
  options: MaterializeMirrorOptions = {},
): Promise<MaterializeResult> {
  const root = await createRoot(rootDirectory);
  await ensureStateDirectory(root);
  const manifest = await readMirrorManifest(root);
  const owners = new Map(Object.entries(manifest.notes).map(([noteId, entry]) => [entry.path, noteId]));
  const writtenPaths: string[] = [];
  const removedPaths: string[] = [];
  const protectedPaths = new Set<string>();

  // The manifest hash is the last value written by the projection. Any
  // divergence (including a missing or replaced path) is an unsynced local
  // change unless the scan in this same serialized operation acknowledged it.
  for (const note of notes.filter((candidate) => candidate.deleted).sort((left, right) => left.id.localeCompare(right.id))) {
    const entry = manifest.notes[note.id];
    if (!entry) continue;
    const diskHash = await regularFileHash(path.join(root, entry.path));
    if (
      diskHash !== entry.hash
      && !options.acknowledgedDeletionNoteIds?.has(note.id)
    ) {
      protectedPaths.add(entry.path);
      continue;
    }
    if (await removeOwnedFile(root, entry.path)) removedPaths.push(entry.path);
    owners.delete(entry.path);
    delete manifest.notes[note.id];
  }

  for (const note of notes.filter((candidate) => !candidate.deleted).sort((left, right) => left.id.localeCompare(right.id))) {
    if (!note.id || !note.notebookId) throw new Error('Mirror notes require stable note and notebook IDs');
    const previous = manifest.notes[note.id];
    if (previous && !options.acknowledgedUpsertNoteIds?.has(note.id)) {
      const previousDiskHash = await regularFileHash(path.join(root, previous.path));
      if (previousDiskHash !== previous.hash) {
        protectedPaths.add(previous.path);
        continue;
      }
    }
    const preferredPath = options.preferredPaths?.[note.id];
    let relativePath: string | undefined;
    if (preferredPath && isSafeFlatMarkdownPath(preferredPath)) {
      const preferredOwner = owners.get(preferredPath);
      const preferredDestination = resolveSafeMirrorPath(root, preferredPath);
      const preferredStat = preferredDestination ? await safeLstat(preferredDestination) : null;
      if (
        (!preferredOwner || preferredOwner === note.id)
        && preferredStat?.isFile()
        && !preferredStat.isSymbolicLink()
      ) {
        relativePath = preferredPath;
      }
    }
    relativePath ??= await allocatePath(root, note, owners);
    const destination = resolveSafeMirrorPath(root, relativePath);
    if (!destination) throw new Error(`Unsafe mirror path: ${relativePath}`);

    const serialized = serializeMirrorNote(note);
    const hash = sha256(serialized);
    const diskHash = await regularFileHash(destination);
    if (diskHash !== hash) {
      await atomicWriteUtf8(destination, serialized, 0o644);
      writtenPaths.push(relativePath);
    }

    if (previous && previous.path !== relativePath) {
      if (await removeOwnedFile(root, previous.path)) removedPaths.push(previous.path);
      owners.delete(previous.path);
    }
    owners.set(relativePath, note.id);
    manifest.notes[note.id] = { path: relativePath, hash };
  }

  const normalizedManifest = orderedManifest(manifest);
  const manifestJson = `${JSON.stringify(normalizedManifest, null, 2)}\n`;
  const manifestDestination = manifestPath(root);
  let existingManifest = '';
  const existingManifestStat = await safeLstat(manifestDestination);
  if (existingManifestStat?.isSymbolicLink()) throw new Error('Refusing to replace a symlinked mirror manifest');
  if (existingManifestStat?.isFile()) {
    const bytes = await readRegularFile(manifestDestination);
    if (bytes) existingManifest = utf8Decoder.decode(bytes);
  }
  if (existingManifest !== manifestJson) await atomicWriteUtf8(manifestDestination, manifestJson, 0o600);

  return {
    writtenPaths,
    removedPaths,
    protectedPaths: Array.from(protectedPaths).sort(),
    manifest: normalizedManifest,
  };
}

export async function scanMirror(
  rootDirectory: string,
  notebookId: string,
  options: ScanMirrorOptions = {},
): Promise<ScanMirrorResult> {
  const root = await existingRoot(rootDirectory);
  if (!root) return { upserts: [], deletedNoteIds: [], ignoredPaths: [], preferredPaths: {} };

  const manifest = await readMirrorManifest(root);
  const ownerByPath = new Map(Object.entries(manifest.notes).map(([noteId, entry]) => [entry.path, noteId]));
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;
  const upserts: MirrorNote[] = [];
  const ignoredPaths: string[] = [];
  const preferredPaths: Record<string, string> = {};
  const presentManifestPaths = new Set<string>();
  const seenNoteIds = new Set<string>();

  const entries = await readdir(root, { withFileTypes: true });
  const entryNames = new Set(entries.map((entry) => entry.name));
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || path.extname(entry.name) !== '.md') continue;
    const ownerId = ownerByPath.get(entry.name);
    if (ownerId) presentManifestPaths.add(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !isSafeFlatMarkdownPath(entry.name)) {
      ignoredPaths.push(entry.name);
      continue;
    }

    const filePath = resolveSafeMirrorPath(root, entry.name);
    if (!filePath) {
      ignoredPaths.push(entry.name);
      continue;
    }
    const stat = await safeLstat(filePath);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      ignoredPaths.push(entry.name);
      continue;
    }

    let bytes: Buffer;
    let source: string;
    try {
      const safeBytes = await readRegularFile(filePath);
      if (!safeBytes) {
        ignoredPaths.push(entry.name);
        continue;
      }
      bytes = safeBytes;
      source = utf8Decoder.decode(bytes);
    } catch {
      ignoredPaths.push(entry.name);
      continue;
    }
    const hash = sha256(bytes);
    if (ownerId) {
      const ownerEntry = manifest.notes[ownerId];
      if (ownerEntry?.hash === hash) {
        seenNoteIds.add(ownerId);
        continue;
      }
    }

    let parsed: MirrorNote;
    try {
      parsed = parseMirrorNote(source, {
        notebookId,
        noteId: ownerId ?? createId(),
        fileName: entry.name,
        createdAt: stat.birthtimeMs || stat.mtimeMs || now(),
        updatedAt: stat.mtimeMs || now(),
      });
    } catch {
      ignoredPaths.push(entry.name);
      continue;
    }
    if (parsed.notebookId !== notebookId) {
      ignoredPaths.push(entry.name);
      continue;
    }

    const previous = manifest.notes[parsed.id];
    if (!ownerId && previous && entryNames.has(previous.path)) {
      // A copied canonical file must not steal an existing note merely because
      // its filename sorts before the manifest-owned path. Manual renames are
      // still adopted when the previous path is actually absent.
      ignoredPaths.push(entry.name);
      continue;
    }
    if (seenNoteIds.has(parsed.id)) {
      ignoredPaths.push(entry.name);
      continue;
    }

    seenNoteIds.add(parsed.id);
    if (previous?.path === entry.name && previous.hash === hash) continue;
    if (!ownerId) preferredPaths[parsed.id] = entry.name;
    if (previous) parsed.updatedAt = Math.max(parsed.updatedAt + 1, now());
    upserts.push(parsed);
  }

  const deletedNoteIds = Object.entries(manifest.notes)
    .filter(([noteId, entry]) => !seenNoteIds.has(noteId) && !presentManifestPaths.has(entry.path))
    .map(([noteId]) => noteId)
    .sort();

  return {
    upserts: upserts.sort((left, right) => left.id.localeCompare(right.id)),
    deletedNoteIds,
    ignoredPaths: ignoredPaths.sort(),
    preferredPaths: Object.fromEntries(Object.entries(preferredPaths).sort(([left], [right]) => left.localeCompare(right))),
  };
}
