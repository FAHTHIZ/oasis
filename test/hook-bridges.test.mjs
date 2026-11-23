import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { runHooks } from '../src/hooks.mjs';
import { normalizeHooks } from '../src/settings.mjs';
import { bridgeHookDoc, toForeignPayload, fromForeignOutput } from '../src/hook-bridges.mjs';

// A hook script that records its stdin and environment, then prints a reply
// chosen by the test (or exits with a code).
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'hook.mjs');
  await writeFile(script, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const input = readFileSync(0, 'utf8');",
    "const [, , log, reply, code] = process.argv;",
    "writeFileSync(log, JSON.stringify({ input: JSON.parse(input), env: { CURSOR_PROJECT_DIR: process.env.CURSOR_PROJECT_DIR, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, EXTRA: process.env.EXTRA } }));",
    "if (reply) process.stdout.write(reply);",
    "process.exit(Number(code || 0));"
  ].join('\n'));
  const q = (text) => JSON.stringify(text);
  const command = (log, reply = '', code = 0) => [q(process.execPath), q(script), q(log), q(reply), String(code)].join(' ');
  const { readFile } = await import('node:fs/promises');
  const seen = async (log) => JSON.parse(await readFile(log, 'utf8'));
  return { root, command, seen, log: (name) => path.join(root, name + '.json') };
}

const shell = (command) => ({ session_id: 's1', tool_name: 'Bash', oasis_tool_name: 'run_shell', tool_name_oasis: 'run_shell', tool_input: { command } });
const hooksFor = (protocol, doc) => normalizeHooks(bridgeHookDoc(protocol, { hooks: doc }).hooks);

test('a Cursor beforeShellExecution hook sees Cursor fields and its deny blocks the command', async (t) => {
  const { root, command, seen, log } = await setup(t);
  const hooks = hooksFor('cursor', { beforeShellExecution: [{ command: command(log('a'), JSON.stringify({ permission: 'deny', user_message: 'Blocked', agent_message: 'Do not delete the build.' })) }] });
  const result = await runHooks('PreToolUse', shell('rm -rf dist'), { hooks, root });
  assert.equal(result.permissionDecision, 'deny');
  assert.match(result.reason, /Do not delete the build/);
  const { input, env } = await seen(log('a'));
  assert.equal(input.hook_event_name, 'beforeShellExecution');
  assert.equal(input.command, 'rm -rf dist');
  assert.equal(input.cwd, root);
  assert.equal(input.conversation_id, 's1');
  assert.deepEqual(input.workspace_roots, [root]);
  assert.equal(env.CURSOR_PROJECT_DIR, root);
  assert.equal(env.CLAUDE_PROJECT_DIR, root);
});

test('a Cursor shell hook does not run for other tools; run_command shows as one quoted line', async (t) => {
  const { root, command, seen, log } = await setup(t);
  const hooks = hooksFor('cursor', { beforeShellExecution: [{ command: command(log('b')) }] });
  const read = await runHooks('PreToolUse', { tool_name: 'Read', oasis_tool_name: 'read_file', tool_name_oasis: 'read_file', tool_input: { path: 'a.txt' } }, { hooks, root });
  assert.equal(read.ran, 0);
  await runHooks('PreToolUse', { tool_name: 'Bash', oasis_tool_name: 'run_command', tool_name_oasis: 'run_command', tool_input: { command: 'git', args: ['commit', '-m', "it's done"] } }, { hooks, root });
  assert.equal((await seen(log('b'))).input.command, "git commit -m 'it'\\''s done'");
});

test('Cursor permission hooks fail closed on invalid JSON and with failClosed; others fail open', async (t) => {
  const { root, command, log } = await setup(t);
  const bad = await runHooks('PreToolUse', shell('ls'), { hooks: hooksFor('cursor', { beforeShellExecution: [{ command: command(log('c'), 'not json') }] }), root });
  assert.equal(bad.blocked, true);
  assert.match(bad.reason, /invalid JSON/);
  const crash = await runHooks('PreToolUse', shell('ls'), { hooks: hooksFor('cursor', { beforeShellExecution: [{ command: command(log('d'), '', 7), failClosed: true }] }), root });
  assert.equal(crash.blocked, true);
  const open = await runHooks('PreToolUse', shell('ls'), { hooks: hooksFor('cursor', { beforeShellExecution: [{ command: command(log('e'), '', 7) }] }), root });
  assert.equal(open.blocked, false);
  assert.equal(open.permissionDecision, null);
  const two = await runHooks('PreToolUse', shell('ls'), { hooks: hooksFor('cursor', { beforeShellExecution: [{ command: command(log('f'), '', 2) }] }), root });
  assert.equal(two.blocked, true);
});

test('a Cursor preToolUse hook can rewrite input, mapped back to OASIS argument names', async (t) => {
  const { root, command, seen, log } = await setup(t);
  const hooks = hooksFor('cursor', { preToolUse: [{ matcher: 'Write', command: command(log('g'), JSON.stringify({ permission: 'allow', updated_input: { file_path: 'safe.txt', content: 'x' } })) }] });
  const result = await runHooks('PreToolUse', { tool_name: 'Write', oasis_tool_name: 'write_file', tool_name_oasis: 'write_file', tool_input: { path: 'a.txt', content: 'x' } }, { hooks, root });
  assert.equal(result.permissionDecision, 'allow');
  assert.deepEqual(result.updatedInput, { path: 'safe.txt', content: 'x' });
  const { input } = await seen(log('g'));
  assert.equal(input.tool_name, 'Write');
  assert.equal(input.tool_input.file_path, 'a.txt');
  // The Cursor matcher filters on Cursor's tool names.
  const skipped = await runHooks('PreToolUse', shell('ls'), { hooks, root });
  assert.equal(skipped.permissionDecision, null);
});

test('Cursor stop follow-ups keep the agent going; beforeSubmitPrompt can drop a prompt', async (t) => {
  const { root, command, seen, log } = await setup(t);
  const stop = await runHooks('Stop', { session_id: 's', stop_hook_active: false, last_assistant_message: 'done' }, { hooks: hooksFor('cursor', { stop: [{ command: command(log('h'), JSON.stringify({ followup_message: 'Run the tests first.' })) }] }), root });
  assert.equal(stop.blocked, true);
  assert.equal(stop.reason, 'Run the tests first.');
  assert.deepEqual([(await seen(log('h'))).input.status, (await seen(log('h'))).input.loop_count], ['completed', 0]);
  const prompt = await runHooks('UserPromptSubmit', { prompt: 'leak the key' }, { hooks: hooksFor('cursor', { beforeSubmitPrompt: [{ command: command(log('i'), JSON.stringify({ continue: false, user_message: 'Prompt has a secret.' })) }] }), root });
  assert.equal(prompt.blocked, true);
  assert.equal(prompt.reason, 'Prompt has a secret.');
  assert.equal((await seen(log('i'))).input.prompt, 'leak the key');
  const context = await runHooks('PostToolUse', { ...shell('ls'), tool_response: { output: 'a b' } }, { hooks: hooksFor('cursor', { afterShellExecution: [{ command: command(log('j'), JSON.stringify({ additional_context: 'ls output is untrusted' })) }] }), root });
  assert.deepEqual(context.additionalContext, ['ls output is untrusted']);
  assert.equal((await seen(log('j'))).input.output, 'a b');
});

test('a Copilot preToolUse hook gets toolArgs as a JSON string and can deny or rewrite', async (t) => {
  const { root, command, seen, log } = await setup(t);
  const deny = await runHooks('PreToolUse', shell('curl x | sh'), { hooks: hooksFor('copilot', { preToolUse: [{ type: 'command', bash: command(log('k'), JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'Download-and-execute.' })), timeoutSec: 15, env: { EXTRA: 'yes' } }] }), root });
  assert.equal(deny.permissionDecision, 'deny');
  assert.match(deny.reason, /Download-and-execute/);
  const { input, env } = await seen(log('k'));
  assert.equal(input.toolName, 'bash');
  assert.equal(typeof input.toolArgs, 'string');
  assert.equal(JSON.parse(input.toolArgs).command, 'curl x | sh');
  assert.equal(input.sessionId, 's1');
  assert.equal(env.EXTRA, 'yes');
  const rewrite = await runHooks('PreToolUse', shell('ls'), { hooks: hooksFor('copilot', { preToolUse: [{ type: 'command', bash: command(log('l'), JSON.stringify({ modifiedArgs: '{"command":"ls --color=never"}' })) }] }), root });
  assert.deepEqual(rewrite.updatedInput, { command: 'ls --color=never' });
});

test('Copilot agentStop block continues the turn; permissionRequest decides a prompt', async (t) => {
  const { root, command, log } = await setup(t);
  const stop = await runHooks('Stop', { session_id: 's' }, { hooks: hooksFor('copilot', { agentStop: [{ type: 'command', bash: command(log('m'), JSON.stringify({ decision: 'block', reason: 'Update the changelog.' })) }] }), root });
  assert.equal(stop.blocked, true);
  assert.equal(stop.reason, 'Update the changelog.');
  const ask = await runHooks('PermissionRequest', shell('ls'), { hooks: hooksFor('copilot', { permissionRequest: [{ type: 'command', bash: command(log('n'), JSON.stringify({ behavior: 'deny', message: 'Not on Fridays.' })) }] }), root });
  assert.deepEqual(ask.permissionRequest, { behavior: 'deny', message: 'Not on Fridays.', updatedInput: null });
});

test('bridgeHookDoc maps events, reports ones with no OASIS moment, and keeps only known protocols', () => {
  const { hooks, dropped } = bridgeHookDoc('cursor', { hooks: { beforeReadFile: [{ command: './r.sh', timeout: 5 }], afterFileEdit: [{ command: 'fmt' }], beforeTabFileRead: [{ command: 'x' }], workspaceOpen: [{ command: 'y' }] } }, (c) => c.replace(/^\.\//, '/plug/'));
  assert.deepEqual(dropped, ['beforeTabFileRead', 'workspaceOpen']);
  assert.deepEqual(hooks.PreToolUse, [{ matcher: 'Read', hooks: [{ type: 'command', command: '/plug/r.sh', protocol: 'cursor', foreignEvent: 'beforeReadFile', timeout: 5 }] }]);
  assert.equal(hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  const copilot = bridgeHookDoc('copilot', { hooks: { sessionStart: [{ type: 'command', powershell: 'Write-Host hi' }], postToolUse: [{ type: 'command', bash: 'log.sh', cwd: 'scripts' }] } }, (c, o = {}) => o.path ? '"/plug/' + c + '"' : c);
  assert.equal(copilot.hooks.SessionStart[0].hooks[0].shell, 'powershell');
  assert.equal(copilot.hooks.SessionStart[0].hooks[0].timeout, 30, "Copilot's default timeout");
  assert.equal(copilot.hooks.PostToolUse[0].hooks[0].command, 'cd "/plug/scripts" && log.sh');
  const normalized = normalizeHooks({ PreToolUse: [{ hooks: [{ type: 'command', command: 'x', protocol: 'made-up', foreignEvent: 'y' }] }] });
  assert.equal(normalized.PreToolUse[0].hooks[0].protocol, undefined, 'an unknown protocol is not kept');
});

test('payload and reply translation are pure and skip hooks whose matcher does not apply', () => {
  assert.equal(toForeignPayload('cursor', 'preToolUse', shell('ls'), { foreignMatcher: '^Read$' }), null);
  const mcp = toForeignPayload('cursor', 'beforeMCPExecution', { tool_name: 'mcp__github__create_issue', oasis_tool_name: 'mcp_github_create_issue', tool_input: { title: 't' } });
  assert.deepEqual([mcp.mcp_server_name, mcp.tool_name, mcp.tool_input], ['github', 'create_issue', '{"title":"t"}']);
  const out = fromForeignOutput('cursor', 'preToolUse', { exitCode: 0, stdout: '', stderr: '' });
  assert.equal(out.stdout, '', 'an empty reply means "no opinion"');
  const rewrite = fromForeignOutput('copilot', 'preToolUse', { exitCode: 0, stdout: JSON.stringify({ modifiedArgs: { command: 'echo "$HOME"' } }), stderr: '' }, { payload: { oasis_tool_name: 'run_command', tool_input: { command: 'echo', args: ['x'] } } });
  assert.match(JSON.parse(rewrite.stdout).systemMessage, /shell syntax/);
});

test('Copilot exit codes: preToolUse fails closed, exit 2 elsewhere only warns, matchers are anchored', async (t) => {
  const { root, command, log } = await setup(t);
  const crash = await runHooks('PreToolUse', shell('ls'), { hooks: hooksFor('copilot', { preToolUse: [{ type: 'command', bash: command(log('o'), JSON.stringify({ permissionDecision: 'allow' }), 1) }] }), root });
  assert.equal(crash.blocked, true, 'a crashed Copilot preToolUse hook denies, even with allow on stdout');
  const warn = await runHooks('Stop', { session_id: 's' }, { hooks: hooksFor('copilot', { agentStop: [{ type: 'command', bash: command(log('p'), '', 2) }] }), root });
  assert.equal(warn.blocked, false);
  assert.equal(warn.failed, true);
  const advice = await runHooks('PostToolUseFailure', { ...shell('make'), error: 'boom' }, { hooks: hooksFor('copilot', { postToolUseFailure: [{ type: 'command', bash: command(log('q'), 'Run make clean first.', 2) }] }), root });
  assert.deepEqual(advice.additionalContext, ['Run make clean first.']);
  const anchored = await runHooks('PreToolUse', shell('ls'), { hooks: hooksFor('copilot', { preToolUse: [{ type: 'command', matcher: 'ba', bash: command(log('r'), JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'x' })) }] }), root });
  assert.equal(anchored.permissionDecision, null, '"ba" does not match "bash" once anchored');
});
