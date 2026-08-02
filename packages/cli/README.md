# stormdance CLI

This package connects one storm.dance XMTP notebook to an ordinary,
Obsidian-compatible directory of Markdown files. Humans and agents edit files
with normal filesystem tools; the CLI owns identity, group catch-up, projection,
and watch lifecycle rather than providing note-edit commands.

Requires Node.js 22 or newer.

```bash
npm install -g ./storm-dance-*.tgz
export STORMDANCE_KEYSTORE_PASSWORD='use-a-strong-passphrase'
stormdance auth init
stormdance auth address
stormdance notebooks list --env dev
stormdance link <notebook-or-conversation-id> ./my-notes --env dev
stormdance sync ./my-notes --watch
```

Identity imports are accepted only on standard input. The linked directory is
safe to index directly with full-text, embedding, or vector-search tools.
First-class folder entities project as ordinary empty or nested directories;
creating directories or moving Markdown files with normal filesystem tools
sends those changes back to browser and desktop collaborators. See
`SYNC_PROTOCOL.md` in this package for the wire and mirror contract.
