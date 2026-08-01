#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Client,
  ConsentState,
  Group,
  GroupPermissionsOptions,
  IdentifierKind,
  SortDirection,
} from '@xmtp/node-sdk';
import { Wallet, getBytes } from 'ethers';
import { createServer } from 'vite';
import { parseMirrorNote } from '../dist-cli/cli/markdown.js';
import { LINK_CONFIG_SCHEMA, NotebookDirectorySync } from '../dist-cli/cli/sync.js';
import { adaptXmtpGroup } from '../dist-cli/cli/xmtp.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(label, operation, attempts = 60, intervalMs = 1_000) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await wait(intervalMs);
  }
  throw new Error(`${label} did not complete`, { cause: lastError });
}

function signer(wallet) {
  return {
    type: 'EOA',
    getIdentifier: async () => ({
      identifier: await wallet.getAddress(),
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message) => getBytes(await wallet.signMessage(message)),
  };
}

async function openClient(root, label) {
  const wallet = Wallet.createRandom();
  const client = await Client.create(signer(wallet), {
    env: 'dev',
    appVersion: `stormdance-live-components/0.2/${label}`,
    dbPath: path.join(root, `${label}.db3`),
    dbEncryptionKey: randomBytes(32),
    useSingleConnection: true,
  });
  return { client, wallet, label };
}

async function findGroup(client, groupId) {
  await client.conversations.sync();
  const conversation = await client.conversations.getConversationById(groupId);
  if (!(conversation instanceof Group)) return undefined;
  if (conversation.consentState() !== ConsentState.Allowed) {
    conversation.updateConsentState(ConsentState.Allowed);
  }
  await conversation.sync();
  return conversation;
}

const toNodeIdentifier = (identifier) => ({
  identifier: identifier.identifier,
  identifierKind: identifier.identifierKind === 'Passkey'
    ? IdentifierKind.Passkey
    : IdentifierKind.Ethereum,
});

const toSharedMessage = (message) => ({
  id: message.id,
  content: message.content,
  senderInboxId: message.senderInboxId,
  conversationId: message.conversationId,
});

/**
 * NotebookCollaborationSession is transport-shaped to the browser SDK. This
 * adapter keeps that shipped session code unchanged while the Node-based live
 * test gives every component an independent native libxmtp database.
 */
function adaptNodeGroupForSharedSession(group) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    send: (content) => group.sendText(content),
    async messages(options = {}) {
      const messages = await group.messages({
        direction: options.direction === 1
          ? SortDirection.Descending
          : SortDirection.Ascending,
        limit: options.limit === undefined ? undefined : Number(options.limit),
      });
      return messages.map(toSharedMessage);
    },
    sync: () => group.sync(),
    async stream(options = {}) {
      const stream = await group.stream({
        onValue: (message) => options.onValue?.(toSharedMessage(message)),
        onError: options.onError,
        onFail: options.onFail,
        onRestart: options.onRestart,
      });
      return { end: () => stream.end() };
    },
    updateConsentState(state) {
      group.updateConsentState(state === 2 ? ConsentState.Denied : ConsentState.Allowed);
    },
    addMembersByIdentifiers(identifiers) {
      return group.addMembersByIdentifiers(identifiers.map(toNodeIdentifier));
    },
  };
}

function adaptNodeClientForSharedSession(client) {
  return {
    inboxId: client.inboxId,
    address: client.accountIdentifier?.identifier,
    canMessage: (identifiers) => client.canMessage(identifiers.map(toNodeIdentifier)),
    conversations: {
      async newGroupWithIdentifiers(identifiers, options = {}) {
        const group = await client.conversations.createGroupWithIdentifiers(
          identifiers.map(toNodeIdentifier),
          {
            groupName: options.name,
            groupDescription: options.description,
            permissions: GroupPermissionsOptions.AdminOnly,
          },
        );
        return adaptNodeGroupForSharedSession(group);
      },
      async getConversationById(id) {
        const conversation = await client.conversations.getConversationById(id);
        return conversation instanceof Group
          ? adaptNodeGroupForSharedSession(conversation)
          : undefined;
      },
    },
  };
}

/**
 * The collaboration session imports browser-sdk enums at runtime in the web
 * bundle. Vite loads the exact source module here and supplies only those three
 * numeric enums, avoiding a fake collaboration implementation while running
 * the browser/Tauri webview engine in Node CI.
 */
async function loadSharedCollaborationSession() {
  const browserSdkEnumShim = '\0stormdance-live-browser-sdk-enums';
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    // This is a one-shot module load, not a development server. Ignoring all
    // files also prevents the live test from consuming one watcher per Cargo
    // artifact when it runs after the native workspace jobs.
    server: { middlewareMode: true, watch: { ignored: ['**'] } },
    ssr: { noExternal: ['@xmtp/browser-sdk'] },
    plugins: [{
      name: 'stormdance-live-browser-sdk-enums',
      enforce: 'pre',
      resolveId(id) {
        return id === '@xmtp/browser-sdk' ? browserSdkEnumShim : undefined;
      },
      load(id) {
        if (id !== browserSdkEnumShim) return undefined;
        return [
          'export const ConsentState = { Unknown: 0, Allowed: 1, Denied: 2 };',
          'export const GroupPermissionsOptions = { Default: 0, AdminOnly: 1, CustomPolicy: 2 };',
          'export const SortDirection = { Ascending: 0, Descending: 1 };',
        ].join('\n');
      },
    }],
  });

  try {
    const module = await server.ssrLoadModule(
      '/src/lib/collaboration/notebookCollaboration.ts',
    );
    return module.NotebookCollaborationSession;
  } finally {
    await server.close();
  }
}

async function readMarkdownNote(root, noteId) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(root, entry.name);
    try {
      const source = await readFile(filePath, 'utf8');
      const note = parseMirrorNote(source);
      if (note.id === noteId) return { filePath, note, source };
    } catch {
      // A user-authored Markdown file without metadata is adopted on the next
      // CLI scan, so it is not an error while polling materialization.
    }
  }
  return undefined;
}

const projectionKey = (projection) => JSON.stringify(projection);

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stormdance-live-components-'));
  const vault = path.join(root, 'cli-vault');
  const clients = [];
  const sessions = [];
  const startedAt = Date.now();

  try {
    const NotebookCollaborationSession = await loadSharedCollaborationSession();
    assert.equal(
      typeof NotebookCollaborationSession,
      'function',
      'The shared web/Tauri collaboration session must load',
    );

    const web = await openClient(root, 'web');
    const cli = await openClient(root, 'cli');
    const tauri = await openClient(root, 'tauri-webview');
    clients.push(web.client, cli.client, tauri.client);

    const notebookId = `live-${randomUUID()}`;
    const noteId = randomUUID();
    const notebook = {
      id: notebookId,
      name: 'Live component matrix',
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const initialNote = {
      id: noteId,
      title: 'Interoperability',
      content: 'alpha\nomega',
      folderId: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      deleted: false,
    };

    const webSession = new NotebookCollaborationSession({
      notebook,
      notes: [initialNote],
      client: adaptNodeClientForSharedSession(web.client),
      onRemoteProjection: () => undefined,
      onStateChange: () => undefined,
    });
    sessions.push(webSession);

    const cliAddress = await cli.wallet.getAddress();
    const tauriAddress = await tauri.wallet.getAddress();
    await retry('ephemeral XMTP identities become messageable', async () => {
      const reachable = await web.client.canMessage([
        { identifier: cliAddress, identifierKind: IdentifierKind.Ethereum },
        { identifier: tauriAddress, identifierKind: IdentifierKind.Ethereum },
      ]);
      return Array.from(reachable.values()).filter(Boolean).length === 2;
    });
    const conversationId = await webSession.start([
      { address: cliAddress, label: 'CLI live test' },
      { address: tauriAddress, label: 'Tauri live test' },
    ]);
    assert.ok(conversationId, 'The web component must create an XMTP notebook group');

    const cliGroup = await retry(
      'CLI group welcome',
      () => findGroup(cli.client, conversationId),
    );
    const tauriGroup = await retry(
      'Tauri group welcome',
      () => findGroup(tauri.client, conversationId),
    );

    const cliSession = new NotebookDirectorySync({
      rootDirectory: vault,
      config: {
        schema: LINK_CONFIG_SCHEMA,
        notebookId,
        conversationId,
        notebookName: notebook.name,
        profile: 'ephemeral-live-matrix',
        env: 'dev',
        expectedInboxId: cli.client.inboxId,
      },
      group: adaptXmtpGroup(cliGroup),
      inboxId: cli.client.inboxId,
    });
    sessions.push(cliSession);

    const tauriSession = new NotebookCollaborationSession({
      notebook,
      notes: [],
      client: adaptNodeClientForSharedSession(tauri.client),
      conversationId,
      onRemoteProjection: () => undefined,
      onStateChange: () => undefined,
    });
    sessions.push(tauriSession);

    await Promise.all([
      cliSession.start({ watch: true }),
      tauriSession.start(),
    ]);

    await retry('web snapshot materialization in CLI and Tauri', async () => {
      const markdown = await readMarkdownNote(vault, noteId);
      return markdown?.note.content === initialNote.content
        && tauriSession.projection.notes.some(
          (note) => note.id === noteId && note.content === initialNote.content,
        );
    });

    // Exercise the actual filesystem-facing CLI path and the packaged Tauri
    // webview session concurrently from the same base CRDT state.
    const materialized = await readMarkdownNote(vault, noteId);
    assert.ok(materialized, 'The CLI must materialize the web-created note as Markdown');
    const tauriBase = tauriSession.projection.notes.find((note) => note.id === noteId);
    assert.ok(tauriBase, 'The Tauri session must receive the web-created note');

    await Promise.all([
      writeFile(
        materialized.filePath,
        materialized.source.replace('alpha\nomega', 'alpha from cli\nomega'),
        'utf8',
      ).then(() => cliSession.scanNow()),
      Promise.resolve().then(() => {
        tauriSession.upsertLocalNote({
          ...tauriBase,
          notebookId,
          content: 'alpha\nomega from tauri',
          updatedAt: startedAt + 2,
        });
      }),
    ]);

    await retry('concurrent CLI/Tauri edits converge in all components', () => {
      const projections = [
        webSession.projection,
        cliSession.projection,
        tauriSession.projection,
      ];
      const content = projections[0].notes.find((note) => note.id === noteId)?.content ?? '';
      return content.includes('from cli')
        && content.includes('from tauri')
        && projections.every(
          (projection) => projectionKey(projection) === projectionKey(projections[0]),
        );
    });

    // Send a subsequent edit in the other direction and require the CLI's
    // ordinary Markdown projection to rename/materialize it.
    const webNote = webSession.projection.notes.find((note) => note.id === noteId);
    assert.ok(webNote);
    webSession.upsertLocalNote({
      ...webNote,
      notebookId,
      title: 'Renamed by web',
      updatedAt: startedAt + 3,
    });

    const finalMarkdown = await retry('web edit reaches Tauri and CLI Markdown', async () => {
      const markdown = await readMarkdownNote(vault, noteId);
      const tauriNote = tauriSession.projection.notes.find((note) => note.id === noteId);
      return markdown?.note.title === 'Renamed by web'
        && tauriNote?.title === 'Renamed by web'
        ? markdown
        : undefined;
    });

    const projections = [
      webSession.projection,
      cliSession.projection,
      tauriSession.projection,
    ];
    assert.ok(
      projections.every(
        (projection) => projectionKey(projection) === projectionKey(projections[0]),
      ),
      'Web, CLI, and Tauri projections must converge exactly',
    );
    const content = projections[0].notes.find((note) => note.id === noteId)?.content ?? '';
    assert.match(content, /from cli/);
    assert.match(content, /from tauri/);

    console.log(JSON.stringify({
      ok: true,
      environment: 'dev',
      conversationId,
      notebookId,
      componentPaths: {
        web: 'src/lib/collaboration/NotebookCollaborationSession',
        cli: 'cli/NotebookDirectorySync + cli/adaptXmtpGroup',
        tauri: 'src/lib/collaboration/NotebookCollaborationSession (shared Tauri webview engine)',
      },
      transportDisclosure: 'The web and Tauri roles run their shared frontend session through a Node SDK adapter so CI can give each role an independent libxmtp SQLite database.',
      clients: [
        {
          role: 'web',
          inboxId: web.client.inboxId,
          installationId: web.client.installationId,
          address: await web.wallet.getAddress(),
        },
        {
          role: 'cli',
          inboxId: cli.client.inboxId,
          installationId: cli.client.installationId,
          address: cliAddress,
        },
        {
          role: 'tauri-webview',
          inboxId: tauri.client.inboxId,
          installationId: tauri.client.installationId,
          address: tauriAddress,
        },
      ],
      filesystem: {
        materializedFile: path.basename(finalMarkdown.filePath),
        title: finalMarkdown.note.title,
      },
      convergedContent: content,
      elapsedMs: Date.now() - startedAt,
    }, null, 2));
  } finally {
    await Promise.allSettled(sessions.reverse().map((session) => session.stop()));
    await Promise.allSettled(clients.map((client) => client.close()));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.env.STORMDANCE_LIVE_XMTP !== '1') {
  console.error('Refusing to run a live network test without STORMDANCE_LIVE_XMTP=1.');
  process.exitCode = 2;
} else {
  await run();
}
