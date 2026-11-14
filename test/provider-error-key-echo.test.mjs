import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { formatApiError } from '../src/api-error.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

// Found in a leak check: a server that echoes the Authorization header in its
// 401 body made OASIS print the full key. OpenAI masks keys itself, which hid it.
const KEY = 'custom-gw-key-7d1f0a9c3b2e4d5f6a7b8c9d';

test('formatApiError redacts the configured key and bearer tokens echoed by the provider', () => {
  const body = JSON.stringify({ error: { message: 'Bad key: Bearer ' + KEY + ' and raw ' + KEY } });
  const message = formatApiError(401, body, 'openai-compatible', 'https://gw.example.com/v1', { secrets: [KEY] });
  assert.ok(!message.includes(KEY), message);
  assert.match(message, /\[redacted\]/);
  const sk = 'sk-proj-SECRETabcdefghijklmnopqrstuvwxyz012345';
  assert.ok(!formatApiError(401, JSON.stringify({ error: { message: 'Incorrect API key provided: ' + sk } }), 'openai-compatible').includes('SECRET'));
});

async function provider(t, handler) {
  const server = createServer(async (req, res) => { for await (const _ of req) { /* drain */ } handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port + '/v1';
}

async function runWith(t, baseURL, stream) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-key-echo-'));
  const config = { protocol: 'openai-compatible', baseURL, model: 'm', apiKey: KEY, maxSteps: 2, stream };
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  return runAgentTurn(session, 'hi', {}).then((value) => JSON.stringify(value), (error) => String(error && error.message));
}

test('an HTTP error body that echoes the key does not reach the user', async (t) => {
  const baseURL = await provider(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rejected ' + req.headers.authorization } }));
  });
  const out = await runWith(t, baseURL, false);
  assert.ok(!out.includes(KEY), out);
});

test('a mid-stream error event that echoes the key does not reach the user', async (t) => {
  const baseURL = await provider(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ error: { message: 'upstream refused ' + KEY, code: 'invalid_api_key' } }) + '\n\n');
  });
  const out = await runWith(t, baseURL, true);
  assert.ok(!out.includes(KEY), out);
});
