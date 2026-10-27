import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(APP_ROOT, 'src', 'cli.mjs');

async function temporaryDirectory() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-plugins-test-'));
}

function runCli(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--workspace', root, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OASIS_API_KEY: '', OPENAI_API_KEY: '' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('plugin catalog lists reviewed built-in bundles without a model provider', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runCli(root, ['plugins', 'list']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /code-quality/);
  assert.match(result.stdout, /project-onboarding/);
  assert.match(result.stdout, /oasis plugins install NAME/);
});

test('plugin installation installs skill files and a manifest; removal preserves pre-existing skills', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const preexisting = path.join(root, '.oasis', 'skills', 'testing', 'SKILL.md');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(preexisting), { recursive: true });
  await writeFile(preexisting, 'user-owned skill\n');

  const install = await runCli(root, ['plugins', 'install', 'code-quality']);
  assert.equal(install.code, 0, install.stderr + install.stdout);
  const manifest = JSON.parse(await readFile(path.join(root, '.oasis', 'plugins', 'code-quality', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'code-quality');
  assert.equal(manifest.skills.find((skill) => skill.name === 'testing').owned, false);
  assert.match(await readFile(path.join(root, '.oasis', 'skills', 'code-review', 'SKILL.md'), 'utf8'), /Code review skill/);

  const remove = await runCli(root, ['plugins', 'remove', 'code-quality']);
  assert.equal(remove.code, 0, remove.stderr + remove.stdout);
  assert.equal(await readFile(preexisting, 'utf8'), 'user-owned skill\n');
  await assert.rejects(access(path.join(root, '.oasis', 'plugins', 'code-quality')));
  await assert.rejects(access(path.join(root, '.oasis', 'skills', 'code-review')));
});

test('unknown plugin names fail without modifying workspace files', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runCli(root, ['plugins', 'install', 'not-a-real-plugin']);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /No built-in plugin named/);
});
