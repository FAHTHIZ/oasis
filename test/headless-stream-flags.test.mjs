import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { runHeadless } from '../src/headless.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const base = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, sandbox: { enabled: false }, shell: { enabled: false } };
const lines = (out) => out.trim().split('\n').map((line) => JSON.parse(line));
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'oasis-stream-'));

test('hook events: SessionStart always, every hook with includeHookEvents', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const hooks = { SessionStart: [{ hooks: [{ type: 'command', command: 'echo started' }] }], PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'exit 0' }] }] };
  const run = async (includeHookEvents) => {
    const { config } = await scriptedModel(t, [toolCall('c1', 'write_file', { path: 'a.txt', content: 'x' }), { content: 'done' }]);
    let out = '';
    await runHeadless({ prompt: 'go', root, config, outputFormat: 'stream-json', includeHookEvents, sessionOptions: { settings: { ...base, hooks } }, write: (text) => { out += text; } });
    return lines(out).filter((event) => event.subtype === 'hook_started' || event.subtype === 'hook_response');
  };
  const quiet = await run(false);
  assert.deepEqual([...new Set(quiet.map((event) => event.hook_event))], ['SessionStart']);
  const started = quiet.find((event) => event.subtype === 'hook_response');
  assert.equal(started.outcome, 'success');
  assert.match(started.stdout, /started/);
  const loud = await run(true);
  assert.ok(loud.some((event) => event.hook_name === 'PreToolUse:write_file' || event.hook_event === 'PreToolUse'));
  const pre = loud.filter((event) => event.hook_event === 'PreToolUse');
  assert.equal(pre[0].hook_id, pre[1].hook_id);
});

test('forwardSubagentText tags subagent messages with the task tool call id', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [toolCall('t1', 'task', { description: 'look', prompt: 'look around' }), { content: 'sub report' }, { content: 'all done' }]);
  config.maxSteps = 20;
  let out = '';
  await runHeadless({ prompt: 'delegate', root, config, outputFormat: 'stream-json', forwardSubagentText: true, sessionOptions: { settings: { ...base, hooks: {} } }, write: (text) => { out += text; } });
  const events = lines(out);
  const forwarded = events.find((event) => event.type === 'assistant' && event.parent_tool_use_id === 't1');
  assert.ok(forwarded, out);
  assert.equal(forwarded.message.content[0].text, 'sub report');
  assert.ok(events.some((event) => event.type === 'tool_use' && event.id === 't1'));
});

test('promptSuggestions emits a prompt_suggestion line after the result', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [{ content: 'Added the parser.' }, { content: 'Write tests for the parser' }]);
  let out = '';
  await runHeadless({ prompt: 'add a parser', root, config, outputFormat: 'stream-json', promptSuggestions: true, sessionOptions: { settings: { ...base, hooks: {} } }, write: (text) => { out += text; } });
  const events = lines(out);
  const last = events[events.length - 1];
  assert.equal(last.type, 'prompt_suggestion');
  assert.equal(last.suggestion, 'Write tests for the parser');
  assert.equal(events[events.length - 2].type, 'result');
});

test('excludeDynamicSections moves the workspace path out of the system prompt', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'ok' }]);
  await runHeadless({ prompt: 'hi', root, config, outputFormat: 'json', sessionOptions: { settings: { ...base, hooks: {} }, excludeDynamicSections: true }, write: () => {} });
  const payload = requests[0];
  const system = payload.messages.find((m) => m.role === 'system').content;
  assert.ok(!system.includes(root));
  const user = payload.messages.filter((m) => m.role === 'user').pop().content;
  assert.match(typeof user === 'string' ? user : JSON.stringify(user), new RegExp('session-context[\\s\\S]*' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
