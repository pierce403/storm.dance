#!/usr/bin/env node

import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(repositoryRoot, 'packages', 'cli');
const stageDirectory = path.join(repositoryRoot, 'artifacts', 'stormdance-cli-package');
const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const cliPackage = JSON.parse(await readFile(path.join(sourceDirectory, 'package.json'), 'utf8'));

if (rootPackage.version !== cliPackage.version) {
  throw new Error(
    `CLI package version ${cliPackage.version} must match app version ${rootPackage.version}`,
  );
}

await rm(stageDirectory, { recursive: true, force: true });
await mkdir(stageDirectory, { recursive: true });
await Promise.all([
  cp(path.join(repositoryRoot, 'dist-cli'), path.join(stageDirectory, 'dist'), { recursive: true }),
  cp(path.join(sourceDirectory, 'package.json'), path.join(stageDirectory, 'package.json')),
  cp(path.join(sourceDirectory, 'README.md'), path.join(stageDirectory, 'README.md')),
  cp(path.join(repositoryRoot, 'LICENSE'), path.join(stageDirectory, 'LICENSE')),
  cp(path.join(repositoryRoot, 'SYNC_PROTOCOL.md'), path.join(stageDirectory, 'SYNC_PROTOCOL.md')),
]);
