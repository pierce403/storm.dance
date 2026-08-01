# storm.dance

storm.dance is a local-first Markdown notebook with real-time, encrypted XMTP
collaboration. It runs as a complete hosted web app or a Tauri desktop app, and
notebooks can be mirrored into ordinary Obsidian-compatible Markdown vaults.

## Implemented

- Browser notebooks, folders, tabs, Markdown editing, import, and encrypted
  backup export.
- One Yjs document and one XMTP MLS group per collaborative notebook, pinned to
  either the XMTP development or production environment.
- Concurrent title/content edits, note creation, note deletion tombstones,
  notebook rename, history replay, and state-vector catch-up.
- Invite discovery and acceptance through XMTP group consent.
- A bidirectional Markdown directory mirror suitable for local search,
  embeddings, vector indexing, static-site tooling, or another editor.
- A shared Rust/Yrs core, strict cross-language fixtures, nested native vault
  projection, filesystem-first native CLI, and typed Tauri CRDT bridge.
- Tauri development packages for Windows, macOS (Apple Silicon and Intel), and
  Linux, plus native CLI archives, built by the package matrix workflow.

The deterministic suite covers Yjs/Yrs compatibility, protocol chunking,
concurrent edits, state-vector repair, native IPC, and filesystem safety. An
XMTP dev-network workflow on relevant `main` changes exercises the actual web/Tauri collaboration
session and Node CLI directory-sync code paths with three disposable XMTP
installations. Packaging artifacts are unsigned development builds until the
platform signing secrets are configured.

The sync design and current limitations are documented in
[SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md). The feature/test inventory is in
[FEATURES.md](./FEATURES.md).

## Requirements

- Node.js 22 or newer
- npm
- A modern browser with IndexedDB, Web Workers, and WebAssembly
- Rust 1.95 or newer for the native CLI/core and Tauri development

## Web app development

```bash
git clone https://github.com/pierce403/storm.dance.git
cd storm.dance
npm ci
npm run dev
```

The local app is served at <http://localhost:5173>.

Useful checks:

```bash
npm test -- --run
npm run build
npm run test:e2e
```

## Browser collaboration

1. Create an XMTP identity from the top-bar connection control, or reuse the
   identity already stored by this browser profile.
2. Connect to the same XMTP environment as your collaborator.
3. Select a notebook, open its collaboration control, add the other person's
   Ethereum address, and start collaboration.
4. The other person connects to XMTP and accepts the incoming notebook invite.

The notebook's actual XMTP group ID is persisted locally. Selecting a linked
notebook resumes its live Yjs session; stopping the session leaves local note
editing available. A linked notebook cannot also be bound in the other XMTP
environment because its local IndexedDB projection is shared.

## Command-line Markdown mirror

Build and link the development CLI:

```bash
npm run build:cli
npm link
```

Create a dedicated, encrypted CLI identity. The passphrase is never accepted as
a command-line argument:

```bash
export STORMDANCE_KEYSTORE_PASSWORD='use-a-strong-passphrase'
stormdance auth init
stormdance auth address
```

Register the CLI installation on the matching XMTP network once. The first
list may be empty, but it makes the address reachable for the browser invite:

```bash
stormdance notebooks list --env dev
```

Invite the CLI address to the notebook from the browser. Then list the groups
again and link a directory:

```bash
stormdance notebooks list --env dev
stormdance link <notebook-id-or-conversation-id> ./my-notes --env dev
stormdance sync ./my-notes
stormdance sync ./my-notes --watch
```

`link` performs the first sync. `sync` performs a finite catch-up; `--watch`
keeps XMTP and the directory live until Ctrl-C. Link metadata and Yjs state are
stored under `./my-notes/.stormdance/`.

To reuse an existing EOA, pipe a raw private key or an ethers encrypted
keystore through standard input. The key is immediately stored as an encrypted
profile keystore and is never printed. For an interactive shell, read it without
terminal echo:

```bash
read -rsp 'Private key: ' STORMDANCE_IMPORT_KEY
printf '\n'
printf '%s' "$STORMDANCE_IMPORT_KEY" | stormdance auth import --profile work
unset STORMDANCE_IMPORT_KEY
```

Prefer a dedicated identity. Profiles live under the XDG data directory with
0700 directories and 0600 credential/state files.

Every mirrored Markdown file contains a storm.dance identity comment and an H1
title. When YAML frontmatter exists, the identity comment follows it rather than
commandeering user keys. Existing `.md` files are adopted in place on first
sync, including nested Obsidian folders. The schema-2 mirror does not follow
symlinks or delete files it cannot verify it still owns.

Folder IDs and nested paths round-trip with notes, but browser folder entities
and names are not yet CRDT-synchronized. A browser that does not recognize a
referenced folder shows the note at the notebook root. The linked config also
records the expected XMTP inbox ID, so copying a vault to the wrong identity
fails closed when the Node CLI profile opens it instead of silently joining
another inbox.

## Native Rust CLI

The Rust workspace contains `storm-core`, `storm-protocol`, `storm-storage`,
`storm-xmtp`, and `storm-cli`. Build and inspect the filesystem-first client:

```bash
cargo build --locked --package storm-cli
target/debug/stormdance --help
```

The native CLI provides `auth`, `list`, `link`, `sync`, `watch`, `status`,
`doctor`, and `unlink` lifecycle commands. Its nested Markdown/Yrs behavior is
usable now, while `sync` and `watch` explicitly report
`networkSynchronized: false`. Direct live XMTP remains on the Node CLI: upstream
`libxmtp` does not currently publish a stable Rust SDK, so the native binary
ships an explicit pinned driver boundary and reports `liveTransportReady:
false` instead of pretending local reconciliation reached the network.

## Tauri desktop

Run the shared React application in the desktop shell:

```bash
npm run desktop:dev
```

Build the current platform's installer/bundle:

```bash
npm run desktop:build
```

Link a vault with a one-shot run of the XMTP-capable Node CLI first. In the desktop app, open the
information dialog and choose **Watch linked vault**. Native Yrs updates from
ordinary file edits are applied as local Yjs updates and broadcast by the
desktop XMTP session; browser or remote updates are merged back into the vault.
The Tauri webview may be a different XMTP inbox that is already a member of the
same notebook group: its native bridge validates notebook, conversation, and
environment binding, while `expectedInboxId` continues to guard the CLI profile
that originally linked the directory.
Do not run the Node `--watch` process and the Tauri watcher against the same
local vault simultaneously. The hosted web build never requires or probes a
localhost daemon.

## Build output

```bash
npm run build
```

This creates:

- `dist/` for the static web app; and
- `dist-cli/` for the Node CLI.

The desktop packaging workflow uploads the XMTP-capable Node CLI as an
installable npm tarball, local-only Rust CLI archives for each target, and
unsigned development installers: AppImage/deb/rpm on Linux, MSI/NSIS on
Windows, and DMG on Apple Silicon and Intel macOS.

`cargo build --workspace` builds the native core/CLI, while
`npm run desktop:build` creates Tauri output under `src-tauri/target/` (or the
workspace target directory selected by Cargo).

## Security notes

- XMTP MLS encrypts collaboration transport and enforces group membership.
- The Node CLI identity is an encrypted ethers keystore with a stable encrypted XMTP
  SQLite database.
- The current browser identity implementation stores its raw EOA private key in
  `localStorage` without separate at-rest encryption or an export/recovery UI.
  Use a dedicated identity and a trusted browser profile. Yjs state in
  IndexedDB and Markdown files on disk are also not separately encrypted at
  rest.
- Protocol payloads are strictly validated and size-bounded before application.

## License

Apache-2.0; see [LICENSE](./LICENSE).
