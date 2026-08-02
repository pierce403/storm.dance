# storm.dance - Features

This is the canonical feature inventory for storm.dance. Each feature declares a stability level and testable properties so humans and coding agents can connect product intent to verification.

## Feature Stability

- **stable**: Production-ready behavior expected to keep working.
- **in-progress**: Implemented or partially implemented behavior that still needs hardening.
- **planned**: Roadmap behavior that should guide design without being treated as shipped.

## Features

### Local Notebook Management
- **Stability**: stable
- **Description**: Users can keep independent notebooks in the browser.
- **Properties**:
  - A default notebook named `My Notebook` is created when no notebook exists.
  - Default notebook creation is idempotent, including under React StrictMode's repeated development effects.
  - Users can create additional notebooks from a modal seeded with a random adjective/subject pairing.
  - Users can rename notebooks inline without changing contained notes or folders.
  - Users can delete a notebook after confirmation, including its notes and folders.
  - The notebook info panel displays identifiers and timestamps and exposes export/delete controls.
- **Test Criteria**:
  - [x] A fresh browser profile shows a selectable default notebook.
  - [x] A new notebook can be created from the notebook toolbar.
  - [ ] Notebook rename preserves contained notes.
  - [ ] Notebook deletion removes associated notes and folders after confirmation.

### Note Editing
- **Stability**: stable
- **Description**: Users can create, open, edit, persist, and delete notes.
- **Properties**:
  - New notes are created in the selected notebook/folder with the title `Untitled`.
  - Title and content edits persist to IndexedDB from `input` events, including browser automation edits that do not emit `change`.
  - `window.stormdance` exposes programmatic note helpers such as `setNoteContent(noteId, content)`, `setNoteTitle(noteId, title)`, `updateNote(noteId, updates)`, `openNote(noteId)`, and workspace state readers.
  - Reloading the app preserves saved notes.
  - Recently opened notes appear as tabs.
  - Selected notebook, open note tabs, and active note are restored from local storage after page refresh.
  - The editor can switch between text, split, and markdown modes, with live rendered edits updating note content.
  - Split mode keeps Markdown source and rendered rich-text editing surfaces synchronized.
  - Markdown mode remains editable as a rendered rich-text document and saves common edits back to Markdown.
  - Split and markdown modes expose a Markdown formatting toolbar for common rich-text actions, including headings, bold, italics, inline code, links, images, quotes, horizontal rules, bulleted lists, numbered lists, and task lists.
  - Markdown task list items render as checkboxes, and checking/unchecking them updates the underlying `- [ ]` or `- [x]` text.
  - The selected editor display mode is restored from local storage after page refresh.
  - Sidebar selection and editor state stay synchronized.
  - Deleting a note removes it from the sidebar and any open editor tab.
- **Test Criteria**:
  - [x] Playwright creates, edits, reloads, reopens, and deletes a note.
  - [x] Playwright verifies raw `input` events and `window.stormdance.setNoteContent` persist note content.
  - [x] Playwright verifies the active note tab is restored after reload.
  - [x] Playwright verifies text, split, and rich editable markdown editor modes.
  - [x] Playwright verifies the Markdown formatting toolbar updates source Markdown and rendered output.
  - [x] Playwright verifies rendered task list checkboxes update Markdown text and persist.
  - [x] Vitest covers collaboration-side note data behavior.

### Folder Organization
- **Stability**: stable
- **Description**: Users can group notes in a notebook-specific folder tree.
- **Properties**:
  - Users can create root folders and subfolders in the selected notebook.
  - Folder rows expand and collapse nested content.
  - Users can rename folders inline.
  - Deleting a folder reparents child notes and folders to the deleted folder's parent.
  - Drag-and-drop can move notes and folders without creating folder cycles.
  - Collaborative folders are first-class CRDT entities with stable IDs, mergeable names, parent-folder pointers, timestamps, and deletion tombstones; empty folders therefore synchronize without needing a placeholder note.
  - Folder create, rename, move, and delete operations and note drag-and-drop folder changes travel through the same persisted Yjs/XMTP session as note edits. Hosted web and Tauri webview replicas persist incoming folder projections into their local notebook database and UI.
  - Concurrent parent changes are projected as a deterministic safe tree: missing, deleted, self, or empty parents become roots, and a cycle is broken at the UTF-8-smallest folder ID on every replica.
  - Notes that reference a missing or tombstoned folder remain visible at the notebook root as a defensive compatibility fallback.
  - Folder paths are preserved during backup export/import.
- **Test Criteria**:
  - [x] Playwright creates a root folder, drags a note into it, reloads, and verifies the nested note remains in that folder.
  - [x] Vitest synchronizes empty/nested folder entities, rename, note moves, tombstones, and deterministic parent normalization between Yjs replicas and simulated collaboration sessions.
  - [ ] Folder deletion reparents child content.
  - [ ] Drag-and-drop move behavior rejects self or descendant folder drops.
  - [x] The live XMTP dev-network matrix creates a web folder, moves a note into it, verifies the Tauri projection and CLI nested Markdown, then publishes a CLI-created empty root directory to web/Tauri and verifies both folder entities during late-contributor catch-up.
  - [ ] Live XMTP coverage still needs nested empty-folder creation, folder rename/parent move, directory rename/move, and folder deletion/reparenting in both directions.

### Backup, Import, and Export
- **Stability**: stable
- **Description**: Users can export encrypted notebook backups and import encrypted or plain JSON backups.
- **Properties**:
  - Imports accept `.json.encrypted` and `.json` files only.
  - Imports reject files over 50 MB.
  - Encrypted imports require a password before data is restored.
  - Imports recreate the notebook/folder tree, import notes, and select the restored notebook.
  - Exports serialize notebook, folder, and note data into a password-encrypted backup with a normalized filename.
- **Test Criteria**:
  - [ ] Invalid import extensions show a destructive toast.
  - [ ] Encrypted import with a valid password creates a notebook with restored content.
  - [ ] Export requires a non-empty password.

### Responsive Application Shell
- **Stability**: stable
- **Description**: The app presents notebook navigation, note navigation, editor surfaces, and status controls across desktop and mobile viewports.
- **Properties**:
  - Desktop layouts keep notebook and editor regions visible side by side.
  - Mobile layouts stack navigation and editor regions without horizontal overflow.
  - A top-bar control switches between light and dark themes and persists the preference to local storage.
  - The initial theme uses stored preference first, then system preference.
  - IPFS and XMTP status indicators remain visible in the top bar.
  - A top-left app information control shows the running version, build timestamp, linked GitHub commit, and local-first note-taking app description.
  - A live workspace status summarizes the selected notebook, selected note, content counts, editor state, and connection state for assistive tools and LLM-driven browsers.
  - Browser-safe Obsidian-style hotkeys are available from the top bar and use Ctrl+Alt on Windows/Linux or Cmd+Option on macOS.
  - Blocked IndexedDB upgrades show a recovery screen with guidance and storage-clear action.
- **Test Criteria**:
  - [x] Playwright checks desktop and mobile shell screenshots.
  - [x] Playwright checks for horizontal overflow at desktop and mobile widths.
  - [x] Playwright verifies the light-to-dark theme toggle state change.
  - [x] Playwright verifies the app information dialog exposes version, build metadata, and the linked commit.
  - [x] Playwright verifies workspace status, selected ARIA state, and hotkey help visibility.

### XMTP Identity and Connection Management
- **Stability**: in-progress
- **Description**: Users can create or reuse an XMTP identity and manage connection state from the top bar.
- **Properties**:
  - Users without an identity can generate a local XMTP-compatible keypair from the connection modal.
  - The XMTP status chip opens a modal showing connection state, address, active conversations, connected notebook count, and network environment.
  - Users can toggle between dev and production environments when disconnected.
  - Users can connect or disconnect from XMTP from the modal.
  - A debug logging switch controls verbose XMTP console output.
  - The SDK must be `@xmtp/browser-sdk` v5 or newer.
  - XMTP clients are created with `Client.create(signer, { env })`.
  - Ethereum identifiers use `{ identifierKind: 'Ethereum', identifier: address }`.
- **Test Criteria**:
  - [ ] Browser tests cover the connection modal without requiring live XMTP network calls.
  - [ ] Network environment toggling is covered while disconnected.
  - [ ] Debug logging state is covered in the modal.

### Collaboration Over XMTP
- **Stability**: in-progress
- **Description**: Users can edit the same notebook through a Yjs document carried by an encrypted XMTP MLS group.
- **Properties**:
  - Collaborators can be added by ENS name or Ethereum address.
  - Reachability is verified through XMTP before contacts are used for collaboration.
  - Notebook settings project the current collaborator list directly from XMTP inbox membership; role and removal mutations use inbox IDs so multi-address and multi-installation identities remain coherent.
  - Collaborator authorization uses XMTP's native `Member`, `Admin`, and `SuperAdmin` roles rather than duplicating access control in notebook metadata. Admins can manage members, while super admins can also manage roles.
  - The current installation cannot change or remove its own role from notebook settings, and the final super admin cannot be demoted or removed.
  - Removing a collaborator revokes access to future MLS updates but cannot erase notebook content that installation already downloaded; the UI states this boundary explicitly.
  - One XMTP MLS group in one XMTP environment represents a collaborative notebook; cross-environment rebinding is rejected and the real conversation ID is persisted locally.
  - Group descriptions bind a conversation to a URI-encoded notebook ID; unrelated groups are ignored.
  - New groups use XMTP admin-only permissions and membership is added by Ethereum identifier.
  - One Yjs document owns notebook metadata, stable note IDs, `Y.Text` note title/content, note folder references, and first-class folder entities. Each folder has a stable ID, `Y.Text` name, parent reference, timestamps, and deletion tombstone in the additive `folders` root.
  - Local Yjs updates are merged into a 250 ms batch before XMTP transmission.
  - Strict, versioned protocol messages support manifests, snapshots, incremental updates, and state-vector requests.
  - Binary updates are size-bounded, chunked, duplicate-tolerant, and safely reassembled out of order.
  - A two-way state-vector handshake repairs missed history and offline edits in either direction.
  - Incoming XMTP groups can be accepted or rejected through group consent; accepted notebooks are materialized locally.
  - Environment-keyed Yjs state is authoritative on reconnect; remote projections persist to IndexedDB, update open UI state, and preserve tombstones.
  - Same-inbox devices distinguish their own messages by protocol message ID instead of dropping all messages from the inbox.
  - Selecting a linked notebook resumes collaboration, while explicit stop and disconnect cleanly end streams.
  - Folder creation, rename, parent moves, deletion, and note-to-folder moves are persisted and broadcast as ordinary CRDT deltas, so browser and Tauri webview replicas converge on the same tree without application-level metadata messages.
  - Legacy schema-v1 Yjs state without the additive `folders` root remains readable; the local folder rows are recovered safely without allowing stale seed data to resurrect a shared tombstone.
  - Stopping collaboration tears down active streams and clears session state.
- **Test Criteria**:
  - [x] Vitest covers ENS/address resolution.
  - [x] Vitest covers native collaborator refresh, reachability, duplicate detection, add/remove by inbox, role promotion/demotion, serialized mutations, self-protection, and final-super-admin protection.
  - [x] Component tests cover role-based collaborator controls and identity display without a live XMTP network.
  - [x] Vitest covers concurrent Yjs edits, offline state-vector repair, duplicate/out-of-order updates, and deletion tombstones.
  - [x] Vitest covers first-class folder creation, nesting, rename, note moves, tombstones, legacy-state recovery, and deterministic cycle normalization.
  - [x] Vitest covers group creation, 250 ms batching, history/live delivery, same-inbox installations, and stream cleanup.
  - [x] A deterministic two-client transport test proves both replicas converge after concurrent edits.
  - [ ] Browser tests cover invite acceptance/rejection without live XMTP network calls.
  - [x] CI on relevant `main` changes exercises shared web/Tauri sessions, the directory CLI, and a dynamically added collaborator through four independent XMTP dev-network identities, installations, and databases. It includes web-folder/note-move projection into Tauri and CLI Markdown, CLI empty-directory projection into web/Tauri, late-contributor folder catch-up, and native role promotion/demotion/removal.

### Command-Line Markdown Sync
- **Stability**: in-progress
- **Description**: A Node CLI binds an XMTP notebook to a bidirectional, indexer-friendly directory of Markdown files.
- **Properties**:
  - `stormdance auth init`, `auth import`, and `auth address` manage named XMTP identity profiles.
  - CLI identities use encrypted ethers keystores, 0700 profile directories, 0600 files, and a stable 32-byte XMTP database encryption key.
  - Identity import accepts a raw private key or encrypted keystore only on standard input, never as a CLI option.
  - `notebooks list` discovers only groups with the storm.dance notebook description prefix.
  - `link` persists strict schema-2 `.stormdance/config.json` metadata, including the expected XMTP inbox ID, and performs the initial sync.
  - `sync` performs a finite catch-up; `sync --watch` keeps the group and directory live until interrupted.
  - `.stormdance/state.bin` persists the local Yjs replica so catch-up does not depend on indefinite XMTP history.
  - Live notes and first-class folder entities materialize as an Obsidian-compatible tree of collision-safe directories and `.md` files; nested and empty remote folders exist on disk without placeholder notes, and existing note paths stay stable when only a title changes.
  - Metadata-free Markdown is adopted in place once, including inside nested Obsidian folders, rather than repeatedly imported as duplicate notes.
  - External edits, new Markdown files, note moves, directory create/rename/move/delete operations, and owned-file deletion tombstones flow back into Yjs and XMTP. The actual parent directory determines a moved note's folder instead of stale embedded metadata.
  - `.stormdance/manifest.json` records folder ID-to-path ownership hints. It preserves stable IDs through unambiguous directory moves and renames; new directories receive deterministic, notebook-scoped `obsidian:path:<encoded-notebook-id>:<encoded-relative-path>` IDs so identical vault paths in different notebooks cannot collide.
  - Writes are atomic per file, unchanged files are not rewritten, unsafe paths and symlinks are rejected, and unowned files are never overwritten or deleted. Retired folder paths are removed only when they are real empty directories, so attachments and other Obsidian data prevent deletion.
  - The ordinary Markdown vault can be consumed by local full-text search, embedding pipelines, and vector databases without a storm.dance-specific reader.
- **Test Criteria**:
  - [x] Vitest covers schema-1 migration, schema-2 metadata, nested Obsidian adoption, empty/nested folder materialization, stable folder identity across rename/move, note moves between folders, deletion, UTF-8, collision, unowned-content preservation, and symlink safety.
  - [x] Vitest covers group discovery, strict link configuration, history replay, Yjs persistence, delta requests, 250 ms batching, remote folder-tree materialization, and publishing an empty filesystem directory as shared CRDT state.
  - [x] A live dev-network smoke test links a CLI profile invited from the browser and observes note edits in both directions.
  - [x] The live dev-network smoke materializes a web-created folder and moved note as nested CLI Markdown, then publishes an ordinary CLI-created empty root directory into the web/Tauri folder tree and a later contributor's catch-up state.
  - [ ] Live CLI coverage still needs empty nested directories, directory rename/move/delete, and filesystem note moves back into browser replicas.

### Filesystem-First Agent and Obsidian Workspaces
- **Stability**: in-progress
- **Description**: A linked notebook behaves like a normal Obsidian-compatible Markdown directory so humans, editors, scripts, and coding agents can collaborate through ordinary filesystem operations without storm.dance-specific editing commands.
- **Properties**:
  - The directory is the primary automation interface: creating, reading, rewriting, renaming, moving, or deleting a managed Markdown file maps to the equivalent notebook operation.
  - The CLI is responsible for lifecycle and diagnostics through commands such as `auth`, `notebooks list`, `link`, `sync`, `watch`, `status`, `doctor`, and `unlink`; routine note authoring does not require `new`, `edit`, or patch commands.
  - A long-running watcher converts filesystem changes into Yjs/Yrs transactions, persists them before transmission, and carries the resulting updates through the notebook's XMTP MLS group.
  - Remote CRDT updates are materialized back to disk with same-directory temporary files, flushes, and atomic renames.
  - Watcher feedback suppression uses persisted content hashes rather than event timing because filesystem events can be duplicated, coalesced, delayed, or reordered.
  - A stable note ID, not its filename or title, is the note's identity. A `.stormdance` manifest maps relative paths to note IDs and synchronized hashes; an unobtrusive leading HTML comment makes identity recoverable after moves or copies.
  - The manifest remains authoritative for an already managed path if an editor or agent accidentally removes the embedded metadata comment.
  - Notebook folders are shared CRDT entities that project to real directories instead of a flat mirror. Empty and nested directories round-trip between browser/Tauri folder trees and Node/Rust vaults; paths are normalized and collision-safe without changing stable folder or note IDs.
  - The manifest maps folder IDs to paths so unambiguous filesystem directory rename/move operations keep their CRDT identity. A new directory receives a deterministic path-derived ID, and a note moved with ordinary filesystem tools adopts its actual parent directory.
  - The linked directory can be opened directly as an Obsidian vault. storm.dance does not require a proprietary Markdown parser or a custom Obsidian plugin for ordinary editing and synchronization.
  - `.obsidian/`, `.trash/`, and other editor configuration directories are treated as local, unowned data unless a future explicit settings-sync feature is enabled; storm.dance never deletes or interprets them as notes.
  - Folder ownership is deliberately conservative: a manifest path is not permission for recursive removal. A remote folder tombstone or move can retire only a real empty directory, and symlinks, attachments, unowned Markdown, and other user content are never followed or deleted.
  - Standard Markdown and Obsidian syntax is preserved losslessly when storm.dance does not need to interpret it, including YAML frontmatter, `[[wikilinks]]`, `![[embeds]]`, tags, task lists, callouts, block references, footnotes, and fenced code blocks.
  - Note metadata does not commandeer user YAML frontmatter. The default identity marker remains an HTML comment, with any future frontmatter integration confined to a namespaced `stormdance` key.
  - Obsidian-style internal links and relative Markdown links remain readable. File renames must not silently rewrite unrelated prose, and any automatic link rewriting must be explicit, scoped, and tested.
  - Non-Markdown attachments are preserved as unowned files in the initial native mirror. Cross-device attachment replication requires a separately specified content-addressed asset transport; references must not be destroyed while that transport is unavailable.
  - Existing metadata-free Markdown files are adopted in place, including nested files, without creating canonical duplicates or flattening the vault.
  - Current reconciliation revalidates exact path/hash witnesses across each scan. Rust/Tauri preserves a changed or ambiguous local version in a clearly named conflict file; the Node mirror protects a newer save in place for its next scan rather than silently discarding it.
  - Target: retain a semantic three-way base so non-overlapping stale whole-file saves can merge automatically instead of producing a conflict artifact.
  - Target: add a configurable deletion grace period and recoverable trash before emitting a distributed tombstone.
  - Linked-directory configuration records the notebook ID, XMTP conversation ID, environment, profile, and expected inbox ID. The inbox ID is a safety assertion for the CLI profile that owns that transport database; a separate Tauri webview group member validates notebook/conversation/environment without pretending to own the CLI profile.
  - Copying a vault without its credentials produces a clear profile/inbox diagnostic. Credentials and MLS database material never live inside the shareable vault.
  - Search and embedding tools can index the vault directly. An optional JSONL change feed may provide stable note IDs and cursors for incremental indexers without becoming a separate editing interface.
- **Test Criteria**:
  - [ ] Cross-platform tests cover create, modify, rename, nested move, atomic-save, delete, and remote-materialization behavior.
  - [ ] Duplicate, coalesced, reordered, and self-generated filesystem events do not create sync loops or duplicate notes.
  - [ ] A three-way reconciliation test preserves simultaneous browser and stale whole-file agent edits.
  - [ ] Ambiguous edits and deletions retain recoverable content and never silently destroy the remote or local version.
  - [ ] An Obsidian fixture vault round-trips frontmatter, wikilinks, embeds, tasks, callouts, block references, code fences, Unicode paths, and nested folders byte-for-byte where no semantic edit occurred.
  - [ ] `.obsidian/`, attachments, symlinks, unsafe paths, and unowned files are never rewritten or deleted by note synchronization.
  - [ ] Profile mismatch reports the expected and actual inbox IDs without exposing private key material.
  - [ ] Obsidian and an ordinary coding agent can edit the same watched vault while a browser collaborator observes convergent changes.
  - [x] Node tests cover browser-to-vault empty/nested folder materialization, vault-to-browser empty directory creation, directory rename/move identity, note moves between folders, tombstones, unowned content, and symlink safety through the shared directory sync path.
  - [x] Rust tests cover nested Markdown adoption, empty/nested folder scans and materialization, folder rename and note move distinction, stable identity, atomic materialization, watcher feedback suppression, fenced metadata, Windows reserved names, dirty tombstone conflict preservation, and parent-symlink rejection.
  - [x] The live XMTP smoke proves web-to-CLI folder/note materialization and CLI-to-web/Tauri empty-root-directory projection; the rename/move/delete directions remain release gates.

### Native Rust Core, CLI, and Sync Daemon
- **Stability**: in-progress
- **Description**: A reusable Rust/Yrs core now powers native Markdown reconciliation, a filesystem-first CLI, and the desktop vault bridge. The Node CLI remains the live XMTP-capable headless client until the direct libxmtp driver is production-ready.
- **Properties**:
  - A reusable `storm-core` owns notebook operations without depending on Tauri, React, command-line parsing, or a particular presentation layer.
  - Native transport is isolated behind `XmtpTransport`, with the reviewed upstream `libxmtp` revision recorded as a compatibility pin. Upstream's Rust crates are not published as a stable SDK, so the default binary does not claim a direct live libxmtp driver yet.
  - Yrs applies the same Yjs-compatible update encoding and state-vector protocol used by the browser; Rust does not introduce a second notebook data model.
  - The native Yrs document exposes the same additive `folders` root and projects folder name, parent, timestamps, and tombstone fields. Rust vault scans create/update/tombstone those entities from real directories, while materialization creates empty/nested directories and relocates owned notes when their folder changes.
  - Native directory retirement follows the same conservative boundary as the Node mirror: never traverse a symlink or recursively delete a path, and remove only empty real directories after preserving unowned content.
  - The native implementation preserves the existing versioned storm.dance envelope, validation bounds, chunking, duplicate tolerance, tombstones, and catch-up behavior.
  - The packaged native CLI is intentionally local-only today: `sync` and `watch` reconcile Markdown/Yrs state and explicitly report `networkSynchronized: false`. The packaged Node CLI remains the supported live XMTP CLI.
  - Target: one process owns a profile's encrypted XMTP database at a time; short-lived commands use daemon IPC or an exclusive profile lock.
  - Target: native profiles use OS key storage, portable encrypted recovery bundles, and explicit inbox/installation separation.
  - Target: migrate Node-created profiles from copies with rollback; Node and Rust implementations never concurrently open one database.
  - Human-readable output is the default for the current lifecycle commands, while `--json` provides stable noninteractive diagnostics for agents and scripts.
  - Target: expose an optional MCP server for typed discovery, reading, search, status, and change subscriptions while keeping files as the authoring interface.
- **Test Criteria**:
  - [ ] Rust can register or recover an XMTP identity, report its inbox/installation IDs, enumerate storm.dance groups, and stream messages on the dev network.
  - [x] Committed fixtures prove Yjs-created full state, nested folder entities, note/folder tombstones, incremental updates, state vectors, concurrent edits, and all wire message kinds are accepted by Yrs/Rust.
  - [x] The Rust protocol engine has deterministic in-memory transport tests for snapshots and concurrent incremental updates; strict wire fixtures cover duplicate and out-of-order chunks.
  - [x] A separately labeled Yrs-produced full-state and incremental fixture is consumed directly by Yjs to prove the reverse producer direction.
  - [x] Rust tests cover folder CRDT convergence/tombstones and bidirectional empty/nested directory, folder rename/move, and owned-note relocation behavior.
  - [ ] The direct libxmtp driver passes dev-network identity, group, stream, and same-inbox installation tests.
  - [ ] Profile locking prevents concurrent database ownership by the daemon, standalone CLI, or desktop process.
  - [ ] A migration test opens a copied Node-created profile, verifies the same inbox and groups, and leaves the source profile untouched.
  - [ ] Release CI builds and tests signed native binaries for supported Linux, macOS, and Windows targets.

### Tauri Desktop Application
- **Stability**: in-progress
- **Description**: The existing React notebook experience can run as a Tauri desktop application backed by the native Rust core while the hosted web application remains a complete independent client.
- **Properties**:
  - The web application remains first-class: it can create, edit, organize, invite, collaborate, recover state, and operate offline without a desktop daemon or native installation.
  - Browser clients use Yjs, IndexedDB, and the supported XMTP browser SDK. The first desktop milestone deliberately reuses that proven XMTP session inside the Tauri webview while a typed Yjs-v1 IPC bridge connects it to the native Yrs vault; direct native libxmtp remains the next transport-adapter milestone.
  - Hosted web, Tauri's shared webview session, and the Node directory CLI are ordinary XMTP installations that can participate in the same notebook group without routing through one another. A direct native daemon installation remains planned.
  - Tauri reuses the complete React interface and adds typed commands/events for runtime status, directory selection, watch lifecycle, full-state materialization, and native CRDT updates. Native vault updates enter the ordinary XMTP batcher; remote/browser state is merged back into every matching watched vault.
  - The bridge carries the complete Yjs-v1 state, including first-class folders, so webview folder create/rename/move/delete and note drag operations materialize through Rust as real directories, while external empty/nested directory changes project back into the React folder tree and XMTP session.
  - The editor remains locally responsive: React applies edits immediately and IndexedDB is always persisted before XMTP broadcast; when a matching vault is watched, the Rust core also persists and materializes the merged state before that broadcast.
  - The current desktop shell includes native vault access, background filesystem watching, conflict-safe materialization, runtime status, and a system tray. OS-keyring credentials, native encrypted XMTP SQLite ownership, notifications, and native FTS remain planned.
  - Target: the desktop process and daemon share one profile-ownership/IPC design rather than running competing XMTP clients against the same database.
  - Target: SQLite FTS provides built-in local text search. Today, full-text and vector tools consume the Markdown vault directly.
  - Browser identity storage should move from raw EOA material in `localStorage` to an encrypted keystore or wallet/passkey-backed flow with an explicit encrypted recovery format interoperable with native clients.
- **Test Criteria**:
  - [ ] Browser-to-browser, browser-to-desktop, browser-to-headless-CLI, and desktop-to-headless-CLI collaboration all converge on the same protocol fixtures and dev network.
  - [ ] The hosted web app passes its complete feature suite with no native service installed or reachable.
  - [ ] Tauri restarts offline from native state, accepts edits, and catches up without data loss when XMTP connectivity returns.
  - [ ] Desktop vault edits made through React, Obsidian, and external agents converge without running duplicate local replicas.
  - [ ] Packaging tests verify credential permissions, profile locking, auto-update integrity, and clean uninstall behavior without deleting user vaults.
  - [x] Unit tests cover hosted-web native no-ops, local-native update capture, desktop-session projection/persistence/XMTP broadcast, and Rust vault reconciliation.
  - [x] The live XMTP smoke verifies that the shared Tauri webview session receives a web-created folder/note move and a CLI-created empty root folder, including late-contributor catch-up.
  - [x] CI defines unsigned development package builds for Windows x86_64, macOS arm64/x86_64, and Linux x86_64 plus CLI archives.

### IPFS Status and Decentralized Storage
- **Stability**: in-progress
- **Description**: The UI surfaces IPFS connectivity and prepares for decentralized note persistence.
- **Properties**:
  - The status indicator checks a local IPFS API endpoint before trying a public gateway.
  - Users can configure a custom endpoint from the IPFS status control.
  - Failed IPFS checks degrade to an offline status without blocking local note editing.
- **Test Criteria**:
  - [x] Playwright mocks failed IPFS calls and verifies the app still loads.
  - [ ] Settings changes persist to local storage.
  - [ ] Successful local and gateway statuses are covered with mocked responses.

### Web3 Identity and Encryption Roadmap
- **Stability**: planned
- **Description**: storm.dance is intended to evolve into a decentralized, encrypted, collaborative notes app.
- **Properties**:
  - Client-side encryption should happen before decentralized storage.
  - Ethereum wallet identity should interoperate with collaboration and publishing.
  - Data pointer mechanisms may use an L2 contract, ENS/IPNS, ENS/CCIP-Read, Ceramic, or XMTP-centric discovery.
  - Farcaster friend syncing may bootstrap social connections.
  - Application-level encryption at rest and key wrapping should complement the existing XMTP MLS transport and Yjs conflict resolution.
- **Test Criteria**:
  - [ ] Encryption round-trips note data before any remote storage write.
  - [ ] Identity-derived keys or key wrapping are specified before implementation.
  - [ ] Sync transport behavior is tested with conflicting edits.

## Technology Constraints

- **Framework**: React 18
- **Build Tool**: Vite 6
- **Language**: TypeScript 5.6
- **Styling**: Tailwind CSS 3.4 with Radix UI primitives and shadcn-style component patterns
- **Icons**: Lucide React
- **Local Database**: IndexedDB through `idb`
- **Forms**: React Hook Form and Zod
- **Date Handling**: date-fns
- **Messaging**: `@xmtp/browser-sdk` 5.0.1 and `@xmtp/node-sdk` 6.x
- **Collaboration**: Yjs 13.x with a versioned, chunked text protocol over XMTP MLS groups
- **Current Live CLI Runtime**: Node.js 22 or newer with the supported XMTP Node SDK
- **Native Runtime**: Rust with Yrs, shared storage/protocol crates, a filesystem-first CLI, and Tauri; direct libxmtp is kept behind a pinned driver boundary until upstream exposes a stable integration surface
- **Desktop**: Tauri with the existing React UI and typed native adapters; desktop capabilities must not become requirements for the hosted web client
- **Filesystem Projection**: Obsidian-compatible Markdown vaults with stable note identity, nested folder projection, atomic writes, manifest hashes, and conservative ownership boundaries
- **Ethereum**: Ethers.js 6
- **Polyfills**: `buffer` for browser-safe binary compatibility

## UX Implementation Notes

### Inline Action Buttons
- Action buttons inside clickable rows must stop propagation on click.
- Buttons that sit inside selectable rows often also need `onMouseDown={(e) => e.stopPropagation()}` so focus and row selection do not fire first.
- Reserve horizontal space for row actions so long text does not run underneath absolutely positioned buttons.
- Notebook and note actions should be visible on hover, focus, or selected state so touch and keyboard users can discover them.

### Keyboard Navigation
- Pressing `Tab` while focused on a column container cycles Notebooks -> Notes -> Editor.
- Editable elements such as `input`, `textarea`, `select`, `button`, and `contenteditable` bypass custom tab handling.
- Pressing `n` in the notes tree creates a note in the focused folder or in the focused note's folder.
