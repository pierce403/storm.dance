import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { Wallet, type HDNodeWallet } from 'ethers';

const APPLICATION_DIRECTORY = 'stormdance';
const DEFAULT_PROFILE = 'default';
const KEYSTORE_FILENAME = 'identity.json';
const XMTP_DB_KEY_FILENAME = 'xmtp-db.key';
const MAX_IDENTITY_INPUT_BYTES = 1024 * 1024;

export const KEYSTORE_PASSWORD_ENV = 'STORMDANCE_KEYSTORE_PASSWORD';

export type StormdanceXmtpEnvironment = 'dev' | 'production';
export type IdentityWallet = Wallet | HDNodeWallet;

export interface ProfilePaths {
  profile: string;
  directory: string;
  keystore: string;
  xmtpDbEncryptionKey: string;
  xmtpDatabase: string;
}

export interface ProfilePathOptions {
  profile?: string;
  env?: StormdanceXmtpEnvironment;
  environment?: NodeJS.ProcessEnv;
}

export interface IdentityOptions extends ProfilePathOptions {
  password?: string;
}

export interface CreatedIdentity {
  address: string;
  keystore: string;
  profile: string;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

function validateProfileName(profile: string): string {
  if (
    profile === '.' ||
    profile === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)
  ) {
    throw new Error('Profile names may contain only letters, numbers, dots, underscores, and hyphens.');
  }
  return profile;
}

function resolveDataHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.XDG_DATA_HOME;
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error('XDG_DATA_HOME must be an absolute path.');
    }
    return configured;
  }
  return join(homedir(), '.local', 'share');
}

/** Resolve all persistent paths for one CLI identity profile. */
export function getProfilePaths(options: ProfilePathOptions = {}): ProfilePaths {
  const profile = validateProfileName(options.profile ?? DEFAULT_PROFILE);
  const env = options.env ?? 'production';
  const environment = options.environment ?? process.env;
  const directory = join(
    resolveDataHome(environment),
    APPLICATION_DIRECTORY,
    'profiles',
    profile,
  );

  return {
    profile,
    directory,
    keystore: join(directory, KEYSTORE_FILENAME),
    xmtpDbEncryptionKey: join(directory, XMTP_DB_KEY_FILENAME),
    xmtpDatabase: join(directory, `xmtp-${env}.db3`),
  };
}

async function ensureProfileDirectory(directory: string): Promise<void> {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('The stormdance profile path must be a real directory, not a symlink.');
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('A stormdance credential path is not a regular file.');
  }
  await chmod(path, 0o600);
}

async function writeNewPrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  await writeFile(path, data, {
    flag: 'wx',
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

function resolvePassword(password: string | undefined, environment: NodeJS.ProcessEnv): string {
  const resolved = password ?? environment[KEYSTORE_PASSWORD_ENV];
  if (!resolved) {
    throw new Error(
      `A non-empty keystore password is required. Prompt securely or set ${KEYSTORE_PASSWORD_ENV}.`,
    );
  }
  return resolved;
}

export function getKeystorePassword(
  password?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolvePassword(password, environment);
}

async function persistWallet(
  wallet: IdentityWallet,
  options: IdentityOptions,
): Promise<CreatedIdentity> {
  const paths = getProfilePaths(options);
  const password = resolvePassword(options.password, options.environment ?? process.env);
  await ensureProfileDirectory(paths.directory);

  let encryptedJson: string;
  try {
    encryptedJson = await wallet.encrypt(password);
  } catch {
    throw new Error('Failed to encrypt the stormdance identity.');
  }

  try {
    await writeNewPrivateFile(paths.keystore, encryptedJson);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`An identity already exists for profile "${paths.profile}".`);
    }
    throw new Error('Failed to store the encrypted stormdance identity.');
  }

  return {
    address: await wallet.getAddress(),
    keystore: paths.keystore,
    profile: paths.profile,
  };
}

/** Generate a dedicated EOA and persist only an encrypted ethers keystore. */
export async function createIdentity(options: IdentityOptions = {}): Promise<CreatedIdentity> {
  return persistWallet(Wallet.createRandom(), options);
}

async function readIdentityInput(input: Readable): Promise<string> {
  if ('isTTY' in input && input.isTTY) {
    throw new Error('Refusing to read identity material from an interactive terminal; pipe it on stdin.');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_IDENTITY_INPUT_BYTES) {
      throw new Error('Identity input is too large.');
    }
    chunks.push(bytes);
  }

  const value = Buffer.concat(chunks).toString('utf8').trim();
  if (!value) {
    throw new Error('No identity material was provided on stdin.');
  }
  return value;
}

async function walletFromStdinValue(value: string, password: string): Promise<IdentityWallet> {
  try {
    if (value.startsWith('{')) {
      return await Wallet.fromEncryptedJson(value, password);
    }
    return new Wallet(value);
  } catch {
    // Do not attach the ethers error: parsing failures can include user-supplied material.
    throw new Error('The identity supplied on stdin is not a valid private key or ethers keystore.');
  }
}

/**
 * Import a raw private key or an ethers keystore from stdin, then persist a
 * freshly encrypted keystore. No API intended for the CLI accepts a key flag.
 */
export async function importIdentityFromStdin(
  options: IdentityOptions & { input?: Readable } = {},
): Promise<CreatedIdentity> {
  const environment = options.environment ?? process.env;
  const password = resolvePassword(options.password, environment);
  const value = await readIdentityInput(options.input ?? process.stdin);
  const wallet = await walletFromStdinValue(value, password);
  return persistWallet(wallet, { ...options, password, environment });
}

/** Load and decrypt the profile's signer without exposing its private key. */
export async function loadIdentity(options: IdentityOptions = {}): Promise<IdentityWallet> {
  const paths = getProfilePaths(options);
  const password = resolvePassword(options.password, options.environment ?? process.env);

  let encryptedJson: string;
  try {
    await assertPrivateRegularFile(paths.keystore);
    encryptedJson = await readFile(paths.keystore, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`No identity exists for profile "${paths.profile}".`);
    }
    throw new Error('Failed to read the encrypted stormdance identity.');
  }

  try {
    return await Wallet.fromEncryptedJson(encryptedJson, password);
  } catch {
    throw new Error('Could not unlock the stormdance identity. Check the keystore password.');
  }
}

async function readDbEncryptionKey(path: string): Promise<Uint8Array> {
  await assertPrivateRegularFile(path);
  const value = await readFile(path);
  if (value.byteLength !== 32) {
    throw new Error('The XMTP database encryption key is invalid; expected exactly 32 bytes.');
  }
  return new Uint8Array(value);
}

/** Return the profile's stable 32-byte XMTP SQLite encryption key. */
export async function getOrCreateXmtpDbEncryptionKey(
  options: ProfilePathOptions = {},
): Promise<Uint8Array> {
  const paths = getProfilePaths(options);
  await ensureProfileDirectory(paths.directory);

  try {
    return await readDbEncryptionKey(paths.xmtpDbEncryptionKey);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const generated = randomBytes(32);
  try {
    await writeNewPrivateFile(paths.xmtpDbEncryptionKey, generated);
    return new Uint8Array(generated);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw new Error('Failed to store the XMTP database encryption key.');
    }
    // Another process initialized the profile between our read and write.
    return readDbEncryptionKey(paths.xmtpDbEncryptionKey);
  }
}

/** True when the profile has an encrypted identity; does not unlock it. */
export async function hasIdentity(options: ProfilePathOptions = {}): Promise<boolean> {
  const paths = getProfilePaths(options);
  try {
    await assertPrivateRegularFile(paths.keystore);
    await readFile(paths.keystore, { flag: fsConstants.O_RDONLY });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}
