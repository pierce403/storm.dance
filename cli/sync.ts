import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  NotebookCrdt,
  mergeCrdtUpdates,
  type CrdtNoteInput,
  type NotebookCrdtProjection,
} from '../src/lib/collaboration/crdt.js';
import {
  ProtocolReassembler,
  STORMDANCE_PROTOCOL_PREFIX,
  encodeProtocolMessage,
  type StormdanceProtocolMessage,
} from '../src/lib/collaboration/protocol.js';
import {
  materializeMirror,
  revalidateScanMirror,
  scanMirror,
  type MaterializeMirrorOptions,
  type MirrorNote,
} from './markdown.js';
import type {
  XmtpGroupAdapter,
  XmtpGroupMessage,
  XmtpGroupStream,
} from './xmtp.js';

export const STORMDANCE_GROUP_DESCRIPTION_PREFIX = 'storm.dance/yjs/1/';
export const LINK_CONFIG_SCHEMA = 2;
const LEGACY_LINK_CONFIG_SCHEMA = 1;
export const UPDATE_BATCH_MS = 250;
export const DEFAULT_HANDSHAKE_WAIT_MS = 1_500;
export const SYNC_HISTORY_LIMIT = 2_048;
export const SYNC_REQUEST_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_SYNC_REQUESTS = 64;

const STATE_DIRECTORY = '.stormdance';
const CONFIG_FILENAME = 'config.json';
const STATE_FILENAME = 'state.bin';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CRDT_STATE_BYTES = 64 * 1024 * 1024;

export type LinkEnvironment = 'dev' | 'production';

export interface LinkConfig {
  schema: typeof LINK_CONFIG_SCHEMA;
  notebookId: string;
  conversationId: string;
  notebookName: string;
  profile: string;
  env: LinkEnvironment;
  expectedInboxId?: string;
}

export interface DiscoveredNotebook {
  notebookId: string;
  group: XmtpGroupAdapter;
}

export interface NotebookDirectorySyncWriters {
  writeState: (root: string, state: Uint8Array) => Promise<void>;
  materialize: typeof materializeMirror;
}

export interface NotebookDirectorySyncOptions {
  rootDirectory: string;
  config: LinkConfig;
  group: XmtpGroupAdapter;
  inboxId: string;
  onWarning?: (message: string, error?: unknown) => void;
  writers?: Partial<NotebookDirectorySyncWriters>;
}

export interface StartSyncOptions {
  watch?: boolean;
}

export interface RunDirectorySyncOptions extends NotebookDirectorySyncOptions {
  watch?: boolean;
  signal?: AbortSignal;
  handshakeWaitMs?: number;
}

export interface DirectorySyncResult {
  projection: NotebookCrdtProjection;
  rootDirectory: string;
}

const isErrno = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === code;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const timestamp = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
};

const stateDirectoryPath = (root: string): string => path.join(root, STATE_DIRECTORY);
const configPath = (root: string): string => path.join(stateDirectoryPath(root), CONFIG_FILENAME);
const statePath = (root: string): string => path.join(stateDirectoryPath(root), STATE_FILENAME);

/** The browser and CLI intentionally use the same URI-encoded group description. */
export function parseNotebookGroupDescription(description: string | undefined): string | null {
  if (!description?.startsWith(STORMDANCE_GROUP_DESCRIPTION_PREFIX)) return null;
  try {
    const notebookId = decodeURIComponent(
      description.slice(STORMDANCE_GROUP_DESCRIPTION_PREFIX.length),
    );
    return notebookId.trim() ? notebookId : null;
  } catch {
    return null;
  }
}

export function discoverStormdanceNotebooks(
  groups: readonly XmtpGroupAdapter[],
): DiscoveredNotebook[] {
  return groups
    .map((group) => ({ group, notebookId: parseNotebookGroupDescription(group.description) }))
    .filter((entry): entry is DiscoveredNotebook => entry.notebookId !== null)
    .sort((left, right) => {
      const byNotebook = left.notebookId.localeCompare(right.notebookId);
      return byNotebook || left.group.id.localeCompare(right.group.id);
    });
}

/** Resolve either an exact conversation ID or a notebook ID. */
export function resolveNotebookGroup(
  groups: readonly XmtpGroupAdapter[],
  selector: string,
): DiscoveredNotebook {
  if (!isNonEmptyString(selector)) throw new Error('A notebook or conversation ID is required.');
  const notebooks = discoverStormdanceNotebooks(groups);
  const exactConversation = notebooks.find(({ group }) => group.id === selector);
  if (exactConversation) return exactConversation;

  const matches = notebooks.filter(({ notebookId }) => notebookId === selector);
  if (matches.length === 0) {
    throw new Error('No storm.dance notebook group matches that selector.');
  }
  if (matches.length > 1) {
    throw new Error(
      'More than one XMTP group uses that notebook ID; link with a conversation ID.',
    );
  }
  return matches[0];
}

async function resolveRoot(rootDirectory: string, create: boolean): Promise<string> {
  const resolved = path.resolve(rootDirectory);
  if (create) await mkdir(resolved, { recursive: true });

  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Error('The notebook mirror directory does not exist.');
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('The notebook mirror path must be a real directory, not a symlink.');
  }
  return realpath(resolved);
}

async function ensureStateDirectory(root: string): Promise<string> {
  const directory = stateDirectoryPath(root);
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${STATE_DIRECTORY} must be a real directory, not a symlink.`);
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    await mkdir(directory, { mode: 0o700 });
  }
  return directory;
}

async function readRegularFile(filePath: string, maximumBytes?: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    if (isErrno(error, 'ELOOP')) throw new Error('Refusing to read a symlinked state file.');
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Expected a regular storm.dance state file.');
    if (maximumBytes !== undefined && stat.size > maximumBytes) {
      throw new Error('A storm.dance state file is too large.');
    }
    const bytes = await handle.readFile();
    if (maximumBytes !== undefined && bytes.byteLength > maximumBytes) {
      throw new Error('A storm.dance state file is too large.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  destination: string,
  data: string | Uint8Array,
  mode: number,
): Promise<void> {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    mode,
  );
  let closed = false;
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporary, destination);
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function validateLinkConfig(value: unknown): LinkConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid storm.dance link config.');
  }
  const config = value as Record<string, unknown>;
  const requiredKeys = [
    'conversationId',
    'env',
    'notebookId',
    'notebookName',
    'profile',
    'schema',
  ];
  const actualKeys = Object.keys(config).sort();
  if (
    requiredKeys.some((key) => !actualKeys.includes(key))
    || actualKeys.some((key) => !requiredKeys.includes(key) && key !== 'expectedInboxId')
  ) {
    throw new Error('Invalid storm.dance link config fields.');
  }
  if (config.schema !== LEGACY_LINK_CONFIG_SCHEMA && config.schema !== LINK_CONFIG_SCHEMA) {
    throw new Error('Unsupported storm.dance link config schema.');
  }
  if (
    !isNonEmptyString(config.notebookId)
    || !isNonEmptyString(config.conversationId)
    || !isNonEmptyString(config.notebookName)
    || !isNonEmptyString(config.profile)
  ) {
    throw new Error('Storm.dance link config contains an invalid identifier.');
  }
  if (config.env !== 'dev' && config.env !== 'production') {
    throw new Error('Storm.dance link config contains an invalid XMTP environment.');
  }
  if (config.expectedInboxId !== undefined && !isNonEmptyString(config.expectedInboxId)) {
    throw new Error('Storm.dance link config contains an invalid expected inbox ID.');
  }
  return {
    schema: LINK_CONFIG_SCHEMA,
    notebookId: config.notebookId,
    conversationId: config.conversationId,
    notebookName: config.notebookName,
    profile: config.profile,
    env: config.env,
    ...(typeof config.expectedInboxId === 'string'
      ? { expectedInboxId: config.expectedInboxId }
      : {}),
  };
}

export async function readLinkConfig(rootDirectory: string): Promise<LinkConfig> {
  const root = await resolveRoot(rootDirectory, false);
  const bytes = await readRegularFile(configPath(root), MAX_CONFIG_BYTES);
  if (!bytes) throw new Error(`No ${STATE_DIRECTORY}/${CONFIG_FILENAME} link config was found.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Storm.dance link config is not valid JSON.');
  }
  return validateLinkConfig(parsed);
}

export async function writeLinkConfig(
  rootDirectory: string,
  config: LinkConfig,
): Promise<string> {
  const validated = validateLinkConfig(config);
  const root = await resolveRoot(rootDirectory, true);
  await ensureStateDirectory(root);

  const existingBytes = await readRegularFile(configPath(root), MAX_CONFIG_BYTES);
  if (existingBytes) {
    let existing: LinkConfig;
    try {
      existing = validateLinkConfig(JSON.parse(existingBytes.toString('utf8')));
    } catch {
      throw new Error('Refusing to replace an invalid existing storm.dance link config.');
    }
    if (
      existing.notebookId !== validated.notebookId
      || existing.conversationId !== validated.conversationId
      || existing.profile !== validated.profile
      || existing.env !== validated.env
    ) {
      throw new Error(
        'Directory is already linked to a different storm.dance notebook, profile, or environment.',
      );
    }
  }

  await atomicWrite(configPath(root), `${JSON.stringify(validated, null, 2)}\n`, 0o600);
  return root;
}

export async function readCrdtState(rootDirectory: string): Promise<Uint8Array | undefined> {
  const root = await resolveRoot(rootDirectory, false);
  const bytes = await readRegularFile(statePath(root), MAX_CRDT_STATE_BYTES);
  return bytes ? new Uint8Array(bytes) : undefined;
}

export async function writeCrdtState(root: string, state: Uint8Array): Promise<void> {
  await ensureStateDirectory(root);
  await atomicWrite(statePath(root), state, 0o600);
}

const asCrdtNote = (note: MirrorNote): CrdtNoteInput => ({
  id: note.id,
  title: note.title,
  content: note.content,
  folderId: note.folderId,
  createdAt: timestamp(note.createdAt),
  updatedAt: timestamp(note.updatedAt),
  deleted: note.deleted,
});

const asMirrorNote = (
  notebookId: string,
  note: NotebookCrdtProjection['notes'][number],
): MirrorNote => ({
  id: note.id,
  notebookId,
  folderId: note.folderId,
  title: note.title,
  content: note.content,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  deleted: note.deleted,
});

const waitForAbort = (signal: AbortSignal | undefined): Promise<void> => {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
};

const wait = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
};

/**
 * Keeps one local Y.Doc, one flat Markdown mirror, and one XMTP MLS group in
 * sync. All filesystem and incoming-message operations are serialized so a
 * materializer write cannot race an external Markdown scan.
 */
export class NotebookDirectorySync {
  private readonly requestedRoot: string;
  private readonly config: LinkConfig;
  private readonly group: XmtpGroupAdapter;
  private readonly inboxId: string;
  private readonly warn: (message: string, error?: unknown) => void;
  private readonly crdt: NotebookCrdt;
  private readonly writeState: NotebookDirectorySyncWriters['writeState'];
  private readonly materialize: NotebookDirectorySyncWriters['materialize'];
  private readonly reassembler = new ProtocolReassembler();
  private readonly outboundMessageIds = new Set<string>();
  // Keep each request active long enough for every group replica to answer;
  // deletion after the first response would strand later responders.
  private readonly ownRequestExpirations = new Map<string, number>();
  private root = '';
  private stream: XmtpGroupStream | null = null;
  private watcher: FSWatcher | null = null;
  private stopCapture: (() => void) | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private pendingUpdates: Uint8Array[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private watchMode = false;
  private initializing = true;
  private stopPromise: Promise<NotebookCrdtProjection> | null = null;

  constructor(options: NotebookDirectorySyncOptions) {
    this.requestedRoot = options.rootDirectory;
    this.config = validateLinkConfig(options.config);
    this.group = options.group;
    if (!isNonEmptyString(options.inboxId)) throw new Error('XMTP inbox ID is unavailable.');
    if (this.config.expectedInboxId && this.config.expectedInboxId !== options.inboxId) {
      throw new Error(
        `Linked directory expects XMTP inbox ${this.config.expectedInboxId}, but the active profile resolves to ${options.inboxId}.`,
      );
    }
    this.inboxId = options.inboxId;
    this.warn = options.onWarning ?? (() => undefined);
    this.crdt = new NotebookCrdt(this.config.notebookId);
    this.writeState = options.writers?.writeState ?? writeCrdtState;
    this.materialize = options.writers?.materialize ?? materializeMirror;

    if (this.group.id !== this.config.conversationId) {
      throw new Error('XMTP group does not match the linked conversation ID.');
    }
    if (parseNotebookGroupDescription(this.group.description) !== this.config.notebookId) {
      throw new Error('XMTP group does not belong to the linked notebook.');
    }
  }

  get projection(): NotebookCrdtProjection {
    return this.crdt.snapshot();
  }

  get rootDirectory(): string {
    return this.root;
  }

  async start(options: StartSyncOptions = {}): Promise<void> {
    if (this.running) return;
    if (this.stopped) throw new Error('A stopped notebook sync session cannot be restarted.');
    this.running = true;
    this.watchMode = options.watch ?? false;

    try {
      this.root = await resolveRoot(this.requestedRoot, true);
      await ensureStateDirectory(this.root);
      const state = await readRegularFile(statePath(this.root), MAX_CRDT_STATE_BYTES);
      if (state?.byteLength) this.crdt.applyUpdate(new Uint8Array(state));

      // Open the stream before replaying local history; queued duplicate Yjs
      // updates are harmless and this closes the history/live race window.
      this.stream = await this.group.stream({
        onMessage: (message) => {
          void this.enqueueOperation(() => this.processMessage(message, false)).catch((error) => {
            this.warn('Failed to process an XMTP collaboration message.', error);
          });
        },
        onError: (error) => this.warn('XMTP collaboration stream error.', error),
        onFail: () => this.warn('XMTP collaboration stream stopped unexpectedly.'),
        onRestart: () => {
          void this.enqueueOperation(async () => {
            if (!this.running || this.stopped) return;
            await this.group.sync();
            if (!this.running || this.stopped) return;
            for (const message of await this.recentMessages()) {
              await this.processMessage(message, true);
            }
            if (!this.running || this.stopped) return;
            if (!this.initializing) await this.materializeAndPersist();
            if (!this.running || this.stopped) return;
            await this.sendSyncRequest();
          }).catch((error) => this.warn('XMTP restart catch-up failed.', error));
        },
      });

      // Pull messages only after the live stream is subscribed. Anything
      // published across the sync boundary is then present in history, live
      // delivery, or both; duplicate Yjs updates are harmless.
      await this.group.sync();
      for (const message of await this.recentMessages()) {
        await this.enqueueOperation(() => this.processMessage(message, true));
      }

      this.stopCapture = this.crdt.captureLocalUpdates((update) => {
        this.pendingUpdates.push(update);
        if (this.watchMode) this.scheduleBatch();
      });

      const snapshot = this.crdt.snapshot();
      if (!snapshot.notebook.name) {
        const now = Date.now();
        this.crdt.seed(
          {
            id: this.config.notebookId,
            name: this.config.notebookName,
            createdAt: now,
            updatedAt: now,
          },
          [],
        );
      }

      // Scan before materializing remote state so unsynced user edits on disk
      // are incorporated into the CRDT rather than overwritten. Install the
      // watcher first so edits made during the initial handshake cannot fall
      // between this scan and live watch mode.
      if (this.watchMode) this.startWatcher();
      await this.scanNow();
      await this.enqueueOperation(async () => {
        this.initializing = false;
        await this.materializeAndPersist();
      });
      if (!this.watchMode) await this.flushPendingUpdates();
      await this.sendSyncRequest();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  /** Force a local scan; useful for explicit one-shot sync and deterministic tests. */
  scanNow(): Promise<void> {
    return this.enqueueOperation(async () => {
      if (!this.root) return;
      const scanned = await revalidateScanMirror(
        this.root,
        await scanMirror(this.root, this.config.notebookId),
      );
      for (const note of scanned.upserts) this.crdt.upsertNote(asCrdtNote(note));
      const deletedAt = Date.now();
      for (const noteId of scanned.deletedNoteIds) this.crdt.deleteNote(noteId, deletedAt);
      if (scanned.ignoredPaths.length > 0) {
        this.warn(`Ignored ${scanned.ignoredPaths.length} unsafe or invalid Markdown file(s).`);
      }
      await this.materializeAndPersist({
        preferredPaths: scanned.preferredPaths,
        witnesses: scanned.witnesses,
      });
    });
  }

  stop(): Promise<NotebookCrdtProjection> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<NotebookCrdtProjection> {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    // Close the source first, then drain every callback it already delivered.
    // Setting running=false before this barrier would make those queued
    // messages silently no-op at the one-shot/abort boundary.
    if (this.stream) {
      await this.stream.end().catch((error) => {
        this.warn('Could not close the XMTP collaboration stream cleanly.', error);
      });
      this.stream = null;
    }
    await this.operationQueue.catch(() => undefined);
    this.running = false;
    // A queued filesystem scan can have scheduled a fresh timer while the
    // queue was draining. Its update is flushed synchronously below.
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    await this.flushPendingUpdates().catch((error) => {
      this.warn('Could not flush the final XMTP CRDT update.', error);
    });
    if (this.root) {
      await this.writeState(this.root, this.crdt.encodeUpdate()).catch((error) => {
        this.warn('Could not persist the final CRDT state.', error);
      });
    }
    const projection = this.crdt.snapshot();
    this.stopCapture?.();
    this.stopCapture = null;
    this.crdt.destroy();
    return projection;
  }

  private enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  private startWatcher(): void {
    this.watcher = watch(this.root, { persistent: true, recursive: true }, (_eventType, fileName) => {
      if (fileName !== null) {
        const value = fileName.toString().replaceAll('\\', '/');
        if (value.split('/').some((component) => component.startsWith('.'))) return;
        const extension = path.posix.extname(value).toLowerCase();
        if (extension && extension !== '.md') return;
      }
      if (this.scanTimer) clearTimeout(this.scanTimer);
      this.scanTimer = setTimeout(() => {
        this.scanTimer = null;
        void this.scanNow().catch((error) => this.warn('Markdown scan failed.', error));
      }, 100);
    });
    this.watcher.on('error', (error) => this.warn('Markdown directory watcher failed.', error));
  }

  private async processMessage(message: XmtpGroupMessage, history: boolean): Promise<void> {
    if (!this.running || message.conversationId !== this.group.id) return;
    if (
      typeof message.content !== 'string'
      || !message.content.startsWith(STORMDANCE_PROTOCOL_PREFIX)
    ) {
      return;
    }

    let logical: StormdanceProtocolMessage | null;
    try {
      logical = this.reassembler.push(message.content);
    } catch (error) {
      this.warn('Rejected an invalid storm.dance protocol message.', error);
      return;
    }
    if (!logical || logical.notebookId !== this.config.notebookId) return;
    if (
      'targetInboxId' in logical
      && logical.targetInboxId
      && logical.targetInboxId !== this.inboxId
    ) return;
    if (this.outboundMessageIds.has(logical.messageId)) return;

    if (logical.kind === 'manifest') return;
    if (logical.kind === 'sync-request') {
      if (!history && !this.hasActiveSyncRequest(logical.requestId)) {
        let update: Uint8Array;
        try {
          update = this.crdt.encodeDiff(logical.stateVector);
        } catch (error) {
          this.warn('Rejected an invalid Yjs state vector.', error);
          return;
        }
        await this.sendProtocol({
          kind: 'update',
          notebookId: this.config.notebookId,
          messageId: randomUUID(),
          sentAt: Date.now(),
          requestId: logical.requestId,
          targetInboxId: message.senderInboxId,
          responderStateVector: this.crdt.encodeStateVector(),
          update,
        });
      }
      return;
    }

    try {
      this.crdt.applyUpdate(logical.update);
    } catch (error) {
      this.warn('Rejected an invalid Yjs update.', error);
      return;
    }
    if (!history && !this.initializing) await this.materializeAndPersist();

    if (
      !history
      && logical.kind === 'update'
      && logical.requestId
      && logical.responderStateVector
      && this.hasActiveSyncRequest(logical.requestId)
    ) {
      let update: Uint8Array;
      try {
        update = this.crdt.encodeDiff(logical.responderStateVector);
      } catch (error) {
        this.warn('Rejected an invalid Yjs responder state vector.', error);
        return;
      }
      await this.sendProtocol({
        kind: 'update',
        notebookId: this.config.notebookId,
        messageId: randomUUID(),
        sentAt: Date.now(),
        requestId: logical.requestId,
        targetInboxId: message.senderInboxId,
        update,
      });
    }
  }

  private recentMessages(): Promise<XmtpGroupMessage[]> {
    return this.group.messages({ direction: 'descending', limit: SYNC_HISTORY_LIMIT });
  }

  private scheduleBatch(): void {
    if (!this.running || this.stopped || this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.enqueueOperation(() => this.flushPendingUpdates()).catch((error) => {
        this.warn('XMTP update send failed; a later state-vector handshake can recover it.', error);
      });
    }, UPDATE_BATCH_MS);
  }

  private async flushPendingUpdates(): Promise<void> {
    if (this.pendingUpdates.length === 0) return;
    const merged = mergeCrdtUpdates(this.pendingUpdates.splice(0));
    try {
      await this.sendProtocol({
        kind: 'update',
        notebookId: this.config.notebookId,
        messageId: randomUUID(),
        sentAt: Date.now(),
        update: merged,
      });
    } catch (error) {
      this.pendingUpdates.unshift(merged);
      if (this.running) {
        this.batchTimer = setTimeout(() => {
          this.batchTimer = null;
          void this.enqueueOperation(() => this.flushPendingUpdates()).catch((retryError) => {
            this.warn('XMTP update retry failed.', retryError);
          });
        }, 1_000);
      }
      throw error;
    }
  }

  private async sendSyncRequest(): Promise<void> {
    const requestId = randomUUID();
    const now = Date.now();
    this.pruneSyncRequests(now);
    this.ownRequestExpirations.set(requestId, now + SYNC_REQUEST_TTL_MS);
    if (this.ownRequestExpirations.size > MAX_ACTIVE_SYNC_REQUESTS) {
      const oldest = this.ownRequestExpirations.keys().next().value as string | undefined;
      if (oldest) this.ownRequestExpirations.delete(oldest);
    }
    await this.sendProtocol({
      kind: 'sync-request',
      notebookId: this.config.notebookId,
      messageId: randomUUID(),
      sentAt: Date.now(),
      requestId,
      stateVector: this.crdt.encodeStateVector(),
    });
  }

  private hasActiveSyncRequest(requestId: string, now = Date.now()): boolean {
    this.pruneSyncRequests(now);
    const expiresAt = this.ownRequestExpirations.get(requestId);
    return expiresAt !== undefined && expiresAt > now;
  }

  private pruneSyncRequests(now = Date.now()): void {
    for (const [requestId, expiresAt] of this.ownRequestExpirations) {
      if (expiresAt <= now) this.ownRequestExpirations.delete(requestId);
    }
  }

  private async sendProtocol(message: StormdanceProtocolMessage): Promise<void> {
    this.outboundMessageIds.add(message.messageId);
    if (this.outboundMessageIds.size > 256) {
      const oldest = this.outboundMessageIds.values().next().value as string | undefined;
      if (oldest) this.outboundMessageIds.delete(oldest);
    }
    const chunks = encodeProtocolMessage(message);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.group.sendText(chunks[index], `${message.messageId}:${index}`);
    }
  }

  private async materializeAndPersist(options: MaterializeMirrorOptions = {}): Promise<void> {
    const projection = this.crdt.snapshot();
    const state = this.crdt.encodeUpdate();

    // state.bin is the durable source of truth. Commit it before advancing the
    // Markdown files or their manifest so a crash can only leave the projection
    // behind the CRDT, never the manifest ahead of recoverable state.
    await this.writeState(this.root, state);
    const result = await this.materialize(
      this.root,
      projection.notes.map((note) => asMirrorNote(this.config.notebookId, note)),
      options,
    );
    if (result.protectedPaths.length > 0) {
      this.warn(
        `Preserved ${result.protectedPaths.length} unsynced or invalid owned Markdown file(s).`,
      );
    }
  }
}

/** Run one finite handshake or watch until the supplied signal is aborted. */
export async function runDirectorySync(
  options: RunDirectorySyncOptions,
): Promise<DirectorySyncResult> {
  const rootDirectory = await resolveRoot(options.rootDirectory, true);
  const session = new NotebookDirectorySync({ ...options, rootDirectory });

  try {
    await session.start({ watch: options.watch });
    if (options.watch) {
      await waitForAbort(options.signal);
    } else {
      await wait(options.handshakeWaitMs ?? DEFAULT_HANDSHAKE_WAIT_MS, options.signal);
    }
    // Queue behind any response delivered at the handshake/abort boundary so
    // it is applied and persisted before the stream is closed.
    await session.scanNow();
    const projection = await session.stop();
    return { projection, rootDirectory };
  } finally {
    await session.stop();
  }
}
