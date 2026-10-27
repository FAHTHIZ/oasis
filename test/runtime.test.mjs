import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { loadConfig, saveConfig, validateBaseUrl, getConfigPath } from '../src/config.mjs';
import { normalizePackageName, parseInstallIntent, resolveEcosystem } from '../src/installer.mjs';
import { executeTool, readWorkspaceFile, resolveWorkspacePath, runWorkspaceCommand, toolCount } from '../src/tools.mjs';
import { listBackups, restoreBackup } from '../src/backups.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

async function temporaryDirectory(prefix = 'oasis-test-') {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

test('configuration validates HTTPS provider URLs and permits loopback HTTP', () => {
  assert.equal(validateBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(validateBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.throws(() => validateBaseUrl('ftp://api.example.com/v1'), /HTTP and HTTPS/);
  assert.throws(() => validateBaseUrl('http://api.example.com/v1'), /must use HTTPS/);
  assert.throws(() => validateBaseUrl('https://user:pass@api.example.com/v1'), /must not include credentials/);
});

test('configuration is written outside the project and its API key is not included in summaries', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const configPath = path.join(tmp, 'cfg', 'config.json');
  await saveConfig({ baseURL: 'https://api.example.com/v1', model: 'example-model', apiKey: 'private-test-key' }, { configPath, env: {} });
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.apiKey, 'private-test-key');
  const loaded = await loadConfig({ configPath, env: {} });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.model, 'example-model');
  assert.equal(getConfigPath({ OASIS_CONFIG_DIR: tmp }, tmp), path.join(tmp, 'config.json'));
  if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test('plain-English installation requests are parsed without accepting command fragments', () => {
  assert.deepEqual(parseInstallIntent('install pnpm'), { packageName: 'pnpm', ecosystem: 'auto' });
  assert.deepEqual(parseInstallIntent('Please install ripgrep in yourself'), { packageName: 'ripgrep', ecosystem: 'auto' });
  assert.deepEqual(parseInstallIntent('install yourself'), { action: 'self' });
  assert.deepEqual(parseInstallIntent('install npm package @org/tool@1.2.0'), { packageName: '@org/tool@1.2.0', ecosystem: 'npm-global' });
  assert.equal(parseInstallIntent('install pnpm and configure the project'), null);
  assert.equal(parseInstallIntent('please explain how package installation works'), null);
});

test('package-name validation rejects shell metacharacters and local paths', () => {
  assert.equal(normalizePackageName('@org/tool@1.2.0'), '@org/tool@1.2.0');
  assert.throws(() => normalizePackageName('foo;rm -rf /'), /single package identifier/);
  assert.throws(() => normalizePackageName('../secret'), /single package identifier/);
  assert.throws(() => normalizePackageName('https://example.com/a.tgz'), /single package identifier/);
});

test('auto ecosystem selection differentiates common CLI tools and project libraries', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  assert.equal(resolveEcosystem('pnpm', 'auto', tmp), 'npm-global');
  assert.equal(resolveEcosystem('ripgrep', 'auto', tmp), 'system');
  await writeFile(path.join(tmp, 'package.json'), '{"name":"demo"}');
  assert.equal(resolveEcosystem('date-fns', 'auto', tmp), 'npm');
});

test('workspace path resolution blocks traversal, sensitive files, and escaping symlinks', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  const outside = path.join(tmp, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(root, 'README.md'), 'safe');
  await writeFile(path.join(root, '.env'), 'PRIVATE=secret');
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await assert.rejects(resolveWorkspacePath(root, '../outside/secret.txt'), /outside the workspace/);
  await assert.rejects(readWorkspaceFile(root, '.env'), /sensitive/);
  assert.equal((await readWorkspaceFile(root, 'README.md')).content, 'safe');
  try {
    await symlink(outside, path.join(root, 'escaped'), 'dir');
    await assert.rejects(resolveWorkspacePath(root, 'escaped/secret.txt'), /symbolic link/);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOTSUP') throw error;
    t.diagnostic('Symlink check skipped because this platform does not permit directory symlinks.');
  }
});

test('workspace file edits create recoverable snapshots; explicit restore works', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  const config = path.join(tmp, 'oasis-config');
  await mkdir(root);
  await writeFile(path.join(root, 'note.txt'), 'before');
  const previous = process.env.OASIS_CONFIG_DIR;
  process.env.OASIS_CONFIG_DIR = config;
  t.after(() => { if (previous === undefined) delete process.env.OASIS_CONFIG_DIR; else process.env.OASIS_CONFIG_DIR = previous; });
  const result = await executeTool('write_file', { path: 'note.txt', content: 'after' }, { root });
  assert.equal(result.backedUpExistingFile, true);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'after');
  const backups = await listBackups(root);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].relativePath, 'note.txt');
  const restored = await restoreBackup(root, backups[0].id);
  assert.equal(restored.path, 'note.txt');
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'before');
  const afterRestoreBackups = await listBackups(root);
  assert.equal(afterRestoreBackups.length, 2);
});

test('delete_file requires explicit approval and leaves the file intact when denied', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'keep.txt'), 'keep');
  const result = await executeTool('delete_file', { path: 'keep.txt' }, { root, approval: async () => false });
  assert.equal(result.approved, false);
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep');
});

test('command tool blocks destructive executable names and strips API keys from children', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await assert.rejects(runWorkspaceCommand(tmp, 'rm', ['-rf', '.'], { autoApprove: true }), /blocked by Oasis safety policy/);
  const result = await runWorkspaceCommand(tmp, process.execPath, ['-e', 'process.stdout.write(process.env.OASIS_API_KEY || "not-present")'], {
    autoApprove: true,
    env: { ...process.env, OASIS_API_KEY: 'do-not-leak-this' }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'not-present');
});

test('public URL fetch blocks loopback and private network addresses', async () => {
  await assert.rejects(executeTool('fetch_url', { url: 'http://127.0.0.1/' }, { root: process.cwd() }), /Private-network/);
  await assert.rejects(executeTool('fetch_url', { url: 'http://localhost/' }, { root: process.cwd() }), /Local and metadata/);
});

test('agent tool registry exposes a useful coding workflow tool set', () => {
  assert.ok(toolCount() >= 7);
});


test('agent completes an OpenAI-compatible tool cycle against a local fixture server', async (t) => {
  const tmp = await temporaryDirectory();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'README.md'), '# Fixture project');
  let requests = 0;
  let secondRequest = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests++;
    const payload = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (requests === 1) {
      res.end(JSON.stringify({ choices: [{ message: {
        role: 'assistant',
        content: 'I will inspect the workspace first.',
        tool_calls: [{ id: 'fixture-call-1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }]
      } }] }));
    } else {
      secondRequest = payload;
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I found README.md and completed the inspection.' } }] }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const config = { baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture-model', apiKey: '', maxSteps: 4, maxCommandSeconds: 10 };
  const session = await createSession({ root, config });
  const transcript = [];
  const result = await runAgentTurn(session, 'List the files in this workspace.', { onText: (text) => transcript.push(text) });
  assert.equal(result.finished, true);
  assert.equal(result.toolCalls, 1);
  assert.equal(requests, 2);
  assert.ok(secondRequest.messages.some((message) => message.role === 'tool' && message.content.includes('README.md')));
  assert.ok(transcript.some((text) => text.includes('completed the inspection')));
});
