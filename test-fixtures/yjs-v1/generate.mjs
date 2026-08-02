import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';

const CONTRACT = {
  id: 'storm.dance/compatibility',
  version: 1,
  transport: {
    protocol: 'storm.dance/yjs',
    version: 1,
    prefix: 'stormdance-sync/1\n',
    payloadEncoding: 'base64',
    updateEncoding: 'yjs-v1',
    messageKinds: ['manifest', 'sync-request', 'update', 'snapshot'],
    chunkIdentity: ['notebookId', 'kind', 'messageId'],
    logicalPayloadField: {
      manifest: null,
      'sync-request': 'stateVector',
      update: 'update',
      snapshot: 'update',
    },
    limits: {
      defaultChunkBytes: 262144,
      maxChunkBytes: 524288,
      maxChunks: 128,
      maxPayloadBytes: 33554432,
      maxWireChars: 800000,
      maxIdBytes: 256,
      maxNameBytes: 512,
    },
  },
  crdt: {
    schemaVersion: 1,
    updateEncoding: 'yjs-v1',
    stateVectorEncoding: 'yjs-v1',
    guidPrefix: 'stormdance:notebook:',
    roots: {
      notebook: {
        name: 'notebook',
        type: 'Y.Map',
        fields: {
          schemaVersion: 'integer',
          id: 'string',
          name: 'string',
          createdAt: 'non-negative-safe-integer',
          updatedAt: 'non-negative-safe-integer',
        },
      },
      folders: {
        name: 'folders',
        type: 'Y.Map<folderId,Y.Map>',
        identity: 'map-key',
        optionalInLegacyDocuments: true,
        fields: {
          name: 'Y.Text',
          parentFolderId: 'string|null',
          createdAt: 'non-negative-safe-integer',
          updatedAt: 'non-negative-safe-integer',
          deleted: 'boolean',
          deletedAt: 'non-negative-safe-integer|null',
        },
      },
      notes: {
        name: 'notes',
        type: 'Y.Map<noteId,Y.Map>',
        identity: 'map-key',
        fields: {
          title: 'Y.Text',
          content: 'Y.Text',
          folderId: 'string|null',
          createdAt: 'non-negative-safe-integer',
          updatedAt: 'non-negative-safe-integer',
          deleted: 'boolean',
          deletedAt: 'non-negative-safe-integer|null',
        },
      },
    },
    semantics: {
      missingDeleted: false,
      tombstonesAreRetained: true,
      timestampsResolveTextConflicts: false,
      noteOrder: 'lexicographic-note-id',
    },
  },
};

const NOTEBOOK_ID = 'fixture-notebook-v1';
const BASE_CLIENT_ID = 0x1020_3040;
const LEFT_CLIENT_ID = 0x2030_4050;
const RIGHT_CLIENT_ID = 0x3040_5060;
const INCREMENTAL_TIMESTAMP = 1_725_000_000_100;
const TOMBSTONE_TIMESTAMP = 1_725_000_000_200;

const binary = (bytes) => ({
  encoding: 'base64',
  byteLength: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  data: Buffer.from(bytes).toString('base64'),
});

const createDocument = (clientId) => {
  const doc = new Y.Doc({ guid: `${CONTRACT.crdt.guidPrefix}${NOTEBOOK_ID}` });
  doc.clientID = clientId;
  return doc;
};

const putNote = (notes, input) => {
  const note = new Y.Map();
  notes.set(input.id, note);

  const title = new Y.Text();
  note.set('title', title);
  title.insert(0, input.title);

  const content = new Y.Text();
  note.set('content', content);
  content.insert(0, input.content);

  note.set('folderId', input.folderId);
  note.set('createdAt', input.createdAt);
  note.set('updatedAt', input.updatedAt);
  note.set('deleted', input.deleted ?? false);
  note.set('deletedAt', input.deletedAt ?? null);
};

const putFolder = (folders, input) => {
  const folder = new Y.Map();
  folders.set(input.id, folder);

  const name = new Y.Text();
  folder.set('name', name);
  name.insert(0, input.name);

  folder.set('parentFolderId', input.parentFolderId);
  folder.set('createdAt', input.createdAt);
  folder.set('updatedAt', input.updatedAt);
  folder.set('deleted', input.deleted ?? false);
  folder.set('deletedAt', input.deletedAt ?? null);
};

const readText = (note, key) => {
  const value = note.get(key);
  return value instanceof Y.Text ? value.toString() : '';
};

const project = (doc) => {
  const metadata = doc.getMap(CONTRACT.crdt.roots.notebook.name);
  const folders = doc.getMap(CONTRACT.crdt.roots.folders.name);
  const notes = doc.getMap(CONTRACT.crdt.roots.notes.name);
  return {
    schemaVersion: 1,
    notebook: {
      id: metadata.get('id'),
      name: metadata.get('name'),
      createdAt: metadata.get('createdAt'),
      updatedAt: metadata.get('updatedAt'),
    },
    folders: Array.from(folders.entries())
      .map(([id, value]) => ({
        id,
        name: readText(value, 'name'),
        parentFolderId: value.get('parentFolderId') ?? null,
        createdAt: value.get('createdAt') ?? 0,
        updatedAt: value.get('updatedAt') ?? 0,
        deleted: value.get('deleted') === true,
        deletedAt: value.get('deletedAt') ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    notes: Array.from(notes.entries())
      .map(([id, value]) => ({
        id,
        title: readText(value, 'title'),
        content: readText(value, 'content'),
        folderId: value.get('folderId') ?? null,
        createdAt: value.get('createdAt') ?? 0,
        updatedAt: value.get('updatedAt') ?? 0,
        deleted: value.get('deleted') === true,
        deletedAt: value.get('deletedAt') ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
};

const encodeChunks = ({ kind, notebookId, messageId, sentAt, payload, chunkBytes, ...rest }) => {
  const chunkCount = Math.max(1, Math.ceil(payload.byteLength / chunkBytes));
  return Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const start = chunkIndex * chunkBytes;
    const end = Math.min(start + chunkBytes, payload.byteLength);
    const chunk = {
      protocol: CONTRACT.transport.protocol,
      version: CONTRACT.transport.version,
      notebookId,
      messageId,
      sentAt,
      chunkIndex,
      chunkCount,
      totalBytes: payload.byteLength,
      payload: Buffer.from(payload.subarray(start, end)).toString('base64'),
      kind,
      ...rest,
    };
    return `${CONTRACT.transport.prefix}${JSON.stringify(chunk)}`;
  });
};

const base = createDocument(BASE_CLIENT_ID);
base.transact(() => {
  const metadata = base.getMap(CONTRACT.crdt.roots.notebook.name);
  metadata.set('schemaVersion', 1);
  metadata.set('id', NOTEBOOK_ID);
  metadata.set('name', 'Interoperability fixtures');
  metadata.set('createdAt', 1_725_000_000_000);
  metadata.set('updatedAt', 1_725_000_000_000);

  const folders = base.getMap(CONTRACT.crdt.roots.folders.name);
  putFolder(folders, {
    id: 'folder-research',
    name: 'Research',
    parentFolderId: null,
    createdAt: 1_725_000_000_005,
    updatedAt: 1_725_000_000_005,
  });

  const notes = base.getMap(CONTRACT.crdt.roots.notes.name);
  putNote(notes, {
    id: 'note-alpha',
    title: 'Protocol notes',
    content: 'A shared line.\n\n- [ ] Validate [[sync]]\n\n> [!note] Portable ⛈️\n',
    folderId: 'folder-research',
    createdAt: 1_725_000_000_010,
    updatedAt: 1_725_000_000_010,
  });
  putNote(notes, {
    id: 'note-beta',
    title: 'Embedded assets',
    content: '![[diagram.png]]\n\nSee [the protocol](Protocol%20notes.md#wire-format).\n',
    folderId: null,
    createdAt: 1_725_000_000_020,
    updatedAt: 1_725_000_000_020,
  });
}, 'fixture:base');

const baseUpdate = Y.encodeStateAsUpdate(base);
const baseStateVector = Y.encodeStateVector(base);
const baseProjection = project(base);

base.transact(() => {
  const metadata = base.getMap(CONTRACT.crdt.roots.notebook.name);
  metadata.set('updatedAt', INCREMENTAL_TIMESTAMP);
  const notes = base.getMap(CONTRACT.crdt.roots.notes.name);
  const alpha = notes.get('note-alpha');
  const content = alpha.get('content');
  content.insert(0, 'Browser edit: ');
  alpha.set('updatedAt', INCREMENTAL_TIMESTAMP);
  const folders = base.getMap(CONTRACT.crdt.roots.folders.name);
  putFolder(folders, {
    id: 'folder-offline',
    name: 'Offline',
    parentFolderId: 'folder-research',
    createdAt: INCREMENTAL_TIMESTAMP,
    updatedAt: INCREMENTAL_TIMESTAMP,
  });
  putNote(notes, {
    id: 'note-gamma',
    title: 'Offline checklist',
    content: '- [x] Create state vector\n- [ ] Apply delta\n',
    folderId: 'folder-offline',
    createdAt: INCREMENTAL_TIMESTAMP,
    updatedAt: INCREMENTAL_TIMESTAMP,
  });
}, 'fixture:incremental');

const incrementalUpdate = Y.encodeStateAsUpdate(base, baseStateVector);
const afterIncrementalStateVector = Y.encodeStateVector(base);
const afterIncrementalProjection = project(base);

const baseOnlyReplica = createDocument(0x4050_6070);
Y.applyUpdate(baseOnlyReplica, baseUpdate);
const deltaFromBaseStateVector = Y.encodeStateAsUpdate(base, Y.encodeStateVector(baseOnlyReplica));

const beforeTombstoneStateVector = Y.encodeStateVector(base);
base.transact(() => {
  const metadata = base.getMap(CONTRACT.crdt.roots.notebook.name);
  metadata.set('updatedAt', TOMBSTONE_TIMESTAMP);
  const beta = base.getMap(CONTRACT.crdt.roots.notes.name).get('note-beta');
  beta.set('deleted', true);
  beta.set('deletedAt', TOMBSTONE_TIMESTAMP);
  beta.set('updatedAt', TOMBSTONE_TIMESTAMP);
  const offline = base.getMap(CONTRACT.crdt.roots.folders.name).get('folder-offline');
  offline.set('deleted', true);
  offline.set('deletedAt', TOMBSTONE_TIMESTAMP);
  offline.set('updatedAt', TOMBSTONE_TIMESTAMP);
}, 'fixture:tombstone');
const tombstoneUpdate = Y.encodeStateAsUpdate(base, beforeTombstoneStateVector);
const afterTombstoneStateVector = Y.encodeStateVector(base);
const tombstoneProjection = project(base);

const left = createDocument(LEFT_CLIENT_ID);
const right = createDocument(RIGHT_CLIENT_ID);
Y.applyUpdate(left, baseUpdate);
Y.applyUpdate(right, baseUpdate);
const leftBefore = Y.encodeStateVector(left);
const rightBefore = Y.encodeStateVector(right);

left.transact(() => {
  const alpha = left.getMap(CONTRACT.crdt.roots.notes.name).get('note-alpha');
  alpha.get('content').insert(0, 'LEFT ');
}, 'fixture:left');
right.transact(() => {
  const alpha = right.getMap(CONTRACT.crdt.roots.notes.name).get('note-alpha');
  const content = alpha.get('content');
  content.insert(content.length, 'RIGHT');
}, 'fixture:right');

const leftUpdate = Y.encodeStateAsUpdate(left, leftBefore);
const rightUpdate = Y.encodeStateAsUpdate(right, rightBefore);
Y.applyUpdate(left, rightUpdate);
Y.applyUpdate(right, leftUpdate);
const concurrentProjection = project(left);
const mergedConcurrentState = Y.encodeStateAsUpdate(left);
const mergedConcurrentStateVector = Y.encodeStateVector(left);

const updateMessage = {
  kind: 'update',
  notebookId: NOTEBOOK_ID,
  messageId: 'fixture-update-message',
  sentAt: 1_725_000_001_000,
  payload: incrementalUpdate,
  chunkBytes: 64,
  requestId: 'fixture-request',
  targetInboxId: 'fixture-target-inbox',
  responderStateVector: Buffer.from(afterIncrementalStateVector).toString('base64'),
};
const updateChunks = encodeChunks(updateMessage);
const syncRequestChunks = encodeChunks({
  kind: 'sync-request',
  notebookId: NOTEBOOK_ID,
  messageId: 'fixture-sync-request-message',
  sentAt: 1_725_000_001_100,
  payload: baseStateVector,
  chunkBytes: 64,
  requestId: 'fixture-request',
  targetInboxId: 'fixture-target-inbox',
});
const snapshotChunks = encodeChunks({
  kind: 'snapshot',
  notebookId: NOTEBOOK_ID,
  messageId: 'fixture-snapshot-message',
  sentAt: 1_725_000_001_200,
  payload: baseUpdate,
  chunkBytes: 64,
  requestId: 'fixture-snapshot-request',
  targetInboxId: 'fixture-target-inbox',
});
const manifestChunks = encodeChunks({
  kind: 'manifest',
  notebookId: NOTEBOOK_ID,
  messageId: 'fixture-manifest-message',
  sentAt: 1_725_000_001_300,
  payload: new Uint8Array(),
  chunkBytes: 64,
  notebookName: 'Interoperability fixtures',
  schemaVersion: 1,
  ownerInboxId: 'fixture-owner-inbox',
});

const fixture = {
  fixtureFormat: 'storm.dance/yjs-v1-fixtures',
  fixtureVersion: 1,
  generator: {
    runtime: 'node',
    library: 'yjs',
    libraryVersion: '13.6.31',
    command: 'node test-fixtures/yjs-v1/generate.mjs',
  },
  contract: CONTRACT,
  ids: {
    notebookId: NOTEBOOK_ID,
    baseClientId: BASE_CLIENT_ID,
    leftClientId: LEFT_CLIENT_ID,
    rightClientId: RIGHT_CLIENT_ID,
  },
  cases: {
    fullState: {
      update: binary(baseUpdate),
      stateVector: binary(baseStateVector),
      expectedProjection: baseProjection,
    },
    incremental: {
      update: binary(incrementalUpdate),
      deltaFromBaseStateVector: binary(deltaFromBaseStateVector),
      afterStateVector: binary(afterIncrementalStateVector),
      expectedProjection: afterIncrementalProjection,
    },
    tombstone: {
      update: binary(tombstoneUpdate),
      afterStateVector: binary(afterTombstoneStateVector),
      expectedProjection: tombstoneProjection,
    },
    concurrency: {
      leftUpdate: binary(leftUpdate),
      rightUpdate: binary(rightUpdate),
      mergedState: binary(mergedConcurrentState),
      mergedStateVector: binary(mergedConcurrentStateVector),
      expectedProjection: concurrentProjection,
    },
  },
  protocol: {
    chunkBytes: updateMessage.chunkBytes,
    updateMessage: {
      kind: updateMessage.kind,
      notebookId: updateMessage.notebookId,
      messageId: updateMessage.messageId,
      sentAt: updateMessage.sentAt,
      requestId: updateMessage.requestId,
      targetInboxId: updateMessage.targetInboxId,
      responderStateVector: binary(afterIncrementalStateVector),
      payload: binary(incrementalUpdate),
    },
    updateChunks,
    updateDeliveryOrder: [2, 0, 2, ...updateChunks.map((_, index) => index).filter((index) => index !== 0 && index !== 2).reverse()],
    syncRequestMessage: {
      kind: 'sync-request',
      notebookId: NOTEBOOK_ID,
      messageId: 'fixture-sync-request-message',
      sentAt: 1_725_000_001_100,
      requestId: 'fixture-request',
      targetInboxId: 'fixture-target-inbox',
      stateVector: binary(baseStateVector),
    },
    syncRequestChunks,
    snapshotMessage: {
      kind: 'snapshot',
      notebookId: NOTEBOOK_ID,
      messageId: 'fixture-snapshot-message',
      sentAt: 1_725_000_001_200,
      requestId: 'fixture-snapshot-request',
      targetInboxId: 'fixture-target-inbox',
      payload: binary(baseUpdate),
    },
    snapshotChunks,
    manifestMessage: {
      kind: 'manifest',
      notebookId: NOTEBOOK_ID,
      messageId: 'fixture-manifest-message',
      sentAt: 1_725_000_001_300,
      notebookName: 'Interoperability fixtures',
      schemaVersion: 1,
      ownerInboxId: 'fixture-owner-inbox',
    },
    manifestChunks,
  },
};

const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
