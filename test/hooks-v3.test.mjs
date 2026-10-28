import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runHooks, HOOK_EVENTS, matcherAccepts } from '../src/hooks.mjs';
import { startHookWatchers, fileChangedMatcherPaths } from '../src/file-watch.mjs';
import { createWorktree, removeWorktree, finishWorktree } from '../src/worktrees.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-hooks-v3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const settingsWith = (hooks) => ({ permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks, sandbox: { enabled: false }, shell: { enabled: false } });
const nodeHook = (code) => JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(code);
// Appends the hook payload to a log file, then prints `out` (if any) and exits with `code`.
const logHook = (log, out = '', code = 0) => nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").appendFileSync(' + JSON.stringify(log) + ',d.trim()+"\\n");process.stdout.write(' + JSON.stringify(out) + ');process.exit(' + code + ')})');
const group = (hook, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [hook] });
const readLog = async (log) => existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
async function waitFor(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return false;
}

test('new Claude Code hook events are known; FileChanged matchers are basenames', () => {
  for (const event of ['FileChanged', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'TeammateIdle', 'Setup']) assert.ok(HOOK_EVENTS.includes(event), event);
  assert.equal(matcherAccepts('.envrc|.env', '.env', 'FileChanged'), true);
  assert.equal(matcherAccepts('package_json', 'package.json', 'FileChanged'), false);
  const paths = fileChangedMatcherPaths({ FileChanged: [{ matcher: '.envrc|.env', hooks: [] }, { matcher: '.*\\.lock$', hooks: [] }] }, '/repo');
  assert.deepEqual(paths, [path.resolve('/repo/.envrc'), path.resolve('/repo/.env')]);
});

test('FileChanged fires for add/change/unlink of matcher files and honors watchPaths', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'log.jsonl');
  const extra = path.join(root, 'extra.txt');
  const session = { root, sessionId: 's1', hookMessages: [], hooks: { FileChanged: [group({ type: 'command', command: logHook(log, JSON.stringify({ hookSpecificOutput: { hookEventName: 'FileChanged', watchPaths: [extra] }, systemMessage: 'env reloaded' })) }, '.envrc')] } };
  const watchers = startHookWatchers(session, {});
  t.after(() => watchers.stop());
  await writeFile(path.join(root, '.envrc'), 'export A=1\n');
  assert.ok(await waitFor(async () => (await readLog(log)).length >= 1), 'add fired');
  let entries = await readLog(log);
  assert.equal(entries[0].hook_event_name, 'FileChanged');
  assert.equal(entries[0].event, 'add');
  assert.equal(entries[0].file_path, path.join(root, '.envrc'));
  assert.ok(session.hookMessages.includes('env reloaded'));
  assert.ok(watchers.paths.includes(extra), 'watchPaths added');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await writeFile(path.join(root, '.envrc'), 'export A=2\n');
  assert.ok(await waitFor(async () => (await readLog(log)).some((entry) => entry.event === 'change')), 'change fired');
  await rm(path.join(root, '.envrc'));
  assert.ok(await waitFor(async () => (await readLog(log)).some((entry) => entry.event === 'unlink')), 'unlink fired');
  // extra.txt is not in the matcher, so its change reaches no hook group (matcher filters by basename).
  await writeFile(extra, 'x');
  await new Promise((resolve) => setTimeout(resolve, 400));
  entries = await readLog(log);
  assert.ok(!entries.some((entry) => entry.file_path === extra));
});

test('ConfigChange runs on settings edits and a block skips the live reload', async (t) => {
  const root = await tmp(t);
  await mkdir(path.join(root, '.claude'), { recursive: true });
  const settingsFile = path.join(root, '.claude', 'settings.json');
  await writeFile(settingsFile, '{}');
  const log = path.join(root, 'log.jsonl');
  const flag = path.join(root, 'block');
  const hook = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const fs=require("fs");fs.appendFileSync(' + JSON.stringify(log) + ',d.trim()+"\\n");process.exit(fs.existsSync(' + JSON.stringify(flag) + ')?2:0)})');
  const session = { root, sessionId: 's2', hookMessages: [], hooks: { ConfigChange: [group({ type: 'command', command: hook }, 'project_settings')] } };
  let reloads = 0;
  const env = { ...process.env, HOME: path.join(root, 'home'), OASIS_CONFIG_DIR: path.join(root, 'home', 'oasis') };
  const watchers = startHookWatchers(session, { env, liveReload: true, reload: async () => { reloads++; } });
  t.after(() => watchers.stop());
  await writeFile(flag, '');
  await writeFile(settingsFile, '{"model":"x"}');
  assert.ok(await waitFor(async () => (await readLog(log)).length >= 1));
  const [entry] = await readLog(log);
  assert.equal(entry.source, 'project_settings');
  assert.equal(entry.file_path, settingsFile);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(reloads, 0, 'blocked change not applied');
  await rm(flag);
  await writeFile(settingsFile, '{"model":"y"}');
  assert.ok(await waitFor(() => reloads > 0), 'unblocked change reloads settings');
});

test('interactive sessions reload settings files live', async (t) => {
  const root = await tmp(t);
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  const env = { ...process.env, HOME: path.join(root, 'home'), OASIS_CONFIG_DIR: path.join(root, 'home', 'oasis') };
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, env, watchFiles: true });
  t.after(() => closeSession(session));
  assert.ok(session.fileWatchers);
  await writeFile(path.join(root, '.oasis', 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }));
  assert.ok(await waitFor(() => session.settings.permissions.deny.includes('Bash(rm *)')), 'deny rule loaded live');
  assert.ok(session.permissions.deny.length >= 1);
});

test('WorktreeCreate/WorktreeRemove hooks replace git worktrees', async (t) => {
  const root = await tmp(t);
  const target = path.join(root, 'copies');
  const create = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=require("path").join(' + JSON.stringify(target) + ',JSON.parse(d).name);require("fs").mkdirSync(p,{recursive:true});console.error("making");console.log("noise");console.log("\\x1b[32m"+p+"\\x1b[0m")})');
  const remove = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").rmSync(JSON.parse(d).worktree_path,{recursive:true,force:true})})');
  const hookOptions = { hooks: { WorktreeCreate: [group({ type: 'command', command: create })], WorktreeRemove: [group({ type: 'command', command: remove })] }, root, env: process.env };
  const worktree = await createWorktree(root, 'Feature Auth', { hookOptions });
  assert.equal(worktree.hook, true);
  assert.match(path.basename(worktree.path), /^feature-auth-/);
  assert.ok(existsSync(worktree.path));
  assert.equal((await finishWorktree(root, worktree)).hook, true);
  await removeWorktree(root, worktree, { hookOptions });
  assert.equal(existsSync(worktree.path), false);

  const failing = { ...hookOptions, hooks: { ...hookOptions.hooks, WorktreeRemove: [group({ type: 'command', command: nodeHook('process.exit(1)') })] } };
  const kept = await createWorktree(root, 'kept', { hookOptions: failing });
  await assert.rejects(removeWorktree(root, kept, { hookOptions: failing }), /worktree removal failed, kept/);
  assert.ok(existsSync(kept.path));

  const broken = { hooks: { WorktreeCreate: [group({ type: 'command', command: nodeHook('process.exit(3)') })] }, root, env: process.env };
  await assert.rejects(createWorktree(root, 'x', { hookOptions: broken }), /WorktreeCreate hook failed/);
  const notDir = { hooks: { WorktreeCreate: [group({ type: 'command', command: nodeHook('console.log("/definitely/not/here")') })] }, root, env: process.env };
  await assert.rejects(createWorktree(root, 'x', { hookOptions: notDir }), /not a directory/);
});

test('TeammateIdle exit 2 keeps a team member working', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'idle.jsonl');
  const counter = path.join(root, 'count');
  const hook = nodeHook('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const fs=require("fs");fs.appendFileSync(' + JSON.stringify(log) + ',d.trim()+"\\n");const n=fs.existsSync(' + JSON.stringify(counter) + ')?1:0;fs.writeFileSync(' + JSON.stringify(counter) + ',"1");if(!n){console.error("Also update the changelog.");process.exit(2)}})');
  const { config, requests } = await scriptedModel(t, [{ content: 'first pass done' }, { content: 'changelog updated' }]);
  const session = await createSession({ root, config, settings: settingsWith({ TeammateIdle: [group({ type: 'command', command: hook }, 'ignored-matcher')] }) });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'work', { isSubagent: true, agentId: 'agent-1', teammate: { name: 'researcher', team: 'docs-team' } });
  assert.equal(result.text, 'changelog updated');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some((m) => m.role === 'user' && /Also update the changelog/.test(m.content)));
  const [entry] = await readLog(log);
  assert.equal(entry.teammate_name, 'researcher');
  assert.equal(entry.team_name, 'docs-team');
});

test('Setup hooks run command handlers only and never block', async (t) => {
  const root = await tmp(t);
  const log = path.join(root, 'setup.jsonl');
  const hooks = { Setup: [{ hooks: [{ type: 'command', command: logHook(log, '{"decision":"block"}', 2) }, { type: 'mcp_tool', server: 's', tool: 't' }] }] };
  const result = await runHooks('Setup', { session_id: 'x', trigger: 'init' }, { hooks, root, env: process.env });
  assert.equal(result.blocked, false);
  assert.equal(result.ran, 1);
  const [entry] = await readLog(log);
  assert.equal(entry.trigger, 'init');
});
