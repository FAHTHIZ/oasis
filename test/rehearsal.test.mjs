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

test('rehearsal is off unless asked for', () => {
  assert.equal(rehearsalEnabled({}), false);
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
