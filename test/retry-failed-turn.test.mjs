import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

// Seen live (13 Nov 2026): a rate-limited turn left "Say hello" unanswered;
// Try again sent it once more and the model saw the request twice, with a
// stand-in reply between them claiming the user had interrupted it.
test('retrying a request that got no reply answers the recorded one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-retry-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-retry-cfg-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0', OASIS_ASSISTED_VERIFICATION: '0' };
  const { config, requests } = await scriptedModel(t, [{ content: 'Hello back' }, { content: 'Hi again' }]);
  const session = await createSession({ root, env, config });
  t.after(() => closeSession(session));
  session.messages.push({ role: 'user', content: 'Say hello' });
  await runAgentTurn(session, 'Say hello', { env, autoApprove: true });
  const said = requests[0].messages.filter((m) => m.role !== 'system');
  assert.equal(said.filter((m) => m.role === 'user' && m.content === 'Say hello').length, 1);
  assert.ok(!said.some((m) => /interrupted by the user/.test(String(m.content))));
  // A request repeated after it was answered is a new request.
  await runAgentTurn(session, 'Say hello', { env, autoApprove: true });
  assert.equal(requests[1].messages.filter((m) => m.role === 'user' && m.content === 'Say hello').length, 2);
});
