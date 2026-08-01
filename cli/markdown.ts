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

export const MIRROR_SCHEMA = 2;
const LEGACY_MIRROR_SCHEMA = 1;
export const MIRROR_STATE_DIRECTORY = '.stormdance';
export const MIRROR_MANIFEST_FILE = 'manifest.json';

const METADATA_PREFIX = '<!-- stormdance:';
const METADATA_SUFFIX = ' -->';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MARKDOWN_BYTES = 32 * 1024 * 1024;
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
  folders: Record<string, string>;
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
  /** Exact path/hash observations carried from scan through materialization. */
  witnesses?: Readonly<Record<string, ScanWitness>>;
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
  witnesses: Record<string, ScanWitness>;
}

export interface ScanWitness {
  path: string;
  /** `null` means the manifest-owned path was observed absent. */
  hash: string | null;
}

interface MirrorMetadata {
  schema: number;
  notebookId: string;
  noteId: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
}

const emptyManifest = (): MirrorManifest => ({ schema: MIRROR_SCHEMA, notes: {}, folders: {} });

const isErrno = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === code;

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const isSafePathComponent = (component: string): boolean =>
  component.length > 0
  && component !== '.'
  && component !== '..'
  && !component.startsWith('.')
  && !component.endsWith(' ')
  && !component.endsWith('.')
  && !Array.from(component).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)
  && !/[<>:"|?*]/u.test(component)
  && !WINDOWS_DEVICE_NAME.test(component);

const pathComponents = (relativePath: string): string[] | null => {
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    return null;
  }
  const components = relativePath.split('/');
  return components.every(isSafePathComponent) ? components : null;
};

const isSafeRelativeDirectory = (relativePath: string): boolean =>
  relativePath === '' || pathComponents(relativePath) !== null;

const isSafeMarkdownPath = (relativePath: string): boolean => {
  const components = pathComponents(relativePath);
  if (!components) return false;
  return path.posix.extname(components.at(-1) ?? '').toLowerCase() === '.md';
};

const resolveSafeMirrorPath = (root: string, relativePath: string): string | null => {
  const components = pathComponents(relativePath);
  if (!components || !isSafeMarkdownPath(relativePath)) return null;
  const resolved = path.resolve(root, ...components);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    ? resolved
    : null;
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
  if (metadata.schema !== LEGACY_MIRROR_SCHEMA && metadata.schema !== MIRROR_SCHEMA) {
    throw new Error('Unsupported storm.dance metadata schema');
  }
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

interface LocatedMetadata {
  metadata: MirrorMetadata;
  start: number;
  end: number;
}

/**
 * Metadata lives before the first H1, but may follow user YAML frontmatter.
 * Ignore marker-like text inside fenced code blocks so ordinary Markdown stays
 * lossless and portable between the Node and Rust mirrors.
 */
const locateMetadata = (source: string): LocatedMetadata | null => {
  let offset = 0;
  let fence: '`' | '~' | null = null;
  for (const line of source.match(/.*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    const clean = line.replace(/[\r\n]+$/u, '');
    const trimmed = clean.trimStart();
    if (trimmed.startsWith('```')) fence = fence === '`' ? null : fence ?? '`';
    else if (trimmed.startsWith('~~~')) fence = fence === '~' ? null : fence ?? '~';

    if (fence === null && clean.startsWith('# ')) break;
    if (fence === null && clean.startsWith(METADATA_PREFIX)) {
      return {
        metadata: parseMetadataLine(clean),
        start: offset,
        end: offset + line.length,
      };
    }
    offset += line.length;
    if (offset > 128 * 1024) break;
  }
  return null;
};

const normalizedTitle = (title: string): string => {
  const oneLine = title.replace(/[\r\n\0]+/g, ' ').trim();
  return oneLine || 'Untitled';
};

const titleFromFileName = (fileName: string): string => {
  const baseName = path.basename(fileName, path.extname(fileName));
  const withoutStableSuffix = baseName.replace(/--[a-z0-9]{12}$/i, '');
  return normalizedTitle(withoutStableSuffix.replace(/[-_]+/g, ' '));
};

interface MarkdownHeading {
  start: number;
  end: number;
  title: string;
}

const findUserTitleHeading = (source: string): MarkdownHeading | null => {
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  let offset = 0;
  let inFrontmatter = lines[0]?.replace(/[\r\n]+$/u, '') === '---';
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const clean = line.replace(/[\r\n]+$/u, '');
    if (inFrontmatter) {
      offset += line.length;
      if (index > 0 && (clean === '---' || clean === '...')) inFrontmatter = false;
      continue;
    }

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(clean);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
      offset += line.length;
      continue;
    }

    if (!fence && clean.startsWith('# ')) {
      return {
        start: offset,
        end: offset + line.length,
        title: clean.slice(2),
      };
    }
    offset += line.length;
  }
  return null;
};

const parseUserMarkdown = (source: string, fileName = 'Untitled.md'): { title: string; content: string } => {
  const heading = findUserTitleHeading(source);
  if (!heading) {
    return { title: titleFromFileName(fileName), content: source };
  }

  let suffix = source.slice(heading.end);
  if (suffix.startsWith('\r\n')) suffix = suffix.slice(2);
  else if (suffix.startsWith('\n')) suffix = suffix.slice(1);

  return {
    title: normalizedTitle(heading.title),
    content: `${source.slice(0, heading.start)}${suffix}`,
  };
};

const splitFrontmatter = (content: string): { frontmatter: string; rest: string } | null => {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;
  let offset = 0;
  const lines = content.match(/.*(?:\n|$)/g) ?? [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    offset += line.length;
    if (index > 0 && ['---', '...'].includes(line.replace(/[\r\n]+$/u, ''))) {
      return { frontmatter: content.slice(0, offset), rest: content.slice(offset) };
    }
  }
  return null;
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
  const marker = `${METADATA_PREFIX}${safeMetadataJson}${METADATA_SUFFIX}\n`;
  const frontmatter = splitFrontmatter(note.content);
  if (frontmatter) {
    return `${frontmatter.frontmatter}${marker}# ${normalizedTitle(note.title)}\n\n${frontmatter.rest.replace(/^[\r\n]+/u, '')}`;
  }
  return `${marker}# ${normalizedTitle(note.title)}\n\n${note.content}`;
}

export function parseMirrorNote(source: string, options: ParseMirrorNoteOptions = {}): MirrorNote {
  const located = locateMetadata(source);
  if (located) {
    const { metadata } = located;
    const withoutMetadata = `${source.slice(0, located.start)}${source.slice(located.end)}`;
    const parsed = parseUserMarkdown(withoutMetadata, options.fileName);
    const parent = options.fileName ? path.posix.dirname(options.fileName) : '.';
    const inferredFolder = parent !== '.' ? `obsidian:path:${parent}` : null;
    return {
      id: metadata.noteId,
      notebookId: metadata.notebookId,
      folderId: metadata.folderId ?? inferredFolder,
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
  const parent = path.posix.dirname(options.fileName);
  return {
    id: options.noteId ?? randomUUID(),
    notebookId: options.notebookId,
    folderId: parent === '.' ? null : `obsidian:path:${parent}`,
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

const readRegularFile = async (
  filePath: string,
  maximumBytes = MAX_MARKDOWN_BYTES,
): Promise<Buffer | null> => {
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
    if (stat.size > maximumBytes) throw new Error('A storm.dance mirror file is too large');
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) throw new Error('A storm.dance mirror file is too large');
    return bytes;
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
  if (
    (object.schema !== LEGACY_MIRROR_SCHEMA && object.schema !== MIRROR_SCHEMA)
    || !object.notes
    || typeof object.notes !== 'object'
    || Array.isArray(object.notes)
  ) {
    return emptyManifest();
  }

  const notes: Record<string, MirrorManifestEntry> = {};
  const claimedPaths = new Set<string>();
  for (const [noteId, entryValue] of Object.entries(object.notes as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isNonEmptyString(noteId) || !entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) continue;
    const entry = entryValue as Record<string, unknown>;
    if (typeof entry.path !== 'string' || typeof entry.hash !== 'string') continue;
    if (!isSafeMarkdownPath(entry.path) || !HASH_PATTERN.test(entry.hash) || claimedPaths.has(entry.path)) continue;
    notes[noteId] = { path: entry.path, hash: entry.hash };
    claimedPaths.add(entry.path);
  }
  const folders: Record<string, string> = {};
  if (object.folders && typeof object.folders === 'object' && !Array.isArray(object.folders)) {
    for (const [folderId, folderPath] of Object.entries(object.folders as Record<string, unknown>)) {
      if (isNonEmptyString(folderId) && typeof folderPath === 'string' && isSafeRelativeDirectory(folderPath)) {
        folders[folderId] = folderPath;
      }
    }
  }
  return { schema: MIRROR_SCHEMA, notes, folders };
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
    const bytes = await readRegularFile(file, MAX_MANIFEST_BYTES);
    return bytes ? parseManifest(utf8Decoder.decode(bytes)) : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

const orderedManifest = (manifest: MirrorManifest): MirrorManifest => ({
  schema: MIRROR_SCHEMA,
  notes: Object.fromEntries(Object.entries(manifest.notes).sort(([left], [right]) => left.localeCompare(right))),
  folders: Object.fromEntries(Object.entries(manifest.folders).sort(([left], [right]) => left.localeCompare(right))),
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

const ensureSafeParent = async (root: string, relativePath: string): Promise<void> => {
  const components = pathComponents(relativePath);
  if (!components || !isSafeMarkdownPath(relativePath)) {
    throw new Error(`Unsafe mirror path: ${relativePath}`);
  }
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    const existing = await safeLstat(current);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`Unsafe mirror parent: ${relativePath}`);
      }
    } else {
      await mkdir(current);
    }
  }
  const canonicalParent = await realpath(path.dirname(path.join(root, ...components)));
  const relativeParent = path.relative(root, canonicalParent);
  if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw new Error(`Unsafe mirror parent: ${relativePath}`);
  }
};

const validateExistingParent = async (root: string, relativePath: string): Promise<boolean> => {
  const components = pathComponents(relativePath);
  if (!components || !isSafeMarkdownPath(relativePath)) {
    throw new Error(`Unsafe mirror path: ${relativePath}`);
  }
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    const existing = await safeLstat(current);
    if (!existing) return false;
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Unsafe mirror parent: ${relativePath}`);
    }
  }
  const canonicalParent = await realpath(path.dirname(path.join(root, ...components)));
  const relativeParent = path.relative(root, canonicalParent);
  if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw new Error(`Unsafe mirror parent: ${relativePath}`);
  }
  return true;
};

const regularFileHash = async (filePath: string): Promise<string | null> => {
  const stat = await safeLstat(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  const bytes = await readRegularFile(filePath);
  return bytes ? sha256(bytes) : null;
};

const witnessMatches = async (
  root: string,
  witness: ScanWitness,
): Promise<boolean> => {
  const filePath = resolveSafeMirrorPath(root, witness.path);
  if (!filePath) return false;
  try {
    const parentExists = await validateExistingParent(root, witness.path);
    if (!parentExists) return witness.hash === null;
    return await regularFileHash(filePath) === witness.hash;
  } catch {
    return false;
  }
};

const removeOwnedFile = async (root: string, relativePath: string): Promise<boolean> => {
  const filePath = resolveSafeMirrorPath(root, relativePath);
  if (!filePath) return false;
  if (!await validateExistingParent(root, relativePath)) return false;
  const stat = await safeLstat(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
  await unlink(filePath);
  return true;
};

const allocatePath = async (
  root: string,
  note: MirrorNote,
  manifest: MirrorManifest,
  owners: Map<string, string>,
): Promise<string> => {
  const directory = note.folderId ? manifest.folders[note.folderId] ?? '' : '';
  if (!isSafeRelativeDirectory(directory)) throw new Error(`Unsafe mirror directory: ${directory}`);
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const fileName = candidateFileName(note, attempt);
    const candidate = directory ? `${directory}/${fileName}` : fileName;
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
    const witness = options.witnesses?.[note.id];
    const witnessedDeletion = witness?.path === entry.path
      && witness.hash === null
      && await witnessMatches(root, witness);
    const ownedPath = resolveSafeMirrorPath(root, entry.path);
    let diskHash: string | null;
    try {
      diskHash = ownedPath && await validateExistingParent(root, entry.path)
        ? await regularFileHash(ownedPath)
        : null;
    } catch {
      protectedPaths.add(entry.path);
      continue;
    }
    if (
      diskHash !== entry.hash
      && !witnessedDeletion
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
    const witness = options.witnesses?.[note.id];
    const currentWitness = witness && await witnessMatches(root, witness) ? witness : undefined;
    if (previous && !options.acknowledgedUpsertNoteIds?.has(note.id)) {
      const previousPath = resolveSafeMirrorPath(root, previous.path);
      let previousDiskHash: string | null;
      try {
        previousDiskHash = previousPath && await validateExistingParent(root, previous.path)
          ? await regularFileHash(previousPath)
          : null;
      } catch {
        protectedPaths.add(previous.path);
        continue;
      }
      const witnessedPrevious = currentWitness !== undefined
        && (
          (currentWitness.path === previous.path && currentWitness.hash === previousDiskHash)
          || (currentWitness.path !== previous.path && previousDiskHash === null)
        );
      if (previousDiskHash !== previous.hash && !witnessedPrevious) {
        protectedPaths.add(previous.path);
        continue;
      }
    }
    const preferredPath = options.preferredPaths?.[note.id];
    let relativePath: string | undefined;
    if (preferredPath && isSafeMarkdownPath(preferredPath)) {
      const preferredOwner = owners.get(preferredPath);
      const preferredDestination = resolveSafeMirrorPath(root, preferredPath);
      const preferredStat = preferredDestination ? await safeLstat(preferredDestination) : null;
      if (
        (!preferredOwner || preferredOwner === note.id)
        && preferredStat?.isFile()
        && !preferredStat.isSymbolicLink()
        && (
          options.witnesses === undefined
          || (currentWitness?.path === preferredPath && currentWitness.hash !== null)
        )
      ) {
        relativePath = preferredPath;
      }
    }
    relativePath ??= previous?.path;
    relativePath ??= await allocatePath(root, note, manifest, owners);
    const destination = resolveSafeMirrorPath(root, relativePath);
    if (!destination) throw new Error(`Unsafe mirror path: ${relativePath}`);
    await ensureSafeParent(root, relativePath);

    const serialized = serializeMirrorNote(note);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MARKDOWN_BYTES) {
      throw new Error(`Markdown note ${note.id} exceeds the mirror size limit`);
    }
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
    if (note.folderId) {
      const parent = path.posix.dirname(relativePath);
      manifest.folders[note.folderId] = parent === '.' ? '' : parent;
    }
    manifest.notes[note.id] = { path: relativePath, hash };
  }

  const normalizedManifest = orderedManifest(manifest);
  const manifestJson = `${JSON.stringify(normalizedManifest, null, 2)}\n`;
  const manifestDestination = manifestPath(root);
  let existingManifest = '';
  const existingManifestStat = await safeLstat(manifestDestination);
  if (existingManifestStat?.isSymbolicLink()) throw new Error('Refusing to replace a symlinked mirror manifest');
  if (existingManifestStat?.isFile()) {
    const bytes = await readRegularFile(manifestDestination, MAX_MANIFEST_BYTES);
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

interface MarkdownWalk {
  paths: string[];
  ignoredPaths: string[];
}

const collectMarkdownPaths = async (root: string): Promise<MarkdownWalk> => {
  const paths: string[] = [];
  const ignoredPaths: string[] = [];

  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      if (prefix) ignoredPaths.push(prefix);
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) {
        ignoredPaths.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        if (isSafeRelativeDirectory(relativePath)) {
          await visit(path.join(directory, entry.name), relativePath);
        } else {
          ignoredPaths.push(relativePath);
        }
        continue;
      }
      if (path.posix.extname(relativePath).toLowerCase() !== '.md') continue;
      if (entry.isFile() && isSafeMarkdownPath(relativePath)) paths.push(relativePath);
      else ignoredPaths.push(relativePath);
    }
  };

  await visit(root, '');
  return { paths: paths.sort(), ignoredPaths: ignoredPaths.sort() };
};

export async function scanMirror(
  rootDirectory: string,
  notebookId: string,
  options: ScanMirrorOptions = {},
): Promise<ScanMirrorResult> {
  const root = await existingRoot(rootDirectory);
  if (!root) return {
    upserts: [],
    deletedNoteIds: [],
    ignoredPaths: [],
    preferredPaths: {},
    witnesses: {},
  };

  const manifest = await readMirrorManifest(root);
  const ownerByPath = new Map(Object.entries(manifest.notes).map(([noteId, entry]) => [entry.path, noteId]));
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;
  const upserts: MirrorNote[] = [];
  const walk = await collectMarkdownPaths(root);
  const ignoredPaths = [...walk.ignoredPaths];
  const preferredPaths: Record<string, string> = {};
  const witnesses: Record<string, ScanWitness> = {};
  const presentManifestPaths = new Set<string>();
  const seenNoteIds = new Set<string>();

  const presentPaths = new Set(walk.paths);
  for (const ignoredPath of walk.ignoredPaths) {
    for (const manifestPath of ownerByPath.keys()) {
      if (manifestPath === ignoredPath || manifestPath.startsWith(`${ignoredPath}/`)) {
        presentManifestPaths.add(manifestPath);
      }
    }
  }
  for (const relativePath of walk.paths) {
    const ownerId = ownerByPath.get(relativePath);
    if (ownerId) presentManifestPaths.add(relativePath);
    const filePath = resolveSafeMirrorPath(root, relativePath);
    if (!filePath) {
      ignoredPaths.push(relativePath);
      continue;
    }
    const stat = await safeLstat(filePath);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      ignoredPaths.push(relativePath);
      continue;
    }

    let bytes: Buffer;
    let source: string;
    try {
      const safeBytes = await readRegularFile(filePath);
      if (!safeBytes) {
        ignoredPaths.push(relativePath);
        continue;
      }
      bytes = safeBytes;
      source = utf8Decoder.decode(bytes);
    } catch {
      ignoredPaths.push(relativePath);
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
        fileName: relativePath,
        createdAt: stat.birthtimeMs || stat.mtimeMs || now(),
        updatedAt: stat.mtimeMs || now(),
      });
    } catch {
      ignoredPaths.push(relativePath);
      continue;
    }
    if (parsed.notebookId !== notebookId) {
      ignoredPaths.push(relativePath);
      continue;
    }

    const previous = manifest.notes[parsed.id];
    if (!ownerId && previous && presentPaths.has(previous.path)) {
      // A copied canonical file must not steal an existing note merely because
      // its filename sorts before the manifest-owned path. Manual renames are
      // still adopted when the previous path is actually absent.
      ignoredPaths.push(relativePath);
      continue;
    }
    if (seenNoteIds.has(parsed.id)) {
      ignoredPaths.push(relativePath);
      continue;
    }

    seenNoteIds.add(parsed.id);
    if (previous?.path === relativePath && previous.hash === hash) continue;
    if (!ownerId) preferredPaths[parsed.id] = relativePath;
    if (previous) parsed.updatedAt = Math.max(parsed.updatedAt + 1, now());
    witnesses[parsed.id] = { path: relativePath, hash };
    upserts.push(parsed);
  }

  const deletedNoteIds = Object.entries(manifest.notes)
    .filter(([noteId, entry]) => !seenNoteIds.has(noteId) && !presentManifestPaths.has(entry.path))
    .map(([noteId]) => noteId)
    .sort();
  for (const noteId of deletedNoteIds) {
    witnesses[noteId] = { path: manifest.notes[noteId].path, hash: null };
  }

  return {
    upserts: upserts.sort((left, right) => left.id.localeCompare(right.id)),
    deletedNoteIds,
    ignoredPaths: ignoredPaths.sort(),
    preferredPaths: Object.fromEntries(Object.entries(preferredPaths).sort(([left], [right]) => left.localeCompare(right))),
    witnesses: Object.fromEntries(Object.entries(witnesses).sort(([left], [right]) => left.localeCompare(right))),
  };
}

/**
 * Recheck scan observations immediately before mutating the CRDT. A stale
 * observation is left on disk for the next watch cycle instead of being sent
 * as if it were the editor's latest save.
 */
export async function revalidateScanMirror(
  rootDirectory: string,
  scanned: ScanMirrorResult,
): Promise<ScanMirrorResult> {
  const root = await existingRoot(rootDirectory);
  if (!root) {
    return {
      upserts: [],
      deletedNoteIds: [],
      ignoredPaths: Array.from(new Set([
        ...scanned.ignoredPaths,
        ...Object.values(scanned.witnesses).map((witness) => witness.path),
      ])).sort(),
      preferredPaths: {},
      witnesses: {},
    };
  }

  const validIds = new Set<string>();
  for (const [noteId, witness] of Object.entries(scanned.witnesses)) {
    if (await witnessMatches(root, witness)) validIds.add(noteId);
  }
  const stalePaths = Object.entries(scanned.witnesses)
    .filter(([noteId]) => !validIds.has(noteId))
    .map(([, witness]) => witness.path);

  return {
    upserts: scanned.upserts.filter((note) => validIds.has(note.id)),
    deletedNoteIds: scanned.deletedNoteIds.filter((noteId) => validIds.has(noteId)),
    ignoredPaths: Array.from(new Set([...scanned.ignoredPaths, ...stalePaths])).sort(),
    preferredPaths: Object.fromEntries(
      Object.entries(scanned.preferredPaths).filter(([noteId]) => validIds.has(noteId)),
    ),
    witnesses: Object.fromEntries(
      Object.entries(scanned.witnesses).filter(([noteId]) => validIds.has(noteId)),
    ),
  };
}
