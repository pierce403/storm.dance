import { z } from 'zod';

export const STORMDANCE_PROTOCOL = 'storm.dance/yjs';
export const STORMDANCE_PROTOCOL_VERSION = 1;
export const STORMDANCE_PROTOCOL_PREFIX = 'stormdance-sync/1\n';

export const DEFAULT_PROTOCOL_CHUNK_BYTES = 256 * 1024;
export const MAX_PROTOCOL_CHUNK_BYTES = 512 * 1024;
export const MAX_PROTOCOL_CHUNKS = 128;
export const MAX_PROTOCOL_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_PROTOCOL_WIRE_CHARS = 800_000;

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 512;

const boundedString = (label: string, max = MAX_ID_LENGTH) =>
  z.string().min(1, `${label} is required`).max(max, `${label} is too long`);

const base64Schema = z.string().max(Math.ceil(MAX_PROTOCOL_CHUNK_BYTES / 3) * 4 + 4).refine(
  (value) => {
    if (value.length === 0) return true;
    if (value.length % 4 !== 0) return false;
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  },
  'payload must be canonical base64',
);

const commonShape = {
  protocol: z.literal(STORMDANCE_PROTOCOL),
  version: z.literal(STORMDANCE_PROTOCOL_VERSION),
  notebookId: boundedString('notebookId'),
  messageId: boundedString('messageId'),
  sentAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  chunkIndex: z.number().int().nonnegative().max(MAX_PROTOCOL_CHUNKS - 1),
  chunkCount: z.number().int().min(1).max(MAX_PROTOCOL_CHUNKS),
  totalBytes: z.number().int().nonnegative().max(MAX_PROTOCOL_PAYLOAD_BYTES),
  payload: base64Schema,
};

const manifestChunkSchema = z.object({
  ...commonShape,
  kind: z.literal('manifest'),
  notebookName: boundedString('notebookName', MAX_NAME_LENGTH),
  schemaVersion: z.number().int().min(1).max(1_000_000),
  ownerInboxId: boundedString('ownerInboxId').optional(),
}).strict();

const syncRequestChunkSchema = z.object({
  ...commonShape,
  kind: z.literal('sync-request'),
  requestId: boundedString('requestId'),
  targetInboxId: boundedString('targetInboxId').optional(),
}).strict();

const updateChunkSchema = z.object({
  ...commonShape,
  kind: z.literal('update'),
  requestId: boundedString('requestId').optional(),
  targetInboxId: boundedString('targetInboxId').optional(),
  responderStateVector: base64Schema.optional(),
}).strict();

const snapshotChunkSchema = z.object({
  ...commonShape,
  kind: z.literal('snapshot'),
  requestId: boundedString('requestId').optional(),
  targetInboxId: boundedString('targetInboxId').optional(),
}).strict();

const protocolChunkSchema = z.discriminatedUnion('kind', [
  manifestChunkSchema,
  syncRequestChunkSchema,
  updateChunkSchema,
  snapshotChunkSchema,
]);

export type ProtocolChunk = z.infer<typeof protocolChunkSchema>;

interface ProtocolMessageBase {
  protocol?: typeof STORMDANCE_PROTOCOL;
  version?: typeof STORMDANCE_PROTOCOL_VERSION;
  notebookId: string;
  messageId: string;
  sentAt: number;
}

export interface ManifestProtocolMessage extends ProtocolMessageBase {
  kind: 'manifest';
  notebookName: string;
  schemaVersion: number;
  ownerInboxId?: string;
}

export interface SyncRequestProtocolMessage extends ProtocolMessageBase {
  kind: 'sync-request';
  requestId: string;
  targetInboxId?: string;
  stateVector: Uint8Array;
}

export interface UpdateProtocolMessage extends ProtocolMessageBase {
  kind: 'update';
  requestId?: string;
  targetInboxId?: string;
  responderStateVector?: Uint8Array;
  update: Uint8Array;
}

export interface SnapshotProtocolMessage extends ProtocolMessageBase {
  kind: 'snapshot';
  requestId?: string;
  targetInboxId?: string;
  update: Uint8Array;
}

export type StormdanceProtocolMessage =
  | ManifestProtocolMessage
  | SyncRequestProtocolMessage
  | UpdateProtocolMessage
  | SnapshotProtocolMessage;

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  const blockSize = 0x8000;
  for (let index = 0; index < bytes.length; index += blockSize) {
    const block = bytes.subarray(index, Math.min(index + blockSize, bytes.length));
    binary += String.fromCharCode(...block);
  }
  return btoa(binary);
};

const base64ToBytes = (value: string) => {
  if (value.length === 0) return new Uint8Array();
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ProtocolValidationError('payload is not valid base64');
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const messagePayload = (message: StormdanceProtocolMessage) => {
  switch (message.kind) {
    case 'manifest':
      return new Uint8Array();
    case 'sync-request':
      return message.stateVector;
    case 'update':
    case 'snapshot':
      return message.update;
  }
};

const validateLogicalMessage = (message: StormdanceProtocolMessage) => {
  const protocol = message.protocol ?? STORMDANCE_PROTOCOL;
  const version = message.version ?? STORMDANCE_PROTOCOL_VERSION;
  const common = {
    protocol,
    version,
    notebookId: message.notebookId,
    messageId: message.messageId,
    sentAt: message.sentAt,
    chunkIndex: 0,
    chunkCount: 1,
    totalBytes: 0,
    payload: '',
  };

  switch (message.kind) {
    case 'manifest':
      manifestChunkSchema.parse({
        ...common,
        kind: message.kind,
        notebookName: message.notebookName,
        schemaVersion: message.schemaVersion,
        ownerInboxId: message.ownerInboxId,
      });
      break;
    case 'sync-request':
      syncRequestChunkSchema.parse({
        ...common,
        kind: message.kind,
        requestId: message.requestId,
        targetInboxId: message.targetInboxId,
      });
      break;
    case 'update':
      updateChunkSchema.parse({
        ...common,
        kind: message.kind,
        requestId: message.requestId,
        targetInboxId: message.targetInboxId,
        responderStateVector: message.responderStateVector
          ? bytesToBase64(message.responderStateVector)
          : undefined,
      });
      break;
    case 'snapshot':
      snapshotChunkSchema.parse({
        ...common,
        kind: message.kind,
        requestId: message.requestId,
        targetInboxId: message.targetInboxId,
      });
      break;
  }
};

export interface EncodeProtocolOptions {
  chunkBytes?: number;
}

/** Encodes one logical message into one or more XMTP-safe text messages. */
export function encodeProtocolMessage(
  message: StormdanceProtocolMessage,
  options: EncodeProtocolOptions = {},
) {
  try {
    validateLogicalMessage(message);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ProtocolValidationError(error.issues.map((issue) => issue.message).join('; '));
    }
    throw error;
  }

  const payload = messagePayload(message);
  if (!(payload instanceof Uint8Array)) {
    throw new ProtocolValidationError('protocol payload must be a Uint8Array');
  }
  if (payload.byteLength > MAX_PROTOCOL_PAYLOAD_BYTES) {
    throw new ProtocolValidationError(`payload exceeds ${MAX_PROTOCOL_PAYLOAD_BYTES} bytes`);
  }

  const chunkBytes = options.chunkBytes ?? DEFAULT_PROTOCOL_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_PROTOCOL_CHUNK_BYTES) {
    throw new ProtocolValidationError(`chunkBytes must be between 1 and ${MAX_PROTOCOL_CHUNK_BYTES}`);
  }

  const chunkCount = Math.max(1, Math.ceil(payload.byteLength / chunkBytes));
  if (chunkCount > MAX_PROTOCOL_CHUNKS) {
    throw new ProtocolValidationError(`payload requires more than ${MAX_PROTOCOL_CHUNKS} chunks`);
  }

  const common = {
    protocol: STORMDANCE_PROTOCOL,
    version: STORMDANCE_PROTOCOL_VERSION,
    notebookId: message.notebookId,
    messageId: message.messageId,
    sentAt: message.sentAt,
    chunkCount,
    totalBytes: payload.byteLength,
  } as const;

  const chunks: string[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * chunkBytes;
    const end = Math.min(start + chunkBytes, payload.byteLength);
    const encodedPayload = bytesToBase64(payload.subarray(start, end));
    const chunkBase = { ...common, chunkIndex, payload: encodedPayload };

    let chunk: ProtocolChunk;
    switch (message.kind) {
      case 'manifest':
        chunk = {
          ...chunkBase,
          kind: message.kind,
          notebookName: message.notebookName,
          schemaVersion: message.schemaVersion,
          ...(message.ownerInboxId ? { ownerInboxId: message.ownerInboxId } : {}),
        };
        break;
      case 'sync-request':
        chunk = {
          ...chunkBase,
          kind: message.kind,
          requestId: message.requestId,
          ...(message.targetInboxId ? { targetInboxId: message.targetInboxId } : {}),
        };
        break;
      case 'update':
        chunk = {
          ...chunkBase,
          kind: message.kind,
          ...(message.requestId ? { requestId: message.requestId } : {}),
          ...(message.targetInboxId ? { targetInboxId: message.targetInboxId } : {}),
          ...(message.responderStateVector
            ? { responderStateVector: bytesToBase64(message.responderStateVector) }
            : {}),
        };
        break;
      case 'snapshot':
        chunk = {
          ...chunkBase,
          kind: message.kind,
          ...(message.requestId ? { requestId: message.requestId } : {}),
          ...(message.targetInboxId ? { targetInboxId: message.targetInboxId } : {}),
        };
        break;
    }

    const parsed = protocolChunkSchema.parse(chunk);
    const wire = `${STORMDANCE_PROTOCOL_PREFIX}${JSON.stringify(parsed)}`;
    if (wire.length > MAX_PROTOCOL_WIRE_CHARS) {
      throw new ProtocolValidationError(`wire chunk exceeds ${MAX_PROTOCOL_WIRE_CHARS} characters`);
    }
    chunks.push(wire);
  }

  return chunks;
}

export function decodeProtocolChunk(text: string): ProtocolChunk {
  if (typeof text !== 'string') {
    throw new ProtocolValidationError('protocol message must be text');
  }
  if (text.length > MAX_PROTOCOL_WIRE_CHARS) {
    throw new ProtocolValidationError(`wire chunk exceeds ${MAX_PROTOCOL_WIRE_CHARS} characters`);
  }
  if (!text.startsWith(STORMDANCE_PROTOCOL_PREFIX)) {
    throw new ProtocolValidationError('not a storm.dance sync message');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text.slice(STORMDANCE_PROTOCOL_PREFIX.length));
  } catch {
    throw new ProtocolValidationError('protocol message contains invalid JSON');
  }

  const parsed = protocolChunkSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ProtocolValidationError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  if (parsed.data.chunkIndex >= parsed.data.chunkCount) {
    throw new ProtocolValidationError('chunkIndex must be less than chunkCount');
  }

  const payload = base64ToBytes(parsed.data.payload);
  if (payload.byteLength > MAX_PROTOCOL_CHUNK_BYTES) {
    throw new ProtocolValidationError(`decoded chunk exceeds ${MAX_PROTOCOL_CHUNK_BYTES} bytes`);
  }
  if (payload.byteLength > parsed.data.totalBytes) {
    throw new ProtocolValidationError('chunk is larger than declared totalBytes');
  }
  if (parsed.data.totalBytes === 0 && (parsed.data.chunkCount !== 1 || payload.byteLength !== 0)) {
    throw new ProtocolValidationError('empty payload must use exactly one empty chunk');
  }

  return parsed.data;
}

interface PendingAssembly {
  header: string;
  chunkCount: number;
  totalBytes: number;
  chunks: Map<number, Uint8Array>;
  bufferedBytes: number;
  expiresAt: number;
  template: ProtocolChunk;
}

export interface ProtocolReassemblerOptions {
  ttlMs?: number;
  maxAssemblies?: number;
  maxBufferedBytes?: number;
  maxCompleted?: number;
}

const assemblyKey = (chunk: ProtocolChunk) =>
  `${chunk.notebookId}\u0000${chunk.kind}\u0000${chunk.messageId}`;

const assemblyHeader = (chunk: ProtocolChunk) => {
  const header = Object.fromEntries(
    Object.entries(chunk).filter(([key]) => key !== 'chunkIndex' && key !== 'payload'),
  );
  return JSON.stringify(header);
};

const equalBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

/** Safely reassembles bounded, duplicate-tolerant, out-of-order chunks. */
export class ProtocolReassembler {
  private readonly ttlMs: number;
  private readonly maxAssemblies: number;
  private readonly maxBufferedBytes: number;
  private readonly maxCompleted: number;
  private readonly pending = new Map<string, PendingAssembly>();
  private readonly completed = new Map<string, number>();
  private bufferedBytes = 0;

  constructor(options: ProtocolReassemblerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxAssemblies = options.maxAssemblies ?? 64;
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_PROTOCOL_PAYLOAD_BYTES;
    this.maxCompleted = options.maxCompleted ?? 256;

    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new ProtocolValidationError('ttlMs must be a positive integer');
    }
    if (!Number.isSafeInteger(this.maxAssemblies) || this.maxAssemblies < 1) {
      throw new ProtocolValidationError('maxAssemblies must be a positive integer');
    }
    if (!Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 1) {
      throw new ProtocolValidationError('maxBufferedBytes must be a positive integer');
    }
    if (!Number.isSafeInteger(this.maxCompleted) || this.maxCompleted < 1) {
      throw new ProtocolValidationError('maxCompleted must be a positive integer');
    }
  }

  push(textOrChunk: string | ProtocolChunk, now = Date.now()): StormdanceProtocolMessage | null {
    this.cleanup(now);
    const chunk = typeof textOrChunk === 'string' ? decodeProtocolChunk(textOrChunk) : protocolChunkSchema.parse(textOrChunk);
    const key = assemblyKey(chunk);
    if (this.completed.has(key)) return null;

    const payload = base64ToBytes(chunk.payload);
    let assembly = this.pending.get(key);
    if (!assembly) {
      if (this.pending.size >= this.maxAssemblies) {
        throw new ProtocolValidationError('too many incomplete protocol messages');
      }
      assembly = {
        header: assemblyHeader(chunk),
        chunkCount: chunk.chunkCount,
        totalBytes: chunk.totalBytes,
        chunks: new Map(),
        bufferedBytes: 0,
        expiresAt: now + this.ttlMs,
        template: chunk,
      };
      this.pending.set(key, assembly);
    } else if (assembly.header !== assemblyHeader(chunk)) {
      this.discard(key, assembly);
      throw new ProtocolValidationError('chunks for the same message have inconsistent metadata');
    }

    const existing = assembly.chunks.get(chunk.chunkIndex);
    if (existing) {
      if (!equalBytes(existing, payload)) {
        this.discard(key, assembly);
        throw new ProtocolValidationError('duplicate chunk index has different data');
      }
      return null;
    }

    if (assembly.bufferedBytes + payload.byteLength > assembly.totalBytes) {
      this.discard(key, assembly);
      throw new ProtocolValidationError('received chunks exceed declared totalBytes');
    }
    if (this.bufferedBytes + payload.byteLength > this.maxBufferedBytes) {
      this.discard(key, assembly);
      throw new ProtocolValidationError('protocol reassembly buffer limit exceeded');
    }

    assembly.chunks.set(chunk.chunkIndex, payload);
    assembly.bufferedBytes += payload.byteLength;
    this.bufferedBytes += payload.byteLength;
    assembly.expiresAt = now + this.ttlMs;

    if (assembly.chunks.size !== assembly.chunkCount) return null;
    if (assembly.bufferedBytes !== assembly.totalBytes) {
      this.discard(key, assembly);
      throw new ProtocolValidationError('reassembled payload length does not match totalBytes');
    }

    const reassembled = new Uint8Array(assembly.totalBytes);
    let offset = 0;
    for (let index = 0; index < assembly.chunkCount; index += 1) {
      const part = assembly.chunks.get(index);
      if (!part) {
        this.discard(key, assembly);
        throw new ProtocolValidationError(`missing chunk ${index}`);
      }
      reassembled.set(part, offset);
      offset += part.byteLength;
    }

    this.discard(key, assembly);
    if (this.completed.size >= this.maxCompleted) {
      const oldest = this.completed.keys().next().value;
      if (oldest) this.completed.delete(oldest);
    }
    this.completed.set(key, now + this.ttlMs);
    return this.toLogicalMessage(assembly.template, reassembled);
  }

  cleanup(now = Date.now()) {
    for (const [key, assembly] of this.pending) {
      if (assembly.expiresAt <= now) this.discard(key, assembly);
    }
    for (const [key, expiresAt] of this.completed) {
      if (expiresAt <= now) this.completed.delete(key);
    }
  }

  get pendingCount() {
    return this.pending.size;
  }

  get bufferedByteLength() {
    return this.bufferedBytes;
  }

  get completedCount() {
    return this.completed.size;
  }

  private discard(key: string, assembly: PendingAssembly) {
    if (!this.pending.delete(key)) return;
    this.bufferedBytes -= assembly.bufferedBytes;
  }

  private toLogicalMessage(chunk: ProtocolChunk, payload: Uint8Array): StormdanceProtocolMessage {
    const common = {
      protocol: STORMDANCE_PROTOCOL,
      version: STORMDANCE_PROTOCOL_VERSION,
      notebookId: chunk.notebookId,
      messageId: chunk.messageId,
      sentAt: chunk.sentAt,
    } as const;

    switch (chunk.kind) {
      case 'manifest':
        return {
          ...common,
          kind: chunk.kind,
          notebookName: chunk.notebookName,
          schemaVersion: chunk.schemaVersion,
          ...(chunk.ownerInboxId ? { ownerInboxId: chunk.ownerInboxId } : {}),
        };
      case 'sync-request':
        return {
          ...common,
          kind: chunk.kind,
          requestId: chunk.requestId,
          ...(chunk.targetInboxId ? { targetInboxId: chunk.targetInboxId } : {}),
          stateVector: payload,
        };
      case 'update':
        return {
          ...common,
          kind: chunk.kind,
          ...(chunk.requestId ? { requestId: chunk.requestId } : {}),
          ...(chunk.targetInboxId ? { targetInboxId: chunk.targetInboxId } : {}),
          ...(chunk.responderStateVector
            ? { responderStateVector: base64ToBytes(chunk.responderStateVector) }
            : {}),
          update: payload,
        };
      case 'snapshot':
        return {
          ...common,
          kind: chunk.kind,
          ...(chunk.requestId ? { requestId: chunk.requestId } : {}),
          ...(chunk.targetInboxId ? { targetInboxId: chunk.targetInboxId } : {}),
          update: payload,
        };
    }
  }
}
