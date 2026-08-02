# storm.dance Yjs v1 interoperability fixtures

`fixtures.json` is the normative cross-language example set for compatibility
contract version 1. Binary values use canonical padded base64 and include their
decoded byte length and SHA-256 digest. A consumer must verify those values
before applying an update.

The CRDT document has three top-level shared maps:

- `notebook`: a `Y.Map` containing `schemaVersion`, `id`, `name`, `createdAt`,
  and `updatedAt`.
- `folders`: an additive `Y.Map<folderId, Y.Map>` whose entries contain a
  `Y.Text` name, `parentFolderId`, timestamps, and deletion tombstones. Legacy
  schema-1 updates without this optional root remain valid.
- `notes`: a `Y.Map<noteId, Y.Map>` whose entries contain `Y.Text` values for
  `title` and `content`, plus `folderId`, `createdAt`, `updatedAt`, `deleted`,
  and `deletedAt` scalar values.

Timestamps are non-negative JavaScript-safe integer milliseconds. They are
metadata and never replace CRDT conflict resolution. A deletion sets a retained
`deleted: true` tombstone; it does not remove the note map. A missing `deleted`
field projects as `false` for defensive backward compatibility.

Transport payloads are Yjs update-v1 or state-vector-v1 bytes. XMTP carries
them as strict, prefixed JSON text chunks. Chunks are identified by the tuple
`(notebookId, kind, messageId)`, may arrive out of order or more than once, and
must agree on every logical-message field before reassembly.

The fixture cases cover:

- complete state and its state vector;
- an incremental update and state-vector-derived delta, including a nested
  folder entity;
- retained note and folder deletion tombstones;
- concurrent prefix/suffix edits from two deterministic client IDs;
- an update split into wire chunks with duplicate, out-of-order delivery; and
- all four wire message kinds: manifest, state-vector sync request, update, and
  full-state snapshot.

Regenerate deterministically after an intentional contract or Yjs upgrade:

```bash
node test-fixtures/yjs-v1/generate.mjs
```

Review the JSON diff. Binary changes are a compatibility event even when all
current implementations still converge.

## Required directions

Web/Yjs to native/Yrs:

1. Decode `cases.fullState.update`, apply it to an empty UTF-16-offset Yrs
   document, and compare its projection with `expectedProjection`.
2. Apply the incremental and tombstone updates in order, checking the supplied
   state vectors and projections after each step.
3. Apply the two concurrency updates in both orders and compare the merged
   projection and state vector.
4. Decode and reassemble every protocol message without first translating it
   through TypeScript.

Native/Yrs to web/Yjs is a distinct requirement; successfully reading a Yjs
fixture does not prove it. The native fixture generator must create Yrs v1
state, incremental, tombstone, and concurrent updates with deterministic client
IDs. Browser conformance then applies those committed bytes through
`NotebookCrdt` and compares language-independent projections. Keep the two
producer labels explicit so a fixture is never accidentally tested only by the
library that generated it.
