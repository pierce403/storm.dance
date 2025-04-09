# Features

This document outlines the current and planned features for the storm.dance application.

## Current Features (MVP)

The initial version focuses on core note-taking functionality within the browser.

### Core Note Management

*   **Create Notes:** Add new, untitled notes.
*   **Edit Notes:** Modify the title and content of selected notes with Markdown support.
*   **Delete Notes:** Remove notes individually.
*   **List Notes:** View notes in a sidebar, most recent first.
*   **Select Note:** Click a note in the sidebar to edit.

### Storage & UI

*   **Local Persistence:** Notes are stored locally using **IndexedDB**.
*   **Minimalist Interface:** Clean two-pane layout (sidebar and editor).
*   **Toast Notifications:** Feedback for actions (create, delete, errors).
*   **Responsive Layout:** Adapts to different screen sizes.

## Planned Future Features (Roadmap)

The following phases outline the plan to evolve storm.dance into a decentralized, collaborative application:

### Phase 2: Web3 Identity & Encryption

*   **Wallet Connection:** Integrate Ethereum wallet connection (e.g., MetaMask) for user identity (`wagmi`/`viem`/`ethers.js`).
*   **Client-Side Encryption:** Encrypt note content in the browser before storage, using keys derived from wallet signatures (Web Crypto API, AES-GCM/XChaCha20, KDF like HKDF).

### Phase 3: Decentralized Storage & Discovery

*   **IPFS Integration:** Upload encrypted notes to IPFS for persistence beyond the browser (`Helia`, Pinning Services like Pinata).
*   **Data Pointer Mechanism:** Implement a system to track the latest IPFS CID for a user's notes. Options include:
    *   Simple L2 Smart Contract (e.g., "IPCM" on Base/Optimism).
    *   ENS + IPNS.
    *   ENS + CCIP-Read gateway.
    *   Ceramic Network (DID/Streams).

### Phase 4: Interoperability & Social Features

*   **Standalone Follower Node (Optional):** A server-side component to monitor and cache data from followed users.
*   **Farcaster Friend Syncing:** Import Farcaster follow graph to bootstrap social connections within the app (Neynar API / Hub API).
*   **ENS Publishing:** Allow users to publish their data root pointer (IPCM address, CID, DID) to their ENS name for discoverability (Text Records / CCIP-Read).

### Phase 5 (Potential): Real-Time Collaboration

*   **CRDT Synchronization:** Enable real-time, conflict-free collaborative editing using CRDTs (`Yjs` / `Automerge`).
*   **Sync Transport:** Implement a synchronization mechanism (WebRTC / WebSocket Relay / XMTP).
*   **Challenge:** Address the significant complexity of synchronizing *encrypted* CRDT data.

### Alternative Approach: XMTP-Centric Integration

*   Explore deeper integration with **XMTP** for:
    *   Identity and discovery.
    *   Secure group management for shared notes (using MLS).
    *   Transporting CRDT updates or data pointers (via custom content types or remote attachments).
    *   Securely sharing encryption keys for collaboration within groups.

*(Note: The detailed speculative implementation notes and considerations from the original file have been omitted for brevity in this summary. Refer to version history if needed.)*
