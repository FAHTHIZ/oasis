import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../src/tools.mjs';
import { createSession, closeSession, runAgentTurn, RESTRICTED_TOOL_NAMES } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { runHeadless } from '../src/headless.mjs';
import { loadCustomCommands } from '../src/commands.mjs';
import { loadKeybindings } from '../src/keybindings.mjs';
import { compactionThresholdChars } from '../src/context.mjs';
import { startExecJob, readEntry, resolveBackgroundId, respawnBackgroundSession, listBackgroundSessions } from '../src/background-sessions.mjs';
import { planPurge, applyPurge, parsePurgeArgs, knownProjects } from '../src/purge.mjs';
import { saveSession, listSessions } from '../src/sessions.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const SETTINGS = () => ({ permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } });

test('--restricted removes command and network tools unless --tools names them, and refuses bypass', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-restricted-'));
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, settings: SETTINGS(), env: { ...process.env, OASIS_CHROME: '1' }, restricted: true });
  const names = session.toolDefinitions.map((tool) => tool.function.name);
  for (const name of ['run_command', 'fetch_url', 'web_search', 'browser']) assert.ok(!names.includes(name), name + ' should be removed');
  assert.ok(names.includes('read_file'));
  assert.ok(RESTRICTED_TOOL_NAMES.has('run_command'));
  closeSession(session);
  const named = await createSession({ root, config, settings: SETTINGS(), restricted: true, tools: ['read_file', 'run_command'] });
  assert.ok(named.toolDefinitions.some((tool) => tool.function.name === 'run_command'));
  closeSession(named);
  await assert.rejects(createSession({ root, config, settings: SETTINGS(), restricted: true, permissionMode: 'bypassPermissions' }), /bypassPermissions/);
});

test('a restricted session denies calls to removed tools even if the model asks for them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-restricted-call-'));
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: 'echo hi' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings: SETTINGS(), restricted: true });
  const results = [];
  await runAgentTurn(session, 'run it', { approval: async () => true, onToolResult: ({ result }) => results.push(result) });
  const tool = session.messages.find((message) => message.role === 'tool');
  assert.match(String(tool && tool.content), /restricted|not available|Unknown|disabled/i);
  closeSession(session);
});

test('--append-subagent-system-prompt reaches subagent system prompts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-subappend-'));
  const { config, requests } = await scriptedModel(t, [
    toolCall('a1', 'task', { description: 'look', prompt: 'look around', subagent_type: 'general-purpose' }),
    { content: 'sub report' },
    { content: 'all done' }
  ]);
  const session = await createSession({ root, config, settings: SETTINGS(), subagentSystemAppend: 'SUBAGENT-EXTRA-RULE' });
  await runAgentTurn(session, 'delegate', { approval: async () => true });
  const subRequest = requests.find((request) => JSON.stringify(request.messages[0]).includes('SUBAGENT MODE'));
  assert.ok(subRequest, 'a subagent request was made');
  assert.match(subRequest.messages[0].content, /SUBAGENT-EXTRA-RULE/);
  assert.doesNotMatch(String(requests[0].messages[0].content), /SUBAGENT-EXTRA-RULE/);
  closeSession(session);
});

test('--permission-prompts none denies without consulting canUseTool', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-pp-none-'));
  const { config } = await scriptedModel(t, [toolCall('w1', 'write_file', { path: 'x.txt', content: 'hi' }), { content: 'finished' }]);
  let asked = 0;
  const events = [];
  const result = await runHeadless({ prompt: 'write', root, config, outputFormat: 'json', sessionOptions: { settings: { ...SETTINGS(), permissions: { allow: [], ask: ['Write'], deny: [], defaultMode: 'default' } } }, env: process.env, permissionPrompts: 'none', canUseTool: async () => { asked += 1; return true; }, onEvent: (event) => events.push(event), output: { write() {} } });
  assert.equal(asked, 0);
  await assert.rejects(readFile(path.join(root, 'x.txt')));
  assert.ok(result);
  assert.ok(events.some((event) => event.type === 'result' && event.permission_denials && event.permission_denials.length === 1), JSON.stringify(events.filter((event) => event.type === 'result')));
});

test('safe mode skips custom commands and keybindings files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-safe-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-safe-home-'));
  await mkdir(path.join(root, '.claude', 'commands'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'commands', 'hello.md'), 'Say hello');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  assert.ok((await loadCustomCommands(root, { env, home })).size >= 1);
  assert.equal((await loadCustomCommands(root, { env: { ...env, OASIS_SAFE_MODE: '1' }, home })).size, 0);
  await mkdir(path.join(home, 'cfg'), { recursive: true });
  await writeFile(path.join(home, 'cfg', 'keybindings.json'), JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+k': 'chat:submit' } }] }));
  assert.ok(loadKeybindings(env).files.length >= 1);
  assert.equal(loadKeybindings({ ...env, OASIS_SAFE_MODE: '1' }).files.length, 0);
});

test('autocompact env values: percentage, off, token counts', () => {
  const config = { model: 'x', contextWindow: 200000 };
  assert.equal(compactionThresholdChars(config, { OASIS_AUTOCOMPACT_PCT: '0' }), 8_000_000);
  assert.equal(compactionThresholdChars(config, { OASIS_AUTOCOMPACT_PCT: '50' }), Math.max(10_000, Math.floor(200000 * 4 * 0.5)));
  assert.equal(compactionThresholdChars(config, { OASIS_COMPACT_THRESHOLD_CHARS: '400000' }), 400000);
});

test('CLI flag validation for --autocompact, --permission-prompts and --restricted', () => {
  const run = (args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, OASIS_CONFIG_DIR: path.join(os.tmpdir(), 'oasis-flag-cfg-' + process.pid) }, timeout: 20000 }); return { stdout: r.stdout, stderr: r.stdout + r.stderr }; };
  assert.match(run(['--autocompact', 'banana', '-p', 'x']).stderr, /--autocompact takes/);
  assert.match(run(['--permission-prompts', 'maybe', '-p', 'x']).stderr, /--permission-prompts must be/);
  assert.match(run(['--restricted', '--dangerously-skip-permissions', '-p', 'x']).stderr, /--restricted cannot be combined/);
  assert.match(run(['--help']).stdout, /--safe-mode/);
});

test('--exec background jobs log output, record exit codes, resolve by prefix/name, and respawn', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-exec-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-exec-root-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const entry = await startExecJob({ root, command: 'echo exec-hello && exit 3', env, name: 'my build' });
  assert.equal(entry.kind, 'exec');
  let current = entry;
  for (let i = 0; i < 200 && current.status === 'running'; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); current = await readEntry(entry.id, env); }
  assert.equal(current.status, 'failed');
  assert.equal(current.exitCode, 3);
  const log = await readFile(entry.logFile, 'utf8');
  assert.match(log, /exec-hello/);
  assert.match(log, /\[exit 3\]/);
  assert.equal(await resolveBackgroundId(entry.id.slice(3, 7), env), entry.id);
  assert.equal(await resolveBackgroundId('build', env), entry.id);
  await assert.rejects(resolveBackgroundId('nothing-matches', env), /No background session/);
  const again = await respawnBackgroundSession(entry.id, env);
  assert.equal(again.id, entry.id);
  current = again;
  for (let i = 0; i < 200 && current.status === 'running'; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); current = await readEntry(entry.id, env); }
  assert.equal(current.exitCode, 3);
  assert.equal((await listBackgroundSessions(env)).length, 1);
  const cli = spawnSync(process.execPath, [CLI, 'logs', entry.id.slice(3)], { encoding: 'utf8', env, cwd: root, timeout: 20000 });
  assert.match(cli.stdout, /exec-hello/, cli.stderr);
});

test('oasis purge removes a project\'s transcripts, history lines and background entries', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-purge-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-purge-root-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'oasis-purge-other-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  await saveSession({ root, id: '11111111-2222-3333-4444-555555555555', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] }, { env });
  await saveSession({ root: other, id: '99999999-2222-3333-4444-555555555555', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'yo' }] }, { env });
  await mkdir(path.join(home, 'cfg'), { recursive: true });
  await writeFile(path.join(home, 'cfg', 'history.jsonl'), JSON.stringify({ root, text: 'mine' }) + '\n' + JSON.stringify({ root: other, text: 'theirs' }) + '\n');
  const job = await startExecJob({ root, command: 'echo purge-me', env });
  for (let i = 0; i < 200 && (await readEntry(job.id, env)).status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(parsePurgeArgs(['x', '--dry-run', '-y']), { path: 'x', dryRun: true, yes: true, interactive: false, all: false, memory: false });
  assert.equal((await knownProjects(env)).length, 2);
  const plan = await planPurge(root, { env });
  assert.deepEqual(plan.items.map((item) => item.kind).sort(), ['background', 'history', 'transcripts']);
  await applyPurge(plan, { env });
  assert.equal((await listSessions(root, { env })).length, 0);
  assert.equal((await listSessions(other, { env })).length, 1);
  const history = await readFile(path.join(home, 'cfg', 'history.jsonl'), 'utf8');
  assert.doesNotMatch(history, /mine/);
  assert.match(history, /theirs/);
  assert.equal((await listBackgroundSessions(env)).length, 0);
  const cli = spawnSync(process.execPath, [CLI, 'purge', other, '--dry-run'], { encoding: 'utf8', env, timeout: 20000 });
  assert.match(cli.stdout, /dry run/, cli.stderr);
  assert.equal((await listSessions(other, { env })).length, 1);
});
