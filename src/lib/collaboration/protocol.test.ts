import { describe, expect, it } from 'vitest';
import {
  MAX_PROTOCOL_CHUNK_BYTES,
  ProtocolReassembler,
  ProtocolValidationError,
  STORMDANCE_PROTOCOL_PREFIX,
  decodeProtocolChunk,
  encodeProtocolMessage,
  type UpdateProtocolMessage,
} from './protocol';

const updateMessage = (update: Uint8Array): UpdateProtocolMessage => ({
  kind: 'update',
  notebookId: 'nb-1',
  messageId: 'message-1',
  sentAt: 1,
  update,
});

describe('storm.dance collaboration protocol', () => {
  it('reassembles base64 chunks out of order and ignores duplicates', () => {
    const payload = Uint8Array.from({ length: 97 }, (_, index) => index % 251);
    const encoded = encodeProtocolMessage(updateMessage(payload), { chunkBytes: 16 });
    const reassembler = new ProtocolReassembler();

    expect(reassembler.push(encoded[2])).toBeNull();
    expect(reassembler.push(encoded[2])).toBeNull();

    let completed = null;
    for (const chunk of [encoded[6], encoded[1], encoded[5], encoded[0], encoded[4], encoded[3]]) {
      completed = reassembler.push(chunk) ?? completed;
    }

    expect(completed).toMatchObject({ kind: 'update', notebookId: 'nb-1', messageId: 'message-1' });
    if (!completed || completed.kind !== 'update') throw new Error('expected update');
    expect(Array.from(completed.update)).toEqual(Array.from(payload));
    expect(reassembler.push(encoded[0])).toBeNull();
    expect(reassembler.pendingCount).toBe(0);
    expect(reassembler.bufferedByteLength).toBe(0);
  });

  it('round-trips manifests and sync requests', () => {
    const reassembler = new ProtocolReassembler();
    const manifest = reassembler.push(encodeProtocolMessage({
      kind: 'manifest',
      notebookId: 'nb-1',
      messageId: 'manifest-1',
      sentAt: 1,
      notebookName: 'Research',
      schemaVersion: 1,
      ownerInboxId: 'owner-inbox',
    })[0]);
    expect(manifest).toMatchObject({
      kind: 'manifest',
      notebookName: 'Research',
      ownerInboxId: 'owner-inbox',
    });

    const stateVector = new Uint8Array([1, 2, 3]);
    const request = reassembler.push(encodeProtocolMessage({
      kind: 'sync-request',
      notebookId: 'nb-1',
      messageId: 'request-message-1',
      requestId: 'request-1',
      sentAt: 2,
      stateVector,
    })[0]);
    expect(request?.kind).toBe('sync-request');
    if (!request || request.kind !== 'sync-request') throw new Error('expected sync request');
    expect(Array.from(request.stateVector)).toEqual([1, 2, 3]);
  });

  it('strictly rejects malformed and unknown protocol fields', () => {
    expect(() => decodeProtocolChunk('ordinary XMTP text')).toThrow(ProtocolValidationError);
    expect(() => decodeProtocolChunk(`${STORMDANCE_PROTOCOL_PREFIX}{bad json`)).toThrow('invalid JSON');

    const valid = decodeProtocolChunk(encodeProtocolMessage(updateMessage(new Uint8Array([1])))[0]);
    const withUnknownField = `${STORMDANCE_PROTOCOL_PREFIX}${JSON.stringify({ ...valid, surprise: true })}`;
    expect(() => decodeProtocolChunk(withUnknownField)).toThrow(ProtocolValidationError);

    const badBase64 = `${STORMDANCE_PROTOCOL_PREFIX}${JSON.stringify({ ...valid, payload: '!!!!' })}`;
    expect(() => decodeProtocolChunk(badBase64)).toThrow('canonical base64');
  });

  it('rejects inconsistent chunks and bounded reassembly overflow', () => {
    const encoded = encodeProtocolMessage(updateMessage(new Uint8Array(20)), { chunkBytes: 10 });
    const first = decodeProtocolChunk(encoded[0]);
    const second = decodeProtocolChunk(encoded[1]);
    const inconsistent = `${STORMDANCE_PROTOCOL_PREFIX}${JSON.stringify({ ...second, totalBytes: 19 })}`;

    const reassembler = new ProtocolReassembler();
    expect(reassembler.push(first)).toBeNull();
    expect(() => reassembler.push(inconsistent)).toThrow('inconsistent metadata');
    expect(reassembler.pendingCount).toBe(0);

    const bounded = new ProtocolReassembler({ maxBufferedBytes: 5 });
    expect(() => bounded.push(encoded[0])).toThrow('buffer limit');
    expect(bounded.pendingCount).toBe(0);
  });

  it('expires incomplete assemblies', () => {
    const encoded = encodeProtocolMessage(updateMessage(new Uint8Array(20)), { chunkBytes: 10 });
    const reassembler = new ProtocolReassembler({ ttlMs: 10 });
    expect(reassembler.push(encoded[0], 100)).toBeNull();
    expect(reassembler.pendingCount).toBe(1);
    reassembler.cleanup(111);
    expect(reassembler.pendingCount).toBe(0);
  });

  it('bounds the completed-message duplicate cache', () => {
    const reassembler = new ProtocolReassembler({ maxCompleted: 2, ttlMs: 60_000 });
    const encoded = (messageId: string) => encodeProtocolMessage({
      ...updateMessage(new Uint8Array([1])),
      messageId,
    })[0];

    expect(reassembler.push(encoded('one'), 1)).not.toBeNull();
    expect(reassembler.push(encoded('two'), 2)).not.toBeNull();
    expect(reassembler.push(encoded('three'), 3)).not.toBeNull();
    expect(reassembler.completedCount).toBe(2);
    expect(reassembler.push(encoded('one'), 4)).not.toBeNull();
    expect(reassembler.completedCount).toBe(2);
  });

  it('enforces chunk size bounds', () => {
    expect(() => encodeProtocolMessage(updateMessage(new Uint8Array([1])), {
      chunkBytes: MAX_PROTOCOL_CHUNK_BYTES + 1,
    })).toThrow('chunkBytes');
  });
});
