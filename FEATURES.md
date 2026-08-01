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
  - Folder paths are preserved during backup export/import.
- **Test Criteria**:
  - [x] Playwright creates and toggles a root folder.
  - [ ] Folder deletion reparents child content.
  - [ ] Drag-and-drop move behavior rejects self or descendant folder drops.

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
  - One XMTP MLS group in one XMTP environment represents a collaborative notebook; cross-environment rebinding is rejected and the real conversation ID is persisted locally.
  - Group descriptions bind a conversation to a URI-encoded notebook ID; unrelated groups are ignored.
  - New groups use XMTP admin-only permissions and membership is added by Ethereum identifier.
  - One Yjs document owns notebook metadata, stable note IDs, `Y.Text` title/content, timestamps, folder IDs, and deletion tombstones.
  - Local Yjs updates are merged into a 250 ms batch before XMTP transmission.
  - Strict, versioned protocol messages support manifests, snapshots, incremental updates, and state-vector requests.
  - Binary updates are size-bounded, chunked, duplicate-tolerant, and safely reassembled out of order.
  - A two-way state-vector handshake repairs missed history and offline edits in either direction.
  - Incoming XMTP groups can be accepted or rejected through group consent; accepted notebooks are materialized locally.
  - Environment-keyed Yjs state is authoritative on reconnect; remote projections persist to IndexedDB, update open UI state, and preserve tombstones.
  - Same-inbox devices distinguish their own messages by protocol message ID instead of dropping all messages from the inbox.
  - Selecting a linked notebook resumes collaboration, while explicit stop and disconnect cleanly end streams.
  - Folder IDs travel with notes, but folder entities/names are not yet synchronized between browser replicas; notes for unknown folders remain visible at the notebook root.
  - Stopping collaboration tears down active streams and clears session state.
- **Test Criteria**:
  - [x] Vitest covers ENS/address resolution.
  - [x] Vitest covers concurrent Yjs edits, offline state-vector repair, duplicate/out-of-order updates, and deletion tombstones.
  - [x] Vitest covers group creation, 250 ms batching, history/live delivery, same-inbox installations, and stream cleanup.
  - [x] A deterministic two-client transport test proves both replicas converge after concurrent edits.
  - [ ] Browser tests cover invite acceptance/rejection without live XMTP network calls.
  - [ ] A live dev-network smoke test covers two independent XMTP identities and installations.

### Command-Line Markdown Sync
- **Stability**: in-progress
- **Description**: A Node CLI binds an XMTP notebook to a bidirectional, indexer-friendly directory of Markdown files.
- **Properties**:
  - `stormdance auth init`, `auth import`, and `auth address` manage named XMTP identity profiles.
  - CLI identities use encrypted ethers keystores, 0700 profile directories, 0600 files, and a stable 32-byte XMTP database encryption key.
  - Identity import accepts a raw private key or encrypted keystore only on standard input, never as a CLI option.
  - `notebooks list` discovers only groups with the storm.dance notebook description prefix.
  - `link` persists strict `.stormdance/config.json` metadata and performs the initial sync.
  - `sync` performs a finite catch-up; `sync --watch` keeps the group and directory live until interrupted.
  - `.stormdance/state.bin` persists the local Yjs replica so catch-up does not depend on indefinite XMTP history.
  - Live notes materialize as flat, collision-safe `.md` files with stable identity/timestamp metadata.
  - Metadata-free Markdown is adopted in place once rather than repeatedly imported as duplicate notes.
  - External edits, new Markdown files, renames, and owned-file deletion tombstones flow back into Yjs and XMTP.
  - Writes are atomic per file, unchanged files are not rewritten, unsafe paths and symlinks are rejected, unowned files are never deleted, and manifest hashes preserve unsynced replacements of owned paths.
  - The flat directory can be consumed by local full-text search, embedding pipelines, and vector databases without a storm.dance-specific reader.
- **Test Criteria**:
  - [x] Vitest covers strict metadata round-trips, incremental materialization, adoption, rename, deletion, UTF-8, collision, and symlink safety.
  - [x] Vitest covers group discovery, strict link configuration, history replay, Yjs persistence, delta requests, 250 ms batching, and file deletion tombstones.
  - [ ] A live dev-network smoke test links a CLI profile invited from the browser and observes edits in both directions.

### Filesystem-First Agent and Obsidian Workspaces
- **Stability**: planned
- **Description**: A linked notebook behaves like a normal Obsidian-compatible Markdown directory so humans, editors, scripts, and coding agents can collaborate through ordinary filesystem operations without storm.dance-specific editing commands.
- **Properties**:
  - The directory is the primary automation interface: creating, reading, rewriting, renaming, moving, or deleting a managed Markdown file maps to the equivalent notebook operation.
  - The CLI is responsible for lifecycle and diagnostics through commands such as `auth`, `notebooks list`, `link`, `sync`, `watch`, `status`, `doctor`, and `unlink`; routine note authoring does not require `new`, `edit`, or patch commands.
  - A long-running watcher converts filesystem changes into Yrs transactions, persists them before transmission, and carries the resulting updates through the notebook's XMTP MLS group.
  - Remote CRDT updates are materialized back to disk with same-directory temporary files, flushes, and atomic renames.
  - Watcher feedback suppression uses persisted content hashes rather than event timing because filesystem events can be duplicated, coalesced, delayed, or reordered.
  - A stable note ID, not its filename or title, is the note's identity. A `.stormdance` manifest maps relative paths to note IDs and synchronized hashes; an unobtrusive leading HTML comment makes identity recoverable after moves or copies.
  - The manifest remains authoritative for an already managed path if an editor or agent accidentally removes the embedded metadata comment.
  - Notebook folders project to real directories instead of a flat mirror. Paths are normalized and collision-safe without changing stable note IDs.
  - The linked directory can be opened directly as an Obsidian vault. storm.dance does not require a proprietary Markdown parser or a custom Obsidian plugin for ordinary editing and synchronization.
  - `.obsidian/`, `.trash/`, and other editor configuration directories are treated as local, unowned data unless a future explicit settings-sync feature is enabled; storm.dance never deletes or interprets them as notes.
  - Standard Markdown and Obsidian syntax is preserved losslessly when storm.dance does not need to interpret it, including YAML frontmatter, `[[wikilinks]]`, `![[embeds]]`, tags, task lists, callouts, block references, footnotes, and fenced code blocks.
  - Note metadata does not commandeer user YAML frontmatter. The default identity marker remains an HTML comment, with any future frontmatter integration confined to a namespaced `stormdance` key.
  - Obsidian-style internal links and relative Markdown links remain readable. File renames must not silently rewrite unrelated prose, and any automatic link rewriting must be explicit, scoped, and tested.
  - Non-Markdown attachments are preserved as unowned files in the initial native mirror. Cross-device attachment replication requires a separately specified content-addressed asset transport; references must not be destroyed while that transport is unavailable.
  - Existing metadata-free Markdown files are adopted in place, including nested files, without creating canonical duplicates or flattening the vault.
  - Reconciliation retains the last materialized base, the current CRDT text, and newly observed filesystem text so a stale whole-file save can be converted into changes against current state instead of blindly replacing concurrent remote edits.
  - Non-overlapping filesystem and remote edits merge automatically. Ambiguous overlapping edits preserve both versions in clearly named conflict files and surface a diagnostic rather than silently discarding content.
  - Delete-and-rename save patterns are reconciled before distributed deletion. Confirmed deletes use a configurable grace period and recoverable trash before emitting a CRDT tombstone.
  - Linked-directory configuration records the notebook ID, XMTP conversation ID, environment, profile, and expected inbox ID. The inbox ID is a safety assertion; the active XMTP client remains its authoritative source.
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

### Native Rust Core, CLI, and Sync Daemon
- **Stability**: planned
- **Description**: The current Node CLI evolves into a reusable Rust synchronization core shared by a native CLI, a single-owner background daemon, and the desktop application.
- **Properties**:
  - A reusable `storm-core` owns notebook operations without depending on Tauri, React, command-line parsing, or a particular presentation layer.
  - Native XMTP integration uses a pinned, reviewed `libxmtp` revision and treats upstream database/API upgrades as explicit migrations until a stable published Rust SDK exists.
  - Yrs applies the same Yjs-compatible update encoding and state-vector protocol used by the browser; Rust does not introduce a second notebook data model.
  - The native implementation preserves the existing versioned storm.dance envelope, validation bounds, chunking, duplicate tolerance, tombstones, and catch-up behavior.
  - One process owns a profile's encrypted XMTP database at a time. Short-lived CLI commands use an existing daemon over local IPC or acquire an exclusive profile lock before standalone operation.
  - Native profiles use OS key storage where available, encrypted portable recovery bundles where requested, and explicit separation between an XMTP inbox and its device installations.
  - Existing Node-created profiles and databases are migrated from copies with rollback retained; Node and Rust implementations never concurrently open the same database.
  - Human-readable output is the default for lifecycle commands, while `--json`, JSONL event streams, stable exit codes, and `--no-input` make diagnostics reliable for agents and scripts.
  - An optional MCP server exposes typed notebook discovery, reading, search, status, and change-subscription operations through the same core. Files remain the preferred interface for authoring.
- **Test Criteria**:
  - [ ] Rust can register or recover an XMTP identity, report its inbox/installation IDs, enumerate storm.dance groups, and stream messages on the dev network.
  - [ ] Committed cross-language fixtures prove Yjs-created state, updates, state vectors, chunks, and tombstones are accepted by Yrs and vice versa.
  - [ ] TypeScript and Rust replicas converge under concurrent edits, offline catch-up, duplicate delivery, out-of-order chunks, and same-inbox multi-installation delivery.
  - [ ] Profile locking prevents concurrent database ownership by the daemon, standalone CLI, or desktop process.
  - [ ] A migration test opens a copied Node-created profile, verifies the same inbox and groups, and leaves the source profile untouched.
  - [ ] Release CI builds and tests signed native binaries for supported Linux, macOS, and Windows targets.

### Tauri Desktop Application
- **Stability**: planned
- **Description**: The existing React notebook experience can run as a Tauri desktop application backed by the native Rust core while the hosted web application remains a complete independent client.
- **Properties**:
  - The web application remains first-class: it can create, edit, organize, invite, collaborate, recover state, and operate offline without a desktop daemon or native installation.
  - Browser clients continue to use Yjs, IndexedDB, and the supported XMTP browser SDK; desktop clients use Yrs, native storage, and `libxmtp` behind the shared compatibility contract.
  - Web, desktop, CLI, and daemon instances are ordinary XMTP installations that can participate in the same notebook group without routing through one another.
  - Tauri reuses the React interface but replaces browser persistence and transport adapters with typed native commands, subscriptions, and batched binary CRDT updates.
  - The editor remains locally responsive: React applies edits immediately, while the Rust core durably persists accepted batches before broadcasting them over XMTP.
  - Desktop capabilities include OS-keyring credentials, encrypted SQLite state, native vault access, background synchronization, system-tray status, invite notifications, and local search.
  - The desktop process and daemon share one profile-ownership/IPC design rather than running competing XMTP clients against the same database.
  - SQLite FTS provides built-in local text search. Embeddings and vector indexes remain optional, replaceable consumers of the Markdown vault or change feed.
  - Browser identity storage should move from raw EOA material in `localStorage` to an encrypted keystore or wallet/passkey-backed flow with an explicit encrypted recovery format interoperable with native clients.
- **Test Criteria**:
  - [ ] Browser-to-browser, browser-to-desktop, browser-to-headless-CLI, and desktop-to-headless-CLI collaboration all converge on the same protocol fixtures and dev network.
  - [ ] The hosted web app passes its complete feature suite with no native service installed or reachable.
  - [ ] Tauri restarts offline from native state, accepts edits, and catches up without data loss when XMTP connectivity returns.
  - [ ] Desktop vault edits made through React, Obsidian, and external agents converge without running duplicate local replicas.
  - [ ] Packaging tests verify credential permissions, profile locking, auto-update integrity, and clean uninstall behavior without deleting user vaults.

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
- **Current CLI Runtime**: Node.js 22 or newer
- **Planned Native Runtime**: Rust with Yrs and a pinned `libxmtp` revision, shared by the CLI, daemon, and Tauri application
- **Desktop**: Tauri with the existing React UI and typed native adapters; desktop capabilities must not become requirements for the hosted web client
- **Filesystem Projection**: Obsidian-compatible Markdown vaults with stable note identity, nested folder projection, atomic writes, manifest hashes, and conservative ownership boundaries
- **Ethereum**: Ethers.js 6
- **Polyfills**: `vite-plugin-node-polyfills`, `buffer`, `crypto-browserify`, and `stream-browserify`

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
