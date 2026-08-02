#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Client,
  ConsentState,
  Group,
  GroupPermissionsOptions,
  IdentifierKind,
  PermissionLevel,
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

const toSharedGroupMember = (member) => ({
  inboxId: member.inboxId,
  accountIdentifiers: member.accountIdentifiers.map((identifier) => ({
    identifier: identifier.identifier,
    identifierKind: identifier.identifierKind === IdentifierKind.Passkey
      ? 'Passkey'
      : 'Ethereum',
  })),
  installationIds: [...member.installationIds],
  permissionLevel: member.permissionLevel,
  consentState: member.consentState,
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
    async members() {
      return (await group.members()).map(toSharedGroupMember);
    },
    listAdmins: async () => group.listAdmins(),
    listSuperAdmins: async () => group.listSuperAdmins(),
    removeMembers: (inboxIds) => group.removeMembers(inboxIds),
    addAdmin: (inboxId) => group.addAdmin(inboxId),
    removeAdmin: (inboxId) => group.removeAdmin(inboxId),
    addSuperAdmin: (inboxId) => group.addSuperAdmin(inboxId),
    removeSuperAdmin: (inboxId) => group.removeSuperAdmin(inboxId),
  };
}

function adaptNodeClientForSharedSession(client) {
  return {
    inboxId: client.inboxId,
    address: client.accountIdentifier?.identifier,
    canMessage: (identifiers) => client.canMessage(identifiers.map(toNodeIdentifier)),
    async findInboxIdByIdentifier(identifier) {
      return (await client.fetchInboxIdByIdentifier(toNodeIdentifier(identifier))) ?? undefined;
    },
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
 * bundle. Vite loads the exact source modules here and supplies only their
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
          'export const PermissionLevel = { Member: 0, Admin: 1, SuperAdmin: 2 };',
          'export const SortDirection = { Ascending: 0, Descending: 1 };',
        ].join('\n');
      },
    }],
  });

  try {
    const [sessionModule, collaboratorModule] = await Promise.all([
      server.ssrLoadModule('/src/lib/collaboration/notebookCollaboration.ts'),
      server.ssrLoadModule('/src/lib/collaboration/collaborators.ts'),
    ]);
    return {
      NotebookCollaborationSession: sessionModule.NotebookCollaborationSession,
      NotebookCollaboratorManager: collaboratorModule.NotebookCollaboratorManager,
    };
  } finally {
    await server.close();
  }
}

async function readMarkdownNote(root, noteId) {
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await visit(filePath);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
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
  };
  return visit(root);
}

const projectionKey = (projection) => JSON.stringify(projection);

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stormdance-live-components-'));
  const vault = path.join(root, 'cli-vault');
  const clients = [];
  const sessions = [];
  const startedAt = Date.now();

  try {
    const {
      NotebookCollaborationSession,
      NotebookCollaboratorManager,
    } = await loadSharedCollaborationSession();
    assert.equal(
      typeof NotebookCollaborationSession,
      'function',
      'The shared web/Tauri collaboration session must load',
    );
    assert.equal(
      typeof NotebookCollaboratorManager,
      'function',
      'The shipped notebook collaborator manager must load',
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

    // Reproduce the two browser regressions that motivated first-class folder
    // entities: creating a folder and dragging a note into it. The same update
    // must materialize as a real directory in the CLI vault and project into
    // the Tauri webview session.
    const sharedFolderId = randomUUID();
    webSession.upsertLocalFolder({
      id: sharedFolderId,
      notebookId,
      name: 'Shared research',
      parentFolderId: null,
      createdAt: startedAt + 1,
      updatedAt: startedAt + 1,
      deleted: false,
      deletedAt: null,
    });
    const noteBeforeFolderMove = webSession.projection.notes.find(
      (note) => note.id === noteId,
    );
    assert.ok(noteBeforeFolderMove, 'The web session must retain the seeded note');
    webSession.upsertLocalNote({
      ...noteBeforeFolderMove,
      notebookId,
      folderId: sharedFolderId,
      updatedAt: startedAt + 1,
    });

    await retry('browser folder creation and note drag reach CLI and Tauri', async () => {
      const markdown = await readMarkdownNote(vault, noteId);
      const relativePath = markdown
        ? path.relative(vault, markdown.filePath).split(path.sep).join('/')
        : '';
      const tauriFolder = tauriSession.projection.folders.find(
        (folder) => folder.id === sharedFolderId,
      );
      const tauriNote = tauriSession.projection.notes.find((note) => note.id === noteId);
      return relativePath.startsWith('Shared research/')
        && markdown?.note.folderId === sharedFolderId
        && tauriFolder?.name === 'Shared research'
        && tauriNote?.folderId === sharedFolderId;
    });

    // The reverse direction must also work for agent workflows: an ordinary
    // empty directory created in the vault becomes a shared folder entity.
    await mkdir(path.join(vault, 'Agent inbox'));
    await cliSession.scanNow();
    const agentFolder = await retry('CLI-created empty directory reaches web and Tauri', () => {
      const cliFolder = cliSession.projection.folders.find(
        (folder) => folder.name === 'Agent inbox' && folder.parentFolderId === null,
      );
      const webFolder = webSession.projection.folders.find(
        (folder) => folder.id === cliFolder?.id,
      );
      const tauriFolder = tauriSession.projection.folders.find(
        (folder) => folder.id === cliFolder?.id,
      );
      return cliFolder && webFolder?.name === cliFolder.name && tauriFolder?.name === cliFolder.name
        ? cliFolder
        : undefined;
    });

    // Add a fourth, independently persisted XMTP identity only after the
    // notebook group and all three primary component sessions are live. This
    // covers the settings-style contributor lifecycle instead of relying only
    // on the members supplied when the group is created.
    const contributor = await openClient(root, 'dynamic-contributor');
    clients.push(contributor.client);
    const contributorAddress = await contributor.wallet.getAddress();
    await retry('dynamic contributor becomes messageable', async () => {
      const reachable = await web.client.canMessage([{
        identifier: contributorAddress,
        identifierKind: IdentifierKind.Ethereum,
      }]);
      return Array.from(reachable.values()).some(Boolean);
    });

    const webGroup = await findGroup(web.client, conversationId);
    assert.ok(webGroup, 'The group creator must still have the notebook group');
    const collaboratorManager = new NotebookCollaboratorManager({
      client: adaptNodeClientForSharedSession(web.client),
      group: adaptNodeGroupForSharedSession(webGroup),
    });
    const addedContributor = await collaboratorManager.add(contributorAddress);
    assert.equal(
      addedContributor.collaborator.inboxId,
      contributor.client.inboxId,
      'The shipped collaborator manager must bind the address to its canonical XMTP inbox',
    );
    assert.equal(
      addedContributor.collaborator.role,
      'member',
      'The shipped collaborator manager must expose the new inbox as Member',
    );

    const contributorMember = await retry('dynamic contributor is added as a member', async () => {
      await webGroup.sync();
      const member = (await webGroup.members()).find(
        (candidate) => candidate.inboxId === contributor.client.inboxId,
      );
      return member?.permissionLevel === PermissionLevel.Member ? member : undefined;
    });
    assert.equal(contributorMember.permissionLevel, PermissionLevel.Member);

    const contributorGroup = await retry(
      'dynamic contributor group welcome',
      () => findGroup(contributor.client, conversationId),
    );
    const contributorSession = new NotebookCollaborationSession({
      notebook,
      notes: [],
      client: adaptNodeClientForSharedSession(contributor.client),
      conversationId,
      onRemoteProjection: () => undefined,
      onStateChange: () => undefined,
    });
    sessions.push(contributorSession);
    await contributorSession.start();

    await retry('dynamic contributor catches up through the shared session', () => (
      contributorSession.projection.notes.some(
        (note) => note.id === noteId
          && note.content === initialNote.content
          && note.folderId === sharedFolderId,
      )
      && contributorSession.projection.folders.some(
        (folder) => folder.id === sharedFolderId && folder.name === 'Shared research',
      )
      && contributorSession.projection.folders.some(
        (folder) => folder.id === agentFolder.id && folder.name === 'Agent inbox',
      )
    ));

    await collaboratorManager.setRole(contributor.client.inboxId, 'admin');
    await retry('dynamic contributor promotion reaches the XMTP group', async () => {
      await Promise.all([webGroup.sync(), contributorGroup.sync()]);
      const ownerView = (await webGroup.members()).find(
        (member) => member.inboxId === contributor.client.inboxId,
      );
      const contributorView = (await contributorGroup.members()).find(
        (member) => member.inboxId === contributor.client.inboxId,
      );
      return ownerView?.permissionLevel === PermissionLevel.Admin
        && contributorView?.permissionLevel === PermissionLevel.Admin;
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
        contributorSession.projection,
      ];
      const content = projections[0].notes.find((note) => note.id === noteId)?.content ?? '';
      return content.includes('from cli')
        && content.includes('from tauri')
        && projections.every(
          (projection) => projectionKey(projection) === projectionKey(projections[0]),
        );
    });

    const contributorNote = contributorSession.projection.notes.find(
      (note) => note.id === noteId,
    );
    assert.ok(contributorNote, 'The dynamic contributor must receive the shared note');
    contributorSession.upsertLocalNote({
      ...contributorNote,
      notebookId,
      content: `${contributorNote.content}\nfrom dynamic contributor`,
      updatedAt: startedAt + 3,
    });

    await retry('dynamic contributor edit converges in every component', () => {
      const projections = [
        webSession.projection,
        cliSession.projection,
        tauriSession.projection,
        contributorSession.projection,
      ];
      const expected = projectionKey(projections[0]);
      const convergedContent = projections[0].notes.find(
        (note) => note.id === noteId,
      )?.content ?? '';
      return convergedContent.includes('from dynamic contributor')
        && projections.every((projection) => projectionKey(projection) === expected);
    });

    // Send a subsequent edit in the other direction and require the CLI's
    // ordinary Markdown projection to rename/materialize it.
    const webNote = webSession.projection.notes.find((note) => note.id === noteId);
    assert.ok(webNote);
    webSession.upsertLocalNote({
      ...webNote,
      notebookId,
      title: 'Renamed by web',
      updatedAt: startedAt + 4,
    });

    const finalMarkdown = await retry('web edit reaches Tauri and CLI Markdown', async () => {
      const markdown = await readMarkdownNote(vault, noteId);
      const tauriNote = tauriSession.projection.notes.find((note) => note.id === noteId);
      const contributorNoteAfterRename = contributorSession.projection.notes.find(
        (note) => note.id === noteId,
      );
      return markdown?.note.title === 'Renamed by web'
        && tauriNote?.title === 'Renamed by web'
        && contributorNoteAfterRename?.title === 'Renamed by web'
        ? markdown
        : undefined;
    });

    const projections = [
      webSession.projection,
      cliSession.projection,
      tauriSession.projection,
      contributorSession.projection,
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
    assert.match(content, /from dynamic contributor/);

    await collaboratorManager.setRole(contributor.client.inboxId, 'member');
    await retry('dynamic contributor demotion reaches the XMTP group', async () => {
      await Promise.all([webGroup.sync(), contributorGroup.sync()]);
      const ownerView = (await webGroup.members()).find(
        (member) => member.inboxId === contributor.client.inboxId,
      );
      const contributorView = (await contributorGroup.members()).find(
        (member) => member.inboxId === contributor.client.inboxId,
      );
      return ownerView?.permissionLevel === PermissionLevel.Member
        && contributorView?.permissionLevel === PermissionLevel.Member;
    });

    const removedContributorState = await collaboratorManager.remove(
      contributor.client.inboxId,
    );
    assert.ok(
      !removedContributorState.collaborators.some(
        (member) => member.inboxId === contributor.client.inboxId,
      ),
      'The shipped collaborator manager must remove its local contributor row',
    );
    await retry('dynamic contributor is removed from the XMTP group', async () => {
      await webGroup.sync();
      return !(await webGroup.members()).some(
        (member) => member.inboxId === contributor.client.inboxId,
      );
    });

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
        {
          role: 'dynamic-contributor',
          inboxId: contributor.client.inboxId,
          installationId: contributor.client.installationId,
          address: contributorAddress,
          membershipLifecycle: ['member', 'admin', 'member', 'removed'],
        },
      ],
      filesystem: {
        materializedFile: path.relative(vault, finalMarkdown.filePath).split(path.sep).join('/'),
        title: finalMarkdown.note.title,
        synchronizedFolders: projections[0].folders.map((folder) => folder.name),
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
