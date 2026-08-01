import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STORMDANCE_COMPATIBILITY_CONTRACT,
  STORMDANCE_COMPATIBILITY_ID,
  STORMDANCE_COMPATIBILITY_VERSION,
} from './compatibility';
import { NotebookCrdt, type NotebookCrdtProjection } from './crdt';
import { ProtocolReassembler, encodeProtocolMessage } from './protocol';

interface BinaryFixture {
  encoding: 'base64';
  byteLength: number;
  sha256: string;
  data: string;
}

interface FixtureCase {
  update?: BinaryFixture;
  stateVector?: BinaryFixture;
  deltaFromBaseStateVector?: BinaryFixture;
  afterStateVector?: BinaryFixture;
  leftUpdate?: BinaryFixture;
  rightUpdate?: BinaryFixture;
  mergedState?: BinaryFixture;
  mergedStateVector?: BinaryFixture;
  expectedProjection: NotebookCrdtProjection;
}

interface InteroperabilityFixtures {
  fixtureFormat: string;
  fixtureVersion: number;
  contract: unknown;
  ids: { notebookId: string };
  cases: {
    fullState: FixtureCase & { update: BinaryFixture; stateVector: BinaryFixture };
    incremental: FixtureCase & {
      update: BinaryFixture;
      deltaFromBaseStateVector: BinaryFixture;
      afterStateVector: BinaryFixture;
    };
    tombstone: FixtureCase & { update: BinaryFixture; afterStateVector: BinaryFixture };
    concurrency: FixtureCase & {
      leftUpdate: BinaryFixture;
      rightUpdate: BinaryFixture;
      mergedState: BinaryFixture;
      mergedStateVector: BinaryFixture;
    };
  };
  protocol: {
    chunkBytes: number;
    updateMessage: {
      kind: 'update';
      notebookId: string;
      messageId: string;
      sentAt: number;
      requestId: string;
      targetInboxId: string;
      responderStateVector: BinaryFixture;
      payload: BinaryFixture;
    };
    updateChunks: string[];
    updateDeliveryOrder: number[];
    syncRequestMessage: {
      kind: 'sync-request';
      notebookId: string;
      messageId: string;
      sentAt: number;
      requestId: string;
      targetInboxId: string;
      stateVector: BinaryFixture;
    };
    syncRequestChunks: string[];
    snapshotMessage: {
      kind: 'snapshot';
      notebookId: string;
      messageId: string;
      sentAt: number;
      requestId: string;
      targetInboxId: string;
      payload: BinaryFixture;
    };
    snapshotChunks: string[];
    manifestMessage: {
      kind: 'manifest';
      notebookId: string;
      messageId: string;
      sentAt: number;
      notebookName: string;
      schemaVersion: number;
      ownerInboxId: string;
    };
    manifestChunks: string[];
  };
}

const fixtures = JSON.parse(readFileSync(
  new URL('../../../test-fixtures/yjs-v1/fixtures.json', import.meta.url),
  'utf8',
)) as InteroperabilityFixtures;

const decodeBinary = (fixture: BinaryFixture) => Uint8Array.from(Buffer.from(fixture.data, 'base64'));

const expectValidBinary = (fixture: BinaryFixture) => {
  expect(fixture.encoding).toBe('base64');
  const decoded = decodeBinary(fixture);
  expect(decoded.byteLength).toBe(fixture.byteLength);
  expect(Buffer.from(decoded).toString('base64')).toBe(fixture.data);
  expect(createHash('sha256').update(decoded).digest('hex')).toBe(fixture.sha256);
};

const expectStateVector = (crdt: NotebookCrdt, expected: BinaryFixture) => {
  expect(Array.from(crdt.encodeStateVector())).toEqual(Array.from(decodeBinary(expected)));
};

describe('storm.dance cross-language compatibility fixtures', () => {
  it('pins the machine-readable contract used by browser and native clients', () => {
    expect(fixtures.fixtureFormat).toBe('storm.dance/yjs-v1-fixtures');
    expect(fixtures.fixtureVersion).toBe(1);
    expect(fixtures.contract).toEqual(STORMDANCE_COMPATIBILITY_CONTRACT);
    expect(STORMDANCE_COMPATIBILITY_ID).toBe('storm.dance/compatibility');
    expect(STORMDANCE_COMPATIBILITY_VERSION).toBe(1);
  });

  it('verifies every committed binary fixture length, canonical base64, and digest', () => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const candidate = value as Partial<BinaryFixture>;
      if (candidate.encoding === 'base64') {
        expectValidBinary(candidate as BinaryFixture);
        return;
      }
      for (const nested of Object.values(value)) visit(nested);
    };
    visit(fixtures);
  });

  it('loads full Yjs state and reproduces its state vector and projection', () => {
    const replica = new NotebookCrdt(fixtures.ids.notebookId);
    replica.applyUpdate(decodeBinary(fixtures.cases.fullState.update));

    expect(replica.snapshot()).toEqual(fixtures.cases.fullState.expectedProjection);
    expectStateVector(replica, fixtures.cases.fullState.stateVector);
  });

  it('applies both the captured incremental update and state-vector delta', () => {
    const applyIncrement = (update: BinaryFixture) => {
      const replica = new NotebookCrdt(fixtures.ids.notebookId);
      replica.applyUpdate(decodeBinary(fixtures.cases.fullState.update));
      replica.applyUpdate(decodeBinary(update));
      expect(replica.snapshot()).toEqual(fixtures.cases.incremental.expectedProjection);
      expectStateVector(replica, fixtures.cases.incremental.afterStateVector);
    };

    applyIncrement(fixtures.cases.incremental.update);
    applyIncrement(fixtures.cases.incremental.deltaFromBaseStateVector);
  });

  it('retains and projects a cross-language deletion tombstone', () => {
    const replica = new NotebookCrdt(fixtures.ids.notebookId);
    replica.applyUpdate(decodeBinary(fixtures.cases.fullState.update));
    replica.applyUpdate(decodeBinary(fixtures.cases.incremental.update));
    replica.applyUpdate(decodeBinary(fixtures.cases.tombstone.update));

    expect(replica.snapshot()).toEqual(fixtures.cases.tombstone.expectedProjection);
    expect(replica.getNote('note-beta')).toMatchObject({ deleted: true });
    expectStateVector(replica, fixtures.cases.tombstone.afterStateVector);
  });

  it('converges concurrent fixture updates regardless of delivery order', () => {
    const leftFirst = new NotebookCrdt(fixtures.ids.notebookId);
    const rightFirst = new NotebookCrdt(fixtures.ids.notebookId);
    for (const replica of [leftFirst, rightFirst]) {
      replica.applyUpdate(decodeBinary(fixtures.cases.fullState.update));
    }

    leftFirst.applyUpdate(decodeBinary(fixtures.cases.concurrency.leftUpdate));
    leftFirst.applyUpdate(decodeBinary(fixtures.cases.concurrency.rightUpdate));
    rightFirst.applyUpdate(decodeBinary(fixtures.cases.concurrency.rightUpdate));
    rightFirst.applyUpdate(decodeBinary(fixtures.cases.concurrency.leftUpdate));

    expect(leftFirst.snapshot()).toEqual(fixtures.cases.concurrency.expectedProjection);
    expect(rightFirst.snapshot()).toEqual(leftFirst.snapshot());
    expectStateVector(leftFirst, fixtures.cases.concurrency.mergedStateVector);
    expectStateVector(rightFirst, fixtures.cases.concurrency.mergedStateVector);

    const mergedStateReplica = new NotebookCrdt(fixtures.ids.notebookId);
    mergedStateReplica.applyUpdate(decodeBinary(fixtures.cases.concurrency.mergedState));
    expect(mergedStateReplica.snapshot()).toEqual(leftFirst.snapshot());
  });

  it('exactly reproduces and reassembles duplicate, out-of-order wire chunks', () => {
    const message = fixtures.protocol.updateMessage;
    const encoded = encodeProtocolMessage({
      kind: message.kind,
      notebookId: message.notebookId,
      messageId: message.messageId,
      sentAt: message.sentAt,
      requestId: message.requestId,
      targetInboxId: message.targetInboxId,
      responderStateVector: decodeBinary(message.responderStateVector),
      update: decodeBinary(message.payload),
    }, { chunkBytes: fixtures.protocol.chunkBytes });
    expect(encoded).toEqual(fixtures.protocol.updateChunks);

    const reassembler = new ProtocolReassembler();
    let completed = null;
    for (const index of fixtures.protocol.updateDeliveryOrder) {
      completed = reassembler.push(fixtures.protocol.updateChunks[index]) ?? completed;
    }

    expect(completed).toMatchObject({
      kind: 'update',
      notebookId: message.notebookId,
      messageId: message.messageId,
      requestId: message.requestId,
      targetInboxId: message.targetInboxId,
    });
    if (!completed || completed.kind !== 'update') throw new Error('expected fixture update');
    expect(Array.from(completed.update)).toEqual(Array.from(decodeBinary(message.payload)));
    expect(Array.from(completed.responderStateVector ?? [])).toEqual(
      Array.from(decodeBinary(message.responderStateVector)),
    );
  });

  it('exactly reproduces and reassembles a state-vector sync request', () => {
    const message = fixtures.protocol.syncRequestMessage;
    const encoded = encodeProtocolMessage({
      kind: message.kind,
      notebookId: message.notebookId,
      messageId: message.messageId,
      sentAt: message.sentAt,
      requestId: message.requestId,
      targetInboxId: message.targetInboxId,
      stateVector: decodeBinary(message.stateVector),
    }, { chunkBytes: fixtures.protocol.chunkBytes });
    expect(encoded).toEqual(fixtures.protocol.syncRequestChunks);

    const reassembler = new ProtocolReassembler();
    const completed = reassembler.push(encoded[0]);
    expect(completed).toMatchObject({ kind: 'sync-request', requestId: message.requestId });
    if (!completed || completed.kind !== 'sync-request') throw new Error('expected sync request');
    expect(Array.from(completed.stateVector)).toEqual(Array.from(decodeBinary(message.stateVector)));
  });

  it('exactly reproduces manifest and full-state snapshot messages', () => {
    const manifest = fixtures.protocol.manifestMessage;
    const encodedManifest = encodeProtocolMessage({
      kind: manifest.kind,
      notebookId: manifest.notebookId,
      messageId: manifest.messageId,
      sentAt: manifest.sentAt,
      notebookName: manifest.notebookName,
      schemaVersion: manifest.schemaVersion,
      ownerInboxId: manifest.ownerInboxId,
    }, { chunkBytes: fixtures.protocol.chunkBytes });
    expect(encodedManifest).toEqual(fixtures.protocol.manifestChunks);
    expect(new ProtocolReassembler().push(encodedManifest[0])).toMatchObject(manifest);

    const snapshot = fixtures.protocol.snapshotMessage;
    const encodedSnapshot = encodeProtocolMessage({
      kind: snapshot.kind,
      notebookId: snapshot.notebookId,
      messageId: snapshot.messageId,
      sentAt: snapshot.sentAt,
      requestId: snapshot.requestId,
      targetInboxId: snapshot.targetInboxId,
      update: decodeBinary(snapshot.payload),
    }, { chunkBytes: fixtures.protocol.chunkBytes });
    expect(encodedSnapshot).toEqual(fixtures.protocol.snapshotChunks);

    const reassembler = new ProtocolReassembler();
    let completed = null;
    for (const chunk of [...encodedSnapshot].reverse()) {
      completed = reassembler.push(chunk) ?? completed;
    }
    expect(completed).toMatchObject({
      kind: 'snapshot',
      notebookId: snapshot.notebookId,
      requestId: snapshot.requestId,
    });
    if (!completed || completed.kind !== 'snapshot') throw new Error('expected snapshot');
    expect(Array.from(completed.update)).toEqual(Array.from(decodeBinary(snapshot.payload)));
  });
});
