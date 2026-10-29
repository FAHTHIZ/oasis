import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { fastModeRequest } from '../src/model-aliases.mjs';

test('fastModeRequest knows which Opus models support fast mode', () => {
  assert.deepEqual(fastModeRequest('claude-opus-5-5'), { speed: 'fast' });
  assert.deepEqual(fastModeRequest('claude-opus-5'), { speed: 'fast', beta: 'fast-mode-2026-02-01' });
  assert.deepEqual(fastModeRequest('claude-opus-4-8'), { speed: 'fast', beta: 'fast-mode-2026-02-01' });
  assert.equal(fastModeRequest('claude-sonnet-5-5'), null);
  assert.equal(fastModeRequest('claude-opus-4-1'), null);
});

test('/fast toggles speed:"fast" and the beta header on Anthropic requests and persists it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-fast-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ headers: req.headers, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const config = { protocol: 'anthropic', baseURL: 'http://127.0.0.1:' + server.address().port, model: 'claude-opus-5', apiKey: 'k', maxSteps: 2, configured: true };
  const session = await createSession({ root, config, env, settings: { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } } });
  t.after(() => closeSession(session));
  const on = await runBuiltinCommand('fast', '', { root, session, env });
  assert.match(on.output, /Fast mode on for claude-opus-5/);
  await runAgentTurn(session, 'hi', { env });
  assert.equal(seen[0].body.speed, 'fast');
  assert.match(String(seen[0].headers['anthropic-beta']), /fast-mode-2026-02-01/);
  const saved = JSON.parse(await readFile(path.join(root, 'cfg', 'settings.json'), 'utf8'));
  assert.equal(saved.fastMode, true);
  assert.match((await runBuiltinCommand('fast', 'off', { root, session, env })).output, /off/);
  await runAgentTurn(session, 'again', { env });
  assert.equal(seen[1].body.speed, undefined);
});

test('/install-github-app writes a workflow from the repo and provider', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { githubRepoFromRemote } = await import('../src/github-install.mjs');
  assert.equal(githubRepoFromRemote('git@github.com:me/app.git'), 'me/app');
  assert.equal(githubRepoFromRemote('https://github.com/me/app'), 'me/app');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-gha-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/me/app.git'], { cwd: root });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  const session = { config: { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: 'x/y' }, messages: [] };
  const declined = await runBuiltinCommand('install-github-app', '', { root, session, confirm: async () => false });
  assert.match(declined.output, /Nothing written/);
  const done = await runBuiltinCommand('install-github-app', '@bot save', { root, session });
  assert.match(done.output, /gh secret set OASIS_API_KEY --repo me\/app/);
  const yml = await readFile(path.join(root, '.github', 'workflows', 'oasis.yml'), 'utf8');
  assert.match(yml, /protocol: openai-compatible/);
  assert.match(yml, /base_url: https:\/\/openrouter.ai\/api\/v1/);
  assert.match(yml, /trigger_phrase: "@bot"/);
  assert.match(yml, /allowed_tools: "Bash\(npm test:\*\),Bash\(npm run lint:\*\)"/);
  assert.match((await runBuiltinCommand('install-github-app', 'save', { root, session })).output, /exists/);
});
