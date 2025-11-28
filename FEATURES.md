# Features

This document summarizes the storm.dance capabilities and roadmap. Features are grouped into **Stable**, **In Development**, and **Planned** to preserve delivered behavior while keeping upcoming work visible.

## Stable Features

### Notebook Lifecycle
- **Create notebooks via modal**: Users open the creation modal, which seeds the name field with a random adjective/subject pairing. Submitting a non-empty name creates the notebook, places it in the list, and selects it automatically.
- **Rename notebooks inline**: Selecting rename turns the notebook title into an input; submitting a non-empty, changed value updates persistence and the list entry.
- **Delete notebooks with confirmation**: Deleting a notebook asks for confirmation, removes contained data, and automatically selects the next available notebook (or clears state if none remain).
- **Notebook info panel with export/delete controls**: The notebook info view displays identifiers and timestamps and provides export and delete buttons for the active notebook.

### Folder Organization
- **Hierarchical folders**: Users can create folders (and subfolders) within a notebook, rename them inline, and drag/drop notes or folders to organize content; folder paths are preserved when exporting/importing.
- **Folder deletion**: Removing a folder clears its notes/folders from the hierarchy and updates the view accordingly.

### Note Management
- **Create, edit, delete notes**: Notes belong to the selected notebook/folder, support Markdown editing, and update their metadata when changed. Notes can be removed individually from the list.
- **Tabbed editing and selection**: Recently opened notes appear as tabs; clicking a note selects it for editing, and the sidebar keeps the active note synchronized with the editor.
- **Keyboard and focus affordances**: Sidebar items expose focus helpers so keyboard navigation remains aligned with selection and rename flows.

### Backup, Import, and Export
- **Encrypted notebook backups**: The notebook info panel exports the selected notebook (including folders and notes) as a password-encrypted JSON file with normalized filenames.
- **Validated, passworded import**: Import accepts only `.json` or `.json.encrypted` files under 50 MB, prompts for the export password, decrypts the payload, recreates the notebook/folder tree, and imports notes before selecting the new notebook.

### UI and Theming
- **Theme toggle**: A top-bar control switches between light and dark themes, persists the preference to `localStorage`, and initializes using the stored or system preference.
- **Status indicators**: The top bar surfaces IPFS and XMTP status pills so users can quickly tell whether messaging and decentralized storage services are reachable.

### Data Storage and Reliability
- **IndexedDB-backed persistence**: Notes, folders, and notebooks are stored locally via IndexedDB services for offline-friendly usage.
- **Blocked database recovery**: If the IndexedDB upgrade path is blocked (e.g., another tab open), the app shows a blocking screen with guidance and a one-click storage clear to recover.

## In Development

### XMTP Identity and Connection Management
- **Local XMTP identity creation**: Users without an identity can generate a local XMTP-compatible keypair from the connection modal and store it for subsequent sessions.
- **Connection modal with environment toggle**: The XMTP status chip opens a modal showing connection state, address, and network environment (dev/production) with a toggle disabled while connected.
- **Debug logging toggle**: The modal includes a switch to enable or disable verbose XMTP console logging during collaboration or invite handling.
- **Connect/Disconnect controls**: Users can connect or disconnect from XMTP directly from the modal; the UI shows active conversations, connected notebook count, and status icons for quick feedback.

### Collaboration Over XMTP
- **Contact management with ENS resolution**: Collaborators can be added via ENS name or address; reachability is verified with XMTP before adding to the contact list, and contacts can be removed.
- **Start/stop collaboration sessions**: A collaboration session can be started for the selected notebook; the hook opens an XMTP topic, stores it on the notebook, and broadcasts local CRDT updates while active. Stopping the session tears down the stream and clears session state.
- **Invite handling**: Incoming XMTP messages are streamed; valid invite payloads open an invite modal where users can accept or reject collaboration. Accepting adds the inviter as a contact and joins the notebook session.
- **Remote updates persistence**: Remote CRDT updates are merged into local state and persisted to IndexedDB so remote edits stay synchronized across sessions.

## Planned Features

### Phase 2: Web3 Identity & Encryption
- **Wallet Connection:** Integrate Ethereum wallet connection (e.g., MetaMask) for user identity (`wagmi`/`viem`/`ethers.js`).
- **Client-Side Encryption:** Encrypt note content in the browser before storage, using keys derived from wallet signatures (Web Crypto API, AES-GCM/XChaCha20, KDF like HKDF).

### Phase 3: Decentralized Storage & Discovery
- **IPFS Integration:** Upload encrypted notes to IPFS for persistence beyond the browser (`Helia`, Pinning Services like Pinata).
- **Data Pointer Mechanism:** Implement a system to track the latest IPFS CID for a user's notes. Options include:
  - Simple L2 Smart Contract (e.g., "IPCM" on Base/Optimism).
  - ENS + IPNS.
  - ENS + CCIP-Read gateway.
  - Ceramic Network (DID/Streams).

### Phase 4: Interoperability & Social Features
- **Standalone Follower Node (Optional):** A server-side component to monitor and cache data from followed users.
- **Farcaster Friend Syncing:** Import Farcaster follow graph to bootstrap social connections within the app (Neynar API / Hub API).
- **ENS Publishing:** Allow users to publish their data root pointer (IPCM address, CID, DID) to their ENS name for discoverability (Text Records / CCIP-Read).

### Phase 5 (Potential): Real-Time Collaboration
- **CRDT Synchronization:** Enable real-time, conflict-free collaborative editing using CRDTs (`Yjs` / `Automerge`).
- **Sync Transport:** Implement a synchronization mechanism (WebRTC / WebSocket Relay / XMTP).
- **Challenge:** Address the significant complexity of synchronizing *encrypted* CRDT data.

### Alternative Approach: XMTP-Centric Integration
- Explore deeper integration with **XMTP** for:
  - Identity and discovery.
  - Secure group management for shared notes (using MLS).
  - Transporting CRDT updates or data pointers (via custom content types or remote attachments).
  - Securely sharing encryption keys for collaboration within groups.

*(Speculative implementation notes and historical details remain available in prior revisions for reference.)*
