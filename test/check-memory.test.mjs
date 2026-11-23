import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { divergenceNote, knownChecksNote, recordCheck, rememberable, storePath, workspaceFingerprint } from '../src/check-memory.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function repo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-checkmem-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  await writeFile(path.join(root, '.gitignore'), '.flag\nnode_modules/\n');
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-checkmem-config-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  return { root, git, env: { ...process.env, OASIS_CONFIG_DIR: config, OASIS_HOME: config } };
}

const check = (passed, extra = {}) => ({ kind: 'check', command: 'npm test', checkKind: 'test', finished: true, passed, exitCode: passed ? 0 : 1, ...extra });

test('the fingerprint follows tracked and untracked content, not ignored files', async (t) => {
  const { root } = await repo(t);
  const clean = await workspaceFingerprint(root);
  assert.ok(clean && clean.dirty === 0);
  await writeFile(path.join(root, '.flag'), 'x');
  assert.equal((await workspaceFingerprint(root)).id, clean.id, 'ignored files do not count');
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  const edited = await workspaceFingerprint(root);
  assert.notEqual(edited.id, clean.id);
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  assert.equal((await workspaceFingerprint(root)).id, clean.id, 'undoing the edit restores it');
  await writeFile(path.join(root, 'new.txt'), 'n');
  assert.notEqual((await workspaceFingerprint(root)).id, clean.id, 'untracked files count');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-checkmem-nogit-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  assert.equal(await workspaceFingerprint(outside), null);
});

test('only finished, whole, unmasked checks that changed nothing are remembered', () => {
  assert.equal(rememberable(check(true)), true);
  for (const extra of [{ masked: true }, { filtered: true }, { noTests: true }, { finished: false }, { changed: ['a.txt'] }]) assert.equal(rememberable(check(true, extra)), false, JSON.stringify(extra));
  assert.equal(rememberable({ ...check(true), passed: null }), false);
});

test('results on the same files are offered to a later session; an edit makes them stale', async (t) => {
  const { root, env } = await repo(t);
  const first = await recordCheck(root, check(true, { command: 'API_TOKEN=ghp_' + 'a'.repeat(36) + ' npm test' }), { env, sessionId: 's1', now: 1000 });
  assert.equal(first.divergence, null);
  const stored = await readFile(storePath(first.fingerprint.top, env), 'utf8');
  assert.doesNotMatch(stored, /ghp_a{36}/, 'secrets are redacted');
  assert.equal(await knownChecksNote(root, { env, sessionId: 's1' }), '', 'not repeated to the session that ran it');
  const note = await knownChecksNote(root, { env, sessionId: 's2', now: 1000 + 3 * 3600_000 });
  assert.match(note, /already ran on exactly the current files/);
  assert.match(note, /npm test`: passed, 3 hours ago/);
  await writeFile(path.join(root, 'a.txt'), 'changed\n');
  assert.equal(await knownChecksNote(root, { env, sessionId: 's2' }), '');
  assert.equal(await knownChecksNote(root, { env, sessionId: 's2', settings: { checkMemory: false } }), '');
});

test('a different outcome on the same files is reported as not the files\u2019 doing', async (t) => {
  const { root, env } = await repo(t);
  await recordCheck(root, check(true), { env, sessionId: 's1', now: 0 });
  const again = await recordCheck(root, check(true), { env, sessionId: 's2', now: 1 });
  assert.equal(again.divergence, null, 'the same outcome is not a divergence');
  const later = await recordCheck(root, check(false), { env, sessionId: 's2', now: 120_000 });
  assert.equal(later.divergence.passed, true);
  assert.match(divergenceNote(check(false), later.divergence, 120_000), /passed on exactly these files 2 minutes ago.*now failed.*flaky, or it depends on something outside them/);
  assert.match(await knownChecksNote(root, { env, sessionId: 's3' }), /different results on these files \(2 passed, 1 failed\); last failed \(exit 1\)/);
  assert.equal(await recordCheck(root, check(true), { env: { ...env, OASIS_CHECK_MEMORY: '0' } }), null);
});

test('end to end: a later session is told the result, and a flip on the same files is flagged', async (t) => {
  const { root, env: base, git } = await repo(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node check.cjs' } }));
  await writeFile(path.join(root, 'check.cjs'), "if (require('fs').existsSync('.flag')) { console.error('broken by .flag'); process.exit(1); } console.log('ok');\n");
  git('add', '-A');
  git('commit', '-qm', 'check');
  const env = { ...base, OASIS_AGENT_EXPERIENCE: '0', OASIS_NEURON_LEDGER: '0' };
  const seen = [];
  const run = async (prompt) => {
    const { config } = await scriptedModel(t, [(payload) => {
      const tools = payload.messages.filter((message) => message.role === 'tool');
      if (tools.length === 0) { seen.push(payload.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')); return toolCall('c' + seen.length, 'run_command', { command: 'npm', args: ['test'] }); }
      seen.push(tools[0].content);
      return { content: 'done' };
    }]);
    const session = await createSession({ root, env, config });
    try { await runAgentTurn(session, prompt, { autoApprove: true, permissionMode: 'bypassPermissions', env }); } finally { await closeSession(session); }
  };
  await run('run the tests');
  assert.doesNotMatch(seen[0], /check memory/, 'nothing known yet');
  assert.doesNotMatch(seen[1], /check memory/);
  await writeFile(path.join(root, '.flag'), 'x');
  await run('run the tests again');
  assert.match(seen[2], /\[OASIS check memory\][\s\S]*`npm test`: passed/, 'the second session is told');
  assert.match(seen[3], /broken by \.flag/);
  assert.match(seen[3], /passed on exactly these files .*now failed/, 'the flip is flagged');
});
