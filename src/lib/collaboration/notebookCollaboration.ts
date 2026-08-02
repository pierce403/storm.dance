import {
  ConsentState,
  GroupPermissionsOptions,
  SortDirection,
  type Identifier,
} from '@xmtp/browser-sdk';
import {
  NotebookCrdt,
  mergeCrdtUpdates,
  type CrdtFolderInput,
  type CrdtNoteInput,
  type NotebookCrdtProjection,
  type NotebookSeed,
} from './crdt';
import {
  ProtocolReassembler,
  STORMDANCE_PROTOCOL_PREFIX,
  encodeProtocolMessage,
  type StormdanceProtocolMessage,
} from './protocol';
import type { CollaborationContact } from './types';

export const STORMDANCE_GROUP_DESCRIPTION_PREFIX = 'storm.dance/yjs/1/';
export const COLLABORATION_BATCH_MS = 250;
export const COLLABORATION_HISTORY_LIMIT = 2_048n;

export const buildGroupDescription = (notebookId: string) =>
  `${STORMDANCE_GROUP_DESCRIPTION_PREFIX}${encodeURIComponent(notebookId)}`;

export const parseGroupDescription = (description: string | undefined) => {
  if (!description?.startsWith(STORMDANCE_GROUP_DESCRIPTION_PREFIX)) return null;
  try {
    const notebookId = decodeURIComponent(description.slice(STORMDANCE_GROUP_DESCRIPTION_PREFIX.length));
    return notebookId || null;
  } catch {
    return null;
  }
};

export interface NoteShape extends CrdtNoteInput {
  notebookId: string;
}

export interface FolderShape extends CrdtFolderInput {
  notebookId: string;
}

export interface IncomingXmtpMessage {
  id?: string;
  content: unknown;
  senderInboxId: string;
  conversationId?: string;
}

export interface XmtpStreamLike {
  end: () => Promise<unknown>;
}

export interface XmtpListMessagesOptions {
  direction?: SortDirection;
  limit?: bigint;
}

export interface XmtpGroupLike {
  id: string;
  name?: string;
  description?: string;
  send: (content: string) => Promise<unknown>;
  messages: (options?: XmtpListMessagesOptions) => Promise<IncomingXmtpMessage[]>;
  sync: () => Promise<unknown>;
  stream: (options?: {
    onValue?: (message: IncomingXmtpMessage) => void;
    onError?: (error: Error) => void;
    onFail?: () => void;
    onRestart?: () => void;
  }) => Promise<XmtpStreamLike>;
  updateConsentState?: (state: ConsentState) => Promise<void> | void;
  addMembersByIdentifiers?: (identifiers: Identifier[]) => Promise<void>;
}

interface ConversationFactory {
  newGroupWithIdentifiers: (
    identifiers: Identifier[],
    options?: {
      name?: string;
      description?: string;
      permissions?: GroupPermissionsOptions;
    },
  ) => Promise<XmtpGroupLike>;
  getConversationById: (id: string) => Promise<XmtpGroupLike | undefined>;
}

export interface XmtpClientLike {
  inboxId: string | undefined;
  address: string | undefined;
  canMessage: (identifiers: Identifier[]) => Promise<Map<string, boolean>>;
  conversations: ConversationFactory;
}

export type ProjectionHandler = (projection: NotebookCrdtProjection) => Promise<void> | void;
export type StateHandler = (state: Uint8Array, conversationId: string | null) => Promise<void> | void;

export interface NotebookCollaborationSessionOptions {
  notebook: NotebookSeed;
  notes: CrdtNoteInput[];
  folders?: CrdtFolderInput[];
  client: XmtpClientLike;
  onRemoteProjection: ProjectionHandler;
  onStateChange: StateHandler;
  initialState?: Uint8Array;
  conversationId?: string | null;
  debugLoggingEnabled?: boolean;
}

const isProtocolText = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(STORMDANCE_PROTOCOL_PREFIX);

const equalBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const newId = () => crypto.randomUUID();

/**
 * Binds one persisted Y.Doc to one XMTP MLS group. XMTP is only the encrypted
 * transport: Yjs owns merge semantics and IndexedDB owns durable local state.
 */
export class NotebookCollaborationSession {
  private readonly client: XmtpClientLike;
  private readonly notebook: NotebookSeed;
  private readonly onRemoteProjection: ProjectionHandler;
  private readonly onStateChange: StateHandler;
  private readonly crdt: NotebookCrdt;
  private hasAuthoritativeState: boolean;
  private deferredRecoveryNotes: Map<string, CrdtNoteInput> | null = null;
  private deferredRecoveryFolders: Map<string, CrdtFolderInput> | null = null;
  private readonly reassembler = new ProtocolReassembler();
  private readonly debugLoggingEnabled: boolean;
  private conversation: XmtpGroupLike | null = null;
  private conversationId: string | null;
  private stream: XmtpStreamLike | null = null;
  private running = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private pendingUpdates: Uint8Array[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private readonly stopCapturing: () => void;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private readonly outboundMessageIds = new Set<string>();

  constructor(options: NotebookCollaborationSessionOptions) {
    this.client = options.client;
    this.notebook = options.notebook;
    this.onRemoteProjection = options.onRemoteProjection;
    this.onStateChange = options.onStateChange;
    this.conversationId = options.conversationId ?? null;
    this.debugLoggingEnabled = options.debugLoggingEnabled ?? false;
    this.crdt = new NotebookCrdt(options.notebook.id);
    this.hasAuthoritativeState = !this.conversationId || Boolean(options.initialState?.byteLength);

    const localFolders = options.folders ?? [];
    const migratePersistedFolders = Boolean(options.initialState?.byteLength && localFolders.length);
    if (options.initialState?.byteLength) {
      this.crdt.applyUpdate(options.initialState);
    } else if (this.conversationId) {
      // A replica joining an existing group must not independently create the
      // nested note maps. The group's snapshot/state-vector exchange supplies
      // their shared Yjs identities; local rows are only a materialized view.
      this.crdt.seed(options.notebook);
      this.deferredRecoveryNotes = new Map(options.notes.map((note) => [note.id, { ...note }]));
      this.deferredRecoveryFolders = new Map(localFolders.map((folder) => [folder.id, { ...folder }]));
    } else {
      // Once a persisted Y.Doc exists it is the source of truth. Re-seeding it
      // from IndexedDB rows can replay a stale materialized projection after a
      // crash and turn that stale value into a new local Yjs edit.
      this.crdt.seed(options.notebook, options.notes, localFolders);
    }
    this.stopCapturing = this.crdt.captureLocalUpdates((update) => {
      this.pendingUpdates.push(update);
      this.scheduleBatch();
      this.schedulePersist();
    });
    if (migratePersistedFolders) this.recoverLocalFolders(localFolders);
  }

  get topic() {
    return this.conversationId;
  }

  get notebookId() {
    return this.notebook.id;
  }

  get projection() {
    return this.crdt.snapshot();
  }

  async start(contacts: CollaborationContact[] = []) {
    this.throwIfStopped();
    if (this.running) return this.conversationId;
    this.running = true;

    try {
      const reachable = contacts.length > 0 ? await this.filterContacts(contacts) : [];
      this.throwIfStopped();
      const identifiers = reachable.map((contact) => ({
        identifierKind: 'Ethereum' as const,
        identifier: contact.address,
      }));
      let isNewGroup = false;
      let addedMembers = false;

      if (this.conversationId) {
        this.conversation = await this.client.conversations.getConversationById(this.conversationId) ?? null;
        this.throwIfStopped();
        if (!this.conversation) {
          throw new Error(`XMTP collaboration group ${this.conversationId} was not found`);
        }
        if (parseGroupDescription(this.conversation.description) !== this.notebook.id) {
          throw new Error('XMTP group does not belong to this notebook');
        }
        if (identifiers.length > 0 && this.conversation.addMembersByIdentifiers) {
          await this.conversation.addMembersByIdentifiers(identifiers);
          this.throwIfStopped();
          addedMembers = true;
        }
      } else {
        if (identifiers.length === 0) {
          throw new Error('Add at least one reachable XMTP collaborator');
        }
        this.conversation = await this.client.conversations.newGroupWithIdentifiers(identifiers, {
          name: `storm.dance · ${this.notebook.name}`,
          description: buildGroupDescription(this.notebook.id),
          permissions: GroupPermissionsOptions.AdminOnly,
        });
        this.throwIfStopped();
        this.conversationId = this.conversation.id;
        isNewGroup = true;
      }

      // Subscribe before syncing and taking the history snapshot. A message
      // published in the gap is then delivered by the stream, included in
      // history, or both; Yjs and the protocol reassembler make the duplicate
      // harmless.
      const stream = await this.conversation.stream({
        onValue: (message) => this.enqueueMessage(message, false),
        onError: (error) => console.warn('XMTP collaboration stream error', error),
        onFail: () => console.warn('XMTP collaboration stream failed'),
        onRestart: () => this.enqueueRestartCatchUp(),
      });
      if (this.stopped) {
        try {
          await stream.end();
        } catch (error) {
          console.warn('Failed to close a cancelled XMTP collaboration stream', error);
        }
        this.throwIfStopped();
      }
      this.stream = stream;

      // Local edits may arrive while contact lookup, group lookup, or stream
      // setup is still pending. Their batch timer cannot send until both the
      // conversation and its stream are ready, so explicitly drain them here.
      await this.flushPendingUpdates();
      this.throwIfStopped();
      await this.enqueueCatchUp({ announce: isNewGroup || addedMembers, syncConversation: true });
      this.throwIfStopped();
      await this.persistNow();
      this.throwIfStopped();
      return this.conversationId;
    } catch (error) {
      this.running = false;
      if (!this.stopped && this.stream) {
        const stream = this.stream;
        this.stream = null;
        try {
          await stream.end();
        } catch (closeError) {
          console.warn('Failed to close XMTP collaboration stream after startup error', closeError);
        }
      }
      throw error;
    }
  }

  upsertLocalNote(note: NoteShape) {
    if (this.stopped || note.notebookId !== this.notebook.id) return;
    if (this.deferredRecoveryNotes) {
      const current = this.deferredRecoveryNotes.get(note.id);
      if (!current || note.updatedAt >= current.updatedAt) {
        this.deferredRecoveryNotes.set(note.id, { ...note });
      }
      return;
    }
    this.crdt.upsertNote(note);
  }

  upsertLocalFolder(folder: FolderShape) {
    if (this.stopped || folder.notebookId !== this.notebook.id) return;
    if (this.deferredRecoveryFolders) {
      const current = this.deferredRecoveryFolders.get(folder.id);
      if (!current || folder.updatedAt >= current.updatedAt) {
        this.deferredRecoveryFolders.set(folder.id, { ...folder });
      }
      return;
    }
    this.crdt.upsertFolder(folder);
  }

  deleteLocalNote(noteId: string, deletedAt = Date.now()) {
    if (this.stopped) return;
    if (this.deferredRecoveryNotes) {
      const current = this.deferredRecoveryNotes.get(noteId);
      if (current && deletedAt >= current.updatedAt) {
        this.deferredRecoveryNotes.set(noteId, {
          ...current,
          deleted: true,
          deletedAt,
          updatedAt: deletedAt,
        });
      }
      return;
    }
    this.crdt.deleteNote(noteId, deletedAt);
  }

  deleteLocalFolder(folderId: string, deletedAt = Date.now()) {
    if (this.stopped) return;
    if (this.deferredRecoveryFolders) {
      const current = this.deferredRecoveryFolders.get(folderId);
      if (current && deletedAt >= current.updatedAt) {
        this.deferredRecoveryFolders.set(folderId, {
          ...current,
          deleted: true,
          deletedAt,
          updatedAt: deletedAt,
        });
      }
      return;
    }
    this.crdt.deleteFolder(folderId, deletedAt);
  }

  updateNotebook(name: string, updatedAt = Date.now()) {
    if (this.stopped) return;
    this.crdt.updateNotebook({ name, updatedAt });
  }

  /**
   * Merge an update produced by this desktop installation's native vault.
   * It is local for transport purposes (so it is batched onto XMTP), while the
   * resulting projection must still be materialized into the React/IndexedDB
   * view because the edit originated outside the webview.
   */
  async applyNativeUpdate(update: Uint8Array) {
    this.throwIfStopped();
    const before = this.crdt.encodeStateVector();
    this.crdt.applyLocalUpdate(update);
    if (equalBytes(before, this.crdt.encodeStateVector())) return false;
    await this.persistNow();
    this.throwIfStopped();
    await this.onRemoteProjection(this.crdt.snapshot());
    return true;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async filterContacts(contacts: CollaborationContact[]) {
    const identifiers = contacts.map((contact) => ({
      identifierKind: 'Ethereum' as const,
      identifier: contact.address,
    }));
    const reachable = await this.client.canMessage(identifiers);

    return contacts.filter((contact) => {
      const exact = reachable.get(contact.address);
      const lower = reachable.get(contact.address.toLowerCase());
      return exact === true || lower === true;
    });
  }

  private async finishStop() {
    let firstError: unknown;
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };

    try {
      // Finish a timer-owned send (or drain the current pending batch) before
      // closing the stream so its self echo cannot race stream shutdown.
      await attempt(() => this.flushPendingUpdates());
      const stream = this.stream;
      this.stream = null;
      if (stream) await attempt(() => stream.end());
      // Drain callbacks that the stream delivered before end() completed while
      // running is still true; otherwise processMessage would silently no-op
      // and the last remote state would never become durable.
      await attempt(() => this.messageQueue);
      this.running = false;
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
        this.batchTimer = null;
      }
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      await attempt(async () => {
        // If a timer-owned flush is already sending, wait for it. An edit can
        // have been captured behind that send just before stop() set stopped,
        // so make one more drain after the in-flight operation settles.
        await this.flushPendingUpdates();
        if (this.pendingUpdates.length > 0) await this.flushPendingUpdates();
      });
      await attempt(() => this.persistNow());
    } finally {
      try {
        this.stopCapturing();
      } catch (error) {
        firstError ??= error;
      } finally {
        try {
          this.crdt.destroy();
        } catch (error) {
          firstError ??= error;
        }
        this.pendingUpdates = [];
        this.conversation = null;
      }
    }

    if (firstError) throw firstError;
  }

  private async replayHistory(conversation: XmtpGroupLike) {
    // Persisted Yjs state is authoritative; a bounded recent replay plus the
    // state-vector exchange repairs gaps without fetching an unbounded log.
    const messages = await conversation.messages({
      direction: SortDirection.Descending,
      limit: COLLABORATION_HISTORY_LIMIT,
    });
    if (this.stopped) return;
    let appliedState = false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || this.stopped) return;
      appliedState = await this.processMessage(message, true) || appliedState;
    }
    if (this.stopped || !appliedState) return;
    this.acceptAuthoritativeState();
    // History can contain thousands of updates. Materialize the converged
    // document once instead of issuing one IndexedDB projection per message.
    // Manifests, sync requests, self echoes, and malformed Yjs payloads do not
    // cause an otherwise spurious projection.
    // Persist the authoritative Y.Doc—including any deferred local recovery
    // merged above—before advancing its IndexedDB materialized projection.
    await this.persistNow();
    if (this.stopped) return;
    await this.onRemoteProjection(this.crdt.snapshot());
  }

  private enqueueMessage(message: IncomingXmtpMessage, history: boolean) {
    void this.enqueueSerialized(
      async () => {
        await this.processMessage(message, history);
      },
      'Failed to process XMTP collaboration message',
    );
  }

  private enqueueRestartCatchUp() {
    if (!this.running || this.stopped) return;
    void this.enqueueCatchUp({ announce: false, syncConversation: true });
  }

  private enqueueCatchUp(options: { announce: boolean; syncConversation: boolean }) {
    return this.enqueueSerialized(async () => {
      if (!this.running || this.stopped || !this.conversation) return;
      const conversation = this.conversation;
      if (options.syncConversation) {
        await conversation.sync();
        if (!this.running || this.stopped) return;
      }
      await this.replayHistory(conversation);
      if (!this.running || this.stopped) return;
      await this.flushPendingUpdates();
      if (!this.running || this.stopped) return;
      if (options.announce) {
        await this.sendManifest();
        if (!this.running || this.stopped) return;
        await this.sendSnapshot();
        if (!this.running || this.stopped) return;
      }
      await this.sendSyncRequest();
    }, 'Failed to catch up XMTP collaboration state');
  }

  private enqueueSerialized(operation: () => Promise<void>, warning: string) {
    const work = this.messageQueue.then(operation);
    this.messageQueue = work.catch((error) => console.warn(warning, error));
    return work;
  }

  private async processMessage(message: IncomingXmtpMessage, history: boolean): Promise<boolean> {
    if (!this.running || !isProtocolText(message.content)) return false;
    if (message.conversationId && this.conversationId && message.conversationId !== this.conversationId) return false;

    let logical: StormdanceProtocolMessage | null;
    try {
      logical = this.reassembler.push(message.content);
    } catch (error) {
      if (this.debugLoggingEnabled) console.warn('Rejected invalid storm.dance message', error);
      return false;
    }
    if (!logical || logical.notebookId !== this.notebook.id) return false;
    if ('targetInboxId' in logical && logical.targetInboxId && logical.targetInboxId !== this.client.inboxId) return false;
    const sentByThisInstallation = this.outboundMessageIds.has(logical.messageId);

    if (this.debugLoggingEnabled) {
      console.log(`[storm.dance/XMTP] ${history ? 'history' : 'live'} ${logical.kind}`, {
        conversationId: this.conversationId,
        messageId: logical.messageId,
        senderInboxId: message.senderInboxId,
      });
    }

    if (logical.kind === 'manifest') return false;
    if (logical.kind === 'sync-request') {
      if (!history && !sentByThisInstallation) {
        let update: Uint8Array;
        try {
          update = this.crdt.encodeDiff(logical.stateVector);
        } catch (error) {
          if (this.debugLoggingEnabled) console.warn('Rejected invalid Yjs state vector', error);
          return false;
        }
        await this.sendProtocol({
          kind: 'update',
          notebookId: this.notebook.id,
          messageId: newId(),
          sentAt: Date.now(),
          requestId: logical.requestId,
          targetInboxId: message.senderInboxId,
          responderStateVector: this.crdt.encodeStateVector(),
          update,
        });
      }
      return false;
    }

    if (sentByThisInstallation) return false;
    const stateVectorBefore = this.crdt.encodeStateVector();
    try {
      this.crdt.applyUpdate(logical.update);
    } catch (error) {
      if (this.debugLoggingEnabled) console.warn('Rejected invalid Yjs update', error);
      return false;
    }
    const stateChanged = !equalBytes(stateVectorBefore, this.crdt.encodeStateVector());
    if (history) return stateChanged;
    if (stateChanged) {
      this.acceptAuthoritativeState();
      // The projection is recoverable after a crash only once the complete
      // authoritative Yjs state is durable.
      await this.persistNow();
      if (this.stopped) return stateChanged;
      await this.onRemoteProjection(this.crdt.snapshot());
    }

    if (logical.kind === 'update' && logical.requestId && logical.responderStateVector) {
      let update: Uint8Array;
      try {
        update = this.crdt.encodeDiff(logical.responderStateVector);
      } catch (error) {
        if (this.debugLoggingEnabled) console.warn('Rejected invalid Yjs responder state vector', error);
        return stateChanged;
      }
      await this.sendProtocol({
        kind: 'update',
        notebookId: this.notebook.id,
        messageId: newId(),
        sentAt: Date.now(),
        requestId: logical.requestId,
        targetInboxId: message.senderInboxId,
        update,
      });
    }
    return stateChanged;
  }

  private scheduleBatch() {
    if (!this.running || this.stopped || this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.flushPendingUpdates();
    }, COLLABORATION_BATCH_MS);
  }

  private flushPendingUpdates(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (!this.conversation || !this.stream || this.pendingUpdates.length === 0) {
      return Promise.resolve();
    }
    const updates = this.pendingUpdates.splice(0);
    const merged = mergeCrdtUpdates(updates);
    const work = (async () => {
      try {
        // The optimistic UI is already updated, but the authoritative CRDT
        // must be durable (IndexedDB and any watched native vault) before its
        // delta is acknowledged on XMTP.
        await this.persistNow();
        await this.sendProtocol({
          kind: 'update',
          notebookId: this.notebook.id,
          messageId: newId(),
          sentAt: Date.now(),
          update: merged,
        });
      } catch (error) {
        this.pendingUpdates.unshift(merged);
        if (this.running && !this.stopped && !this.batchTimer) {
          this.batchTimer = setTimeout(() => {
            this.batchTimer = null;
            void this.flushPendingUpdates();
          }, 1_000);
        }
        console.warn('XMTP update send failed; state-vector catch-up will retry it', error);
      }
    })();
    const tracked = work.finally(() => {
      if (this.flushPromise === tracked) this.flushPromise = null;
      if (
        this.running
        && !this.stopped
        && this.pendingUpdates.length > 0
        && !this.batchTimer
      ) {
        this.scheduleBatch();
      }
    });
    this.flushPromise = tracked;
    return tracked;
  }

  private schedulePersist() {
    if (this.stopped || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow().catch((error) => {
        console.warn('Could not persist storm.dance collaboration state', error);
      });
    }, 100);
  }

  private async persistNow() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.hasAuthoritativeState) return;
    const state = this.crdt.encodeUpdate();
    const conversationId = this.conversationId;
    const work = this.persistenceQueue
      .catch(() => undefined)
      .then(() => this.onStateChange(state, conversationId));
    this.persistenceQueue = work.catch(() => undefined);
    await work;
  }

  private acceptAuthoritativeState() {
    if (this.hasAuthoritativeState) return;
    this.hasAuthoritativeState = true;
    const recoveryNotes = this.deferredRecoveryNotes;
    const recoveryFolders = this.deferredRecoveryFolders;
    this.deferredRecoveryNotes = null;
    this.deferredRecoveryFolders = null;

    if (recoveryFolders) this.recoverLocalFolders(recoveryFolders.values());
    if (!recoveryNotes) return;

    for (const note of recoveryNotes.values()) {
      const remote = this.crdt.getNote(note.id);
      if (remote && note.updatedAt <= remote.updatedAt) continue;
      try {
        // This now edits the shared remote-created nested map when present. A
        // locally unique note is created only after a valid remote state has
        // established the document identity.
        this.crdt.upsertNote(note);
      } catch (error) {
        if (this.debugLoggingEnabled) console.warn('Could not recover a local note into Yjs state', error);
      }
    }
  }

  private recoverLocalFolders(folders: Iterable<CrdtFolderInput>) {
    for (const folder of folders) {
      const remote = this.crdt.getFolder(folder.id);
      if (remote && folder.updatedAt <= remote.updatedAt) continue;
      try {
        // Legacy persisted Yjs states did not contain folder entities. Recover
        // IndexedDB rows only when the shared document has no such folder or
        // the local row is newer, preserving authoritative folder tombstones.
        this.crdt.upsertFolder(folder);
      } catch (error) {
        if (this.debugLoggingEnabled) console.warn('Could not recover a local folder into Yjs state', error);
      }
    }
  }

  private async sendManifest() {
    await this.sendProtocol({
      kind: 'manifest',
      notebookId: this.notebook.id,
      messageId: newId(),
      sentAt: Date.now(),
      notebookName: this.notebook.name,
      schemaVersion: 1,
      ownerInboxId: this.client.inboxId,
    });
  }

  private async sendSnapshot() {
    await this.sendProtocol({
      kind: 'snapshot',
      notebookId: this.notebook.id,
      messageId: newId(),
      sentAt: Date.now(),
      update: this.crdt.encodeUpdate(),
    });
  }

  private async sendSyncRequest() {
    await this.sendProtocol({
      kind: 'sync-request',
      notebookId: this.notebook.id,
      messageId: newId(),
      sentAt: Date.now(),
      requestId: newId(),
      stateVector: this.crdt.encodeStateVector(),
    });
  }

  private async sendProtocol(message: StormdanceProtocolMessage) {
    if (!this.conversation) throw new Error('XMTP collaboration group is not ready');
    this.outboundMessageIds.add(message.messageId);
    if (this.outboundMessageIds.size > 512) {
      const oldest = this.outboundMessageIds.values().next().value;
      if (oldest) this.outboundMessageIds.delete(oldest);
    }
    for (const chunk of encodeProtocolMessage(message)) {
      if (this.debugLoggingEnabled) {
        console.log('[storm.dance/XMTP] outgoing', message.kind, {
          conversationId: this.conversationId,
          messageId: message.messageId,
        });
      }
      await this.conversation.send(chunk);
    }
  }

  private throwIfStopped(): void {
    if (this.stopped) throw new Error('XMTP collaboration session was stopped');
  }
}
