#!/usr/bin/env node

import path from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  createIdentity,
  importIdentityFromStdin,
  loadIdentity,
  type StormdanceXmtpEnvironment,
} from './auth.js';
import {
  LINK_CONFIG_SCHEMA,
  discoverStormdanceNotebooks,
  readLinkConfig,
  resolveNotebookGroup,
  runDirectorySync,
  writeLinkConfig,
  type LinkConfig,
} from './sync.js';
import {
  createNodeXmtpClient,
  getGroup,
  listGroups,
  type XmtpGroupAdapter,
} from './xmtp.js';

const DEFAULT_PROFILE = 'default';
// Match the web app's default so a freshly invited notebook is discoverable
// without a surprising empty production-network listing.
const DEFAULT_ENV: StormdanceXmtpEnvironment = 'dev';

const USAGE = `stormdance — sync a storm.dance notebook with Markdown

Usage:
  stormdance auth init [--profile NAME]
  stormdance auth import [--profile NAME] < PRIVATE_KEY_OR_KEYSTORE
  stormdance auth address [--profile NAME]
  stormdance notebooks list [--profile NAME] [--env dev|production]
  stormdance link <notebook-or-conversation-id> <directory> [--profile NAME] [--env dev|production]
  stormdance sync [directory] [--watch]

Authentication:
  Set STORMDANCE_KEYSTORE_PASSWORD to a strong passphrase. Identity imports
  are accepted only on stdin; private keys are never accepted as arguments.
`;

interface CliXmtpClient {
  readonly inboxId: string;
  close(): Promise<void>;
}

interface WritableOutput {
  write(chunk: string): unknown;
}

export interface CliDependencies {
  cwd: () => string;
  environment: NodeJS.ProcessEnv;
  stdin: Readable;
  stdout: WritableOutput;
  stderr: WritableOutput;
  createIdentity: typeof createIdentity;
  importIdentityFromStdin: typeof importIdentityFromStdin;
  loadIdentity: typeof loadIdentity;
  createClient: (options: {
    profile: string;
    env: StormdanceXmtpEnvironment;
    environment: NodeJS.ProcessEnv;
  }) => Promise<CliXmtpClient>;
  listGroups: (client: CliXmtpClient) => Promise<XmtpGroupAdapter[]>;
  getGroup: (
    client: CliXmtpClient,
    conversationId: string,
  ) => Promise<XmtpGroupAdapter | undefined>;
  readLinkConfig: typeof readLinkConfig;
  writeLinkConfig: typeof writeLinkConfig;
  runDirectorySync: typeof runDirectorySync;
}

const defaultDependencies: CliDependencies = {
  cwd: () => process.cwd(),
  environment: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  createIdentity,
  importIdentityFromStdin,
  loadIdentity,
  createClient: createNodeXmtpClient,
  listGroups: (client) => listGroups(client as Awaited<ReturnType<typeof createNodeXmtpClient>>),
  getGroup: (client, conversationId) =>
    getGroup(client as Awaited<ReturnType<typeof createNodeXmtpClient>>, conversationId),
  readLinkConfig,
  writeLinkConfig,
  runDirectorySync,
};

interface ParsedOptions {
  positionals: string[];
  profile?: string;
  env?: StormdanceXmtpEnvironment;
  watch: boolean;
  help: boolean;
}

interface AllowedOptions {
  profile?: boolean;
  env?: boolean;
  watch?: boolean;
}

function parseOptions(args: readonly string[], allowed: AllowedOptions): ParsedOptions {
  const parsed: ParsedOptions = { positionals: [], watch: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      parsed.positionals.push(argument);
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    if (option === '--help') {
      if (inlineValue !== undefined) throw new Error('--help does not take a value.');
      parsed.help = true;
      continue;
    }
    if (option === '--watch') {
      if (!allowed.watch) throw new Error('Unknown option: --watch');
      if (inlineValue !== undefined) throw new Error('--watch does not take a value.');
      parsed.watch = true;
      continue;
    }
    if (option !== '--profile' && option !== '--env') {
      // Report only the option name. A mistaken --private-key=<secret> must
      // never echo its value into terminal history or logs.
      throw new Error(`Unknown option: ${option}`);
    }
    if (option === '--profile' && !allowed.profile) throw new Error('Unknown option: --profile');
    if (option === '--env' && !allowed.env) throw new Error('Unknown option: --env');

    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
    if (option === '--profile') {
      parsed.profile = value;
    } else if (value === 'dev' || value === 'production') {
      parsed.env = value;
    } else {
      throw new Error('--env must be either dev or production.');
    }
  }

  return parsed;
}

function expectPositionals(parsed: ParsedOptions, count: number, usage: string): void {
  if (parsed.positionals.length !== count) {
    throw new Error(`Expected ${usage}.`);
  }
}

async function withClient<T>(
  dependencies: CliDependencies,
  profile: string,
  env: StormdanceXmtpEnvironment,
  operation: (client: CliXmtpClient) => Promise<T>,
): Promise<T> {
  const client = await dependencies.createClient({
    profile,
    env,
    environment: dependencies.environment,
  });
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

function notebookDisplayName(groupName: string, notebookId: string): string {
  const prefix = 'storm.dance · ';
  const value = groupName.startsWith(prefix) ? groupName.slice(prefix.length) : groupName;
  return terminalField(value.trim() || notebookId);
}

const terminalField = (value: string): string =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('');

const warningHandler = (dependencies: CliDependencies) => (message: string): void => {
  dependencies.stderr.write(`Warning: ${terminalField(message)}\n`);
};

async function runAuth(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const action = args[0];
  if (!action || action === '--help') {
    dependencies.stdout.write(USAGE);
    return 0;
  }
  const parsed = parseOptions(args.slice(1), { profile: true });
  if (parsed.help) {
    dependencies.stdout.write(USAGE);
    return 0;
  }
  expectPositionals(parsed, 0, 'no positional arguments for auth commands');
  const profile = parsed.profile ?? DEFAULT_PROFILE;

  if (action === 'init') {
    const identity = await dependencies.createIdentity({
      profile,
      environment: dependencies.environment,
    });
    dependencies.stdout.write(`Created profile ${identity.profile}: ${identity.address}\n`);
    return 0;
  }
  if (action === 'import') {
    const identity = await dependencies.importIdentityFromStdin({
      profile,
      environment: dependencies.environment,
      input: dependencies.stdin,
    });
    dependencies.stdout.write(`Imported profile ${identity.profile}: ${identity.address}\n`);
    return 0;
  }
  if (action === 'address') {
    const wallet = await dependencies.loadIdentity({
      profile,
      environment: dependencies.environment,
    });
    dependencies.stdout.write(`${await wallet.getAddress()}\n`);
    return 0;
  }

  throw new Error('Unknown auth command. Run "stormdance auth --help" for usage.');
}

async function runNotebooks(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const action = args[0];
  if (action === '--help') {
    dependencies.stdout.write(USAGE);
    return 0;
  }
  if (action !== 'list') throw new Error('Expected "notebooks list".');
  const parsed = parseOptions(args.slice(1), { profile: true, env: true });
  if (parsed.help) {
    dependencies.stdout.write(USAGE);
    return 0;
  }
  expectPositionals(parsed, 0, 'no positional arguments for "notebooks list"');
  const profile = parsed.profile ?? DEFAULT_PROFILE;
  const env = parsed.env ?? DEFAULT_ENV;

  return withClient(dependencies, profile, env, async (client) => {
    const notebooks = discoverStormdanceNotebooks(await dependencies.listGroups(client));
    if (notebooks.length === 0) {
      dependencies.stdout.write('No storm.dance notebook groups found.\n');
      return 0;
    }
    dependencies.stdout.write('NOTEBOOK_ID\tCONVERSATION_ID\tNAME\n');
    for (const { notebookId, group } of notebooks) {
      dependencies.stdout.write(
        `${terminalField(notebookId)}\t${terminalField(group.id)}\t${notebookDisplayName(group.name, notebookId)}\n`,
      );
    }
    return 0;
  });
}

async function runLink(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseOptions(args, { profile: true, env: true });
  if (parsed.help) {
    dependencies.stdout.write(USAGE);
    return 0;
  }
  expectPositionals(parsed, 2, 'a notebook or conversation ID and a directory');
  const [selector, directoryArgument] = parsed.positionals;
  const directory = path.resolve(dependencies.cwd(), directoryArgument);
  const profile = parsed.profile ?? DEFAULT_PROFILE;
  const env = parsed.env ?? DEFAULT_ENV;

  return withClient(dependencies, profile, env, async (client) => {
    const resolved = resolveNotebookGroup(await dependencies.listGroups(client), selector);
    resolved.group.allow();
    const config: LinkConfig = {
      schema: LINK_CONFIG_SCHEMA,
      notebookId: resolved.notebookId,
      conversationId: resolved.group.id,
      notebookName: notebookDisplayName(resolved.group.name, resolved.notebookId),
      profile,
      env,
    };
    const root = await dependencies.writeLinkConfig(directory, config);
    await dependencies.runDirectorySync({
      rootDirectory: root,
      config,
      group: resolved.group,
      inboxId: client.inboxId,
      onWarning: warningHandler(dependencies),
    });
    dependencies.stdout.write(
      `Linked ${terminalField(root)} to ${terminalField(config.notebookId)} (${terminalField(config.conversationId)}).\n`,
    );
    return 0;
  });
}

async function runSync(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseOptions(args, { watch: true });
  if (parsed.help) {
    dependencies.stdout.write(USAGE);
    return 0;
  }
  if (parsed.positionals.length > 1) throw new Error('Expected at most one directory.');
  const directory = path.resolve(dependencies.cwd(), parsed.positionals[0] ?? '.');
  const config = await dependencies.readLinkConfig(directory);

  return withClient(dependencies, config.profile, config.env, async (client) => {
    const group = await dependencies.getGroup(client, config.conversationId);
    if (!group) {
      throw new Error('The linked XMTP group was not found for this profile.');
    }

    const abortController = new AbortController();
    const stop = () => abortController.abort();
    if (parsed.watch) {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      dependencies.stdout.write(
        `Watching ${terminalField(directory)} for Markdown changes. Press Ctrl-C to stop.\n`,
      );
    }
    try {
      await dependencies.runDirectorySync({
        rootDirectory: directory,
        config,
        group,
        inboxId: client.inboxId,
        watch: parsed.watch,
        signal: abortController.signal,
        onWarning: warningHandler(dependencies),
      });
    } finally {
      if (parsed.watch) {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    }
    if (!parsed.watch) dependencies.stdout.write(`Synced ${terminalField(directory)}.\n`);
    return 0;
  });
}

/** Execute one CLI command. Errors are deliberately left to the entrypoint. */
export async function runCli(
  args: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies: CliDependencies = { ...defaultDependencies, ...overrides };
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    dependencies.stdout.write(USAGE);
    return 0;
  }
  if (command === 'auth') return runAuth(args.slice(1), dependencies);
  if (command === 'notebooks') return runNotebooks(args.slice(1), dependencies);
  if (command === 'link') return runLink(args.slice(1), dependencies);
  if (command === 'sync') return runSync(args.slice(1), dependencies);
  throw new Error('Unknown command. Run "stormdance --help" for usage.');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await runCli(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected stormdance CLI failure.';
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  void main();
}
