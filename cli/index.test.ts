import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliDependencies } from './index.js';
import { LINK_CONFIG_SCHEMA, type LinkConfig } from './sync.js';
import type { XmtpGroupAdapter } from './xmtp.js';

const output = () => {
  let value = '';
  return {
    stream: {
      write(chunk: string) {
        value += chunk;
      },
    },
    text: () => value,
  };
};

const group = (overrides: Partial<XmtpGroupAdapter> = {}): XmtpGroupAdapter => ({
  id: 'conversation-1',
  name: 'storm.dance · Shared notes',
  description: 'storm.dance/yjs/1/notebook-1',
  allow: vi.fn(),
  sync: async () => undefined,
  messages: async () => [],
  sendText: async () => 'message-1',
  stream: async () => ({ isDone: false, end: async () => undefined }),
  ...overrides,
});

const client = () => ({
  inboxId: 'cli-inbox',
  close: vi.fn(async () => undefined),
});

const linkedConfig = (): LinkConfig => ({
  schema: LINK_CONFIG_SCHEMA,
  notebookId: 'notebook-1',
  conversationId: 'conversation-1',
  notebookName: 'Shared notes',
  profile: 'work',
  env: 'dev',
});

const projection = {
  schemaVersion: 1 as const,
  notebook: { id: 'notebook-1', name: 'Shared notes', createdAt: 1, updatedAt: 1 },
  notes: [],
};

describe('stormdance CLI parsing', () => {
  it('rejects private-key options without echoing the supplied value', async () => {
    const secret = '0xnot-a-real-secret';
    const importIdentity = vi.fn();

    let caught: unknown;
    try {
      await runCli(['auth', 'import', `--private-key=${secret}`], {
        importIdentityFromStdin: importIdentity,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Unknown option: --private-key');
    expect((caught as Error).message).not.toContain(secret);
    expect(importIdentity).not.toHaveBeenCalled();
  });

  it('does not echo an unknown command value', async () => {
    const supplied = '0xpossibly-sensitive-value';
    await expect(runCli([supplied])).rejects.toThrow('Unknown command.');
    await expect(runCli([supplied])).rejects.not.toThrow(supplied);
  });

  it('passes stdin, profile, and environment to identity import', async () => {
    const stdout = output();
    const stdin = new PassThrough();
    stdin.end('not inspected by this parser');
    const importIdentity = vi.fn(async (options) => {
      expect(options.input).toBe(stdin);
      expect(options.profile).toBe('team');
      expect(options.environment).toEqual({ STORMDANCE_KEYSTORE_PASSWORD: 'set' });
      return { address: '0x1234', keystore: '/private/identity.json', profile: 'team' };
    });

    await runCli(['auth', 'import', '--profile', 'team'], {
      stdin,
      stdout: stdout.stream,
      environment: { STORMDANCE_KEYSTORE_PASSWORD: 'set' },
      importIdentityFromStdin: importIdentity,
    });

    expect(stdout.text()).toBe('Imported profile team: 0x1234\n');
  });
});

describe('stormdance notebook commands', () => {
  it('lists only groups carrying the storm.dance notebook description', async () => {
    const stdout = output();
    const xmtp = client();
    const createClient = vi.fn(async () => xmtp);

    await runCli(['notebooks', 'list', '--profile=team', '--env', 'dev'], {
      stdout: stdout.stream,
      createClient,
      listGroups: async () => [
        group(),
        group({ id: 'other', name: 'unrelated', description: 'not-stormdance' }),
      ],
    });

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ profile: 'team', env: 'dev' }));
    expect(stdout.text()).toContain('NOTEBOOK_ID\tCONVERSATION_ID\tNAME');
    expect(stdout.text()).toContain('notebook-1\tconversation-1\tShared notes');
    expect(stdout.text()).not.toContain('unrelated');
    expect(xmtp.close).toHaveBeenCalledOnce();
  });

  it('links by notebook ID, persists its XMTP binding, and performs an initial sync', async () => {
    const stdout = output();
    const xmtp = client();
    const sharedGroup = group();
    const writeConfig = vi.fn(async () => '/workspace/notes');
    const sync = vi.fn(async () => ({ projection, rootDirectory: '/workspace/notes' }));

    await runCli(
      ['link', 'notebook-1', 'notes', '--profile', 'work', '--env=dev'],
      {
        cwd: () => '/workspace',
        stdout: stdout.stream,
        createClient: async () => xmtp,
        listGroups: async () => [sharedGroup],
        writeLinkConfig: writeConfig,
        runDirectorySync: sync,
      },
    );

    expect(sharedGroup.allow).toHaveBeenCalledOnce();
    expect(writeConfig).toHaveBeenCalledWith('/workspace/notes', linkedConfig());
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({
      rootDirectory: '/workspace/notes',
      config: linkedConfig(),
      inboxId: 'cli-inbox',
    }));
    expect(stdout.text()).toContain('Linked /workspace/notes to notebook-1 (conversation-1).');
    expect(xmtp.close).toHaveBeenCalledOnce();
  });

  it('does not echo a failed notebook selector and still closes the XMTP client', async () => {
    const selector = '0xpossibly-sensitive-selector';
    const xmtp = client();
    let caught: unknown;
    try {
      await runCli(['link', selector, 'notes'], {
        cwd: () => '/workspace',
        createClient: async () => xmtp,
        listGroups: async () => [],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('No storm.dance notebook group matches that selector.');
    expect((caught as Error).message).not.toContain(selector);
    expect(xmtp.close).toHaveBeenCalledOnce();
  });

  it('loads profile and environment from the directory binding for one-shot sync', async () => {
    const stdout = output();
    const xmtp = client();
    const createClient = vi.fn(async () => xmtp);
    const getLinkedGroup = vi.fn(async () => group());
    const sync = vi.fn(async () => ({ projection, rootDirectory: '/workspace/notes' }));

    await runCli(['sync', 'notes'], {
      cwd: () => '/workspace',
      stdout: stdout.stream,
      createClient,
      readLinkConfig: async () => linkedConfig(),
      getGroup: getLinkedGroup,
      runDirectorySync: sync,
    });

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ profile: 'work', env: 'dev' }));
    expect(getLinkedGroup).toHaveBeenCalledWith(xmtp, 'conversation-1');
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({
      rootDirectory: '/workspace/notes',
      watch: false,
    }));
    expect(stdout.text()).toBe('Synced /workspace/notes.\n');
    expect(xmtp.close).toHaveBeenCalledOnce();
  });

  it('installs and removes signal handlers around watch mode', async () => {
    const stdout = output();
    const xmtp = client();
    const sync = vi.fn(async (options) => {
      expect(options.watch).toBe(true);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return { projection, rootDirectory: '/workspace/notes' };
    });
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    await runCli(['sync', 'notes', '--watch'], {
      cwd: () => '/workspace',
      stdout: stdout.stream,
      createClient: async () => xmtp,
      readLinkConfig: async () => linkedConfig(),
      getGroup: async () => group(),
      runDirectorySync: sync,
    });

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    expect(stdout.text()).toContain('Watching /workspace/notes');
    expect(xmtp.close).toHaveBeenCalledOnce();
  });
});

// Compile-time guard: tests override only documented injectable dependencies.
const _dependencyShape: Partial<CliDependencies> = {};
void _dependencyShape;
