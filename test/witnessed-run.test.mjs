import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { rehearsalSupport, witnessVerdict } from '../src/rehearsal.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { loadSettings } from '../src/settings.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// Witnessed runs: when auto mode's classifier is unsure, the command runs once as a
// rehearsal and, if everything it did stayed in the workspace, that rehearsal is the run.

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
async function tmp(t, prefix = 'oasis-witness-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const rehearsed = (over = {}) => ({ status: 'ok', exitCode: 0, keep: {}, contacts: [], readOnlyWrites: false, git: 0, changes: { created: [], modified: [], deleted: [] }, ...over });

test('a rehearsal stands in for the run only when everything it did stayed in the workspace', () => {
  assert.deepEqual(witnessVerdict(rehearsed(), '/w'), { clean: true, reason: '' });
  assert.equal(witnessVerdict(rehearsed({ status: 'failed', exitCode: 1, changes: { created: ['out.txt'], modified: ['a.py'], deleted: ['b.py'] } }), '/w').clean, true, 'a failing test run is still a result');
  for (const [over, reason] of [
    [{ status: 'timeout' }, /did not finish in time/],
    [{ status: 'error' }, /could not finish/],
    [{ keep: null }, /could not finish/],
    [{ contacts: [{ host: 'evil.example', port: 443 }] }, /tried to reach evil\.example/],
    [{ readOnlyWrites: true }, /outside the workspace/],
    [{ git: 3 }, /3 path\(s\) inside \.git/],
    [{ changes: { created: ['.oasis/settings.json'], modified: [], deleted: [] } }, /\.oasis\/settings\.json, a protected configuration file/],
    [{ changes: { created: [], modified: ['.claude/settings.json'], deleted: [] } }, /protected configuration file/],
    [{ changes: { created: Array.from({ length: 201 }, (_, i) => 'f' + i), modified: [], deleted: [] } }, /201 paths/]
  ]) {
    const verdict = witnessVerdict(rehearsed(over), '/w');
    assert.equal(verdict.clean, false, JSON.stringify(over).slice(0, 80));
    assert.match(verdict.reason, reason);
  }
  assert.equal(witnessVerdict(null, '/w').clean, false);
});

test('a project may turn witnessed runs off but not on', async (t) => {
  const root = await tmp(t);
  const cfg = await tmp(t);
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(cfg, 'settings.json'), JSON.stringify({ autoMode: { witness: false } }));
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ autoMode: { witness: true } }));
  const env = { ...process.env, OASIS_CONFIG_DIR: cfg };
  assert.equal((await loadSettings(root, { env })).autoMode.witness, false);
  await writeFile(path.join(cfg, 'settings.json'), JSON.stringify({ autoMode: { rules: [] } }));
  const loaded = await loadSettings(root, { env });
  assert.notEqual(loaded.autoMode && loaded.autoMode.witness, true, 'a project cannot turn them on');
});

const rehearsable = rehearsalSupport().available;

test('an unsure verdict is settled by watching: the rehearsal is the run, and nothing runs twice', { skip: !rehearsable && 'needs bubblewrap overlay support' }, async (t) => {
  const root = await tmp(t);
  // Each run appends a line, so a second (real) run would show as two lines.
  await writeFile(path.join(root, 'count.js'), "require('fs').appendFileSync('runs.txt', 'run\\n'); console.log('counted');\n");
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: process.execPath, args: ['count.js'] }),
    { content: '{"decision": "ask", "reason": "Not sure what count.js does."}' },
    { content: 'Counted.' }
  ]);
  const session = await createSession({ root, config, settings, permissionMode: 'auto' });
  t.after(() => closeSession(session));
  let asked = 0;
  const events = [];
  const result = await runAgentTurn(session, 'run count.js', { approval: async () => { asked++; return false; }, onAutoMode: (event) => events.push(event) });
  assert.equal(result.text, 'Counted.');
  assert.equal(asked, 0, 'nobody was asked');
  assert.equal(await readFile(path.join(root, 'runs.txt'), 'utf8'), 'run\n', 'applied once, never run again');
  const tool = JSON.parse(requests.at(-1).messages.find((m) => m.role === 'tool').content);
  assert.equal(tool.witnessed, true);
  assert.equal(tool.exitCode, 0);
  assert.match(tool.stdout, /counted/);
  assert.match(tool.message, /that rehearsal was the run/);
  assert.equal(events.at(-1).rule, 'Witnessed run');
  assert.match(session.autoMode.log.at(-1).reason, /Witnessed: .*Not sure what count\.js does/);
});

test('a rehearsal that leaves the workspace goes to a person, who is told what it tried', { skip: !rehearsable && 'needs bubblewrap overlay support' }, async (t) => {
  const root = await tmp(t);
  // The home folder is read-only in a rehearsal (/tmp is a private tmpfs,
  // covered below). The clean-environment CI job sets HOME=/tmp/h1, where a
  // write lands in that tmpfs instead; use the checkout then.
  const underTmp = (dir) => !path.relative(os.tmpdir(), dir).startsWith('..');
  const base = [os.homedir(), process.cwd()].find((dir) => !underTmp(dir));
  if (!base) return t.skip('the home folder and the checkout are both under ' + os.tmpdir());
  const outside = path.join(base, '.oasis-witness-test-' + process.pid);
  t.after(() => rm(outside, { force: true }));
  await writeFile(path.join(root, 'leak.js'), 'require("fs").writeFileSync("in.txt", "1"); require("fs").writeFileSync(' + JSON.stringify(outside) + ', "1");\n');
  const { config } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: process.execPath, args: ['leak.js'] }),
    { content: '{"decision": "ask", "reason": "Unsure."}' },
    { content: 'Not run.' }
  ]);
  const session = await createSession({ root, config, settings, permissionMode: 'auto' });
  t.after(() => closeSession(session));
  const metas = [];
  await runAgentTurn(session, 'run leak.js', { approval: async (message, force, meta) => { metas.push(meta); return false; } });
  assert.equal(metas.length, 1, 'the person decides');
  assert.match(metas[0].autoModeReason, /Unsure; its rehearsal tried to write outside the workspace/);
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(path.join(root, 'in.txt')), false, 'nothing from the rehearsal was kept');
});

test('files a witnessed run leaves in /tmp are reported as discarded', { skip: !rehearsable && 'needs bubblewrap overlay support' }, async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'tmpout.js'), 'require("fs").writeFileSync("/tmp/oasis-witness-left.txt", "1"); console.log("wrote")\n');
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: process.execPath, args: ['tmpout.js'] }),
    { content: '{"decision": "ask", "reason": "Unsure."}' },
    { content: 'ok' }
  ]);
  const session = await createSession({ root, config, settings, permissionMode: 'auto' });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'run tmpout.js', { approval: async () => false });
  const tool = JSON.parse(requests.at(-1).messages.find((m) => m.role === 'tool').content);
  assert.equal(tool.witnessed, true);
  assert.deepEqual(tool.rehearsal.leftInTmp, ['oasis-witness-left.txt']);
  assert.match(tool.message, /what it wrote in \/tmp \(oasis-witness-left\.txt\) was discarded/);
  assert.equal(existsSync('/tmp/oasis-witness-left.txt'), false);
});

test('witnessed runs can be turned off, and never apply to high-risk commands', { skip: !rehearsable && 'needs bubblewrap overlay support' }, async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'ok.js'), 'console.log(1)\n');
  const { config } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: process.execPath, args: ['ok.js'] }),
    { content: '{"decision": "ask", "reason": "Unsure."}' },
    toolCall('c2', 'run_command', { command: process.execPath, args: ['-e', 'console.log(2)'] }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, settings: { ...settings, autoMode: { witness: false } }, permissionMode: 'auto' });
  t.after(() => closeSession(session));
  const prompts = [];
  await runAgentTurn(session, 'run them', { approval: async (message) => { prompts.push(message); return false; } });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /HIGH RISK/);
});

test('run_shell offers a witnessed run too, and applies only what its rehearsal did', { skip: !rehearsable && 'needs bubblewrap overlay support' }, async (t) => {
  const { executePowerTool } = await import('../src/power-tools.mjs');
  const root = await tmp(t);
  let seen = null;
  // With an approver that witnesses, as auto mode's does when its classifier is unsure.
  const approval = async (message, force, extra) => {
    seen = extra && extra.witness ? await extra.witness() : null;
    if (seen && seen.clean) { extra.choice.value = 'witnessed'; return true; }
    return false;
  };
  const sandbox = { enabled: true, available: true, kind: 'bubblewrap' };
  const context = { approval, env: process.env, session: { settings: {} }, sandbox };
  const result = await executePowerTool('run_shell', { command: 'echo hi > made.txt && echo done' }, context, root).catch((error) => ({ error: String(error.message || error) }));
  if (result.error && /sandbox/i.test(result.error)) return t.skip('the bubblewrap sandbox cannot start here: ' + result.error);
  assert.equal(seen && seen.clean, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.witnessed, true);
  assert.match(result.stdout, /done/);
  assert.equal(await readFile(path.join(root, 'made.txt'), 'utf8'), 'hi\n');
});

