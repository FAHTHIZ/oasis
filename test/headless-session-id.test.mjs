// The stream-json init event names the session up front (as claude -p does), and a
// run that ends before anything is saved does not report an id --resume cannot find.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { runHeadless } from '../src/headless.mjs';

async function provider(t, reply) {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (reply === 'fail') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad request"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { configured: true, protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'k' };
}

async function run(t, reply) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-headless-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_PROVIDER_MAX_RETRIES: '0', OASIS_NO_STREAM: '1' };
  const events = [];
  const config = await provider(t, reply);
  const { summary } = await runHeadless({ prompt: 'hi', root, config, env, outputFormat: 'none', onEvent: (event) => events.push(event), persistence: { enabled: true } });
  return { events, summary, root, env };
}

test('stream-json init carries the session id that the result and the saved file use', async (t) => {
  const { events, summary } = await run(t, 'Hello.');
  const init = events.find((event) => event.subtype === 'init');
  assert.match(String(init.session_id), /^[0-9a-f-]{36}$/);
  assert.equal(summary.session_id, init.session_id);
});

test('a run that saved nothing reports no session id', async (t) => {
  const { summary, env } = await run(t, 'fail');
  assert.equal(summary.is_error, true);
  assert.equal(summary.session_id, null);
  const dir = path.join(env.OASIS_CONFIG_DIR, 'sessions');
  const files = await readdir(dir, { recursive: true }).catch(() => []);
  assert.equal(files.filter((name) => String(name).endsWith('.json')).length, 0);
});
