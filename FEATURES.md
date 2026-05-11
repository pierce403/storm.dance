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
- **Description**: Users can coordinate notebook collaboration sessions over XMTP.
- **Properties**:
  - Collaborators can be added by ENS name or Ethereum address.
  - Reachability is verified through XMTP before contacts are used for collaboration.
  - A collaboration session can be started for the selected notebook.
  - Starting collaboration opens DM conversations, sends invite payloads, and stores the notebook topic.
  - Local note updates can be broadcast as CRDT update payloads.
  - Incoming invite payloads can be accepted or rejected.
  - Remote CRDT updates merge into local state and persist to IndexedDB.
  - Stopping collaboration tears down active streams and clears session state.
- **Test Criteria**:
  - [x] Vitest covers ENS/address resolution.
  - [x] Vitest covers collaboration broadcast and duplicate remote update handling.
  - [ ] Browser tests cover invite acceptance/rejection without live XMTP network calls.
  - [ ] Multi-client collaboration tests cover remote note update application.

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
  - Encrypted CRDT synchronization must account for key sharing and conflict resolution.
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
- **Messaging**: `@xmtp/browser-sdk` 5.0.1
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
