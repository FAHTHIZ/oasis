import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('README describes the actual interfaces and keeps their execution boundaries distinct', async () => {
  const readme = await read('README.md');
  for (const phrase of [
    'CLI and headless runner',
    'Connected browser workspace',
    'Universal browser app',
    'Desktop application',
    'Editor integration',
    'Agent Client Protocol',
    'Node.js SDK',
    'GitHub Action and messaging gateways',
    'does not guarantee that every model will solve every task'
  ]) assert.ok(readme.includes(phrase), phrase);
  assert.ok(readme.includes('does not provide a host shell'));
  assert.ok(readme.includes('Approval prompts are not a replacement for operating-system isolation'));
  assert.ok(readme.includes('Apache License 2.0'));
});

test('README relative links resolve to tracked repository files', async () => {
  const readme = await read('README.md');
  const links = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const target of links.filter((value) => !/^[a-z]+:/i.test(value) && !value.startsWith('#'))) {
    const resolved = path.resolve(root, target.split('#')[0]);
    await stat(resolved);
  }
});

test('package manifests do not include deleted documentation or demonstration folders', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.ok(pkg.files.includes('README.md'));
  assert.ok(pkg.files.includes('LICENSE'));
  assert.ok(!pkg.files.includes('docs/'));
  assert.ok(!pkg.files.includes('SECURITY.md'));
  assert.ok(!pkg.files.includes('CONTRIBUTING.md'));
  assert.ok(!pkg.build.files.includes('docs/**/*'));
  assert.ok(!pkg.build.files.some((entry) => entry.includes('demo')));
});
