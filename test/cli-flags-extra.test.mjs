import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { colorEnabled } from '../src/markdown.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

test('ANTHROPIC_BETAS / config.betas send an anthropic-beta header', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-betas-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let seen = null;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    seen = req.headers['anthropic-beta'] || null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'f', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { protocol: 'anthropic', baseURL: 'http://127.0.0.1:' + server.address().port, model: 'f', apiKey: 'k', maxSteps: 2, maxCommandSeconds: 10, betas: ['context-1m'] };
  const env = { ...process.env, ANTHROPIC_BETAS: 'interleaved-thinking, context-1m' };
  const session = await createSession({ root, config, settings, env });
  session.providerEnv = env;
  await runAgentTurn(session, 'hello', { env });
  assert.equal(seen, 'context-1m,interleaved-thinking');
});

test('--system-prompt-snapshot on reuses the recorded system prompt until compaction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-snap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const restore = { id: 's1', messages: [{ role: 'system', content: 'RECORDED PROMPT' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
  const rebuilt = await createSession({ root, config, settings, restore });
  assert.notEqual(rebuilt.messages[0].content, 'RECORDED PROMPT');
  const kept = await createSession({ root, config, settings, restore, systemPromptSnapshot: 'on' });
  assert.equal(kept.messages[0].content, 'RECORDED PROMPT');
  assert.ok(kept.freshSystemText && kept.freshSystemText !== 'RECORDED PROMPT');
});

test('--ax-screen-reader turns color off; --tmux requires --worktree; bad snapshot value errors', async () => {
  assert.equal(colorEnabled({ isTTY: true }, { OASIS_AX_SCREEN_READER: '1' }), false);
  assert.equal(colorEnabled({ isTTY: true }, { CLAUDE_AX_SCREEN_READER: '1' }), false);
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: os.tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(out));
  });
  assert.match(await run(['--tmux']), /--tmux requires --worktree/);
  assert.match(await run(['--system-prompt-snapshot', 'maybe']), /must be on or off/);
});
