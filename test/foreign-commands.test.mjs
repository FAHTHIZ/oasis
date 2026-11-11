import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCustomCommands, resolveCustomCommand } from '../src/commands.mjs';

async function setup(t, files, { git = true } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-foreign-cmd-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const root = path.join(repo, 'packages', 'app');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  if (git) await mkdir(path.join(repo, '.git'));
  for (const [rel, text] of Object.entries(files)) {
    const file = rel.startsWith('~/') ? path.join(home, rel.slice(2)) : rel.startsWith('^/') ? path.join(repo, rel.slice(2)) : path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis'), OASIS_OTHER_AGENT_RULES: '' };
  return { base, repo, root, home, env };
}

test('Cursor, Devin Desktop, Windsurf, Antigravity and Cline command folders become slash commands', async (t) => {
  const { root, home, env } = await setup(t, {
    '.cursor/commands/review.md': '# Review the diff\nReview the staged changes.',
    '~/.cursor/commands/standup.md': 'Write my standup.',
    '.devin/workflows/deploy.md': '---\ndescription: Deploy the service\n---\n1. Build\n2. Call /smoke-test',
    '.windsurf/workflows/smoke-test.md': '---\ndescription: Smoke test\n---\nRun the smoke tests. Then call /notify.',
    '^/.windsurf/workflows/notify.md': 'Post a message in the release channel.',
    '.agents/workflows/startcycle.md': '---\ndescription: Start the pipeline\n---\nAct as the PM.',
    '~/.gemini/config/workflows/agy-global.md': 'ANTIGRAVITY-GLOBAL',
    '~/.codeium/windsurf/global_workflows/address-pr-comments.md': 'Check out the PR branch.',
    '.clinerules/workflows/release.md': 'Cline release steps.'
  });
  const commands = await loadCustomCommands(root, { env, home });
  for (const name of ['review', 'standup', 'deploy', 'smoke-test', 'notify', 'startcycle', 'agy-global', 'address-pr-comments', 'release']) assert.ok(commands.has(name), name);
  assert.equal(commands.get('review').description, 'Review the diff (Cursor)');
  assert.equal(commands.get('deploy').description, 'Deploy the service (Devin Desktop)');
  assert.equal(commands.get('startcycle').foreign, 'Antigravity');
  // A workflow that calls other workflows gets them appended once each.
  const deploy = await resolveCustomCommand(root, '/deploy to staging', { env, home });
  assert.match(deploy.prompt, /^Follow the Devin Desktop workflow \/deploy step by step\./);
  assert.match(deploy.prompt, /--- Workflow \/smoke-test \(called above\) ---\nRun the smoke tests/);
  assert.match(deploy.prompt, /--- Workflow \/notify \(called above\) ---\nPost a message/);
  assert.match(deploy.prompt, /Arguments: to staging$/);
  const review = await resolveCustomCommand(root, '/review', { env, home });
  assert.equal(review.prompt, '# Review the diff\nReview the staged changes.');
});

test('native OASIS and Claude commands win, and .devin beats .windsurf', async (t) => {
  const { root, home, env } = await setup(t, {
    '.cursor/commands/review.md': 'CURSOR',
    '.claude/commands/review.md': 'CLAUDE',
    '.windsurf/workflows/ship.md': 'WINDSURF',
    '.devin/workflows/ship.md': 'DEVIN'
  });
  const commands = await loadCustomCommands(root, { env, home });
  assert.equal(commands.get('review').body, 'CLAUDE');
  assert.equal(commands.get('ship').body, 'DEVIN');
});

test('foreign command files never run inline shell, and symlinks out of the workspace are skipped', async (t) => {
  const { base, root, home, env } = await setup(t, {
    '.cursor/commands/status.md': 'Status: !`echo SHOULD-NOT-RUN`'
  });
  await writeFile(path.join(base, 'outside.md'), 'OUTSIDE');
  await symlink(path.join(base, 'outside.md'), path.join(root, '.cursor', 'commands', 'leak.md'));
  const resolved = await resolveCustomCommand(root, '/status', { env, home, trusted: true });
  assert.equal(resolved.prompt, 'Status: !`echo SHOULD-NOT-RUN`');
  assert.deepEqual(resolved.shell, []);
  assert.ok(!(await loadCustomCommands(root, { env, home })).has('leak'));
});

test('workflows above the workspace are read only up to the git root, and the switch turns them off', async (t) => {
  const { root, home, env } = await setup(t, { '^/.windsurf/workflows/up.md': 'UP' }, { git: false });
  assert.ok(!(await loadCustomCommands(root, { env, home })).has('up'));
  const second = await setup(t, { '.cursor/commands/x.md': 'X', '^/.devin/workflows/up.md': 'UP' });
  assert.ok((await loadCustomCommands(second.root, { env: second.env, home: second.home })).has('up'));
  const off = await loadCustomCommands(second.root, { env: { ...second.env, OASIS_OTHER_AGENT_RULES: '0' }, home: second.home });
  assert.ok(!off.has('x') && !off.has('up'));
});
