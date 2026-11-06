import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

test('cancelling during the step-limit summary request stops it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-limit-cancel-'));
  await writeFile(path.join(root, 'a.txt'), 'A\n');
  let requests = 0;
  const hanging = new Set();
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    if (requests === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] }));
      return;
    }
    hanging.add(res); // the summary request never answers
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 1 };
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); for (const res of hanging) res.destroy(); server.close(); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const timer = setInterval(() => { if (requests >= 2) { clearInterval(timer); controller.abort(); } }, 20);
  const started = Date.now();
  const outcome = await runAgentTurn(session, 'read a.txt', { signal: controller.signal }).then((value) => ({ value }), (error) => ({ error }));
  clearInterval(timer);
  assert.ok(Date.now() - started < 5000, 'returned ' + (Date.now() - started) + ' ms after start');
  assert.equal(requests, 2);
  assert.ok(outcome.error ? outcome.error.name === 'AbortError' : /cancel/i.test(outcome.value.text), JSON.stringify(outcome.error ? outcome.error.message : outcome.value.text));
});
