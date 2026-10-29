import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptedModel } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'oasis-auth-'));
const clean = { OASIS_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', OASIS_BASE_URL: '', OASIS_PROTOCOL: '', OASIS_MODEL: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '', OASIS_API_KEY_HELPER: '' };

function run(args, env, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('oasis auth status / login --api-key / logout', async (t) => {
  const home = await tmp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const before = await run(['auth', 'status'], env);
  assert.equal(before.code, 1, before.out + before.err);
  assert.equal(JSON.parse(before.out).loggedIn, false);
  const login = await run(['auth', 'login', '--api-key-stdin', '--protocol', 'anthropic', '--model', 'claude-sonnet-5'], env, 'sk-test-123\n');
  assert.equal(login.code, 0, login.out + login.err);
  assert.match(login.out, /api key/);
  assert.ok(!login.out.includes('sk-test-123'));
  const after = await run(['auth', 'status'], env);
  const status = JSON.parse(after.out);
  assert.equal(after.code, 0);
  assert.equal(status.authMethod, 'api_key');
  assert.equal(status.apiKeySource, 'config');
  assert.equal(status.model, 'claude-sonnet-5');
  assert.equal(status.configDirectory, path.join(home, 'cfg'));
  assert.ok(!after.out.includes('sk-test-123'));
  const text = await run(['auth', 'status', '--text'], env);
  assert.match(text.out, /Signed in: api key/);
  const fromEnv = await run(['auth', 'status'], { ...env, OASIS_CONFIG_DIR: path.join(home, 'other'), ANTHROPIC_API_KEY: 'sk-env', OASIS_PROTOCOL: 'anthropic' });
  assert.equal(JSON.parse(fromEnv.out).apiKeySource, 'ANTHROPIC_API_KEY');
  const logout = await run(['auth', 'logout'], env);
  assert.match(logout.out, /Removed the stored API key/);
  assert.ok(!(await readFile(path.join(home, 'cfg', 'config.json'), 'utf8')).includes('sk-test'));
  assert.equal((await run(['auth', 'status'], env)).code, 1);
  const token = await run(['setup-token'], env);
  assert.match(token.out, /ANTHROPIC_API_KEY=<your key>/);
});

test('oasis agents --json lists background sessions', async (t) => {
  const home = await tmp();
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const { backgroundDirectory } = await import('../src/background-sessions.mjs');
  const dir = backgroundDirectory({ ...process.env, ...env });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'bg_done1.json'), JSON.stringify({ id: 'bg_done1', status: 'completed', root: home, prompt: 'old task', startedAt: new Date().toISOString(), pid: 1 }));
  const active = await run(['agents', '--json'], env);
  assert.deepEqual(JSON.parse(active.out), []);
  const all = await run(['agents', '--json', '--all'], env);
  const list = JSON.parse(all.out);
  assert.equal(list[0].id, 'bg_done1');
  assert.equal(list[0].cwd, home);
  const elsewhere = await run(['agents', '--json', '--all', '--cwd', os.tmpdir() + '/nope'], env);
  assert.deepEqual(JSON.parse(elsewhere.out), []);
});

test('oasis ultrareview runs the deep review headlessly and refuses --post without a PR', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'No findings.' }]);
  const env = { HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture' };
  const result = await run(['-C', root, 'ultrareview', 'src', '--json'], env);
  assert.equal(result.code, 0, result.out + result.err);
  const summary = JSON.parse(result.out);
  assert.equal(summary.result, 'No findings.');
  const user = requests[0].messages.filter((m) => m.role === 'user').pop().content;
  assert.match(String(user), /Do not post anything/);
  assert.match(String(user), /report_findings/);
  const bad = await run(['-C', root, 'ultrareview', 'src', '--post'], env);
  assert.match(bad.out + bad.err, /--post needs a GitHub pull request/);
});
