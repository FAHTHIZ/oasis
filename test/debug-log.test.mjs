import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import '../src/tools.mjs';
import { enableDebug, disableDebug, debugLog, debugEnabled, parseDebugCategories } from '../src/debug-log.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

test('categories filter and secrets are redacted', async (t) => {
  t.after(disableDebug);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-debug-'));
  assert.deepEqual([...parseDebugCategories('api,!mcp').include], ['api']);
  const file = enableDebug({ categories: 'api,hooks', file: path.join(dir, 'log.txt') });
  debugLog('api', 'request', { headers: { authorization: 'Bearer sk-abcdef1234567890' } });
  debugLog('mcp', 'should not appear');
  assert.equal(debugEnabled('mcp'), false);
  const text = await readFile(file, 'utf8');
  assert.match(text, /\[API\] request/);
  assert.doesNotMatch(text, /should not appear/);
  assert.doesNotMatch(text, /sk-abcdef/);
  assert.match(text, /\[redacted\]/);
});

test('OASIS_DEBUG logs api, tools and permissions for a turn; /debug and /heapdump work', async (t) => {
  t.after(disableDebug);
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-debug-root-'));
  await writeFile(path.join(root, 'a.txt'), 'hello');
  const file = path.join(root, 'debug.txt');
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_DEBUG: 'all', OASIS_DEBUG_FILE: file };
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const { config } = await scriptedModel(t, [toolCall('r', 'read_file', { path: 'a.txt' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'read it', { env, approval: async () => true });
  const text = await readFile(file, 'utf8');
  assert.match(text, /\[SESSION\] debug logging on/);
  assert.match(text, /\[API\] request openai-compatible model=fixture/);
  assert.match(text, /\[API\] response in \d+ms/);
  assert.match(text, /\[TOOLS\] read_file ok/);
  assert.match(text, /\[PERMISSIONS\] read_file ->/);
  const dbg = await runBuiltinCommand('debug', 'hooks never fire', { session, sessionOptions: {}, env, root });
  assert.match(dbg.prompt, /hooks never fire/);
  assert.ok(dbg.prompt.includes(file));
  const heap = await runBuiltinCommand('heapdump', '', { session, sessionOptions: {}, env, root });
  const snapshot = /Heap snapshot: (\S+\.heapsnapshot)/.exec(heap.output)[1];
  assert.ok((await stat(snapshot)).size > 1000);
  assert.match(heap.output, /RSS .* heap/);
});

test('/team-onboarding builds a prompt from usage and project files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-onboard-'));
  const out = await runBuiltinCommand('team-onboarding', '14', { root, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') } });
  assert.match(out.output, /last 14 days/);
  assert.match(out.prompt, /ONBOARDING\.md/);
  assert.match(out.prompt, /never copy secrets/);
});
