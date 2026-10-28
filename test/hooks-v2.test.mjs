import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession, stopFailureType } from '../src/agent.mjs';
import { loadSettings } from '../src/settings.mjs';
import { runHooks, matcherAccepts, ifAccepts, describeHook, HOOK_EVENTS, HOOK_TYPES } from '../src/hooks.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-hooks-v2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const settingsWith = (hooks) => ({ permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks, sandbox: { enabled: false }, shell: { enabled: false } });
const nodeHook = (code) => JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(code);
const printJson = (value) => nodeHook('process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(' + JSON.stringify(JSON.stringify(value)) + '))');
const group = (hook, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [hook] });

test('every Claude Code event and handler type is known', () => {
  for (const event of ['PostToolBatch', 'PermissionDenied', 'StopFailure', 'UserPromptExpansion', 'InstructionsLoaded', 'TaskCreated', 'TaskCompleted', 'PreModelSwitch', 'PostModelSwitch', 'DirectoryAdded']) assert.ok(HOOK_EVENTS.includes(event), event);
  assert.deepEqual(HOOK_TYPES, ['command', 'http', 'mcp_tool', 'prompt', 'agent']);
});

test('matchers follow Claude Code: plain names are exact, anything else is an unanchored regex', () => {
  assert.equal(matcherAccepts('Edit', ['multi_edit', 'MultiEdit']), false, '"Edit" no longer matches MultiEdit');
  assert.equal(matcherAccepts('Edit|Write', ['write_file', 'Write']), true);
  assert.equal(matcherAccepts('Edit, Write', ['edit_file', 'Edit']), true);
  assert.equal(matcherAccepts('mcp__memory__.*', ['mcp_memory_create', 'mcp__memory__create']), true);
  assert.equal(matcherAccepts('^Notebook', ['notebook_edit', 'NotebookEdit']), true);
  assert.equal(matcherAccepts('Bash', ['run_shell', 'Bash']), true);
  assert.equal(matcherAccepts('rate_limit|overloaded', 'overloaded', 'StopFailure'), true);
});

test('"if" filters tool hooks with one permission rule and never runs on other events', async (t) => {
  const root = await tmp(t);
  assert.equal(ifAccepts('Bash(git *)', 'PreToolUse', { tool_name_oasis: 'run_command', tool_input: { command: 'git', args: ['status'] } }), true);
  assert.equal(ifAccepts('Bash(git *)', 'PreToolUse', { tool_name_oasis: 'run_command', tool_input: { command: 'npm', args: ['test'] } }), false);
  assert.equal(ifAccepts('Edit(*.ts)', 'PostToolUse', { tool_name_oasis: 'edit_file', tool_input: { path: 'src/a.ts' } }), true);
  assert.equal(ifAccepts('Bash(git *)', 'Stop', {}), false);
  const hooks = { PreToolUse: [group({ type: 'command', command: printJson({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no git' } }), if: 'Bash(git *)' }, 'Bash')] };
  const git = await runHooks('PreToolUse', { tool_name: 'Bash', tool_name_oasis: 'run_command', tool_input: { command: 'git', args: ['push'] } }, { hooks, root });
  assert.equal(git.permissionDecision, 'deny');
  const npm = await runHooks('PreToolUse', { tool_name: 'Bash', tool_name_oasis: 'run_command', tool_input: { command: 'npm', args: ['test'] } }, { hooks, root });
  assert.equal(npm.ran, 0);
});

test('exec-form "args" runs without a shell and substitutes ${CLAUDE_PROJECT_DIR}', async (t) => {
  const root = await tmp(t);
  const hooks = { UserPromptSubmit: [group({ type: 'command', command: process.execPath, args: ['-e', 'process.stdout.write("dir=" + process.argv[1])', '${CLAUDE_PROJECT_DIR}'] })] };
  const result = await runHooks('UserPromptSubmit', { prompt: 'hi' }, { hooks, root });
  assert.deepEqual(result.additionalContext, ['dir=' + root]);
  assert.match(describeHook(hooks.UserPromptSubmit[0].hooks[0]), /-e/);
});

test('async hooks run in the background; asyncRewake feeds exit 2 back', async (t) => {
  const root = await tmp(t);
  const delivered = [];
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const hooks = { PostToolUse: [{ hooks: [
    { type: 'command', async: true, command: printJson({ hookSpecificOutput: { additionalContext: 'lint: 2 warnings' } }) },
    { type: 'command', asyncRewake: true, command: nodeHook('process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("tests failed");process.exit(2)})') }
  ] }] };
  const result = await runHooks('PostToolUse', { tool_name: 'Edit', tool_name_oasis: 'edit_file', tool_input: {} }, { hooks, root, onAsyncResult: (text) => { delivered.push(text); if (delivered.length === 2) done(); } });
  assert.equal(result.ran, 0);
  assert.equal(result.background, 2);
  assert.equal(result.blocked, false, 'background hooks never block');
  await finished;
  assert.ok(delivered.some((text) => /lint: 2 warnings/.test(text)));
  assert.ok(delivered.some((text) => /tests failed/.test(text)));
});

test('onFailure "block" turns a crash into a block; PermissionRequest ignores bare exit 2', async (t) => {
  const root = await tmp(t);
  const crash = nodeHook('process.exit(1)');
  const soft = await runHooks('PreToolUse', { tool_name_oasis: 'run_command', tool_input: {} }, { hooks: { PreToolUse: [group({ type: 'command', command: crash })] }, root });
  assert.equal(soft.blocked, false);
  const hard = await runHooks('PreToolUse', { tool_name_oasis: 'run_command', tool_input: {} }, { hooks: { PreToolUse: [group({ type: 'command', command: crash, onFailure: 'block' })] }, root });
  assert.equal(hard.blocked, true);
  assert.match(hard.reason, /configured to block/);
  const exit2 = nodeHook('process.exit(2)');
  const request = await runHooks('PermissionRequest', { tool_name_oasis: 'run_command', tool_input: {} }, { hooks: { PermissionRequest: [group({ type: 'command', command: exit2 })] }, root });
  assert.equal(request.blocked, false);
});

test('mcp_tool hooks call a connected server with ${tool_input.*} substitution', async (t) => {
  const root = await tmp(t);
  const calls = [];
  const callMcpTool = async (request) => { calls.push(request); return { text: JSON.stringify({ decision: 'block', reason: 'secret scanner found a key in ' + request.input.path }) }; };
  const hooks = { PostToolUse: [group({ type: 'mcp_tool', server: 'scanner', tool: 'scan', input: { path: '${tool_input.path}', all: true } }, 'Write')] };
  const result = await runHooks('PostToolUse', { tool_name: 'Write', tool_name_oasis: 'write_file', tool_input: { path: 'config.env' } }, { hooks, root, callMcpTool });
  assert.deepEqual(calls, [{ server: 'scanner', tool: 'scan', input: { path: 'config.env', all: true } }]);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /found a key in config\.env/);
  const missing = await runHooks('PostToolUse', { tool_name: 'Write', tool_name_oasis: 'write_file', tool_input: {} }, { hooks, root });
  assert.equal(missing.blocked, false);
  assert.match(missing.messages[0], /no MCP servers/);
});

test('agent hooks use a verifier; prompt hooks honor "impossible" on Stop', async (t) => {
  const root = await tmp(t);
  const agentHooks = { Stop: [group({ type: 'agent', prompt: 'Check that tests pass. $ARGUMENTS' })] };
  let seen = '';
  const verdict = await runHooks('Stop', { last_assistant_message: 'done' }, { hooks: agentHooks, root, evaluateAgent: async ({ prompt }) => { seen = prompt; return 'I ran the tests.\n{"ok": false, "reason": "2 tests fail"}'; } });
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /2 tests fail/);
  assert.match(seen, /"hook_event_name": "Stop"/);
  const promptHooks = { Stop: [group({ type: 'prompt', prompt: 'Is the work complete?' })] };
  const impossible = await runHooks('Stop', {}, { hooks: promptHooks, root, evaluatePrompt: async () => '{"ok": false, "reason": "needs credentials", "impossible": true}' });
  assert.equal(impossible.blocked, false);
  assert.match(impossible.messages.join('\n'), /needs credentials/);
});

test('settings keep the new handler fields', async (t) => {
  const root = await tmp(t);
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  const home = path.join(root, 'home');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis') };
  await mkdir(env.OASIS_CONFIG_DIR, { recursive: true });
  await writeFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: 'check', args: ['--strict'], if: 'Bash(rm *)', onFailure: 'block', statusMessage: 'Checking' },
      { type: 'mcp_tool', server: 'guard', tool: 'inspect', input: { cmd: '${tool_input.command}' } },
      { type: 'agent', prompt: 'Verify $ARGUMENTS', timeout: 90 },
      { type: 'command', command: 'notify', async: true }
    ] }]
  } }));
  const settings = await loadSettings(root, { env });
  const [first, mcp, agent, background] = settings.hooks.PreToolUse[0].hooks;
  assert.deepEqual(first, { type: 'command', command: 'check', if: 'Bash(rm *)', statusMessage: 'Checking', onFailure: 'block', args: ['--strict'] });
  assert.deepEqual(mcp, { type: 'mcp_tool', server: 'guard', tool: 'inspect', input: { cmd: '${tool_input.command}' } });
  assert.equal(agent.type, 'agent');
  assert.equal(agent.timeout, 90);
  assert.equal(background.async, true);
});

test('PostToolUse updatedToolOutput replaces what the model sees', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'secret.txt'), 'API_KEY=abc123\n');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'read_file', { path: 'secret.txt' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings: settingsWith({ PostToolUse: [group({ type: 'command', command: printJson({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { content: '[redacted by hook]' } } }) }, 'Read')] }) });
  await runAgentTurn(session, 'read it');
  const tool = requests[1].messages.find((m) => m.role === 'tool');
  assert.match(tool.content, /redacted by hook/);
  assert.doesNotMatch(tool.content, /abc123/);
  closeSession(session);
});

test('PostToolBatch can stop the loop before the next model request', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'a.txt'), 'a');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'read_file', { path: 'a.txt' }), { content: 'should not be reached' }]);
  const log = path.join(root, 'batch.json');
  const hook = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").writeFileSync(' + JSON.stringify(log) + ',d);process.stdout.write(JSON.stringify({decision:"block",reason:"Budget gate: stop here."}))})');
  const session = await createSession({ root, config, settings: settingsWith({ PostToolBatch: [group({ type: 'command', command: hook })] }) });
  const result = await runAgentTurn(session, 'read');
  assert.equal(result.stoppedByHook, true);
  assert.match(result.text, /Budget gate/);
  assert.equal(requests.length, 1, 'no second model request');
  const payload = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(payload.hook_event_name, 'PostToolBatch');
  assert.equal(payload.tool_calls[0].tool_name, 'Read');
  closeSession(session);
});

test('TaskCreated rolls back a blocked task; TaskCompleted can keep one open', async (t) => {
  const root = await tmp(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'task_create', { subject: 'WIP: hack' }),
    toolCall('c2', 'task_create', { subject: 'Add tests' }),
    { content: 'done' }
  ]);
  const gate = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);if(/WIP/.test(p.task_subject)){process.stderr.write("No WIP tasks.");process.exit(2)}})');
  const session = await createSession({ root, config, settings: settingsWith({ TaskCreated: [group({ type: 'command', command: gate })] }) });
  await runAgentTurn(session, 'plan');
  const tools = requests[2].messages.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /TaskCreated hook rejected the task: No WIP tasks/);
  assert.deepEqual(session.sharedTasks.tasks.map((task) => task.subject), ['Add tests']);
  closeSession(session);
});

test('UserPromptExpansion can block a custom command; StopFailure classifies API errors', async (t) => {
  const root = await tmp(t);
  const { config, requests } = await scriptedModel(t, [{ content: 'never' }]);
  const session = await createSession({ root, config, settings: settingsWith({ UserPromptExpansion: [group({ type: 'command', command: printJson({ decision: 'block', reason: 'deploys are frozen' }) }, 'deploy')] }) });
  const result = await runAgentTurn(session, 'Deploy to prod', { expansion: { command_name: 'deploy', command_args: 'prod', prompt: 'Deploy to prod' } });
  assert.equal(result.blockedByHook, true);
  assert.match(result.text, /deploys are frozen/);
  assert.equal(requests.length, 0);
  closeSession(session);
  assert.equal(stopFailureType(Object.assign(new Error('Too many requests'), { status: 429 })), 'rate_limit');
  assert.equal(stopFailureType(new Error('invalid api key')), 'authentication_failed');
  assert.equal(stopFailureType(Object.assign(new Error('boom'), { status: 503 })), 'server_error');
});
