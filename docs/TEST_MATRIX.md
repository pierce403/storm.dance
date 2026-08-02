# storm.dance interoperability test matrix

This matrix is the release contract for the hosted web app, native CLI/daemon,
and Tauri desktop app. Passing one client in isolation is insufficient: every
required client pairing must converge through the same Yjs v1 payloads and XMTP
MLS group without routing through another storm.dance client.

## Test tiers

| Tier | Environment | Frequency | Network |
|---|---|---|---|
| T0 | Pure TypeScript/Rust unit and committed fixtures | Every change | None |
| T1 | Simulated transport, filesystem, IPC, and restart tests | Every change | None |
| T2 | XMTP dev-network tests with disposable identities | Relevant `main` changes, manual, and release candidate | XMTP dev |
| T3 | Installed release artifacts on clean OS runners/VMs | Release candidate | XMTP dev where applicable |
| T4 | Hosted production smoke test | After deployment | XMTP production only with dedicated smoke identities |

T0 and T1 must be deterministic and parallel-safe. T2–T4 need bounded timeouts,
unique notebook/group IDs, and credentials that are never printed or retained as
artifacts.

“Required” in the matrices below is a release-contract target, not a claim that
the row currently passes. The 0.2 development checkpoint automates the shared
Yjs/Yrs fixtures, protocol bounds, browser/CLI simulated transport, schema-2
nested vault safety (including exact scan-witness revalidation), hosted-web
fallback, typed Tauri bridge behavior, the live
four-installation smoke below, and unsigned package builds. Direct native
libxmtp, installed-artifact launch tests, profile locking, semantic three-way
file merge, deletion grace/trash, signing, and the remaining client/topology
rows are explicitly pending.

### Implemented live component smoke

`.github/workflows/interoperability.yml` runs
`scripts/live-xmtp-matrix.mjs` on relevant `main` changes and by manual
dispatch. It uses four disposable wallets, inboxes, installations, encrypted
SQLite databases, and one XMTP dev group. The roles are real shipped component
code paths rather than manually labelled CRDT replicas:

| Role | Code exercised | Live assertion |
|---|---|---|
| Hosted web | `NotebookCollaborationSession` | Creates the notebook group and snapshot; receives concurrent native edits; sends a later rename |
| Directory CLI | `NotebookDirectorySync` with `adaptXmtpGroup` | Materializes Markdown, ingests an ordinary file write, sends its Yjs delta, and materializes the later web rename |
| Tauri webview | `NotebookCollaborationSession` | Receives the snapshot, concurrently edits another text region, and receives the later web rename |
| Dynamic contributor | `NotebookCollaborationSession` plus native XMTP group roles | Joins only after the three primary sessions are live, catches up, edits and converges, then completes Member → Admin → Member → removed lifecycle checks |

The web and Tauri roles intentionally share `NotebookCollaborationSession`
because the packaged Tauri application hosts the same React collaboration
engine as the hosted site. In this headless CI smoke test, a small Node SDK
adapter supplies that browser-shaped transport so each role can use an
independent libxmtp database. The dynamic contributor is added by Ethereum
identifier, and both the owner and contributor independently observe its native
XMTP role before and after promotion/demotion. This validates the shared
frontend, contributor lifecycle, and directory CLI transport paths over the
real XMTP dev network; it does not by itself claim
that installer launch, native IPC, same-inbox topology, or every scenario below
has passed. Those remain separate matrix rows and release gates.

## Compatibility fixture gate

The normative fixtures are in `test-fixtures/yjs-v1/fixtures.json`. Every
implementation must consume the same file; copying expected bytes into a native
test is not sufficient.

| ID | Input | Required assertion | Browser/Yjs | Native/Yrs |
|---|---|---|---|---|
| CF-01 | Contract metadata | Contract ID, version, roots, field types, and wire prefix match the implementation constants | Automated | Required |
| CF-02 | Every binary field | Canonical base64, decoded length, and SHA-256 all match | Automated | Required |
| CF-03 | Full-state update | Empty replica projects the exact notebook and notes | Automated | Required |
| CF-04 | State vector | Decoded client clocks match; mutual deltas are empty where map-entry byte order differs | Automated | Required |
| CF-05 | Incremental update | Base plus update projects the exact post-edit state | Automated | Required |
| CF-06 | State-vector delta | Base plus requested delta equals the incremental result | Automated | Required |
| CF-07 | Tombstone update | Deleted note remains present with `deleted: true` and its content intact | Automated | Required |
| CF-08 | Concurrent updates | Left-first and right-first delivery converge to the exact expected projection | Automated | Required |
| CF-09 | Merged state | Empty replica accepts the merged concurrent update and matches both peers | Automated | Required |
| CF-10 | Update wire chunks | Encoder reproduces every prefixed JSON chunk byte-for-byte | Automated | Required |
| CF-11 | Reassembly | Duplicate and out-of-order chunks yield exactly one logical update | Automated | Required |
| CF-12 | Sync request | State-vector request encodes, decodes, and preserves targeting fields | Automated | Required |
| CF-13 | Snapshot | Full-state snapshot chunks reproduce exactly and reassemble in reverse order | Automated | Required |
| CF-14 | Manifest | Empty-payload manifest preserves notebook name, schema, and owner fields | Automated | Required |

Fixture regeneration is an explicit compatibility event. The generator must be
run twice with no second diff, and both implementations must pass before updated
fixture bytes can land.

## Client-pair convergence matrix

Each row is required. “Same inbox” always means distinct XMTP installations and
distinct local databases; it must not mean two processes sharing one database.
For each pairing, A→B and B→A are separately asserted.

The current live smoke covers the different-inbox paths CP-01, CP-03, CP-05,
and CP-07 through the shipped Node directory client and shared web/Tauri
collaboration engine. CP-05/CP-07 do not yet include packaged Tauri IPC, and
none of the same-inbox or installed-artifact rows should be inferred from that
smoke.

| ID | Client A | Client B | XMTP identity topology | T1 simulated | T2 live |
|---|---|---|---|---|---|
| CP-01 | Web | Web | Different inboxes | Required | Required |
| CP-02 | Web | Web | Same inbox, different installations | Required | Required |
| CP-03 | Web | CLI/daemon | Different inboxes | Required | Required |
| CP-04 | Web | CLI/daemon | Same inbox, different installations | Required | Required |
| CP-05 | Web | Tauri | Different inboxes | Required | Required |
| CP-06 | Web | Tauri | Same inbox, different installations | Required | Required |
| CP-07 | CLI/daemon | Tauri | Different inboxes | Required | Required |
| CP-08 | CLI/daemon | Tauri | Same inbox, different installations | Required | Required |
| CP-09 | CLI/daemon | CLI/daemon | Different inboxes | Required | Required |
| CP-10 | Tauri | Tauri | Different inboxes | Required | Required |

Every client-pair row runs this scenario set:

| ID | Scenario | Required result |
|---|---|---|
| CS-01 | A creates a note; B edits its title; A edits its body | Both converge on one stable note ID with both edits |
| CS-02 | A and B insert at opposite ends while connected | Both text insertions survive and snapshots/state vectors converge |
| CS-03 | A goes offline; each side edits a different region; A reconnects | Two-way state-vector exchange transfers missing history in both directions |
| CS-04 | A goes offline; both replace the same Unicode span | Updates converge without malformed Unicode; any filesystem ambiguity is preserved as a surfaced conflict |
| CS-05 | A deletes while B edits offline | Tombstone wins visibility, edited content remains recoverable, and no note is resurrected implicitly |
| CS-06 | A explicitly restores a tombstone, then B edits | Restored note converges with the subsequent edit |
| CS-07 | One update exceeds one transport chunk | Reordered and duplicated chunks produce one update; incomplete chunks do not mutate state |
| CS-08 | The same update and XMTP message are replayed | Processing is idempotent and sends no echo loop |
| CS-09 | A closes during send and restarts from durable state | Restart catches up without losing accepted edits or re-sending unbounded duplicates |
| CS-10 | History delivery overlaps live-stream startup | A boundary message is applied exactly once; no history/live gap exists |
| CS-11 | Notebook name and note metadata change with body text | Metadata and text project consistently on both sides |
| CS-12 | Unknown folder ID arrives | Note remains visible at root until folder entities are supported; content is not discarded |

## Identity, group, and lifecycle matrix

| ID | Case | Expected behavior | Tier |
|---|---|---|---|
| ID-01 | Different inboxes join one notebook group | Both can decrypt and exchange updates | T2 |
| ID-02 | One inbox has two installations | Each installation processes the other installation’s messages | T1/T2 |
| ID-03 | This installation receives its own sent message | Protocol message-ID cache suppresses only the actual local send | T1 |
| ID-04 | Directory expects inbox X; active profile resolves to Y | Startup fails closed and reports expected/actual inbox IDs without key material | T1 |
| ID-05 | Correct inbox but group is absent from local installation state | Client syncs conversations, then returns an actionable not-found/not-in-group error | T1/T2 |
| ID-06 | Group description binds another notebook ID | Client rejects the binding and never applies its payload | T1 |
| ID-07 | Group belongs to another XMTP environment | Rebinding is rejected; existing local projection is unchanged | T1 |
| ID-08 | Invite is allowed, denied, then replayed | Consent transition is idempotent; denied groups do not materialize | T1/T2 |
| ID-09 | Two native processes open one profile | Exactly one owns the XMTP database; the other uses IPC or exits with a stable lock error | T1/T3 |
| ID-10 | Identity recovery on a second client | Same inbox, new installation, existing groups and notes become available after sync | T2 |
| ID-11 | Owner adds a reachable Ethereum identifier after the notebook session is live | XMTP adds the resolved inbox as Member; the new installation receives the welcome and converges through state-vector catch-up | T1/T2 |
| ID-12 | Super admin promotes then demotes a contributor | Owner and contributor independently observe Admin then Member from native XMTP membership state | T0/T1/T2 |
| ID-13 | Owner removes a contributor | Current membership omits that inbox; settings refresh does not retain a stale contributor row | T0/T1/T2 |

### Implemented contributor lifecycle coverage

Contributor management is checked at three complementary layers. Deterministic
manager and UI-state tests cover role normalization, membership mutation
sequencing, and authorization safeguards without network timing. Existing
simulated session tests cover existing-group startup and catch-up behavior. The
gated live smoke then uses
the XMTP dev network to validate a real welcome, native Member/Admin state from
two independent databases, CRDT convergence after the late join, demotion, and
removal. Run the live tier only with `STORMDANCE_LIVE_XMTP=1`; disposable keys
and databases are deleted in `finally` cleanup.

## Transport and validation matrix

Malformed input must fail before allocating unbounded memory or mutating Yjs.

| ID | Input/failure | Expected behavior | Tier |
|---|---|---|---|
| TV-01 | Non-storm.dance XMTP text | Ignore as unrelated content | T0/T1 |
| TV-02 | Invalid JSON, unknown field, version, or message kind | Strict validation error; no state change | T0 |
| TV-03 | Invalid/noncanonical base64 | Reject; no partial payload is applied | T0 |
| TV-04 | Chunk count, index, total, or per-chunk size exceeds bounds | Reject before buffering | T0 |
| TV-05 | Same chunk identity with inconsistent headers or bytes | Discard the whole pending assembly | T0 |
| TV-06 | Too many pending messages or buffered bytes | Enforce configured global bounds | T0 |
| TV-07 | Incomplete assembly expires | Release all associated memory | T0 |
| TV-08 | Duplicate completed message after restart | Yjs remains idempotent; durable receive cursor/message tracking prevents churn | T1 |
| TV-09 | Stream disconnect, restart callback, and repeated failure | Bounded exponential backoff, observable degraded status, clean cancellation | T1/T2 |
| TV-10 | XMTP send succeeds but local acknowledgement is interrupted | Retry is safe and does not duplicate notebook state | T1/T2 |
| TV-11 | Target inbox does not match local inbox | Ignore targeted response while still allowing another installation of the target inbox to process it | T1 |
| TV-12 | Snapshot/update belongs to another notebook | Reject before applying Yjs bytes | T0/T1 |

## Web independence matrix

The hosted web client is complete without Tauri, a daemon, localhost service,
or filesystem permission.

| ID | Web-only case | Required result | Tier |
|---|---|---|---|
| WB-01 | `window.__TAURI__` and native IPC are absent | App loads, creates notebooks/notes, edits, searches, and organizes normally | T1/T4 |
| WB-02 | Browser is offline after initial load | IndexedDB state opens and edits remain durable across reload | T1 |
| WB-03 | Browser reconnects after offline edits | Persisted Yjs state initiates state-vector catch-up and converges | T1/T2 |
| WB-04 | Browser identity is locked/unavailable | Local notes remain readable; collaboration clearly reports disconnected state | T1 |
| WB-05 | Browser receives an invite | Accept materializes the notebook; reject leaves local data untouched | T1/T2 |
| WB-06 | Two tabs open the same notebook | No IndexedDB corruption, duplicate transport loop, or silent lost update | T1 |
| WB-07 | Static production build is served from the deployed origin | Assets load with no native endpoint and reported commit matches the deployed artifact | T4 |
| WB-08 | Unsupported native-only action is requested | UI explains the capability boundary without disabling web collaboration | T1 |

## Filesystem and Obsidian vault matrix

These cases run against the same vault from the Rust core, CLI/daemon, and
Tauri. The external actor uses ordinary filesystem calls, never a note-editing
CLI command.

| ID | Vault action | Required result | Linux | macOS | Windows |
|---|---|---|---|---|---|
| FS-01 | Create nested `Research/New note.md` without metadata | Adopt in place once, allocate one stable note ID, send one logical creation | Required | Required | Required |
| FS-02 | Modify body with an ordinary whole-file save | Convert the minimal semantic text change into Yrs operations | Required | Required | Required |
| FS-03 | Editor writes temp file then renames over target | Treat as one save, not delete plus create | Required | Required | Required |
| FS-04 | Rename a managed file | Preserve note ID and content; update path/title according to documented policy | Required | Required | Required |
| FS-05 | Move a note between nested folders | Preserve note ID; update folder projection without flattening | Required | Required | Required |
| FS-06 | Browser changes remotely while agent saves a stale non-overlapping copy | Three-way reconciliation preserves both edits and converges | Required | Required | Required |
| FS-07 | Browser and agent make ambiguous overlapping replacements | Preserve both versions in a named conflict artifact and surface status | Required | Required | Required |
| FS-08 | Delete managed file and leave it absent beyond grace period | Move recoverable content to trash, then emit one tombstone | Required | Required | Required |
| FS-09 | Delete followed by immediate rename/reappearance | Cancel deletion; never emit a distributed tombstone | Required | Required | Required |
| FS-10 | Remote create/update/delete | Materialize atomically, flush, rename, record hash, and suppress watcher echo | Required | Required | Required |
| FS-11 | Duplicate, coalesced, delayed, or reordered watcher events | Hash reconciliation creates no duplicate notes or send loop | Required | Required | Required |
| FS-12 | Agent removes the embedded storm.dance comment | Existing manifest path retains identity; comment can be repaired safely | Required | Required | Required |
| FS-13 | Agent moves a file with its identity comment | Manifest recovers the same note ID at the new path | Required | Required | Required |
| FS-14 | Filename collision, reserved Windows name, case-only rename, Unicode normalization | Produce stable collision-safe paths without escaping the vault | Required | Required | Required |
| FS-15 | Symlink, junction, traversal path, or path outside vault | Refuse to follow/write/delete and emit a diagnostic | Required | Required | Required |
| FS-16 | Unowned Markdown or attachment exists | Never overwrite or delete it | Required | Required | Required |
| FS-17 | `.obsidian/`, `.trash/`, and `.git/` change | Ignore as local configuration/state | Required | Required | Required |
| FS-18 | Daemon crashes between temp write, flush, rename, and manifest update | Recovery chooses a complete version; no truncated Markdown or lost remote state | Required | Required | Required |
| FS-19 | Vault is copied without profile credentials | Markdown remains usable; sync fails with actionable profile/inbox guidance | Required | Required | Required |
| FS-20 | Two processes attempt to watch the same vault/profile | One owner; no competing materializers or database access | Required | Required | Required |

### Obsidian syntax preservation corpus

The corpus must include the following in nested files with spaces and Unicode
names. A no-op materialization must be byte-for-byte identical; a semantic edit
may change only the intended region and storm.dance identity marker.

| ID | Syntax/data | Required assertion |
|---|---|---|
| OB-01 | User YAML frontmatter, aliases, tags, and custom keys | Preserved; storm.dance does not commandeer user keys |
| OB-02 | `[[wikilinks]]`, headings, aliases, and block references | Preserved literally unless explicit link rewriting is enabled |
| OB-03 | `![[embeds]]` and non-Markdown attachments | Reference and attachment preserved; attachment remains unowned initially |
| OB-04 | Tasks, nested lists, callouts, tables, footnotes, HTML, and comments | Round-trip without structural normalization |
| OB-05 | Fenced code containing Markdown, YAML, and storm.dance-like comments | Never parsed as note metadata |
| OB-06 | CRLF and LF files | Preserve documented line-ending policy without watcher loops |
| OB-07 | Empty note, no final newline, and multiple final newlines | Preserve byte form when semantically untouched |
| OB-08 | Unicode title/path/content, combining marks, emoji, and RTL text | Valid UTF-8, stable identity, no malformed scalar boundaries |

## CLI and agent ergonomics matrix

| ID | Command/workflow | Required result | Tier |
|---|---|---|---|
| CL-01 | `auth init/import/address` | Secret input is stdin/keyring only; stdout never includes private material | T1/T3 |
| CL-02 | `notebooks list` | Only valid storm.dance groups are returned; human and JSON modes agree | T1/T2 |
| CL-03 | `link <notebook> <directory>` | Strict config records notebook, conversation, environment, profile, and expected inbox | T1/T2 |
| CL-04 | `sync <directory>` | Finite catch-up exits success only after durable CRDT and vault projection | T1/T2 |
| CL-05 | `watch <directory>` / daemon | Continues bidirectional sync, exposes health, and shuts down cleanly | T1/T2/T3 |
| CL-06 | `status` and `doctor` | Stable human/JSON output diagnoses profile, inbox, group, lock, and vault state | T1/T3 |
| CL-07 | Noninteractive agent execution | `--json --no-input` never prompts and uses stable exit/error codes | T1/T3 |
| CL-08 | JSONL change feed resumes from cursor | Exactly-once logical events or documented at-least-once IDs permit deduplication | T1 |
| CL-09 | Agent uses `rg`, editor, copy, move, and delete directly | All authoring works through filesystem projection; no edit command is required | T1/T2 |
| CL-10 | SIGINT/SIGTERM or console close | Flush accepted state, stop streams/watchers, release database and vault locks | T1/T3 |

## Tauri and native IPC matrix

| ID | Case | Required result | Tier |
|---|---|---|---|
| TA-01 | React edits rapidly | UI is immediate; batched binary updates persist natively before XMTP broadcast | T1 |
| TA-02 | Remote Yrs update arrives | One typed event updates browser Yjs projection without echoing it | T1/T2 |
| TA-03 | Large binary update crosses IPC | No UTF-8 corruption, truncation, quadratic copy, or ordering change | T1 |
| TA-04 | Window closes while sync continues by policy | Tray/daemon ownership is explicit; exactly one process owns profile state | T1/T3 |
| TA-05 | Desktop restarts offline | Native SQLite/Yrs state and vault open fully without XMTP | T1/T3 |
| TA-06 | Desktop reconnects | Missing history flows both ways and sync status returns healthy | T1/T2/T3 |
| TA-07 | IPC receives invalid notebook ID, path, or oversized payload | Typed validation rejects it without filesystem escape or native crash | T1 |
| TA-08 | Built-in FTS indexes a remote/local update and tombstone | Search results update transactionally and omit deleted notes by default | T1 |
| TA-09 | Optional embedding provider is absent/fails | Notes, FTS, editing, and sync remain operational | T1 |
| TA-10 | Native capability is denied by OS/user | UI reports the denied capability and keeps unrelated features available | T1/T3 |

## Packaging and installation matrix

Release artifacts are tested after packaging, not only with `cargo test` or a
development Tauri runner.

| ID | Target artifact | Clean install/launch | CLI/daemon | Credential store | Vault survives update/uninstall | Signing/update integrity |
|---|---|---|---|---|---|---|
| PK-01 | Windows x86_64 MSI/NSIS | Required | Required | Credential Manager or encrypted fallback | Required | Authenticode + updater signature |
| PK-02 | macOS arm64 app/DMG | Required | Required | Keychain | Required | Hardened runtime, signing, notarization, updater signature |
| PK-03 | macOS x86_64 app/DMG | Required | Required | Keychain | Required | Hardened runtime, signing, notarization, updater signature |
| PK-04 | Linux x86_64 AppImage | Required | Required | Secret Service or explicit encrypted fallback | Required | Artifact checksum + updater signature |
| PK-05 | Linux x86_64 deb | Required | Required | Secret Service or explicit encrypted fallback | Required | Package metadata + artifact checksum |
| PK-06 | Linux x86_64 rpm | Required | Required | Secret Service or explicit encrypted fallback | Required | Package metadata + artifact checksum |

Each packaging row must also verify:

1. First launch creates profile directories/files with least-privilege modes
   available on that OS.
2. A vault can be linked, edited, closed, reopened offline, and synchronized.
3. A second process cannot concurrently own the same profile database.
4. Upgrade preserves profiles, CRDT state, configuration, and user vaults.
5. Uninstall removes program files but never removes a user-selected vault.
6. Logs, crash reports, process arguments, installer logs, and shell history do
   not contain private keys, database keys, or decrypted recovery bundles.
7. The packaged UI reports the same version and commit as artifact metadata.

Unsigned local artifacts may satisfy functional tests, but release publication
must clearly distinguish them and cannot claim the signing/notarization cells.

## Security and durability gates

| ID | Failure/adversary | Required result | Tier |
|---|---|---|---|
| SD-01 | XMTP peer sends malformed/oversized chunks repeatedly | Bounded CPU/memory and no state mutation | T0/T1 |
| SD-02 | Untrusted note contains HTML/script-like Markdown | Stored losslessly; renderer policy prevents script execution | T1 |
| SD-03 | Malicious note title/path attempts traversal or reserved device path | Safe projection or rejection inside vault root | T1 |
| SD-04 | Symlink/junction is swapped during write | Descriptor/path checks fail closed; outside target is untouched | T1 |
| SD-05 | Disk fills or permission changes mid-materialization | CRDT remains durable, original file remains complete, degraded status is actionable | T1/T3 |
| SD-06 | SQLite/XMTP database is corrupt or migration fails | Preserve original, fail closed, and provide rollback/recovery path | T1/T3 |
| SD-07 | System clock moves backward/forward | CRDT convergence and deletion safety do not depend on wall-clock ordering | T1 |
| SD-08 | Logs and structured errors are captured | No signer, key, plaintext recovery bundle, or database key is present | T1/T3 |
| SD-09 | Update/snapshot claims a valid group but wrong notebook ID | Reject before CRDT application | T0/T1 |
| SD-10 | Dependency or protocol version changes | Fixture diff and compatibility tests make the change explicit | T0 |

## Release gates

A cross-platform release is ready only when:

1. All CF tests pass in both TypeScript/Yjs and Rust/Yrs from the same fixture.
2. All CP pairings pass T1; CP-01 through CP-08 pass live on XMTP dev.
3. The full hosted web suite passes with no native service present.
4. Filesystem tests FS-01 through FS-20 and Obsidian tests OB-01 through OB-08
   pass on Linux, macOS, and Windows.
5. The shipped platform artifacts pass their PK row plus TA-05 and TA-06.
6. No test loses a note silently. Ambiguous conflicts and deletions retain a
   recoverable copy and expose a diagnostic.
7. CI publishes machine-readable results keyed by these IDs, plus the commit,
   client versions, XMTP environment, OS, architecture, and artifact digest.

Live tests are evidence of transport integration, while deterministic fixtures
are evidence of format compatibility. Both are required.

These gates describe the production destination. The current workflows publish
unsigned development artifacts so installation and platform-specific rows can
be exercised; they do not by themselves satisfy the production release gate.
