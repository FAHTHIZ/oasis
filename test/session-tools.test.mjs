import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextCronRun, createCronJob, listCronJobs, deleteCronJob, tickCron, stopCron, deferMcpTools, searchTools, monitorCommand, enterPlanMode, notifyUser, SESSION_TOOL_NAMES } from '../src/session-tools.mjs';

const def = (name, description = '') => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } });

test('parseCron handles steps, ranges and lists', () => {
  const [minute, hour, , , weekday] = parseCron('*/15 9-17 * * 1,3,7');
  assert.deepEqual([...minute], [0, 15, 30, 45]);
  assert.equal(hour.size, 9);
  assert.deepEqual([...weekday].sort(), [0, 1, 3]);
  assert.throws(() => parseCron('* * *'), /5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
});

test('nextCronRun finds the next matching minute', () => {
  const next = nextCronRun(parseCron('30 10 * * *'), new Date(2026, 0, 1, 10, 29, 40));
  assert.equal(next.getHours(), 10);
  assert.equal(next.getMinutes(), 30);
});

test('cron jobs fire once or repeatedly and can be deleted', () => {
  const session = {};
  const fired = [];
  const start = new Date(2026, 0, 1, 8, 0, 0);
  const once = createCronJob(session, { cron: '* * * * *', prompt: 'check build', recurring: false }, { now: () => start, startTimer: false });
  const every = createCronJob(session, { cron: '* * * * *', prompt: 'ping' }, { now: () => start, startTimer: false });
  session.cron.onFire = (prompt) => fired.push(prompt);
  tickCron(session, new Date(2026, 0, 1, 8, 1, 5));
  assert.deepEqual(fired, ['check build', 'ping']);
  assert.equal(listCronJobs(session).jobs.length, 1);
  tickCron(session, new Date(2026, 0, 1, 8, 2, 5));
  assert.deepEqual(fired, ['check build', 'ping', 'ping']);
  assert.equal(deleteCronJob(session, every.id).deleted, true);
  assert.equal(deleteCronJob(session, once.id).deleted, false);
  stopCron(session);
});

test('cron prompts queue as pending when nothing is listening', () => {
  const session = {};
  createCronJob(session, { cron: '* * * * *', prompt: 'later' }, { now: () => new Date(2026, 0, 1, 8, 0), startTimer: false });
  tickCron(session, new Date(2026, 0, 1, 8, 1));
  assert.deepEqual(session.cron.pending, ['later']);
});

test('MCP tools are deferred above the threshold and loaded by search', () => {
  const mcp = Array.from({ length: 30 }, (_, i) => def('mcp__srv__tool' + i, i === 7 ? 'Create a GitHub issue' : 'Other thing'));
  const session = { mcpToolMap: new Map(mcp.map((tool) => [tool.function.name, {}])), toolDefinitions: [def('read_file'), ...mcp] };
  assert.equal(deferMcpTools(session, { env: {} }), 30);
  assert.deepEqual(session.toolDefinitions.map((tool) => tool.function.name), ['read_file', 'tool_search']);
  const found = searchTools(session, { query: 'github issue' });
  assert.deepEqual(found.loaded, ['mcp__srv__tool7']);
  assert.equal(searchTools(session, { query: 'select:mcp__srv__tool3,nope' }).loaded[0], 'mcp__srv__tool3');
  assert.equal(session.toolDefinitions.length, 4);
  assert.equal(found.remaining_deferred, 29);
});

test('MCP tools stay loaded below the threshold or when disabled', () => {
  const mcp = [def('mcp__a__x')];
  const session = { mcpToolMap: new Map([['mcp__a__x', {}]]), toolDefinitions: [...mcp] };
  assert.equal(deferMcpTools(session, { env: {} }), 0);
  assert.equal(deferMcpTools(session, { env: { OASIS_TOOL_SEARCH: 'off' } }), 0);
  assert.equal(deferMcpTools(session, { env: { OASIS_TOOL_SEARCH: 'always' } }), 1);
});

test('monitor_command returns when the pattern matches or the process exits', async () => {
  const entry = { id: 'bg_1', status: 'running', exitCode: null, output: 'booting\n', readOffset: 0 };
  const session = { background: new Map([['bg_1', entry]]) };
  setTimeout(() => { entry.output += 'Server ready on 3000\n'; }, 50);
  const matched = await monitorCommand(session, { id: 'bg_1', pattern: 'ready on \\d+', timeout_seconds: 5 });
  assert.equal(matched.reason, 'matched');
  assert.match(matched.output, /ready on 3000/);
  setTimeout(() => { entry.status = 'exited'; entry.exitCode = 0; }, 50);
  const exited = await monitorCommand(session, { id: 'bg_1', timeout_seconds: 5 });
  assert.equal(exited.reason, 'exited');
  await assert.rejects(() => monitorCommand(session, { id: 'missing' }), /No background command/);
});

test('enter_plan_mode switches the permission mode', () => {
  const session = { permissions: { mode: 'acceptEdits' } };
  assert.equal(enterPlanMode(session, { reason: 'risky' }).mode, 'plan');
  assert.equal(session.permissions.mode, 'plan');
  assert.equal(session.prePlanMode, 'acceptEdits');
});

test('notify writes an OSC 9 sequence and calls the desktop notifier', () => {
  let written = '';
  const calls = [];
  const result = notifyUser({ message: 'Build done\n', title: 'CI' }, { env: { DISPLAY: ':0' }, platform: 'linux', output: { isTTY: true, write: (text) => { written += text; } }, run: (...args) => calls.push(args) });
  assert.equal(written, '\x1b]9;CI: Build done \x07');
  assert.deepEqual(calls, [['notify-send', ['CI', 'Build done ']]]);
  assert.deepEqual(result.channels, ['terminal', 'notify-send']);
});

test('session tool names are registered', () => {
  for (const name of ['tool_search', 'monitor_command', 'enter_plan_mode', 'notify', 'cron_create', 'cron_list', 'cron_delete']) assert.ok(SESSION_TOOL_NAMES.has(name));
});

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn, askSideQuestion, evaluateGoal } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-st-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-st-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  return { root, env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), OASIS_AUTO_MEMORY: '0' } };
}

test('the agent can enter plan mode and schedule a prompt through tools', async (t) => {
  const { root, env } = await workspace(t);
  const { config } = await scriptedModel(t, [
    toolCall('c1', 'cron_create', { cron: '*/5 * * * *', prompt: 'check the build' }),
    toolCall('c2', 'enter_plan_mode', { reason: 'big refactor' }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'monitor_command'));
  await runAgentTurn(session, 'plan a refactor and check the build every 5 minutes', { env, autoApprove: false, approval: async () => false });
  assert.equal(session.permissions.mode, 'plan');
  const listed = await runBuiltinCommand('schedule', 'list', { root, session, env });
  assert.match(listed.output, /cron_1 {2}\*\/5 \* \* \* \*/);
  assert.match((await runBuiltinCommand('schedule', 'delete cron_1', { root, session, env })).output, /Deleted/);
});

test('side questions and goal checks do not change the conversation', async (t) => {
  const { root, env } = await workspace(t);
  const { config, requests } = await scriptedModel(t, [{ content: 'hello there' }, { content: 'You greeted me.' }, { content: 'MET\nThe greeting was answered.' }]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'say hello', { env, autoApprove: false, approval: async () => false });
  const before = session.messages.length;
  assert.equal(await askSideQuestion(session, 'what did I ask?'), 'You greeted me.');
  assert.equal(requests[1].tools, undefined);
  const verdict = await evaluateGoal(session, 'the assistant said hello');
  assert.equal(verdict.met, true);
  assert.match(verdict.reason, /greeting/);
  assert.equal(session.messages.length, before);
});

test('slash commands: goal, rename, keybindings, simplify and verify', async (t) => {
  const { root, env } = await workspace(t);
  const session = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Fix the login bug' }] };
  const goal = await runBuiltinCommand('goal', 'tests pass', { root, session, env });
  assert.deepEqual(goal.goal, { condition: 'tests pass', maxTurns: 20 });
  assert.match((await runBuiltinCommand('goal', '', { root, session, env })).output, /No goal/);
  assert.match((await runBuiltinCommand('rename', 'auth\u0007 work', { root, session, env })).output, /"auth work"/);
  assert.equal(session.sessionName, 'auth work');
  await runBuiltinCommand('rename', '', { root, session, env });
  assert.equal(session.sessionName, 'Fix the login bug');
  assert.match((await runBuiltinCommand('keybindings', '', { root, session, env })).output, /Shift\+Tab/);
  assert.match((await runBuiltinCommand('simplify', '', { root, session, env })).prompt, /four read-only review subagents/);
  assert.match((await runBuiltinCommand('verify', 'the login page', { root, session, env })).prompt, /the login page/);
  assert.match((await runBuiltinCommand('batch', 'rename foo', { root, session, env })).prompt, /isolation "worktree"/);
  assert.match((await runBuiltinCommand('schedule', '"* *" do it', { root, session, env })).output, /5 fields/);
});
