import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xmtp/browser-sdk', () => ({
  ConsentState: {
    Allowed: 'allowed',
    Denied: 'denied',
    Unknown: 'unknown',
  },
  GroupPermissionsOptions: {
    AdminOnly: 'admin-only',
  },
  SortDirection: {
    Ascending: 'ascending',
    Descending: 'descending',
  },
}));

import { SortDirection } from '@xmtp/browser-sdk';
import {
  COLLABORATION_BATCH_MS,
  COLLABORATION_HISTORY_LIMIT,
  NotebookCollaborationSession,
  buildGroupDescription,
  type IncomingXmtpMessage,
  type XmtpListMessagesOptions,
  type NotebookCollaborationSessionOptions,
  type XmtpClientLike,
  type XmtpGroupLike,
  type XmtpStreamLike,
} from './notebookCollaboration';
import {
  encodeProtocolMessage,
  ProtocolReassembler,
  type StormdanceProtocolMessage,
} from './protocol';
import {
  NotebookCrdt,
  type CrdtNoteInput,
  type NotebookCrdtProjection,
  type NotebookSeed,
} from './crdt';

interface StoredMessage extends IncomingXmtpMessage {
  id: string;
  conversationId: string;
  content: string;
}

interface GroupCreation {
  ownerAddress: string;
  identifiers: Array<{ identifier: string; identifierKind: string }>;
  options: {
    name?: string;
    description?: string;
    permissions?: unknown;
  };
  state: FakeGroupState;
}

interface FakeGroupState {
  id: string;
  name?: string;
  description?: string;
  history: StoredMessage[];
  views: Set<FakeGroupView>;
  syncCount: number;
  endedStreamCount: number;
  liveDeliveryEnabled: boolean;
  listMessageOptions: XmtpListMessagesOptions[];
  lifecycle: string[];
  beforeMessagesReturn?: () => Promise<void> | void;
  beforeStreamReturn?: () => Promise<void> | void;
  beforeSendReturn?: () => Promise<void> | void;
  failStreamEnd?: Error;
}

type StreamOptions = Parameters<XmtpGroupLike['stream']>[0];

class FakeStream implements XmtpStreamLike {
  private ended = false;

  constructor(
    private readonly state: FakeGroupState,
    private readonly view: FakeGroupView,
  ) {}

  async end() {
    if (this.ended) return;
    this.ended = true;
    this.view.closeStream();
    this.state.endedStreamCount += 1;
    if (this.state.failStreamEnd) throw this.state.failStreamEnd;
  }
}

class FakeGroupView implements XmtpGroupLike {
  private streamOptions: StreamOptions;

  constructor(
    private readonly state: FakeGroupState,
    private readonly client: FakeClient,
  ) {
    state.views.add(this);
  }

  get id() {
    return this.state.id;
  }

  get name() {
    return this.state.name;
  }

  get description() {
    return this.state.description;
  }

  async send(content: string) {
    const beforeReturn = this.state.beforeSendReturn;
    this.state.beforeSendReturn = undefined;
    await beforeReturn?.();
    this.appendAndDeliver(content, this.client.inboxId);
  }

  async messages(options: XmtpListMessagesOptions = {}) {
    this.state.lifecycle.push('messages');
    this.state.listMessageOptions.push({ ...options });
    const ordered = options.direction === SortDirection.Descending
      ? [...this.state.history].reverse()
      : [...this.state.history];
    const limit = options.limit === undefined
      ? ordered.length
      : Math.min(Number(options.limit), ordered.length);
    const snapshot = ordered.slice(0, limit).map((message) => ({ ...message }));
    const beforeReturn = this.state.beforeMessagesReturn;
    this.state.beforeMessagesReturn = undefined;
    await beforeReturn?.();
    return snapshot;
  }

  async sync() {
    this.state.lifecycle.push('sync');
    this.state.syncCount += 1;
  }

  async stream(options: StreamOptions = {}) {
    this.state.lifecycle.push('stream');
    this.streamOptions = options;
    const beforeReturn = this.state.beforeStreamReturn;
    this.state.beforeStreamReturn = undefined;
    await beforeReturn?.();
    return new FakeStream(this.state, this);
  }

  async addMembersByIdentifiers() {}

  async updateConsentState() {}

  deliver(message: StoredMessage) {
    this.streamOptions?.onValue?.({ ...message });
  }

  closeStream() {
    this.streamOptions = undefined;
  }

  restartStream() {
    this.streamOptions?.onRestart?.();
  }

  appendAndDeliver(content: string, senderInboxId: string) {
    const message: StoredMessage = {
      id: `message-${this.state.history.length + 1}`,
      content,
      senderInboxId,
      conversationId: this.state.id,
    };
    this.state.history.push(message);

    if (this.state.liveDeliveryEnabled) {
      for (const view of this.state.views) {
        view.deliver(message);
      }
    }
  }

  get inboxId() {
    return this.client.inboxId;
  }

  get hasActiveStream() {
    return this.streamOptions !== undefined;
  }
}

class FakeXmtpNetwork {
  readonly groups = new Map<string, FakeGroupState>();
  readonly creations: GroupCreation[] = [];
  beforeNextStreamReturn?: () => Promise<void> | void;
  beforeNextConversationReturn?: () => Promise<void> | void;

  createClient(address: string, inboxId: string, unreachableAddresses: string[] = []) {
    return new FakeClient(this, address, inboxId, new Set(unreachableAddresses));
  }

  createGroup(
    owner: FakeClient,
    identifiers: GroupCreation['identifiers'],
    options: GroupCreation['options'] = {},
  ) {
    const state: FakeGroupState = {
      id: `group-${this.groups.size + 1}`,
      name: options.name,
      description: options.description,
      history: [],
      views: new Set(),
      syncCount: 0,
      endedStreamCount: 0,
      liveDeliveryEnabled: true,
      listMessageOptions: [],
      lifecycle: [],
      beforeStreamReturn: this.beforeNextStreamReturn,
    };
    this.beforeNextStreamReturn = undefined;
    this.groups.set(state.id, state);
    this.creations.push({
      ownerAddress: owner.address,
      identifiers: identifiers.map((identifier) => ({ ...identifier })),
      options: { ...options },
      state,
    });
    return new FakeGroupView(state, owner);
  }

  async getGroup(client: FakeClient, id: string) {
    const beforeReturn = this.beforeNextConversationReturn;
    this.beforeNextConversationReturn = undefined;
    await beforeReturn?.();
    const state = this.groups.get(id);
    return state ? new FakeGroupView(state, client) : undefined;
  }

  get activeStreamCount() {
    let count = 0;
    for (const group of this.groups.values()) {
      for (const view of group.views) {
        if (view.hasActiveStream) count += 1;
      }
    }
    return count;
  }
}

class FakeClient implements XmtpClientLike {
  readonly conversations: XmtpClientLike['conversations'];

  constructor(
    private readonly network: FakeXmtpNetwork,
    readonly address: string,
    readonly inboxId: string,
    private readonly unreachableAddresses: Set<string>,
  ) {
    this.conversations = {
      newGroupWithIdentifiers: async (identifiers, options) => this.network.createGroup(
        this,
        identifiers.map((identifier) => ({ ...identifier })),
        options,
      ),
      getConversationById: async (id) => this.network.getGroup(this, id),
    };
  }

  async canMessage(identifiers: Parameters<XmtpClientLike['canMessage']>[0]) {
    return new Map(identifiers.map(({ identifier }) => [
      identifier,
      !this.unreachableAddresses.has(identifier.toLowerCase()),
    ]));
  }
}

const notebook: NotebookSeed = {
  id: 'notebook-1',
  name: 'Team notebook',
  createdAt: 1,
  updatedAt: 1,
};

const baseNote: CrdtNoteInput = {
  id: 'note-1',
  title: 'Plan',
  content: 'middle',
  folderId: null,
  createdAt: 1,
  updatedAt: 1,
};

const collaborator = {
  address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  label: 'Bob',
};

const createSession = (
  client: FakeClient,
  options: Partial<NotebookCollaborationSessionOptions> = {},
) => {
  const projections: NotebookCrdtProjection[] = [];
  const states: Uint8Array[] = [];
  const session = new NotebookCollaborationSession({
    notebook,
    notes: [baseNote],
    client,
    onRemoteProjection: (projection) => projections.push(projection),
    onStateChange: (state) => states.push(state.slice()),
    ...options,
  });
  return { session, projections, states };
};

const settleMessages = async (rounds = 12) => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
};

const advance = async (milliseconds: number) => {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await settleMessages();
};

const decodeHistory = (state: FakeGroupState) => {
  const reassembler = new ProtocolReassembler();
  const decoded: Array<{
    senderInboxId: string;
    logical: StormdanceProtocolMessage;
  }> = [];

  for (const message of state.history) {
    const logical = reassembler.push(message.content);
    if (logical) decoded.push({ senderInboxId: message.senderInboxId, logical });
  }
  return decoded;
};

describe('NotebookCollaborationSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('treats persisted Yjs state as authoritative over stale materialized rows', async () => {
    const persisted = new NotebookCrdt(notebook.id);
    persisted.seed(
      { ...notebook, name: 'Persisted notebook', updatedAt: 10 },
      [{ ...baseNote, content: 'persisted remote content', updatedAt: 10 }],
    );
    const initialState = persisted.encodeUpdate();
    persisted.destroy();

    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const { session } = createSession(alice, {
      initialState,
      notes: [{ ...baseNote, content: 'stale IndexedDB content', updatedAt: 2 }],
    });

    expect(session.projection.notebook.name).toBe('Persisted notebook');
    expect(session.projection.notes[0]?.content).toBe('persisted remote content');
    await session.stop();
  });

  it('seeds note maps for a new group but not for an unpersisted existing-group replica', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);

    expect(first.session.projection.notes).toEqual([
      expect.objectContaining({ id: baseNote.id, content: baseNote.content }),
    ]);
    await first.session.start([collaborator]);

    const resumed = createSession(bob, {
      conversationId: first.session.topic,
      initialState: undefined,
      notes: [{ ...baseNote, content: 'stale materialized content' }],
    });
    expect(resumed.session.projection).toMatchObject({
      notebook: { id: notebook.id, name: notebook.name },
      notes: [],
    });

    await resumed.session.start();
    expect(resumed.session.projection.notes[0]?.content).toBe(baseNote.content);

    await resumed.session.stop();
    await first.session.stop();
  });

  it('recovers only newer or remotely absent local rows after shared note maps arrive', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);
    const state = network.creations[0].state;
    state.liveDeliveryEnabled = false;

    const resumed = createSession(bob, {
      conversationId: first.session.topic,
      initialState: undefined,
      notes: [
        { ...baseNote, content: 'newer offline materialized content', updatedAt: 2 },
        {
          id: 'offline-only-note',
          title: 'Offline only',
          content: 'Created before the first shared state arrived',
          folderId: null,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });
    expect(resumed.session.projection.notes).toEqual([]);

    await resumed.session.start();

    expect(resumed.session.projection.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: baseNote.id, content: 'newer offline materialized content' }),
      expect.objectContaining({ id: 'offline-only-note', title: 'Offline only' }),
    ]));
    expect(decodeHistory(state).filter(
      ({ senderInboxId, logical }) => senderInboxId === 'bob-inbox' && logical.kind === 'update',
    )).toHaveLength(1);

    await resumed.session.stop();
    await first.session.stop();
  });

  it('persists history and deferred recovery before projecting the materialized rows', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);
    network.creations[0].state.liveDeliveryEnabled = false;

    let releasePersistence: (() => void) | undefined;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const events: string[] = [];
    let persistedState: Uint8Array | undefined;
    const resumed = createSession(bob, {
      conversationId: first.session.topic,
      initialState: undefined,
      notes: [{
        id: 'offline-recovery-note',
        title: 'Recovered locally',
        content: 'must be durable before projection',
        folderId: null,
        createdAt: 2,
        updatedAt: 2,
      }],
      onStateChange: async (state) => {
        events.push('persist:start');
        persistedState = state.slice();
        await persistenceGate;
        events.push('persist:end');
      },
      onRemoteProjection: () => {
        events.push('project');
      },
    });
    const starting = resumed.session.start();
    await settleMessages(48);

    expect(events).toEqual(['persist:start']);
    expect(persistedState).toBeDefined();
    const durable = new NotebookCrdt(notebook.id);
    try {
      durable.applyUpdate(persistedState!);
      expect(durable.getNote('offline-recovery-note')).toMatchObject({
        title: 'Recovered locally',
        content: 'must be durable before projection',
      });
    } finally {
      durable.destroy();
    }

    releasePersistence?.();
    await starting;
    expect(events.slice(0, 3)).toEqual(['persist:start', 'persist:end', 'project']);

    await resumed.session.stop();
    await first.session.stop();
  });

  it('creates an admin-only XMTP group and announces the notebook protocol', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const { session, states } = createSession(alice);

    await expect(session.start([collaborator])).resolves.toBe('group-1');
    await settleMessages();

    expect(network.creations).toHaveLength(1);
    expect(network.creations[0]).toMatchObject({
      ownerAddress: alice.address,
      identifiers: [{ identifier: collaborator.address, identifierKind: 'Ethereum' }],
      options: {
        name: 'storm.dance · Team notebook',
        description: buildGroupDescription(notebook.id),
        permissions: 'admin-only',
      },
    });
    expect(session.topic).toBe('group-1');
    expect(network.creations[0].state.syncCount).toBe(1);
    expect(network.creations[0].state.lifecycle.slice(0, 3)).toEqual([
      'stream',
      'sync',
      'messages',
    ]);
    expect(network.creations[0].state.listMessageOptions).toEqual([{
      direction: SortDirection.Descending,
      limit: COLLABORATION_HISTORY_LIMIT,
    }]);
    expect(decodeHistory(network.creations[0].state).map(({ logical }) => logical.kind)).toEqual([
      'manifest',
      'snapshot',
      'sync-request',
    ]);
    expect(states).toHaveLength(1);

    await session.stop();
  });

  it('merges rapid local transactions into one send after the 250 ms batch window', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const { session } = createSession(alice);
    await session.start([collaborator]);
    await settleMessages();
    const state = network.creations[0].state;
    const baselineMessageCount = state.history.length;

    session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'first local edit',
      updatedAt: 2,
    });
    session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'second local edit',
      updatedAt: 3,
    });

    await advance(COLLABORATION_BATCH_MS - 1);
    expect(state.history).toHaveLength(baselineMessageCount);

    await advance(1);
    expect(state.history).toHaveLength(baselineMessageCount + 1);
    expect(decodeHistory(state).filter(({ logical }) => logical.kind === 'update')).toHaveLength(1);
    expect(session.projection.notes[0].content).toBe('second local edit');

    await session.stop();
  });

  it('does not publish a local batch until its complete state is durable', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    let blockPersistence = false;
    let releasePersistence: (() => void) | undefined;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const { session } = createSession(alice, {
      onStateChange: async () => {
        if (blockPersistence) await persistenceGate;
      },
    });
    await session.start([collaborator]);
    await settleMessages();
    const state = network.creations[0].state;
    const baselineMessageCount = state.history.length;
    blockPersistence = true;

    session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'durable before XMTP',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);

    expect(state.history).toHaveLength(baselineMessageCount);
    releasePersistence?.();
    await settleMessages(24);
    expect(state.history).toHaveLength(baselineMessageCount + 1);

    await session.stop();
  });

  it('projects, persists, and broadcasts a local native-vault update', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const { session, projections, states } = createSession(alice);
    await session.start([collaborator]);
    await settleMessages();
    const group = network.creations[0].state;
    const baselineMessageCount = group.history.length;

    const nativeReplica = new NotebookCrdt(notebook.id);
    nativeReplica.applyUpdate(states.at(-1)!);
    const before = nativeReplica.encodeStateVector();
    nativeReplica.upsertNote({
      ...baseNote,
      content: 'edited through the native Markdown vault',
      updatedAt: 2,
    });
    const nativeUpdate = nativeReplica.encodeDiff(before);
    nativeReplica.destroy();

    await expect(session.applyNativeUpdate(nativeUpdate)).resolves.toBe(true);
    expect(session.projection.notes[0].content).toBe('edited through the native Markdown vault');
    expect(projections.at(-1)?.notes[0].content)
      .toBe('edited through the native Markdown vault');
    expect(states.length).toBeGreaterThan(1);

    await advance(COLLABORATION_BATCH_MS);
    expect(group.history).toHaveLength(baselineMessageCount + 1);
    expect(decodeHistory(group).at(-1)?.logical.kind).toBe('update');

    await session.stop();
  });

  it('flushes edits captured while an existing conversation lookup is still pending', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);
    const state = network.creations[0].state;
    state.liveDeliveryEnabled = false;

    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    network.beforeNextConversationReturn = () => lookupGate;
    const second = createSession(bob, {
      notes: [],
      conversationId: first.session.topic,
    });
    const starting = second.session.start();
    await settleMessages();

    second.session.upsertLocalNote({
      id: 'note-created-during-startup',
      notebookId: notebook.id,
      title: 'Captured during startup',
      content: 'This update must not be stranded by the elapsed batch timer.',
      folderId: null,
      createdAt: 2,
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);
    expect(decodeHistory(state).filter(
      ({ senderInboxId, logical }) => senderInboxId === 'bob-inbox' && logical.kind === 'update',
    )).toHaveLength(0);

    releaseLookup?.();
    await starting;

    expect(decodeHistory(state).filter(
      ({ senderInboxId, logical }) => senderInboxId === 'bob-inbox' && logical.kind === 'update',
    )).toHaveLength(1);

    await second.session.stop();
    await first.session.stop();
  });

  it('captures a message published after stream startup but outside the history snapshot', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);

    const state = network.creations[0].state;
    state.beforeMessagesReturn = async () => {
      first.session.upsertLocalNote({
        ...baseNote,
        notebookId: notebook.id,
        content: 'published in the startup gap',
        updatedAt: 2,
      });
      await advance(COLLABORATION_BATCH_MS);
    };

    const second = createSession(bob, {
      notes: [],
      conversationId: first.session.topic,
    });
    await second.session.start();
    await settleMessages(24);

    expect(second.session.projection.notes[0]?.content).toBe('published in the startup gap');
    expect(state.listMessageOptions.at(-1)).toEqual({
      direction: SortDirection.Descending,
      limit: COLLABORATION_HISTORY_LIMIT,
    });

    await second.session.stop();
    await first.session.stop();
  });

  it('applies history and live updates sent by another installation of the same inbox', async () => {
    const network = new FakeXmtpNetwork();
    const firstInstallation = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'shared-inbox',
    );
    const secondInstallation = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'shared-inbox',
    );
    const first = createSession(firstInstallation);
    await first.session.start([collaborator]);

    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'loaded from history',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);

    const state = network.creations[0].state;
    state.liveDeliveryEnabled = false;
    const second = createSession(secondInstallation, {
      notes: [],
      conversationId: first.session.topic,
    });
    await second.session.start();
    await settleMessages();

    expect(second.session.projection.notes[0]?.content).toBe('loaded from history');

    state.liveDeliveryEnabled = true;
    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'received live',
      updatedAt: 3,
    });
    await advance(COLLABORATION_BATCH_MS);

    expect(second.session.projection.notes[0]?.content).toBe('received live');

    await second.session.stop();
    await first.session.stop();
  });

  it('materializes a bounded history replay only once', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);

    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'first historical edit',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);
    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'second historical edit',
      updatedAt: 3,
    });
    await advance(COLLABORATION_BATCH_MS);

    const state = network.creations[0].state;
    state.liveDeliveryEnabled = false;
    const second = createSession(bob, {
      notes: [],
      conversationId: first.session.topic,
    });
    await second.session.start();

    expect(second.session.projection.notes[0]?.content).toBe('second historical edit');
    expect(second.projections).toHaveLength(1);

    await second.session.stop();
    await first.session.stop();
  });

  it('ignores a malformed Yjs update in history and continues replaying later updates', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);
    const state = network.creations[0].state;
    state.liveDeliveryEnabled = false;
    const aliceView = [...state.views].find((view) => view.inboxId === 'alice-inbox');
    if (!aliceView) throw new Error('expected Alice to have a group view');

    aliceView.appendAndDeliver(encodeProtocolMessage({
      kind: 'update',
      notebookId: notebook.id,
      messageId: 'poison-history-update',
      sentAt: Date.now(),
      update: new Uint8Array([0xff]),
    })[0], 'malicious-inbox');
    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'valid update after poison history',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);

    const second = createSession(bob, {
      notes: [],
      conversationId: first.session.topic,
    });
    await expect(second.session.start()).resolves.toBe(first.session.topic);

    expect(second.session.projection.notes[0]?.content).toBe('valid update after poison history');
    expect(second.projections).toHaveLength(1);

    await second.session.stop();
    await first.session.stop();
  });

  it('does not recover or project history for a valid but state-vector-neutral update', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);
    const state = network.creations[0].state;
    state.liveDeliveryEnabled = false;
    const manifestOnly = state.history.filter((message) => message.content.includes('"kind":"manifest"'));
    state.history.splice(0, state.history.length, ...manifestOnly);
    const aliceView = [...state.views].find((view) => view.inboxId === 'alice-inbox');
    if (!aliceView) throw new Error('expected Alice to have a group view');
    aliceView.appendAndDeliver(encodeProtocolMessage({
      kind: 'snapshot',
      notebookId: notebook.id,
      messageId: 'empty-history-snapshot',
      sentAt: Date.now(),
      update: new Uint8Array([0, 0]),
    })[0], 'alice-inbox');

    const second = createSession(bob, {
      notes: [{ ...baseNote, content: 'must not be materialized' }],
      conversationId: first.session.topic,
    });
    await second.session.start();

    expect(second.projections).toHaveLength(0);
    expect(second.states).toHaveLength(0);
    expect(second.session.projection.notes).toEqual([]);

    await second.session.stop();
    await first.session.stop();
  });

  it('ignores malformed live Yjs updates without poisoning the serialized message queue', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);
    const second = createSession(bob, {
      notes: [],
      conversationId: first.session.topic,
    });
    await second.session.start();
    await settleMessages(24);

    const state = network.creations[0].state;
    const aliceView = [...state.views].find((view) => view.inboxId === 'alice-inbox');
    if (!aliceView) throw new Error('expected Alice to have a group view');
    const baselineProjectionCount = second.projections.length;
    aliceView.appendAndDeliver(encodeProtocolMessage({
      kind: 'snapshot',
      notebookId: notebook.id,
      messageId: 'poison-live-snapshot',
      sentAt: Date.now(),
      update: new Uint8Array([0xff]),
    })[0], 'malicious-inbox');
    await settleMessages(24);
    expect(second.projections).toHaveLength(baselineProjectionCount);

    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'valid live update after poison',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);

    expect(second.session.projection.notes[0]?.content).toBe('valid live update after poison');
    expect(second.projections).toHaveLength(baselineProjectionCount + 1);

    await second.session.stop();
    await first.session.stop();
  });

  it('awaits live-state persistence before projecting it', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);

    let persistenceGate: Promise<void> | null = null;
    let releasePersistence: (() => void) | undefined;
    const events: string[] = [];
    let persistedState: Uint8Array | undefined;
    const second = createSession(bob, {
      notes: [],
      conversationId: first.session.topic,
      onStateChange: async (state) => {
        if (!persistenceGate) return;
        events.push('persist:start');
        persistedState = state.slice();
        await persistenceGate;
        events.push('persist:end');
      },
      onRemoteProjection: () => {
        if (persistenceGate) events.push('project');
      },
    });
    await second.session.start();
    await settleMessages(48);
    persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });

    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'live state durable before projection',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);

    expect(events).toEqual(['persist:start']);
    expect(second.session.projection.notes[0]?.content).toBe(
      'live state durable before projection',
    );
    const durable = new NotebookCrdt(notebook.id);
    try {
      durable.applyUpdate(persistedState!);
      expect(durable.getNote(baseNote.id)?.content).toBe(
        'live state durable before projection',
      );
    } finally {
      durable.destroy();
    }

    releasePersistence?.();
    await settleMessages(48);
    expect(events.slice(0, 3)).toEqual(['persist:start', 'persist:end', 'project']);

    await second.session.stop();
    await first.session.stop();
  });

  it('ignores a malformed live Yjs state vector and continues processing updates', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);
    const second = createSession(bob, {
      notes: [],
      conversationId: first.session.topic,
    });
    await second.session.start();
    await settleMessages(24);

    const state = network.creations[0].state;
    const aliceView = [...state.views].find((view) => view.inboxId === 'alice-inbox');
    if (!aliceView) throw new Error('expected Alice to have a group view');
    aliceView.appendAndDeliver(encodeProtocolMessage({
      kind: 'sync-request',
      notebookId: notebook.id,
      messageId: 'poison-live-state-vector',
      sentAt: Date.now(),
      requestId: 'poison-request',
      stateVector: new Uint8Array([0xff]),
    })[0], 'malicious-inbox');
    await settleMessages(24);

    second.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'valid update after malformed state vector',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);

    expect(first.session.projection.notes[0]?.content)
      .toBe('valid update after malformed state vector');

    await second.session.stop();
    await first.session.stop();
  });

  it('converges concurrent edits from two XMTP inboxes', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    let sharedBase: Uint8Array | undefined;
    const first = createSession(alice, {
      onStateChange: (state) => {
        sharedBase = state.slice();
      },
    });
    await first.session.start([collaborator]);
    if (!sharedBase) throw new Error('expected the first replica to persist its state');

    const second = createSession(bob, {
      initialState: sharedBase,
      conversationId: first.session.topic,
    });
    await second.session.start();
    await settleMessages();

    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'LEFT middle',
      updatedAt: 2,
    });
    second.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'middle RIGHT',
      updatedAt: 3,
    });
    await advance(COLLABORATION_BATCH_MS);

    expect(first.session.projection).toEqual(second.session.projection);
    expect(first.session.projection.notes[0].content).toContain('LEFT');
    expect(first.session.projection.notes[0].content).toContain('RIGHT');

    await second.session.stop();
    await first.session.stop();
  });

  it('uses a bidirectional state-vector handshake to repair offline replicas', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    let sharedBase: Uint8Array | undefined;
    const first = createSession(alice, {
      onStateChange: (state) => {
        sharedBase = state.slice();
      },
    });
    await first.session.start([collaborator]);
    if (!sharedBase) throw new Error('expected the first replica to persist its state');
    const offlineBase = sharedBase.slice();

    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'online content',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);

    const offlineReplica = new NotebookCrdt(notebook.id);
    offlineReplica.applyUpdate(offlineBase);
    offlineReplica.upsertNote({ ...baseNote, title: 'offline title', updatedAt: 3 });
    const offlineState = offlineReplica.encodeUpdate();
    offlineReplica.destroy();

    const second = createSession(bob, {
      initialState: offlineState,
      conversationId: first.session.topic,
    });
    await second.session.start();
    await settleMessages(24);

    expect(first.session.projection).toEqual(second.session.projection);
    expect(first.session.projection.notes[0]).toMatchObject({
      title: 'offline title',
      content: 'online content',
    });

    const logicalMessages = decodeHistory(network.creations[0].state).map(({ logical }) => logical);
    const request = logicalMessages.findLast((message) => message.kind === 'sync-request');
    expect(request?.kind).toBe('sync-request');
    if (request?.kind !== 'sync-request') throw new Error('expected a sync request');

    const responses = logicalMessages.filter(
      (message) => message.kind === 'update' && message.requestId === request.requestId,
    );
    expect(responses).toHaveLength(2);
    expect(responses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'update',
        targetInboxId: 'bob-inbox',
        responderStateVector: expect.any(Uint8Array),
      }),
      expect.objectContaining({
        kind: 'update',
        targetInboxId: 'alice-inbox',
      }),
    ]));

    await second.session.stop();
    await first.session.stop();
  });

  it('replays bounded history and requests a fresh state vector when the stream restarts', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    const first = createSession(alice);
    await first.session.start([collaborator]);
    const second = createSession(bob, {
      notes: [],
      conversationId: first.session.topic,
    });
    await second.session.start();
    await settleMessages(24);

    const state = network.creations[0].state;
    const baselineSyncCount = state.syncCount;
    const baselineRequestCount = decodeHistory(state)
      .filter(({ logical }) => logical.kind === 'sync-request').length;
    state.liveDeliveryEnabled = false;
    first.session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'missed while the stream was down',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);
    expect(second.session.projection.notes[0]?.content).not.toBe('missed while the stream was down');

    state.liveDeliveryEnabled = true;
    const bobView = [...state.views].find((view) => view.inboxId === 'bob-inbox');
    if (!bobView) throw new Error('expected Bob to have a group view');
    bobView.restartStream();
    await settleMessages(48);

    expect(second.session.projection.notes[0]?.content).toBe('missed while the stream was down');
    expect(state.syncCount).toBe(baselineSyncCount + 1);
    expect(decodeHistory(state).filter(({ logical }) => logical.kind === 'sync-request'))
      .toHaveLength(baselineRequestCount + 1);
    expect(state.listMessageOptions.at(-1)).toEqual({
      direction: SortDirection.Descending,
      limit: COLLABORATION_HISTORY_LIMIT,
    });

    await second.session.stop();
    await first.session.stop();
  });

  it('flushes pending changes and closes the XMTP stream exactly once', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const { session } = createSession(alice);
    await session.start([collaborator]);
    const state = network.creations[0].state;
    const baselineMessageCount = state.history.length;
    expect(network.activeStreamCount).toBe(1);

    session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'flush me while stopping',
      updatedAt: 2,
    });
    await session.stop();

    expect(state.history).toHaveLength(baselineMessageCount + 1);
    expect(state.endedStreamCount).toBe(1);
    expect(network.activeStreamCount).toBe(0);

    await session.stop();
    expect(state.endedStreamCount).toBe(1);
  });

  it('waits for a timer-owned in-flight update send before closing the stream', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const { session } = createSession(alice);
    await session.start([collaborator]);
    const state = network.creations[0].state;
    const baselineMessageCount = state.history.length;
    let releaseSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    state.beforeSendReturn = () => sendGate;

    session.upsertLocalNote({
      ...baseNote,
      notebookId: notebook.id,
      content: 'in-flight while stop begins',
      updatedAt: 2,
    });
    await advance(COLLABORATION_BATCH_MS);

    let stopSettled = false;
    const stopping = session.stop().then(() => {
      stopSettled = true;
    });
    await settleMessages();
    expect(stopSettled).toBe(false);
    expect(state.endedStreamCount).toBe(0);

    releaseSend?.();
    await stopping;

    expect(state.history).toHaveLength(baselineMessageCount + 1);
    expect(state.endedStreamCount).toBe(1);
  });

  it('persists a live update already delivered when shutdown begins', async () => {
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const bob = network.createClient(collaborator.address, 'bob-inbox');
    let sharedState: Uint8Array | undefined;
    const first = createSession(alice, {
      onStateChange: (state) => {
        sharedState = state.slice();
      },
    });
    await first.session.start([collaborator]);
    if (!sharedState) throw new Error('expected the first replica to persist state');

    const second = createSession(bob, {
      initialState: sharedState,
      conversationId: first.session.topic,
    });
    await second.session.start();
    await settleMessages(48);
    second.states.length = 0;

    const remote = new NotebookCrdt(notebook.id);
    remote.applyUpdate(sharedState);
    const remoteVector = remote.encodeStateVector();
    remote.upsertNote({
      ...baseNote,
      content: 'delivered immediately before browser shutdown',
      updatedAt: 2,
    });
    const state = network.creations[0].state;
    const aliceView = [...state.views].find((view) => view.inboxId === 'alice-inbox');
    if (!aliceView) throw new Error('expected Alice to have a group view');
    aliceView.appendAndDeliver(encodeProtocolMessage({
      kind: 'update',
      notebookId: notebook.id,
      messageId: 'browser-shutdown-boundary-update',
      sentAt: Date.now(),
      update: remote.encodeDiff(remoteVector),
    })[0], 'remote-inbox');

    await second.session.stop();

    const durable = new NotebookCrdt(notebook.id);
    try {
      durable.applyUpdate(second.states.at(-1)!);
      expect(durable.getNote(baseNote.id)?.content).toBe(
        'delivered immediately before browser shutdown',
      );
    } finally {
      durable.destroy();
      remote.destroy();
    }
    expect(state.endedStreamCount).toBe(1);

    await first.session.stop();
  });

  it('releases CRDT resources even when stream shutdown and persistence fail', async () => {
    const stopCapturing = vi.fn();
    vi.spyOn(NotebookCrdt.prototype, 'captureLocalUpdates').mockReturnValue(stopCapturing);
    const destroy = vi.spyOn(NotebookCrdt.prototype, 'destroy');
    const network = new FakeXmtpNetwork();
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    let failPersistence = false;
    let persistenceAttempts = 0;
    const { session } = createSession(alice, {
      onStateChange: () => {
        persistenceAttempts += 1;
        if (failPersistence) throw new Error('state persistence failed');
      },
    });
    await session.start([collaborator]);
    const state = network.creations[0].state;
    state.failStreamEnd = new Error('stream shutdown failed');
    failPersistence = true;

    const firstStop = session.stop();
    const secondStop = session.stop();
    expect(secondStop).toBe(firstStop);
    await expect(firstStop).rejects.toThrow('stream shutdown failed');

    expect(state.endedStreamCount).toBe(1);
    expect(persistenceAttempts).toBe(2);
    expect(stopCapturing).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('closes a stream that resolves after startup has been cancelled', async () => {
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const network = new FakeXmtpNetwork();
    network.beforeNextStreamReturn = () => streamGate;
    const alice = network.createClient(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'alice-inbox',
    );
    const { session } = createSession(alice);

    const starting = session.start([collaborator]);
    await settleMessages(12);
    expect(network.activeStreamCount).toBe(1);
    await session.stop();
    releaseStream?.();

    await expect(starting).rejects.toThrow('XMTP collaboration session was stopped');
    expect(network.creations[0].state.endedStreamCount).toBe(1);
    expect(network.activeStreamCount).toBe(0);
  });
});
