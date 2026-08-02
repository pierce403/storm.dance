import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const MIRROR_SCHEMA = 2;
const LEGACY_MIRROR_SCHEMA = 1;
export const MIRROR_STATE_DIRECTORY = '.stormdance';
export const MIRROR_MANIFEST_FILE = 'manifest.json';

/**
 * Stable IDs for folders first discovered through a linked filesystem vault.
 * Each component is percent encoded, so the `:` delimiter is unambiguous and
 * the same Obsidian path in two notebooks cannot collide in IndexedDB/Yjs.
 * Existing IDs from note metadata or the manifest always take precedence.
 */
export const obsidianPathFolderId = (notebookId: string, relativePath: string): string => (
  `obsidian:path:${encodeURIComponent(notebookId)}:${encodeURIComponent(relativePath)}`
);

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

export interface MirrorFolder {
  id: string;
  notebookId: string;
  name: string;
  parentFolderId: string | null;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
  deletedAt?: number | null;
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
  createdDirectories: string[];
  removedDirectories: string[];
  manifest: MirrorManifest;
}

export interface MaterializeMirrorOptions {
  /** Authoritative folder entities from the shared CRDT projection. */
  folders?: readonly MirrorFolder[];
  /** Safe, root-relative paths discovered by scanMirror that should be adopted in place. */
  preferredPaths?: Readonly<Record<string, string>>;
  /** Safe directory paths discovered by scanMirror that should retain their folder IDs. */
  preferredFolderPaths?: Readonly<Record<string, string>>;
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
  /** Current CRDT folders, used to avoid emitting unchanged directory updates. */
  knownFolders?: readonly MirrorFolder[];
}

export interface ScanMirrorResult {
  upserts: MirrorNote[];
  deletedNoteIds: string[];
  upsertFolders: MirrorFolder[];
  deletedFolderIds: string[];
  ignoredPaths: string[];
  preferredPaths: Record<string, string>;
  preferredFolderPaths: Record<string, string>;
  witnesses: Record<string, ScanWitness>;
  folderWitnesses: Record<string, ScanFolderWitness>;
}

export interface ScanWitness {
  path: string;
  /** `null` means the manifest-owned path was observed absent. */
  hash: string | null;
}

export interface ScanFolderWitness {
  path: string;
  present: boolean;
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
    const inferredFolder = parent !== '.'
      ? obsidianPathFolderId(metadata.notebookId, parent)
      : null;
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
    folderId: parent === '.' ? null : obsidianPathFolderId(options.notebookId, parent),
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

const resolveSafeMirrorDirectory = (root: string, relativePath: string): string | null => {
  if (!relativePath || !isSafeRelativeDirectory(relativePath)) return null;
  const components = pathComponents(relativePath);
  if (!components) return null;
  const resolved = path.resolve(root, ...components);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    ? resolved
    : null;
};

const ensureSafeDirectory = async (root: string, relativePath: string): Promise<boolean> => {
  const components = pathComponents(relativePath);
  if (!components) throw new Error(`Unsafe mirror directory: ${relativePath}`);
  let current = root;
  let created = false;
  for (const component of components) {
    current = path.join(current, component);
    const existing = await safeLstat(current);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`Unsafe mirror directory: ${relativePath}`);
      }
      continue;
    }
    await mkdir(current);
    created = true;
  }
  const canonical = await realpath(path.join(root, ...components));
  const relative = path.relative(root, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe mirror directory: ${relativePath}`);
  }
  return created;
};

const removeEmptyOwnedDirectory = async (root: string, relativePath: string): Promise<boolean> => {
  const destination = resolveSafeMirrorDirectory(root, relativePath);
  if (!destination) return false;
  const existing = await safeLstat(destination);
  if (!existing || existing.isSymbolicLink() || !existing.isDirectory()) return false;
  if ((await readdir(destination)).length > 0) return false;
  try {
    await rmdir(destination);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTEMPTY')) return false;
    throw error;
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

const folderWitnessMatches = async (
  root: string,
  witness: ScanFolderWitness,
): Promise<boolean> => {
  const destination = resolveSafeMirrorDirectory(root, witness.path);
  if (!destination) return false;
  const existing = await safeLstat(destination);
  if (!witness.present) return existing === null;
  return Boolean(existing?.isDirectory() && !existing.isSymbolicLink());
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

export function sanitizeMirrorFolderName(name: string): string {
  const value = Array.from(name)
    .map((character) => (
      (character.codePointAt(0) ?? 0) <= 0x1f || '<>:"/\\|?*'.includes(character)
        ? '-'
        : character
    ))
    .join('')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .replace(/[ .]+$/u, '')
    .slice(0, 96)
    .replace(/[ .]+$/u, '');
  const fallback = value && value !== '.' && value !== '..' ? value : 'Untitled';
  const safe = fallback.startsWith('.') || WINDOWS_DEVICE_NAME.test(fallback)
    ? `_${fallback.replace(/^\.+/u, '') || 'Untitled'}`
    : fallback;
  return isSafePathComponent(safe) ? safe : 'Untitled';
}

const parentDirectory = (relativePath: string): string => {
  const parent = path.posix.dirname(relativePath);
  return parent === '.' ? '' : parent;
};

const joinRelative = (directory: string, name: string): string => (
  directory ? `${directory}/${name}` : name
);

const allocateFolderPath = async (
  root: string,
  parent: string,
  name: string,
  folderId: string,
  claims: Map<string, string>,
  preferred?: string,
): Promise<string> => {
  const safeName = sanitizeMirrorFolderName(name);
  const candidates: string[] = [];
  if (
    preferred
    && isSafeRelativeDirectory(preferred)
    && parentDirectory(preferred) === parent
    && path.posix.basename(preferred) === safeName
  ) {
    candidates.push(preferred);
  }
  candidates.push(joinRelative(parent, safeName));
  for (let attempt = 2; attempt < 10_000; attempt += 1) {
    candidates.push(joinRelative(parent, `${safeName} ${attempt}`));
  }

  for (const candidate of candidates) {
    const claimedBy = claims.get(candidate);
    if (claimedBy && claimedBy !== folderId) continue;
    const destination = resolveSafeMirrorDirectory(root, candidate);
    if (!destination) continue;
    const existing = await safeLstat(destination);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) continue;
    claims.set(candidate, folderId);
    return candidate;
  }
  throw new Error(`Could not allocate a collision-safe directory for folder ${folderId}`);
};

const resolveFolderPaths = async (
  root: string,
  folders: readonly MirrorFolder[],
  manifest: MirrorManifest,
  preferredPaths: Readonly<Record<string, string>> | undefined,
): Promise<Map<string, string>> => {
  const live = new Map(
    folders
      .filter((folder) => !folder.deleted)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((folder) => [folder.id, folder] as const),
  );
  const resolved = new Map<string, string>();
  const claims = new Map<string, string>();
  const resolving = new Set<string>();

  const resolve = async (folderId: string): Promise<string> => {
    const existing = resolved.get(folderId);
    if (existing !== undefined) return existing;
    const folder = live.get(folderId);
    if (!folder) return '';

    // Concurrent parent moves can form a cycle. Detach the recursion edge
    // deterministically in the projection instead of ever creating a path loop.
    if (resolving.has(folderId)) return '';
    resolving.add(folderId);
    const parent = folder.parentFolderId && live.has(folder.parentFolderId)
      ? await resolve(folder.parentFolderId)
      : '';
    const pathForFolder = await allocateFolderPath(
      root,
      parent,
      folder.name,
      folderId,
      claims,
      preferredPaths?.[folderId] ?? manifest.folders[folderId],
    );
    resolving.delete(folderId);
    resolved.set(folderId, pathForFolder);
    return pathForFolder;
  };

  for (const folderId of live.keys()) await resolve(folderId);
  return resolved;
};

const allocateRelocatedNotePath = async (
  root: string,
  note: MirrorNote,
  directory: string,
  previousPath: string,
  owners: Map<string, string>,
  manifest: MirrorManifest,
): Promise<string> => {
  const basename = path.posix.basename(previousPath);
  const direct = joinRelative(directory, basename);
  const directOwner = owners.get(direct);
  const directDestination = resolveSafeMirrorPath(root, direct);
  const directStat = directDestination ? await safeLstat(directDestination) : null;
  if (
    directDestination
    && (!directOwner || directOwner === note.id)
    && (!directStat || (directOwner === note.id && directStat.isFile() && !directStat.isSymbolicLink()))
  ) return direct;

  return allocatePath(root, note, manifest, owners);
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
  const previousFolderPaths = { ...manifest.folders };
  const owners = new Map(Object.entries(manifest.notes).map(([noteId, entry]) => [entry.path, noteId]));
  const writtenPaths: string[] = [];
  const removedPaths: string[] = [];
  const protectedPaths = new Set<string>();
  const createdDirectories: string[] = [];
  const removedDirectories: string[] = [];
  const folderPaths = options.folders
    ? await resolveFolderPaths(root, options.folders, manifest, options.preferredFolderPaths)
    : new Map<string, string>();

  if (options.folders) {
    const tombstonedFolderIds = new Set(
      options.folders.filter((folder) => folder.deleted).map((folder) => folder.id),
    );
    for (const folderId of tombstonedFolderIds) delete manifest.folders[folderId];
    for (const [folderId, folderPath] of [...folderPaths.entries()]
      .sort((left, right) => left[1].split('/').length - right[1].split('/').length
        || left[1].localeCompare(right[1]))) {
      if (await ensureSafeDirectory(root, folderPath)) createdDirectories.push(folderPath);
      manifest.folders[folderId] = folderPath;
    }
  }

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
    if (!relativePath && previous) {
      const targetDirectory = note.folderId
        ? folderPaths.get(note.folderId) ?? manifest.folders[note.folderId] ?? ''
        : '';
      relativePath = parentDirectory(previous.path) === targetDirectory
        ? previous.path
        : await allocateRelocatedNotePath(
          root,
          note,
          targetDirectory,
          previous.path,
          owners,
          manifest,
        );
    }
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

  // Folder paths are ownership hints, not permission to recursively delete.
  // Retire only real directories that became empty after owned Markdown moved.
  const retainedFolderPaths = new Set(Object.values(manifest.folders).filter(Boolean));
  const retiredFolderPaths = Array.from(new Set(Object.values(previousFolderPaths)))
    .filter((folderPath) => folderPath && !retainedFolderPaths.has(folderPath))
    .sort((left, right) => right.split('/').length - left.split('/').length
      || right.localeCompare(left));
  for (const folderPath of retiredFolderPaths) {
    if (await removeEmptyOwnedDirectory(root, folderPath)) removedDirectories.push(folderPath);
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
    createdDirectories: Array.from(new Set(createdDirectories)).sort(),
    removedDirectories: Array.from(new Set(removedDirectories)).sort(),
    manifest: normalizedManifest,
  };
}

interface MirrorWalk {
  markdownPaths: string[];
  directoryPaths: string[];
  ignoredPaths: string[];
}

const collectMirrorPaths = async (root: string): Promise<MirrorWalk> => {
  const markdownPaths: string[] = [];
  const directoryPaths: string[] = [];
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
          directoryPaths.push(relativePath);
          await visit(path.join(directory, entry.name), relativePath);
        } else {
          ignoredPaths.push(relativePath);
        }
        continue;
      }
      if (path.posix.extname(relativePath).toLowerCase() !== '.md') continue;
      if (entry.isFile() && isSafeMarkdownPath(relativePath)) markdownPaths.push(relativePath);
      else ignoredPaths.push(relativePath);
    }
  };

  await visit(root, '');
  return {
    markdownPaths: markdownPaths.sort(),
    directoryPaths: directoryPaths.sort(),
    ignoredPaths: ignoredPaths.sort(),
  };
};

interface PreparedNote {
  note: MirrorNote;
  path: string;
  ownerId: string | undefined;
  hash: string;
}

const pathIsProtectedByIgnoredEntry = (candidate: string, ignoredPaths: readonly string[]) => (
  ignoredPaths.some((ignored) => candidate === ignored || candidate.startsWith(`${ignored}/`))
);

export async function scanMirror(
  rootDirectory: string,
  notebookId: string,
  options: ScanMirrorOptions = {},
): Promise<ScanMirrorResult> {
  const root = await existingRoot(rootDirectory);
  if (!root) return {
    upserts: [],
    deletedNoteIds: [],
    upsertFolders: [],
    deletedFolderIds: [],
    ignoredPaths: [],
    preferredPaths: {},
    preferredFolderPaths: {},
    witnesses: {},
    folderWitnesses: {},
  };

  const manifest = await readMirrorManifest(root);
  const ownerByPath = new Map(Object.entries(manifest.notes).map(([noteId, entry]) => [entry.path, noteId]));
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;
  const upserts: MirrorNote[] = [];
  const walk = await collectMirrorPaths(root);
  const ignoredPaths = [...walk.ignoredPaths];
  const preferredPaths: Record<string, string> = {};
  const witnesses: Record<string, ScanWitness> = {};
  const presentManifestPaths = new Set<string>();
  const seenNoteIds = new Set<string>();
  const preparedNotes: PreparedNote[] = [];

  const presentPaths = new Set(walk.markdownPaths);
  for (const ignoredPath of walk.ignoredPaths) {
    for (const manifestPath of ownerByPath.keys()) {
      if (manifestPath === ignoredPath || manifestPath.startsWith(`${ignoredPath}/`)) {
        presentManifestPaths.add(manifestPath);
      }
    }
  }
  for (const relativePath of walk.markdownPaths) {
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
    if (previous) parsed.updatedAt = Math.max(parsed.updatedAt + 1, now());
    preparedNotes.push({ note: parsed, path: relativePath, ownerId, hash });
  }

  const directoryPaths = new Set(walk.directoryPaths);
  const folderIdByPath = new Map<string, string>();
  const pathByFolderId = new Map<string, string>();
  const manifestFolderIdByPath = new Map<string, string>();
  for (const [folderId, folderPath] of Object.entries(manifest.folders)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (!folderPath || manifestFolderIdByPath.has(folderPath)) continue;
    manifestFolderIdByPath.set(folderPath, folderId);
    if (directoryPaths.has(folderPath) && !folderIdByPath.has(folderPath)) {
      folderIdByPath.set(folderPath, folderId);
      pathByFolderId.set(folderId, folderPath);
    }
  }

  // A managed note carries its old folder ID through an ordinary directory
  // rename. Use that only when the old manifest directory is truly absent and
  // the hint occurs in exactly one new directory; the actual destination path
  // remains authoritative for a note moved into an existing folder.
  const hintedPathsByFolderId = new Map<string, Set<string>>();
  for (const prepared of preparedNotes) {
    const hint = prepared.note.folderId;
    const directory = parentDirectory(prepared.path);
    const oldPath = hint ? manifest.folders[hint] : undefined;
    if (!hint || !directory || !oldPath || directoryPaths.has(oldPath)) continue;
    const paths = hintedPathsByFolderId.get(hint) ?? new Set<string>();
    paths.add(directory);
    hintedPathsByFolderId.set(hint, paths);
  }
  for (const [folderId, hintedPaths] of [...hintedPathsByFolderId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (hintedPaths.size !== 1 || pathByFolderId.has(folderId)) continue;
    const [directory] = hintedPaths;
    if (!directoryPaths.has(directory) || folderIdByPath.has(directory)) continue;
    folderIdByPath.set(directory, folderId);
    pathByFolderId.set(folderId, directory);
  }

  // If a nested managed folder moved as a tree, a note marker identifies the
  // leaf. Recover same-depth missing ancestors positionally when unambiguous.
  for (const [folderId, newPath] of [...pathByFolderId.entries()]) {
    const oldPath = manifest.folders[folderId];
    if (!oldPath || oldPath === newPath) continue;
    const oldParts = oldPath.split('/');
    const newParts = newPath.split('/');
    if (oldParts.length !== newParts.length) continue;
    for (let index = 1; index < oldParts.length; index += 1) {
      const oldAncestor = oldParts.slice(0, index).join('/');
      const newAncestor = newParts.slice(0, index).join('/');
      const ancestorId = manifestFolderIdByPath.get(oldAncestor);
      if (
        ancestorId
        && !directoryPaths.has(oldAncestor)
        && directoryPaths.has(newAncestor)
        && !pathByFolderId.has(ancestorId)
        && !folderIdByPath.has(newAncestor)
      ) {
        folderIdByPath.set(newAncestor, ancestorId);
        pathByFolderId.set(ancestorId, newAncestor);
      }
    }
  }

  // Preserve an empty folder ID across a pure move when its basename gives a
  // unique match. A rename with no managed content is intentionally treated as
  // delete+create because the filesystem carries no stable identity marker.
  for (const directory of walk.directoryPaths) {
    if (folderIdByPath.has(directory)) continue;
    const matchingIds = Object.entries(manifest.folders)
      .filter(([folderId, oldPath]) => (
        oldPath
        && !directoryPaths.has(oldPath)
        && !pathByFolderId.has(folderId)
        && path.posix.basename(oldPath) === path.posix.basename(directory)
      ))
      .map(([folderId]) => folderId);
    if (matchingIds.length !== 1) continue;
    const folderId = matchingIds[0];
    const competingPaths = walk.directoryPaths.filter((candidate) => (
      !folderIdByPath.has(candidate)
      && path.posix.basename(candidate) === path.posix.basename(directory)
    ));
    if (competingPaths.length !== 1) continue;
    folderIdByPath.set(directory, folderId);
    pathByFolderId.set(folderId, directory);
  }

  for (const directory of walk.directoryPaths) {
    if (folderIdByPath.has(directory)) continue;
    const baseId = obsidianPathFolderId(notebookId, directory);
    let folderId = baseId;
    if (pathByFolderId.has(folderId)) folderId = `${baseId}:${stableIdFragment(directory)}`;
    folderIdByPath.set(directory, folderId);
    pathByFolderId.set(folderId, directory);
  }

  const knownFolders = new Map((options.knownFolders ?? []).map((folder) => [folder.id, folder]));
  const upsertFolders: MirrorFolder[] = [];
  const preferredFolderPaths: Record<string, string> = {};
  const folderWitnesses: Record<string, ScanFolderWitness> = {};
  for (const directory of walk.directoryPaths) {
    const folderId = folderIdByPath.get(directory);
    if (!folderId) continue;
    const parent = parentDirectory(directory);
    const parentFolderId = parent ? folderIdByPath.get(parent) ?? null : null;
    const name = path.posix.basename(directory);
    const known = knownFolders.get(folderId);
    preferredFolderPaths[folderId] = directory;
    folderWitnesses[folderId] = { path: directory, present: true };
    if (
      !known
      || known.deleted
      || known.name !== name
      || known.parentFolderId !== parentFolderId
    ) {
      const changedAt = now();
      upsertFolders.push({
        id: folderId,
        notebookId,
        name,
        parentFolderId,
        createdAt: known?.createdAt ?? changedAt,
        updatedAt: known ? Math.max(known.updatedAt + 1, changedAt) : changedAt,
        deleted: false,
        deletedAt: null,
      });
    }
  }

  for (const prepared of preparedNotes) {
    const directory = parentDirectory(prepared.path);
    prepared.note.folderId = directory ? folderIdByPath.get(directory) ?? null : null;
    if (!prepared.ownerId) preferredPaths[prepared.note.id] = prepared.path;
    witnesses[prepared.note.id] = { path: prepared.path, hash: prepared.hash };
    upserts.push(prepared.note);
  }

  const deletedNoteIds = Object.entries(manifest.notes)
    .filter(([noteId, entry]) => !seenNoteIds.has(noteId) && !presentManifestPaths.has(entry.path))
    .map(([noteId]) => noteId)
    .sort();
  for (const noteId of deletedNoteIds) {
    witnesses[noteId] = { path: manifest.notes[noteId].path, hash: null };
  }

  const deletedFolderIds = Object.entries(manifest.folders)
    .filter(([folderId, folderPath]) => (
      folderPath
      && !pathByFolderId.has(folderId)
      && !directoryPaths.has(folderPath)
      && !pathIsProtectedByIgnoredEntry(folderPath, walk.ignoredPaths)
      && knownFolders.get(folderId)?.deleted !== true
    ))
    .map(([folderId, folderPath]) => {
      folderWitnesses[folderId] = { path: folderPath, present: false };
      return folderId;
    })
    .sort();

  return {
    upserts: upserts.sort((left, right) => left.id.localeCompare(right.id)),
    deletedNoteIds,
    upsertFolders: upsertFolders.sort((left, right) => left.id.localeCompare(right.id)),
    deletedFolderIds,
    ignoredPaths: ignoredPaths.sort(),
    preferredPaths: Object.fromEntries(Object.entries(preferredPaths).sort(([left], [right]) => left.localeCompare(right))),
    preferredFolderPaths: Object.fromEntries(Object.entries(preferredFolderPaths).sort(([left], [right]) => left.localeCompare(right))),
    witnesses: Object.fromEntries(Object.entries(witnesses).sort(([left], [right]) => left.localeCompare(right))),
    folderWitnesses: Object.fromEntries(Object.entries(folderWitnesses).sort(([left], [right]) => left.localeCompare(right))),
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
      upsertFolders: [],
      deletedFolderIds: [],
      ignoredPaths: Array.from(new Set([
        ...scanned.ignoredPaths,
        ...Object.values(scanned.witnesses).map((witness) => witness.path),
        ...Object.values(scanned.folderWitnesses).map((witness) => witness.path),
      ])).sort(),
      preferredPaths: {},
      preferredFolderPaths: {},
      witnesses: {},
      folderWitnesses: {},
    };
  }

  const validIds = new Set<string>();
  for (const [noteId, witness] of Object.entries(scanned.witnesses)) {
    if (await witnessMatches(root, witness)) validIds.add(noteId);
  }
  const stalePaths = Object.entries(scanned.witnesses)
    .filter(([noteId]) => !validIds.has(noteId))
    .map(([, witness]) => witness.path);
  const validFolderIds = new Set<string>();
  for (const [folderId, witness] of Object.entries(scanned.folderWitnesses)) {
    if (await folderWitnessMatches(root, witness)) validFolderIds.add(folderId);
  }
  const staleFolderPaths = Object.entries(scanned.folderWitnesses)
    .filter(([folderId]) => !validFolderIds.has(folderId))
    .map(([, witness]) => witness.path);

  return {
    upserts: scanned.upserts.filter((note) => validIds.has(note.id)),
    deletedNoteIds: scanned.deletedNoteIds.filter((noteId) => validIds.has(noteId)),
    upsertFolders: scanned.upsertFolders.filter((folder) => validFolderIds.has(folder.id)),
    deletedFolderIds: scanned.deletedFolderIds.filter((folderId) => validFolderIds.has(folderId)),
    ignoredPaths: Array.from(new Set([
      ...scanned.ignoredPaths,
      ...stalePaths,
      ...staleFolderPaths,
    ])).sort(),
    preferredPaths: Object.fromEntries(
      Object.entries(scanned.preferredPaths).filter(([noteId]) => validIds.has(noteId)),
    ),
    preferredFolderPaths: Object.fromEntries(
      Object.entries(scanned.preferredFolderPaths)
        .filter(([folderId]) => validFolderIds.has(folderId)),
    ),
    witnesses: Object.fromEntries(
      Object.entries(scanned.witnesses).filter(([noteId]) => validIds.has(noteId)),
    ),
    folderWitnesses: Object.fromEntries(
      Object.entries(scanned.folderWitnesses)
        .filter(([folderId]) => validFolderIds.has(folderId)),
    ),
  };
}
