import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { isMalformedGenerationError, createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { retryPlan } from '../app/core/providers.mjs';

// Captured from Pollinations (gpt-oss-20b): the upstream failed to parse the
// model's own output, and the whole eval run ended on this 400.
const BODY = '{"success":false,"error":{"message":"400 Bad Request: Unknown role: assistant<|channel|>commentary","code":"BAD_REQUEST"},"status":400}';

test('a 400 caused by the model\'s own harmony output is treated as retryable', () => {
  assert.equal(isMalformedGenerationError(400, BODY), true);
  assert.equal(isMalformedGenerationError(400, '{"error":{"message":"Invalid message name for role \'tool\'. Names must match ^[a-zA-Z0-9_-]{1,64}$."}}'), false);
  assert.equal(isMalformedGenerationError(401, BODY), false);
  assert.equal(retryPlan(400, BODY).retryable, true);
  assert.equal(retryPlan(400, '{"error":"bad model"}').retryable, false);
});

test('the agent retries that 400 and finishes the turn', async (t) => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls++;
    if (calls === 1) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(BODY); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'All set.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-harmony-400-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-harmony-400-cfg-'));
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0' };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'gpt-oss-20b', apiKey: 'x', approvalMode: 'auto' } });
  try {
    const result = await runAgentTurn(session, 'say hi', { env });
    assert.equal(calls, 2);
    assert.match(String(result.text), /All set/);
  } finally { await closeSession(session); }
});
