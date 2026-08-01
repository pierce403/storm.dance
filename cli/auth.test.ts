import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIdentity,
  getOrCreateXmtpDbEncryptionKey,
  getProfilePaths,
  loadIdentity,
} from './auth.js';

const temporaryDirectories: string[] = [];

const makeDataHome = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stormdance-auth-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('CLI identity storage', () => {
  it('stores an encrypted identity and stable XMTP DB key with private permissions', async () => {
    const dataHome = await makeDataHome();
    const environment = {
      XDG_DATA_HOME: dataHome,
      STORMDANCE_KEYSTORE_PASSWORD: 'correct horse battery staple',
    };
    const created = await createIdentity({ profile: 'work', environment });
    const paths = getProfilePaths({ profile: 'work', env: 'dev', environment });
    const firstKey = await getOrCreateXmtpDbEncryptionKey({
      profile: 'work',
      env: 'dev',
      environment,
    });
    const secondKey = await getOrCreateXmtpDbEncryptionKey({
      profile: 'work',
      env: 'dev',
      environment,
    });

    expect(await (await loadIdentity({ profile: 'work', environment })).getAddress())
      .toBe(created.address);
    expect(firstKey).toHaveLength(32);
    expect(secondKey).toEqual(firstKey);
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.keystore)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.xmtpDbEncryptionKey)).mode & 0o777).toBe(0o600);
  }, 20_000);

  it('refuses a symlink in place of a profile keystore', async () => {
    const dataHome = await makeDataHome();
    const environment = {
      XDG_DATA_HOME: dataHome,
      STORMDANCE_KEYSTORE_PASSWORD: 'not-used',
    };
    const paths = getProfilePaths({ profile: 'work', environment });
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const target = path.join(dataHome, 'untrusted.json');
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, paths.keystore);

    await expect(loadIdentity({ profile: 'work', environment }))
      .rejects.toThrow('Failed to read the encrypted stormdance identity');
  });
});
