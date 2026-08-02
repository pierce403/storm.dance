import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotebookCrdt } from '../src/lib/collaboration/crdt.js';
import {
  ProtocolReassembler,
  encodeProtocolMessage,
  type StormdanceProtocolMessage,
} from '../src/lib/collaboration/protocol.js';
import {
  materializeMirror,
  obsidianPathFolderId,
  parseMirrorNote,
  readMirrorManifest,
  serializeMirrorNote,
} from './markdown.js';
import {
  LINK_CONFIG_SCHEMA,
  SYNC_REQUEST_TTL_MS,
  NotebookDirectorySync,
  discoverStormdanceNotebooks,
  parseNotebookGroupDescription,
  readCrdtState,
  readLinkConfig,
  resolveNotebookGroup,
  runDirectorySync,
  writeCrdtState,
  writeLinkConfig,
  type LinkConfig,
  type NotebookDirectorySyncWriters,
} from './sync.js';
import type {
  XmtpGroupAdapter,
  XmtpGroupMessage,
  XmtpGroupStreamOptions,
} from './xmtp.js';

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stormdance-sync-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

const config = (overrides: Partial<LinkConfig> = {}): LinkConfig => ({
  schema: LINK_CONFIG_SCHEMA,
  notebookId: 'notebook-1',
  conversationId: 'conversation-1',
  notebookName: 'Shared notes',
  profile: 'default',
  env: 'dev',
  ...overrides,
});

class FakeGroup implements XmtpGroupAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sent: string[] = [];
  readonly history: XmtpGroupMessage[] = [];
  readonly calls: string[] = [];
  streamEndCount = 0;
  private streamOptions: XmtpGroupStreamOptions | null = null;
  private nextMessage = 0;

  allow(): void {}

  sync(): Promise<void> {
    this.calls.push('sync');
    return Promise.resolve();
  }

  constructor(options: {
    id?: string;
    name?: string;
    notebookId?: string;
  } = {}) {
    this.id = options.id ?? 'conversation-1';
    this.name = options.name ?? 'storm.dance · Shared notes';
    this.description = `storm.dance/yjs/1/${encodeURIComponent(options.notebookId ?? 'notebook-1')}`;
  }

  messages(): Promise<XmtpGroupMessage[]> {
    this.calls.push('history');
    return Promise.resolve([...this.history]);
  }

  async sendText(text: string): Promise<string> {
    this.sent.push(text);
    return `sent-${this.sent.length}`;
  }

  stream(options: XmtpGroupStreamOptions) {
    this.calls.push('stream');
    this.streamOptions = options;
    let done = false;
    return Promise.resolve({
      get isDone() {
        return done;
      },
      end: async () => {
        done = true;
        this.streamEndCount += 1;
        this.streamOptions = null;
      },
    });
  }

  addHistory(message: StormdanceProtocolMessage, senderInboxId = 'peer-inbox') {
    for (const content of encodeProtocolMessage(message)) {
      this.history.push(this.makeMessage(content, senderInboxId));
    }
  }

  emit(message: StormdanceProtocolMessage, senderInboxId = 'peer-inbox') {
    for (const content of encodeProtocolMessage(message)) {
      this.streamOptions?.onMessage(this.makeMessage(content, senderInboxId));
    }
  }

  restart() {
    this.calls.push('restart');
    this.streamOptions?.onRestart?.();
  }

  private makeMessage(content: string, senderInboxId: string): XmtpGroupMessage {
    return {
      id: `message-${++this.nextMessage}`,
      conversationId: this.id,
      senderInboxId,
      sentAt: new Date(),
      kind: 0,
      content,
    };
  }
}

const remoteDocument = () => {
  const crdt = new NotebookCrdt('notebook-1');
  crdt.seed(
    { id: 'notebook-1', name: 'Shared notes', createdAt: 10, updatedAt: 20 },
    [{
      id: 'note-1',
      title: 'Remote note',
      content: 'from XMTP',
      folderId: null,
      createdAt: 11,
      updatedAt: 20,
    }],
  );
  return crdt;
};

const logicalMessages = (chunks: readonly string[]): StormdanceProtocolMessage[] => {
  const reassembler = new ProtocolReassembler();
  return chunks
    .map((chunk) => reassembler.push(chunk))
    .filter((message): message is StormdanceProtocolMessage => message !== null);
};

describe('notebook group discovery', () => {
  it('parses encoded notebook IDs and resolves notebook or conversation selectors', () => {
    const first = new FakeGroup({ notebookId: 'notebook / one', id: 'group-a' });
    const second = new FakeGroup({ notebookId: 'notebook-2', id: 'group-b' });
    const unrelated = {
      ...new FakeGroup({ id: 'group-c' }),
      description: 'some-other-app',
    } as XmtpGroupAdapter;

    expect(parseNotebookGroupDescription(first.description)).toBe('notebook / one');
    expect(discoverStormdanceNotebooks([unrelated, second, first]).map((item) => item.notebookId))
      .toEqual(['notebook / one', 'notebook-2']);
    expect(resolveNotebookGroup([first, second], 'group-b').notebookId).toBe('notebook-2');
    expect(resolveNotebookGroup([first, second], 'notebook / one').group.id).toBe('group-a');
  });

  it('requires a conversation ID when duplicate groups use the same notebook ID', () => {
    const first = new FakeGroup({ id: 'group-a' });
    const second = new FakeGroup({ id: 'group-b' });
    expect(() => resolveNotebookGroup([first, second], 'notebook-1')).toThrow(
      'More than one XMTP group',
    );
  });
});

describe('link config persistence', () => {
  it('round-trips strict config and refuses to silently relink a directory', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    expect(await readLinkConfig(root)).toEqual(config());

    await expect(writeLinkConfig(root, config({ notebookId: 'other' }))).rejects.toThrow(
      'already linked',
    );
    await expect(writeLinkConfig(root, config({ profile: 'other-profile' }))).rejects.toThrow(
      'already linked',
    );
    await expect(writeLinkConfig(root, config({ env: 'production' }))).rejects.toThrow(
      'already linked',
    );

    const legacyRoot = await makeTemporaryDirectory();
    await mkdir(path.join(legacyRoot, '.stormdance'));
    await writeFile(
      path.join(legacyRoot, '.stormdance', 'config.json'),
      `${JSON.stringify({ ...config(), schema: 1 })}\n`,
      'utf8',
    );
    expect(await readLinkConfig(legacyRoot)).toEqual(config());
  });
});

describe('directory sync', () => {
  it('fails closed when a copied vault is opened by the wrong XMTP inbox', () => {
    expect(() => new NotebookDirectorySync({
      rootDirectory: '/unused',
      config: config({ expectedInboxId: 'expected-inbox' }),
      group: new FakeGroup(),
      inboxId: 'different-inbox',
    })).toThrow('expects XMTP inbox expected-inbox');
  });

  it('replays XMTP history, materializes Markdown, persists Yjs, and requests a delta', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    group.addHistory({
      kind: 'update',
      notebookId: 'notebook-1',
      messageId: 'invalid-yjs',
      sentAt: 29,
      update: new Uint8Array([255]),
    });
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'snapshot-1',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });

    const warnings: string[] = [];
    const result = await runDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
      handshakeWaitMs: 0,
      onWarning: (message) => warnings.push(message),
    });

    expect(result.projection.notes).toEqual([
      expect.objectContaining({ id: 'note-1', title: 'Remote note', content: 'from XMTP' }),
    ]);
    const markdownFile = (await import('node:fs/promises'))
      .readdir(root)
      .then((entries) => entries.find((entry) => entry.endsWith('.md')));
    const relativePath = await markdownFile;
    expect(relativePath).toBeTruthy();
    expect(parseMirrorNote(await readFile(path.join(root, relativePath!), 'utf8'))).toMatchObject({
      id: 'note-1',
      notebookId: 'notebook-1',
      content: 'from XMTP',
    });
    expect((await readCrdtState(root))?.byteLength).toBeGreaterThan(0);
    expect(logicalMessages(group.sent).some((message) => message.kind === 'sync-request')).toBe(true);
    expect(warnings).toContain('Rejected an invalid Yjs update.');
    remote.destroy();
  });

  it('materializes remote folder trees and publishes an empty CLI directory as CRDT state', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    remote.upsertFolder({
      id: 'remote-folder',
      name: 'Research',
      parentFolderId: null,
      createdAt: 21,
      updatedAt: 21,
    });
    remote.upsertNote({
      ...remote.snapshot().notes[0],
      folderId: 'remote-folder',
      updatedAt: 22,
    });
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'folder-snapshot',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
    });
    await session.start();

    const manifest = await readMirrorManifest(root);
    expect(manifest.folders['remote-folder']).toBe('Research');
    expect(manifest.notes['note-1'].path).toMatch(/^Research\//u);
    expect(parseMirrorNote(
      await readFile(path.join(root, manifest.notes['note-1'].path), 'utf8'),
    )).toMatchObject({ id: 'note-1', folderId: 'remote-folder' });

    await mkdir(path.join(root, 'Ideas'));
    await session.scanNow();
    const ideasId = obsidianPathFolderId('notebook-1', 'Ideas');
    expect(session.projection.folders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ideasId,
        name: 'Ideas',
        parentFolderId: null,
        deleted: false,
      }),
    ]));
    await session.stop();

    for (const message of logicalMessages(group.sent)) {
      if (message.kind === 'update' && !message.targetInboxId) remote.applyUpdate(message.update);
    }
    expect(remote.snapshot().folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ideasId, name: 'Ideas' }),
    ]));
    remote.destroy();
  });

  it('ignores a malformed Yjs state vector without poisoning later live updates', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'state-vector-base',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });
    const warnings: string[] = [];
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
      onWarning: (message) => warnings.push(message),
    });
    await session.start();

    group.emit({
      kind: 'sync-request',
      notebookId: 'notebook-1',
      messageId: 'invalid-state-vector',
      sentAt: 40,
      requestId: 'invalid-state-vector-request',
      stateVector: new Uint8Array([0xff]),
    });
    const remoteVector = remote.encodeStateVector();
    remote.upsertNote({
      id: 'note-1',
      title: 'Remote note',
      content: 'valid update after malformed state vector',
      folderId: null,
      createdAt: 11,
      updatedAt: 41,
    });
    group.emit({
      kind: 'update',
      notebookId: 'notebook-1',
      messageId: 'valid-after-invalid-state-vector',
      sentAt: 41,
      update: remote.encodeDiff(remoteVector),
    });
    await session.scanNow();

    expect(warnings).toContain('Rejected an invalid Yjs state vector.');
    expect(session.projection.notes[0]?.content)
      .toBe('valid update after malformed state vector');

    await session.stop();
    remote.destroy();
  });

  it('completes the two-way state-vector handshake with another installation of the same inbox', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    await writeFile(path.join(root, 'local.md'), '# Local note\n\nfrom the CLI', 'utf8');
    const group = new FakeGroup();
    const peer = remoteDocument();
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'shared-inbox',
    });
    await session.start();

    const request = logicalMessages(group.sent).find(
      (message): message is Extract<StormdanceProtocolMessage, { kind: 'sync-request' }> =>
        message.kind === 'sync-request',
    );
    expect(request).toBeDefined();
    const sentBeforeResponse = group.sent.length;
    group.emit(
      {
        kind: 'update',
        notebookId: 'notebook-1',
        messageId: 'peer-response',
        sentAt: 50,
        requestId: request!.requestId,
        targetInboxId: 'shared-inbox',
        responderStateVector: peer.encodeStateVector(),
        update: peer.encodeDiff(request!.stateVector),
      },
      // XMTP installations owned by the same identity share an inbox ID. The
      // incoming message must still be applied when its message ID is not ours.
      'shared-inbox',
    );
    await session.scanNow();

    expect(session.projection.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'note-1', content: 'from XMTP' }),
      expect.objectContaining({ title: 'Local note', content: 'from the CLI' }),
    ]));
    const reverse = logicalMessages(group.sent.slice(sentBeforeResponse)).find(
      (message): message is Extract<StormdanceProtocolMessage, { kind: 'update' }> =>
        message.kind === 'update'
        && message.requestId === request!.requestId
        && message.targetInboxId === 'shared-inbox',
    );
    expect(reverse).toBeDefined();
    peer.applyUpdate(reverse!.update);
    expect(peer.snapshot().notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'note-1' }),
      expect.objectContaining({ title: 'Local note', content: 'from the CLI' }),
    ]));

    await session.stop();
    peer.destroy();
  });

  it('returns a reverse delta to every responder for one active sync request', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    await writeFile(path.join(root, 'local.md'), '# Local note\n\nfrom the CLI', 'utf8');
    const group = new FakeGroup();
    const firstPeer = remoteDocument();
    const secondPeer = new NotebookCrdt('notebook-1');
    secondPeer.seed(
      { id: 'notebook-1', name: 'Shared notes', createdAt: 10, updatedAt: 20 },
      [{
        id: 'note-2',
        title: 'Second peer note',
        content: 'from another installation',
        folderId: null,
        createdAt: 12,
        updatedAt: 20,
      }],
    );
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'shared-inbox',
    });
    await session.start();

    const request = logicalMessages(group.sent).find(
      (message): message is Extract<StormdanceProtocolMessage, { kind: 'sync-request' }> =>
        message.kind === 'sync-request',
    );
    expect(request).toBeDefined();
    const sentBeforeResponses = group.sent.length;
    for (const [messageId, peer] of [
      ['first-peer-response', firstPeer],
      ['second-peer-response', secondPeer],
    ] as const) {
      group.emit({
        kind: 'update',
        notebookId: 'notebook-1',
        messageId,
        sentAt: 50,
        requestId: request!.requestId,
        targetInboxId: 'shared-inbox',
        responderStateVector: peer.encodeStateVector(),
        update: peer.encodeDiff(request!.stateVector),
      }, 'shared-inbox');
    }
    await session.scanNow();

    const reverses = logicalMessages(group.sent.slice(sentBeforeResponses)).filter(
      (message): message is Extract<StormdanceProtocolMessage, { kind: 'update' }> =>
        message.kind === 'update'
        && message.requestId === request!.requestId
        && message.targetInboxId === 'shared-inbox',
    );
    expect(reverses).toHaveLength(2);
    firstPeer.applyUpdate(reverses[0].update);
    secondPeer.applyUpdate(reverses[1].update);
    for (const peer of [firstPeer, secondPeer]) {
      expect(peer.snapshot().notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Local note', content: 'from the CLI' }),
      ]));
    }

    await session.stop();
    firstPeer.destroy();
    secondPeer.destroy();
  });

  it('bounds reverse-delta eligibility with the sync request TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
      const root = await makeTemporaryDirectory();
      await writeLinkConfig(root, config());
      const group = new FakeGroup();
      const peer = remoteDocument();
      const session = new NotebookDirectorySync({
        rootDirectory: root,
        config: config(),
        group,
        inboxId: 'cli-inbox',
      });
      await session.start();

      const request = logicalMessages(group.sent).find(
        (message): message is Extract<StormdanceProtocolMessage, { kind: 'sync-request' }> =>
          message.kind === 'sync-request',
      );
      expect(request).toBeDefined();
      const sentBeforeResponse = group.sent.length;
      vi.setSystemTime(new Date(Date.now() + SYNC_REQUEST_TTL_MS + 1));
      group.emit({
        kind: 'update',
        notebookId: 'notebook-1',
        messageId: 'expired-request-response',
        sentAt: Date.now(),
        requestId: request!.requestId,
        targetInboxId: 'cli-inbox',
        responderStateVector: peer.encodeStateVector(),
        update: peer.encodeDiff(request!.stateVector),
      });
      await session.scanNow();

      expect(logicalMessages(group.sent.slice(sentBeforeResponse)).filter(
        (message) => message.kind === 'update' && message.requestId === request!.requestId,
      )).toEqual([]);

      await session.stop();
      peer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('scans unsynced disk edits before projecting a live update received during startup', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const base = remoteDocument();
    const baseState = base.encodeUpdate();
    const firstGroup = new FakeGroup();
    firstGroup.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'base-snapshot',
      sentAt: 30,
      update: baseState,
    });
    await runDirectorySync({
      rootDirectory: root,
      config: config(),
      group: firstGroup,
      inboxId: 'cli-inbox',
      handshakeWaitMs: 0,
    });

    const relativePath = (await (await import('node:fs/promises')).readdir(root))
      .find((entry) => entry.endsWith('.md'))!;
    const canonicalPath = path.join(root, relativePath);
    const local = parseMirrorNote(await readFile(canonicalPath, 'utf8'));
    await writeFile(
      canonicalPath,
      serializeMirrorNote({ ...local, content: 'unsynced disk edit' }),
      'utf8',
    );

    const remoteStateVector = base.encodeStateVector();
    base.upsertNote({
      id: 'note-1',
      title: 'Remote note',
      content: 'live remote edit',
      folderId: null,
      createdAt: 11,
      updatedAt: 40,
    });
    const liveUpdate = base.encodeDiff(remoteStateVector);
    class ImmediateLiveGroup extends FakeGroup {
      override async stream(options: XmtpGroupStreamOptions) {
        const stream = await super.stream(options);
        this.emit({
          kind: 'update',
          notebookId: 'notebook-1',
          messageId: 'live-during-start',
          sentAt: 40,
          update: liveUpdate,
        });
        return stream;
      }
    }
    const secondGroup = new ImmediateLiveGroup();
    secondGroup.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'base-snapshot',
      sentAt: 30,
      update: baseState,
    });
    await runDirectorySync({
      rootDirectory: root,
      config: config(),
      group: secondGroup,
      inboxId: 'cli-inbox',
      handshakeWaitMs: 0,
    });

    expect(parseMirrorNote(await readFile(canonicalPath, 'utf8')).content).toBe(
      'unsynced disk edit',
    );
    base.destroy();
  });

  it('preserves unsynced edits and deletions when a live remote update wins the queue', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'dirty-race-snapshot',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
    });
    await session.start({ watch: true });

    const relativePath = (await (await import('node:fs/promises')).readdir(root))
      .find((entry) => entry.endsWith('.md'))!;
    const canonicalPath = path.join(root, relativePath);
    const local = parseMirrorNote(await readFile(canonicalPath, 'utf8'));
    await writeFile(
      canonicalPath,
      serializeMirrorNote({ ...local, content: 'unsynced local edit' }),
      'utf8',
    );

    let remoteVector = remote.encodeStateVector();
    remote.upsertNote({
      id: 'note-2',
      title: 'Unrelated remote note',
      content: 'remote content',
      folderId: null,
      createdAt: 30,
      updatedAt: 40,
    });
    group.emit({
      kind: 'update',
      notebookId: 'notebook-1',
      messageId: 'remote-update-before-dirty-scan',
      sentAt: 40,
      update: remote.encodeDiff(remoteVector),
    });
    await session.scanNow();

    expect(parseMirrorNote(await readFile(canonicalPath, 'utf8')).content).toBe(
      'unsynced local edit',
    );
    expect(session.projection.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'note-2', content: 'remote content' }),
    ]));

    await unlink(canonicalPath);
    remoteVector = remote.encodeStateVector();
    remote.upsertNote({
      id: 'note-3',
      title: 'Another remote note',
      content: 'more remote content',
      folderId: null,
      createdAt: 40,
      updatedAt: 50,
    });
    group.emit({
      kind: 'update',
      notebookId: 'notebook-1',
      messageId: 'remote-update-before-deletion-scan',
      sentAt: 50,
      update: remote.encodeDiff(remoteVector),
    });
    await session.scanNow();

    await expect(readFile(canonicalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(session.projection.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'note-1', deleted: true }),
      expect.objectContaining({ id: 'note-3', content: 'more remote content' }),
    ]));

    await session.stop();
    remote.destroy();
  });

  it('keeps an invalid owned Markdown replacement intact for user repair', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'invalid-file-snapshot',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });
    const warnings: string[] = [];
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
      onWarning: (message) => warnings.push(message),
    });
    await session.start();

    const relativePath = (await (await import('node:fs/promises')).readdir(root))
      .find((entry) => entry.endsWith('.md'))!;
    const canonicalPath = path.join(root, relativePath);
    const invalidReplacement = '<!-- stormdance:{not-json} -->\n# unfinished\n\nkeep me';
    await writeFile(canonicalPath, invalidReplacement, 'utf8');
    await session.scanNow();

    expect(await readFile(canonicalPath, 'utf8')).toBe(invalidReplacement);
    expect(warnings).toEqual(expect.arrayContaining([
      'Ignored 1 unsafe or invalid Markdown file(s).',
      'Preserved 1 unsynced or invalid owned Markdown file(s).',
    ]));

    await session.stop();
    remote.destroy();
  });

  it('materializes and persists updates recovered by stream restart history', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'restart-base-snapshot',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
    });
    await session.start();
    expect(group.calls.slice(0, 3)).toEqual(['stream', 'sync', 'history']);
    group.calls.length = 0;

    const relativePath = (await (await import('node:fs/promises')).readdir(root))
      .find((entry) => entry.endsWith('.md'))!;
    const canonicalPath = path.join(root, relativePath);
    const remoteVector = remote.encodeStateVector();
    remote.upsertNote({
      id: 'note-1',
      title: 'Remote note',
      content: 'recovered after restart',
      folderId: null,
      createdAt: 11,
      updatedAt: 60,
    });
    group.addHistory({
      kind: 'update',
      notebookId: 'notebook-1',
      messageId: 'restart-missed-update',
      sentAt: 60,
      update: remote.encodeDiff(remoteVector),
    });
    group.restart();

    await vi.waitFor(async () => {
      expect(parseMirrorNote(await readFile(canonicalPath, 'utf8')).content).toBe(
        'recovered after restart',
      );
      const state = await readCrdtState(root);
      expect(state?.byteLength).toBeGreaterThan(0);
      const persisted = new NotebookCrdt('notebook-1');
      try {
        persisted.applyUpdate(state!);
        expect(persisted.getNote('note-1')?.content).toBe('recovered after restart');
      } finally {
        persisted.destroy();
      }
    }, { timeout: 1_000, interval: 10 });
    expect(group.calls.slice(0, 3)).toEqual(['restart', 'sync', 'history']);

    await session.stop();
    remote.destroy();
  });

  it('durably commits CRDT state before advancing Markdown and its manifest', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'durability-base-snapshot',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });

    const writes: string[] = [];
    let failProjection = false;
    let resolveProjectionFailure: (() => void) | undefined;
    const projectionFailed = new Promise<void>((resolve) => {
      resolveProjectionFailure = resolve;
    });
    const writers: NotebookDirectorySyncWriters = {
      writeState: async (writerRoot, state) => {
        writes.push('state');
        await writeCrdtState(writerRoot, state);
      },
      materialize: async (writerRoot, notes, options) => {
        writes.push('markdown');
        if (failProjection) {
          resolveProjectionFailure?.();
          throw new Error('injected Markdown projection failure');
        }
        return materializeMirror(writerRoot, notes, options);
      },
    };
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
      writers,
    });
    await session.start();
    expect(writes).toEqual(['state', 'markdown', 'state', 'markdown']);

    const manifestBefore = await readMirrorManifest(root);
    const relativePath = manifestBefore.notes['note-1'].path;
    const canonicalPath = path.join(root, relativePath);
    expect(parseMirrorNote(await readFile(canonicalPath, 'utf8')).content).toBe('from XMTP');

    writes.length = 0;
    failProjection = true;
    const remoteVector = remote.encodeStateVector();
    remote.upsertNote({
      id: 'note-1',
      title: 'Remote note',
      content: 'state committed before projection',
      folderId: null,
      createdAt: 11,
      updatedAt: 70,
    });
    group.emit({
      kind: 'update',
      notebookId: 'notebook-1',
      messageId: 'durability-live-update',
      sentAt: 70,
      update: remote.encodeDiff(remoteVector),
    });
    await projectionFailed;

    expect(writes).toEqual(['state', 'markdown']);
    expect(await readMirrorManifest(root)).toEqual(manifestBefore);
    expect(parseMirrorNote(await readFile(canonicalPath, 'utf8')).content).toBe('from XMTP');
    const durableState = await readCrdtState(root);
    const recovered = new NotebookCrdt('notebook-1');
    try {
      recovered.applyUpdate(durableState!);
      expect(recovered.getNote('note-1')?.content).toBe(
        'state committed before projection',
      );
    } finally {
      recovered.destroy();
    }

    await session.stop();
    remote.destroy();
  });

  it('observes a Markdown edit made while the startup sync request is in flight', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const remote = remoteDocument();
    class EditDuringHandshakeGroup extends FakeGroup {
      private readonly outgoing = new ProtocolReassembler();
      private edited = false;

      override async sendText(text: string): Promise<string> {
        const sent = await super.sendText(text);
        const logical = this.outgoing.push(text);
        if (logical?.kind === 'sync-request' && !this.edited) {
          this.edited = true;
          const relativePath = (await (await import('node:fs/promises')).readdir(root))
            .find((entry) => entry.endsWith('.md'))!;
          const canonicalPath = path.join(root, relativePath);
          const local = parseMirrorNote(await readFile(canonicalPath, 'utf8'));
          await writeFile(
            canonicalPath,
            serializeMirrorNote({ ...local, content: 'edited during startup handshake' }),
            'utf8',
          );
        }
        return sent;
      }
    }
    const group = new EditDuringHandshakeGroup();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'watcher-gap-snapshot',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
    });
    await session.start({ watch: true });

    await vi.waitFor(() => {
      expect(session.projection.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'note-1',
          content: 'edited during startup handshake',
        }),
      ]));
    }, { timeout: 2_000, interval: 25 });

    await session.stop();
    remote.destroy();
  });

  it('batches canonical Markdown edits and propagates deletion tombstones', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    const initialState = remote.encodeUpdate();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'snapshot-1',
      sentAt: 30,
      update: initialState,
    });

    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
    });
    await session.start({ watch: true });
    group.sent.length = 0;

    const relativePath = (await (await import('node:fs/promises')).readdir(root))
      .find((entry) => entry.endsWith('.md'))!;
    const canonicalPath = path.join(root, relativePath);
    const parsed = parseMirrorNote(await readFile(canonicalPath, 'utf8'));
    await writeFile(canonicalPath, `# ${parsed.title}\n\nfirst edit`, 'utf8');
    await session.scanNow();
    const rewritten = parseMirrorNote(await readFile(canonicalPath, 'utf8'));
    await writeFile(
      canonicalPath,
      serializeMirrorNote({ ...rewritten, content: 'second edit' }),
      'utf8',
    );
    await session.scanNow();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const editUpdates = logicalMessages(group.sent).filter((message) => message.kind === 'update');
    expect(editUpdates).toHaveLength(1);

    group.sent.length = 0;
    await unlink(canonicalPath);
    await session.scanNow();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const deletionUpdates = logicalMessages(group.sent).filter(
      (message): message is Extract<StormdanceProtocolMessage, { kind: 'update' }> =>
        message.kind === 'update',
    );
    expect(deletionUpdates).toHaveLength(1);

    const peer = new NotebookCrdt('notebook-1');
    peer.applyUpdate(initialState);
    peer.applyUpdate((editUpdates[0] as Extract<StormdanceProtocolMessage, { kind: 'update' }>).update);
    peer.applyUpdate(deletionUpdates[0].update);
    expect(peer.getNote('note-1')).toMatchObject({ deleted: true, content: 'second edit' });

    await session.stop();
    peer.destroy();
    remote.destroy();
  });

  it('flushes state and closes the XMTP stream when watch mode is aborted', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'snapshot-watch',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });
    const abortController = new AbortController();
    const running = runDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
      watch: true,
      signal: abortController.signal,
    });
    setTimeout(() => abortController.abort(), 25);
    await running;

    expect(group.streamEndCount).toBe(1);
    expect((await readCrdtState(root))?.byteLength).toBeGreaterThan(0);
    remote.destroy();
  });

  it('drains a live update already delivered when shutdown begins', async () => {
    const root = await makeTemporaryDirectory();
    await writeLinkConfig(root, config());
    const group = new FakeGroup();
    const remote = remoteDocument();
    group.addHistory({
      kind: 'snapshot',
      notebookId: 'notebook-1',
      messageId: 'shutdown-drain-base',
      sentAt: 30,
      update: remote.encodeUpdate(),
    });
    const session = new NotebookDirectorySync({
      rootDirectory: root,
      config: config(),
      group,
      inboxId: 'cli-inbox',
    });
    await session.start();

    const remoteVector = remote.encodeStateVector();
    remote.upsertNote({
      id: 'note-1',
      title: 'Remote note',
      content: 'delivered at shutdown boundary',
      folderId: null,
      createdAt: 11,
      updatedAt: 80,
    });
    group.emit({
      kind: 'update',
      notebookId: 'notebook-1',
      messageId: 'shutdown-boundary-update',
      sentAt: 80,
      update: remote.encodeDiff(remoteVector),
    });

    const finalProjection = await session.stop();

    expect(finalProjection.notes[0]?.content).toBe('delivered at shutdown boundary');
    const durableState = await readCrdtState(root);
    const recovered = new NotebookCrdt('notebook-1');
    try {
      recovered.applyUpdate(durableState!);
      expect(recovered.getNote('note-1')?.content).toBe('delivered at shutdown boundary');
    } finally {
      recovered.destroy();
    }
    expect(group.streamEndCount).toBe(1);
    remote.destroy();
  });
});
