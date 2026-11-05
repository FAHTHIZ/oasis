import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

// Every request resends the tool schemas, so tools that can only answer
// "not available" are left out: ask_user_question when no one can answer,
// exit_plan_mode outside plan mode.
async function toolNamesFor(turnOptions, sessionExtra = {}) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push((JSON.parse(raw).tools || []).map((tool) => tool.function.name));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-trim-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-trim-cfg-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0' };
  const session = await createSession({ root, env, ...sessionExtra, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'x', approvalMode: 'auto' } });
  try { await runAgentTurn(session, 'hi', { env, ...turnOptions }); } finally {
    await closeSession(session); server.close();
    await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true });
  }
  return seen[0];
}

test('a headless turn does not send ask_user_question or exit_plan_mode', async () => {
  const names = await toolNamesFor({});
  assert.ok(names.includes('read_file'));
  assert.equal(names.includes('ask_user_question'), false);
  assert.equal(names.includes('exit_plan_mode'), false);
});

test('ask_user_question is sent when someone can answer', async () => {
  const names = await toolNamesFor({ askUser: async () => 'yes' });
  assert.equal(names.includes('ask_user_question'), true);
});

test('exit_plan_mode is sent in plan mode', async () => {
  const names = await toolNamesFor({}, { permissionMode: 'plan' });
  assert.equal(names.includes('exit_plan_mode'), true);
});
