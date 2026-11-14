// The headless summary's tool_calls counts every tool the run made, even when a
// provider error (or SIGINT) stopped it before the turn returned a result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { runHeadless } from '../src/headless.mjs';

test('a run stopped by a provider error still reports the tool calls it made', async (t) => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests += 1;
    if (requests > 1) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad request"}}'); return; }
    const message = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-headless-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_PROVIDER_MAX_RETRIES: '0', OASIS_NO_STREAM: '1' };
  const config = { configured: true, protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'k' };
  const { summary } = await runHeadless({ prompt: 'list the files', root, config, env, outputFormat: 'none', onEvent: () => {}, persistence: { enabled: false } });
  assert.equal(requests, 2);
  assert.equal(summary.is_error, true);
  assert.equal(summary.tool_calls, 1);
});
