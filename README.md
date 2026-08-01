# storm.dance

storm.dance is a local-first Markdown notebook with real-time, encrypted XMTP
collaboration. Notes live in IndexedDB for the web app and can also be mirrored
to a normal directory of `.md` files with the Node CLI.

## Implemented (live-network validation pending)

- Browser notebooks, folders, tabs, Markdown editing, import, and encrypted
  backup export.
- One Yjs document and one XMTP MLS group per collaborative notebook, pinned to
  either the XMTP development or production environment.
- Concurrent title/content edits, note creation, note deletion tombstones,
  notebook rename, history replay, and state-vector catch-up.
- Invite discovery and acceptance through XMTP group consent.
- A bidirectional Markdown directory mirror suitable for local search,
  embeddings, vector indexing, static-site tooling, or another editor.

The protocol and transport behavior are covered by deterministic multi-replica
tests. A two-identity XMTP dev-network smoke test is still required before this
should be treated as production-ready collaboration.

The sync design and current limitations are documented in
[SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md). The feature/test inventory is in
[FEATURES.md](./FEATURES.md).

## Requirements

- Node.js 22 or newer
- npm
- A modern browser with IndexedDB, Web Workers, and WebAssembly

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

Every mirrored Markdown file begins with a storm.dance metadata comment and an
H1 title. Existing visible, flat `.md` files are adopted in place on first sync.
The mirror does not follow symlinks or delete files it cannot verify it still
owns.

Folder IDs round-trip with notes, but folder names and folder-tree operations
are not yet CRDT-synchronized. A browser that does not have a referenced folder
shows the note at the notebook root; the CLI intentionally remains flat.

## Build output

```bash
npm run build
```

This creates:

- `dist/` for the static web app; and
- `dist-cli/` for the Node CLI.

## Security notes

- XMTP MLS encrypts collaboration transport and enforces group membership.
- The CLI identity is an encrypted ethers keystore with a stable encrypted XMTP
  SQLite database.
- The current browser identity implementation stores its raw EOA private key in
  `localStorage` without separate at-rest encryption or an export/recovery UI.
  Use a dedicated identity and a trusted browser profile. Yjs state in
  IndexedDB and Markdown files on disk are also not separately encrypted at
  rest.
- Protocol payloads are strictly validated and size-bounded before application.

## License

Apache-2.0; see [LICENSE](./LICENSE).
