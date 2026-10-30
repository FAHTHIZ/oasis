import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(ROOT, file), 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('published installer checksums match the exact checked-in scripts', async () => {
  const [readme, shell, powershell] = await Promise.all([
    read('README.md'), read('scripts/install.sh'), read('scripts/install.ps1')
  ]);
  assert.equal(readme.match(/expected=([a-f0-9]{64})/)?.[1], sha256(shell));
  assert.equal(readme.match(/\$expected='([a-f0-9]{64})'/)?.[1], sha256(powershell));
  assert.match(readme, /mktemp.*oasis-install/);
  assert.match(readme, /NewGuid\(\)\.ToString\('N'\)/);
});

test('installers pin the immutable source revision and Termux guide', async () => {
  const [readme, shell, powershell, termux, install] = await Promise.all([
    read('README.md'), read('scripts/install.sh'), read('scripts/install.ps1'), read('docs/TERMUX.md'), read('docs/INSTALL.md')
  ]);
  const revision = 'd3a2156924e7fe6bfd8f7bad5b49b8531f740a0a';
  assert.ok(shell.includes(revision + '.tar.gz'));
  assert.ok(powershell.includes(revision + '.tar.gz'));
  assert.ok(readme.includes(revision));
  assert.match(termux, /official.*Termux/i);
  assert.match(termux, /Android is not yet a fully verified support target/i);
  assert.match(install, /TERMUX\.md/);
});
