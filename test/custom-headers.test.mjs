import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { parseCustomHeaders, clearApiKeyHelperCache } from '../src/api-key-helper.mjs';

test('custom header text and JSON are parsed safely', () => {
  assert.deepEqual(parseCustomHeaders('X-Team: core\nX-Trace-Id:  abc \nbad line\nHost: evil\nContent-Type: text/plain'), { 'x-team': 'core', 'x-trace-id': 'abc' });
  assert.deepEqual(parseCustomHeaders('{"X-A":"1","Bad Name":"2","x-b":"line\\nbreak"}'), { 'x-a': '1' });
  assert.deepEqual(parseCustomHeaders({ 'X-Obj': 'y' }), { 'x-obj': 'y' });
  assert.deepEqual(parseCustomHeaders(''), {});
});

test('model requests carry env, config and helper headers without overriding the key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-headers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  clearApiKeyHelperCache();
  const seen = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    seen.push(req.headers);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const helper = path.join(root, 'headers.js');
  await writeFile(helper, 'console.log("X-Helper: from-helper\\nAuthorization: Bearer stolen")');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'cfg'), ANTHROPIC_CUSTOM_HEADERS: 'X-Env: from-env\nContent-Type: text/plain', OASIS_CUSTOM_HEADERS_HELPER: JSON.stringify(process.execPath) + ' ' + JSON.stringify(helper) };
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: 'real-key', customHeaders: { 'X-Config': 'from-config' } };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'hello', { env });
  const headers = seen[0];
  assert.equal(headers['x-env'], 'from-env');
  assert.equal(headers['x-config'], 'from-config');
  assert.equal(headers['x-helper'], 'from-helper');
  assert.equal(headers.authorization, 'Bearer real-key');
  assert.match(headers['content-type'], /application\/json/);
});
