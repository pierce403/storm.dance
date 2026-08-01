/**
 * Language-independent compatibility contract for every storm.dance replica.
 *
 * Keep this module limited to JSON-compatible constants. Browser, native,
 * command-line, and desktop implementations may use different libraries, but
 * they must produce and consume the exact Yjs v1 document and wire layouts
 * described here. Portable binary examples live in test-fixtures/yjs-v1.
 */

export const STORMDANCE_COMPATIBILITY_ID = 'storm.dance/compatibility';
export const STORMDANCE_COMPATIBILITY_VERSION = 1;

export const STORMDANCE_PROTOCOL = 'storm.dance/yjs';
export const STORMDANCE_PROTOCOL_VERSION = 1;
export const STORMDANCE_PROTOCOL_PREFIX = 'stormdance-sync/1\n';

export const DEFAULT_PROTOCOL_CHUNK_BYTES = 256 * 1024;
export const MAX_PROTOCOL_CHUNK_BYTES = 512 * 1024;
export const MAX_PROTOCOL_CHUNKS = 128;
export const MAX_PROTOCOL_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_PROTOCOL_WIRE_CHARS = 800_000;
export const MAX_PROTOCOL_ID_BYTES = 256;
export const MAX_PROTOCOL_NAME_BYTES = 512;

export const NOTEBOOK_CRDT_SCHEMA_VERSION = 1;
export const NOTEBOOK_CRDT_UPDATE_ENCODING = 'yjs-v1';
export const NOTEBOOK_CRDT_STATE_VECTOR_ENCODING = 'yjs-v1';
export const NOTEBOOK_CRDT_GUID_PREFIX = 'stormdance:notebook:';
export const NOTEBOOK_CRDT_METADATA_MAP = 'notebook';
export const NOTEBOOK_CRDT_NOTES_MAP = 'notes';

/**
 * Machine-readable description mirrored by the committed fixture manifest.
 * This is intentionally data rather than TypeScript types so native clients
 * can compare it directly with the JSON contract before loading a fixture.
 */
export const STORMDANCE_COMPATIBILITY_CONTRACT = {
  id: STORMDANCE_COMPATIBILITY_ID,
  version: STORMDANCE_COMPATIBILITY_VERSION,
  transport: {
    protocol: STORMDANCE_PROTOCOL,
    version: STORMDANCE_PROTOCOL_VERSION,
    prefix: STORMDANCE_PROTOCOL_PREFIX,
    payloadEncoding: 'base64',
    updateEncoding: NOTEBOOK_CRDT_UPDATE_ENCODING,
    messageKinds: ['manifest', 'sync-request', 'update', 'snapshot'],
    chunkIdentity: ['notebookId', 'kind', 'messageId'],
    logicalPayloadField: {
      manifest: null,
      'sync-request': 'stateVector',
      update: 'update',
      snapshot: 'update',
    },
    limits: {
      defaultChunkBytes: DEFAULT_PROTOCOL_CHUNK_BYTES,
      maxChunkBytes: MAX_PROTOCOL_CHUNK_BYTES,
      maxChunks: MAX_PROTOCOL_CHUNKS,
      maxPayloadBytes: MAX_PROTOCOL_PAYLOAD_BYTES,
      maxWireChars: MAX_PROTOCOL_WIRE_CHARS,
      maxIdBytes: MAX_PROTOCOL_ID_BYTES,
      maxNameBytes: MAX_PROTOCOL_NAME_BYTES,
    },
  },
  crdt: {
    schemaVersion: NOTEBOOK_CRDT_SCHEMA_VERSION,
    updateEncoding: NOTEBOOK_CRDT_UPDATE_ENCODING,
    stateVectorEncoding: NOTEBOOK_CRDT_STATE_VECTOR_ENCODING,
    guidPrefix: NOTEBOOK_CRDT_GUID_PREFIX,
    roots: {
      notebook: {
        name: NOTEBOOK_CRDT_METADATA_MAP,
        type: 'Y.Map',
        fields: {
          schemaVersion: 'integer',
          id: 'string',
          name: 'string',
          createdAt: 'non-negative-safe-integer',
          updatedAt: 'non-negative-safe-integer',
        },
      },
      notes: {
        name: NOTEBOOK_CRDT_NOTES_MAP,
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
} as const;

export type StormdanceCompatibilityContract = typeof STORMDANCE_COMPATIBILITY_CONTRACT;
