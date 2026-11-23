import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, lstat, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRehearsal, disposeRehearsal, formatRehearsal, rehearsalDivergence, rehearsalEnabled, rehearsalSupport, rehearseCommand, rehearseForApproval, summaryDivergence } from '../src/rehearsal.mjs';
import { runWorkspaceCommand } from '../src/tools.mjs';

const support = rehearsalSupport();
const skip = support.available ? false : 'rehearsal unavailable: ' + support.reason;

async function workspace() {
  const root = await mkdtemp(path.join(os.homedir(), '.oasis-rehearsal-test-'));
  await writeFile(path.join(root, 'a.txt'), 'alpha\n');
  await writeFile(path.join(root, 'b.txt'), 'beta\n');
  await mkdir(path.join(root, 'd', 'e'), { recursive: true });
  await writeFile(path.join(root, 'd', 'c.txt'), 'gamma\n');
  await writeFile(path.join(root, 'd', 'e', 'f.txt'), 'delta\n');
  await writeFile(path.join(root, 'run.sh'), '#!/bin/sh\n');
  await symlink('a.txt', path.join(root, 'link'));
  return root;
}

// Every path, type, mode and content (or link target) under root.
async function fingerprint(root) {
  const hash = createHash('sha256');
  const walk = async (dir, rel) => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const childRel = rel ? rel + '/' + name : name;
      hash.update(childRel + ':' + (info.mode & 0o7777) + ':');
      if (info.isSymbolicLink()) hash.update('link:' + await readlink(full));
      else if (info.isDirectory()) await walk(full, childRel);
      else hash.update(await readFile(full));
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}

test('rehearsal is off unless asked for or the bubblewrap sandbox is on', () => {
  assert.equal(rehearsalEnabled({}), false);
  const bwrap = { available: true, kind: 'bubblewrap' };
  assert.equal(rehearsalEnabled({}, {}, bwrap), true);
  assert.equal(rehearsalEnabled({}, {}, { available: true, kind: 'docker' }), false);
  assert.equal(rehearsalEnabled({}, {}, { available: false, kind: 'none' }), false);
  assert.equal(rehearsalEnabled({}, { rehearse: false }, bwrap), false);
  assert.equal(rehearsalEnabled({ OASIS_REHEARSE: '0' }, {}, bwrap), false);
  assert.equal(rehearsalEnabled({ OASIS_REHEARSE: '1' }), true);
  assert.equal(rehearsalEnabled({}, { rehearse: true }), true);
  assert.equal(rehearsalEnabled({ OASIS_REHEARSE: '0' }, { rehearse: true }), false);
});

test('a rehearsal reports exact changes and leaves the workspace untouched', { skip }, async () => {
  const root = await workspace();
  try {
    const before = await fingerprint(root);
    const result = await rehearseCommand({ root, command: '/bin/sh', args: ['-c', 'echo more >> a.txt; rm b.txt; echo new > new.txt; rm -r d; mkdir d; echo z > d/z.txt; chmod +x run.sh; ln -sf b.txt link; mkdir -p g/h && echo q > g/h/q.txt'] });
    assert.equal(result.status, 'ok', result.stderr);
    assert.deepEqual(result.changes.created, ['d/z.txt', 'g/h/q.txt', 'new.txt']);
    assert.deepEqual(result.changes.modified, ['a.txt', 'link', 'run.sh']);
    assert.deepEqual(result.changes.deleted, ['b.txt', 'd/c.txt', 'd/e/f.txt']);
    assert.equal(await fingerprint(root), before, 'the real workspace changed during the rehearsal');
    const text = formatRehearsal(result);
    assert.match(text, /would create \(3\): d\/z\.txt, g\/h\/q\.txt, new\.txt/);
    assert.match(text, /would delete \(3\)/);
    await disposeRehearsal(result);
    assert.equal(result.keep, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the rehearsal has no network, no host sockets and a read-only system', { skip }, async () => {
  const root = await workspace();
  const outside = path.join(os.homedir(), '.oasis-rehearsal-outside-' + process.pid);
  try {
    const script = [
      // Under the test runner HOME may sit in /tmp, which is a throwaway tmpfs in the rehearsal:
      // what matters is that the host file never appears.
      'echo x > ' + JSON.stringify(outside) + ' 2>/dev/null',
      'touch /usr/oasis-rehearsal-probe 2>/dev/null && echo usr-writable',
      'ls /run 2>/dev/null | wc -l | tr -d " " | sed "s/^/run:/"',
      process.execPath + ' -e "require(\'net\').connect(80, \'1.1.1.1\').on(\'error\', (e) => console.log(\'net:\' + e.code)).on(\'connect\', () => { console.log(\'net:open\'); process.exit(0); })"',
      'echo $OASIS_REHEARSAL'
    ].join('; ');
    const result = await rehearseCommand({ root, command: '/bin/sh', args: ['-c', script] });
    assert.doesNotMatch(result.stdout, /usr-writable/);
    assert.match(result.stdout, /run:0/);
    assert.match(result.stdout, /net:(ENETUNREACH|EAI_AGAIN|ECONNREFUSED|EACCES)/);
    assert.match(result.stdout, /^1$/m);
    await assert.rejects(lstat(outside));
    await disposeRehearsal(result);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { force: true }); }
});

test('applying a rehearsal lands exactly what it showed, and refuses after the workspace moved', { skip }, async () => {
  const root = await workspace();
  const twin = await workspace();
  try {
    const line = 'echo more >> a.txt; rm b.txt; echo new > new.txt; rm -r d; mkdir d; echo z > d/z.txt; chmod +x run.sh; ln -sf b.txt link';
    const result = await rehearseCommand({ root, command: '/bin/sh', args: ['-c', line] });
    const applied = await applyRehearsal(result);
    assert.equal(applied.applied, true, applied.message);
    execFileSync('/bin/sh', ['-c', line], { cwd: twin });
    assert.equal(await fingerprint(root), await fingerprint(twin), 'applying differs from running the command');

    const second = await rehearseCommand({ root, command: '/bin/sh', args: ['-c', 'echo again >> a.txt'] });
    await writeFile(path.join(root, 'a.txt'), 'someone else\n');
    const refused = await applyRehearsal(second);
    assert.equal(refused.applied, false);
    assert.deepEqual(refused.conflicts, ['a.txt']);
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'someone else\n');
    await disposeRehearsal(second);
  } finally { await rm(root, { recursive: true, force: true }); await rm(twin, { recursive: true, force: true }); }
});

test('changes inside .git are counted and not applied unless asked', { skip }, async () => {
  const root = await workspace();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const result = await rehearseCommand({ root, command: '/bin/sh', args: ['-c', 'git add -A && git -c user.email=t@t -c user.name=t commit -qm x'] });
    assert.equal(result.status, 'ok', result.stderr);
    assert.ok(result.git > 0);
    assert.deepEqual([...result.changes.created, ...result.changes.modified, ...result.changes.deleted], []);
    const refused = await applyRehearsal(result);
    assert.equal(refused.applied, false);
    assert.match(refused.message, /inside \.git/);
    assert.throws(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'ignore' }));
    await disposeRehearsal(result);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('divergence names files the real run changed that the rehearsal did not show', () => {
  const rehearsed = { status: 'ok', changes: { created: ['out.txt'], modified: [], deleted: [] } };
  assert.equal(rehearsalDivergence(rehearsed, { modified: ['out.txt'] }), null);
  assert.equal(rehearsalDivergence(rehearsed, { modified: ['out.txt', '.git/index'] }), null);
  const diverged = rehearsalDivergence(rehearsed, { modified: ['out.txt', 'stamp'] });
  assert.deepEqual(diverged.unrehearsed, ['stamp']);
  assert.match(diverged.note, /did not: stamp/);
  assert.deepEqual(summaryDivergence({ status: 'ok', created: ['out.txt'], modified: [], deleted: [] }, ['out.txt', 'x']).unrehearsed, ['x']);
});

test('run_command shows the rehearsal in its approval prompt', { skip }, async () => {
  const root = await workspace();
  try {
    const prompts = [];
    const env = { ...process.env, OASIS_REHEARSE: '1' };
    const declined = await runWorkspaceCommand(root, 'sed', ['-i', 's/alpha/ALPHA/', 'a.txt'], { env, approval: async (text) => { prompts.push(text); return false; } });
    assert.equal(declined.approved, false);
    assert.match(prompts[0], /Rehearsal \(network off, nothing kept\): exit 0/);
    assert.match(prompts[0], /would modify \(1\): a\.txt/);
    assert.deepEqual(declined.rehearsal.modified, ['a.txt']);
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'alpha\n');

    const sink = {};
    const ran = await runWorkspaceCommand(root, 'sed', ['-i', 's/alpha/ALPHA/', 'a.txt'], { env, rehearsalSink: sink, approval: async () => true });
    assert.equal(ran.exitCode, 0);
    assert.deepEqual(sink.summary.modified, ['a.txt']);
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'ALPHA\n');

    const quiet = [];
    await runWorkspaceCommand(root, 'sed', ['-i', 's/beta/BETA/', 'b.txt'], { env: { ...process.env, OASIS_REHEARSE: '0' }, approval: async (text) => { quiet.push(text); return false; } });
    assert.doesNotMatch(quiet[0], /Rehearsal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rehearsal is skipped for prompt-injection holds and remote sandboxes', async () => {
  const env = { OASIS_REHEARSE: '1' };
  assert.deepEqual(await rehearseForApproval({ root: os.tmpdir(), command: 'true', env, injectionHold: 'untrusted content' }), { text: '', summary: null });
  assert.deepEqual(await rehearseForApproval({ root: os.tmpdir(), command: 'true', env, sandbox: { available: true, kind: 'ssh' } }), { text: '', summary: null });
});

test('the home directory and the file system root are never rehearsed', { skip }, async () => {
  assert.equal((await rehearseCommand({ root: os.homedir(), command: 'true' })).status, 'unavailable');
  assert.equal((await rehearseCommand({ root: '/', command: 'true' })).status, 'unavailable');
});

test('a command that runs too long is stopped and reported', { skip }, async () => {
  const root = await workspace();
  try {
    const result = await rehearseCommand({ root, command: '/bin/sh', args: ['-c', 'echo early > early.txt; sleep 30'], timeoutMs: 1000 });
    assert.equal(result.status, 'timeout');
    assert.deepEqual(result.changes.created, ['early.txt']);
    assert.match(formatRehearsal(result), /did not finish/);
    await disposeRehearsal(result);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unapproved rehearsal cannot read credential folders or secret variables into file names', { skip }, async (t) => {
  const root = await workspace();
  const home = await mkdtemp(path.join(os.homedir(), '.oasis-rehearsal-home-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  await mkdir(path.join(home, '.aws'));
  await writeFile(path.join(home, '.aws', 'credentials'), 'TOPSECRETAWSVALUE\n');
  await writeFile(path.join(home, '.netrc'), 'machine x password NETRCSECRET\n');
  const line = 'touch "x$(rev < "$HOME/.aws/credentials")" "y$(rev < "$HOME/.netrc" | tr -cd A-Z)" "z$(printenv GITHUB_TOKEN | rev)" ok';
  const result = await rehearseForApproval({ root, line, env: { ...process.env, HOME: home, GITHUB_TOKEN: 'tokenvalueABCDEF', OASIS_REHEARSE: '1' } });
  assert.ok(result.summary, JSON.stringify(result));
  const names = result.summary.created.join(' ');
  assert.match(names, /\bok\b/, 'the rehearsal itself still ran');
  assert.doesNotMatch(names, /EULAVSWATERCESPOT|TERCESCRTEN|FEDCBAeulavnekot/);
  assert.deepEqual(result.summary.created.sort(), ['ok', 'x', 'y', 'z']);
});

test('a declined command says it only ran as a rehearsal', { skip }, async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runWorkspaceCommand(root, 'touch', ['new.txt'], { approval: async () => false, env: { ...process.env, OASIS_REHEARSE: '1' }, readOnlyCommands: false });
  assert.equal(result.approved, false);
  assert.deepEqual(result.rehearsal && result.rehearsal.created, ['new.txt']);
  assert.match(result.message, /only ran as a rehearsal/);
  assert.doesNotMatch(result.message, /No process was started/);
});

test('an approval rehearsal also hides the active sandbox\'s own masks (denyRead)', { skip }, async (t) => {
  const root = await workspace();
  // Outside /tmp: the rehearsal's fresh /tmp would hide it anyway.
  const secrets = await mkdtemp(path.join(process.cwd(), '.rehearsal-secret-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(secrets, { recursive: true, force: true })]));
  await writeFile(path.join(secrets, 'id'), 'hunter2');
  const line = 'touch "s-$(cat ' + JSON.stringify(path.join(secrets, 'id')) + ' 2>/dev/null)"';
  const open = await rehearseCommand({ root, command: '/bin/sh', args: ['-c', line] });
  await disposeRehearsal(open);
  assert.deepEqual(open.changes.created, ['s-hunter2'], 'control: not a default credential path');
  const sandbox = { available: true, kind: 'bubblewrap', maskedPaths: [{ path: secrets, type: 'directory' }] };
  const shown = await rehearseForApproval({ root, line, settings: {}, sandbox });
  assert.deepEqual(shown.summary.created, ['s-'], 'rehearsal is on by default under bubblewrap and honors its masks');
});

async function script(root, name, body) {
  await writeFile(path.join(root, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  return './' + name;
}
const rehearsalDirs = async () => (await readdir(os.tmpdir())).filter((name) => name.startsWith('oasis-rehearsal-')).length;

test('"apply the rehearsal" lands exactly the rehearsed changes without a second run', { skip }, async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const count = await script(root, 'count.sh', 'echo run >> count.txt');
  const before = await rehearsalDirs();
  let offered = null;
  const result = await runWorkspaceCommand(root, count, [], {
    env: { ...process.env, OASIS_REHEARSE: '1' }, readOnlyCommands: false,
    approval: async (text, high, extra) => { offered = extra; extra.choice.value = 'rehearsal'; return true; }
  });
  assert.equal(offered.rehearsal.offer, true);
  assert.equal(result.appliedRehearsal, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.rehearsal.created, ['count.txt']);
  assert.equal(await readFile(path.join(root, 'count.txt'), 'utf8'), 'run\n', 'ran once (in the rehearsal), not twice');
  assert.equal(await rehearsalDirs(), before, 'the kept rehearsal is cleaned up');
});

test('a plain yes still runs the command for real and discards the kept rehearsal', { skip }, async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const count = await script(root, 'count.sh', 'echo run >> count.txt');
  const before = await rehearsalDirs();
  const result = await runWorkspaceCommand(root, count, [], { env: { ...process.env, OASIS_REHEARSE: '1' }, readOnlyCommands: false, approval: async () => true });
  assert.equal(result.appliedRehearsal, undefined);
  assert.equal(await readFile(path.join(root, 'count.txt'), 'utf8'), 'run\n');
  assert.equal(await rehearsalDirs(), before);
});

test('applying a rehearsal refuses when its files moved meanwhile, and runs nothing', { skip }, async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const more = await script(root, 'more.sh', 'echo more >> a.txt');
  const result = await runWorkspaceCommand(root, more, [], {
    env: { ...process.env, OASIS_REHEARSE: '1' }, readOnlyCommands: false,
    approval: async (text, high, extra) => { await writeFile(path.join(root, 'a.txt'), 'edited meanwhile\n'); extra.choice.value = 'rehearsal'; return true; }
  });
  assert.match(result.error, /changed since the rehearsal: a\.txt[\s\S]*not run/);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'edited meanwhile\n');
});

test('apply is not offered for a failing rehearsal, a no-op or a high-risk command', { skip }, async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const offers = [];
  const options = { env: { ...process.env, OASIS_REHEARSE: '1' }, readOnlyCommands: false, approval: async (text, high, extra) => { offers.push(extra); return false; } };
  await runWorkspaceCommand(root, await script(root, 'fail.sh', 'echo x > out.txt; exit 3'), [], options);
  await runWorkspaceCommand(root, await script(root, 'noop.sh', 'true'), [], options);
  await runWorkspaceCommand(root, 'python3', ['-c', 'open("p.txt","w").write("x")'], options);
  assert.deepEqual(offers, [null, null, null]);
});

test('the agent turns an "apply the rehearsal" answer into a single landed change', { skip }, async (t) => {
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_REHEARSE: '1', OASIS_CONFIG_DIR: path.join(root, '.cfg') };
  const count = await script(root, 'count.sh', 'echo run >> count.txt');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: count, args: [] }), { content: 'done' }]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const metas = [];
  await runAgentTurn(session, 'count', { env, approval: async (text, force, meta) => { metas.push(meta); return meta && meta.rehearsal && meta.rehearsal.offer ? 'rehearsal' : false; } });
  assert.equal(metas.length, 1, JSON.stringify(requests[1] && requests[1].messages.filter((m) => m.role === 'tool')));
  assert.equal(await readFile(path.join(root, 'count.txt'), 'utf8'), 'run\n');
  const tool = requests[1].messages.find((message) => message.role === 'tool');
  assert.match(tool.content, /"appliedRehearsal":true/);
  assert.match(tool.content, /not run a second time/);
});

test('run_shell offers and applies the rehearsal the same way', { skip }, async (t) => {
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_REHEARSE: '1', OASIS_CONFIG_DIR: path.join(root, '.cfg') };
  const { config, requests } = await scriptedModel(t, [toolCall('s1', 'run_shell', { command: 'echo run >> count.txt && echo two >> other.txt' }), { content: 'done' }]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'count', { env, approval: async (text, force, meta) => meta && meta.rehearsal && meta.rehearsal.offer ? 'rehearsal' : false });
  const tool = requests[1].messages.find((message) => message.role === 'tool');
  assert.match(tool.content, /"appliedRehearsal":true/, tool.content);
  assert.equal(await readFile(path.join(root, 'count.txt'), 'utf8'), 'run\n');
  assert.equal(await readFile(path.join(root, 'other.txt'), 'utf8'), 'two\n');
});

test('edits made while the approval prompt is open are not credited to the command', async (t) => {
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: root });
  const env = { ...process.env, OASIS_REHEARSE: '0', OASIS_CONFIG_DIR: path.join(os.tmpdir(), 'oasis-rebase-cfg-' + process.pid) };
  t.after(() => rm(env.OASIS_CONFIG_DIR, { recursive: true, force: true }));
  const make = await script(root, 'make-b.sh', 'echo built > built.txt');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: make, args: [] }), { content: 'done' }]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'build', { env, approval: async () => { await writeFile(path.join(root, 'a.txt'), 'edited by a person meanwhile\n'); return true; } });
  const tool = JSON.parse(requests[1].messages.find((message) => message.role === 'tool').content);
  assert.ok(tool.effects, JSON.stringify(tool));
  assert.deepEqual(tool.effects.files, ['built.txt (added)']);
});

test('the app approval card can apply the rehearsal through the web server', { skip }, async (t) => {
  const { startOasisWebServer } = await import('../src/web.mjs');
  const { saveConfig } = await import('../src/config.mjs');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await workspace();
  const env = { ...process.env, OASIS_REHEARSE: '1', OASIS_CONFIG_DIR: path.join(root, '.cfg') };
  const count = await script(root, 'count.sh', 'echo run >> count.txt');
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: count, args: [] }), { content: 'done' }]);
  await saveConfig(config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const job = await (await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'count' }) })).json();
  const poll = async (predicate) => {
    for (const deadline = Date.now() + 15000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 25))) {
      const snapshot = await (await fetch(base + '/api/jobs/' + job.jobId + '?after=0', { headers })).json();
      if (predicate(snapshot)) return snapshot;
    }
    throw new Error('timed out');
  };
  let snapshot = await poll((s) => s.events.some((e) => e.type === 'approval_required') || ['completed', 'error'].includes(s.status));
  const asked = snapshot.events.find((e) => e.type === 'approval_required');
  assert.ok(asked, JSON.stringify(snapshot.events.map((e) => e.type)));
  assert.equal(asked.data.rehearsal, true, 'the card is told it can offer "Apply rehearsal"');
  assert.match(asked.data.prompt, /Rehearsal \(network off, nothing kept\).*\nWould create \(1\): count\.txt/s, 'the card shows what the rehearsal changed');
  const answer = await (await fetch(base + '/api/jobs/' + job.jobId + '/approval', { method: 'POST', headers, body: JSON.stringify({ approvalId: asked.data.approvalId, approved: true, rehearsal: true }) })).json();
  assert.equal(answer.rehearsal, true);
  snapshot = await poll((s) => ['completed', 'error'].includes(s.status));
  assert.equal(snapshot.status, 'completed', snapshot.error);
  assert.equal(snapshot.events.find((e) => e.type === 'approval_resolved').data.rehearsal, true);
  assert.equal(await readFile(path.join(root, 'count.txt'), 'utf8'), 'run\n', 'landed once, not run a second time');
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /"appliedRehearsal":true/);
});

test('the web server ignores a rehearsal answer when none was offered', async (t) => {
  const { startOasisWebServer } = await import('../src/web.mjs');
  const { saveConfig } = await import('../src/config.mjs');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-norehearse-'));
  const env = { ...process.env, OASIS_REHEARSE: '0', OASIS_CONFIG_DIR: path.join(root, '.cfg') };
  const { config } = await scriptedModel(t, [toolCall('c1', 'run_command', { command: process.execPath, args: ['-e', 'require("fs").appendFileSync("ran.txt","x")'] }), { content: 'done' }]);
  await saveConfig(config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const job = await (await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'go' }) })).json();
  let snapshot;
  for (const deadline = Date.now() + 10000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 25))) {
    snapshot = await (await fetch(base + '/api/jobs/' + job.jobId + '?after=0', { headers })).json();
    if (snapshot.events.some((e) => e.type === 'approval_required')) break;
  }
  const asked = snapshot.events.find((e) => e.type === 'approval_required');
  assert.equal(asked.data.rehearsal, undefined);
  const answer = await (await fetch(base + '/api/jobs/' + job.jobId + '/approval', { method: 'POST', headers, body: JSON.stringify({ approvalId: asked.data.approvalId, approved: true, rehearsal: true }) })).json();
  assert.equal(answer.rehearsal, undefined, 'falls back to a plain yes');
  for (const deadline = Date.now() + 10000; Date.now() < deadline && !['completed', 'error'].includes(snapshot.status); await new Promise((resolve) => setTimeout(resolve, 25))) snapshot = await (await fetch(base + '/api/jobs/' + job.jobId + '?after=0', { headers })).json();
  assert.equal(snapshot.status, 'completed', snapshot.error);
  assert.equal(await readFile(path.join(root, 'ran.txt'), 'utf8'), 'x', 'the command ran for real');
});
