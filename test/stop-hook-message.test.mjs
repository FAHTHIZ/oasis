import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { stopHookMessage, MAX_STOP_HOOK_MESSAGE_CHARS } from '../src/completion-gates.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const settingsWith = (hooks) => ({ permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks, sandbox: { enabled: false }, shell: { enabled: false } });
const nodeHook = (code) => JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(code);

test('a Stop hook sees the end of a long final reply', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-stop-msg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'stop.json');
  const reply = 'Summary of the work.\n' + 'detail line\n'.repeat(1000) + 'Tests: 41 pass, 0 fail. DONE';
  const { config } = await scriptedModel(t, [{ content: reply }]);
  const session = await createSession({ root, config, settings: settingsWith({ Stop: [{ hooks: [{ type: 'command', command: nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>require("fs").writeFileSync(' + JSON.stringify(log) + ',d))') }] }] }) });
  await runAgentTurn(session, 'do it');
  const payload = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(payload.last_assistant_message, reply);
  assert.match(payload.last_assistant_message, /DONE$/);
  closeSession(session);
});

test('a huge final reply keeps its head and tail for the Stop hook', () => {
  const text = 'HEAD ' + 'x'.repeat(MAX_STOP_HOOK_MESSAGE_CHARS * 2) + ' TAIL';
  const out = stopHookMessage(text);
  assert.ok(out.length < MAX_STOP_HOOK_MESSAGE_CHARS + 100);
  assert.match(out, /^HEAD /);
  assert.match(out, / TAIL$/);
  assert.match(out, /characters omitted/);
  assert.equal(stopHookMessage('short'), 'short');
});
