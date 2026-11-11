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

test('Gemini CLI TOML commands: namespaces, {{args}}, !{shell} with escaping, @{file} and the appended command line', async (t) => {
  const { root, home, env } = await setup(t, {
    '.gemini/commands/git/fix.toml': 'description = "Generates a fix"\nprompt = "Fix this issue: {{args}}."\n',
    '.gemini/commands/changelog.toml': 'prompt = """\n# Update the changelog\nParse the version.\n"""\n',
    '.gemini/commands/grep-code.toml': 'prompt = """\nPattern `{{args}}`:\n!{printf \'%s|\' {{args}}; echo \'{"json": {"ok": true}}\'}\n!{echo oops >&2; exit 3}\n"""\n',
    '.gemini/commands/review.toml': 'prompt = "Review using:\\n@{docs/guide.md}\\nAll docs:\\n@{docs}\\nSecret:@{.env}"\n',
    '.gemini/commands/broken.toml': 'description = "no prompt"\n',
    'docs/guide.md': 'GUIDE-BODY {{args}} !{echo injected}',
    'docs/more/extra.md': 'EXTRA-BODY',
    '.env': 'TOKEN=1',
    '~/.gemini/commands/test.toml': 'prompt = "USER-TEST {{args}}"\n',
    '~/.gemini/commands/changelog.toml': 'prompt = "USER-CHANGELOG"\n'
  });
  const commands = await loadCustomCommands(root, { env, home });
  for (const name of ['git:fix', 'changelog', 'grep-code', 'review', 'test']) assert.ok(commands.has(name), name);
  assert.equal(commands.has('broken'), false);
  assert.equal(commands.get('git:fix').description, 'Generates a fix (Gemini CLI)');
  assert.equal(commands.get('changelog').description, 'Update the changelog (Gemini CLI)');
  // Project commands override user commands with the same name, as in Gemini CLI.
  assert.match(commands.get('changelog').body, /Parse the version/);

  const fix = await resolveCustomCommand(root, '/git:fix "Button is misaligned"', { env, home, commands });
  assert.equal(fix.prompt, 'Fix this issue: "Button is misaligned".');
  const changelog = await resolveCustomCommand(root, '/changelog 1.2.0 added "x"', { env, home, commands });
  assert.match(changelog.prompt, /Parse the version\.\n\n\/changelog 1\.2\.0 added "x"$/);
  const bare = await resolveCustomCommand(root, '/changelog', { env, home, commands });
  assert.equal(bare.prompt.includes('/changelog'), false);

  // Untrusted project: shell blocks are skipped, never run.
  const untrusted = await resolveCustomCommand(root, "/grep-code It's x", { env, home, commands });
  assert.match(untrusted.prompt, /\[skipped !\{printf/);
  assert.equal(untrusted.shell.every((item) => item.skipped), true);
  if (process.platform !== 'win32') {
    const trusted = await resolveCustomCommand(root, "/grep-code It's x; rm -rf /", { env, home, commands, trusted: true });
    assert.match(trusted.prompt, /Pattern `It's x; rm -rf \/`:/);
    assert.match(trusted.prompt, /It's x; rm -rf \/\|\{"json": \{"ok": true\}\}/);
    assert.match(trusted.prompt, /oops\n\[Shell command exited with code 3\]/);
    const denied = await resolveCustomCommand(root, '/grep-code a', { env, home, commands, trusted: true, policy: { evaluate: () => ({ decision: 'deny', rule: 'Bash(*)' }) } });
    assert.match(denied.prompt, /blocked by permission rule Bash\(\*\)/);
  }

  const review = await resolveCustomCommand(root, '/review FileLoader.ts', { env, home, commands, trusted: true });
  // Injected file content is not expanded again; .env is never read.
  assert.match(review.prompt, /GUIDE-BODY \{\{args\}\} !\{echo injected\}/);
  assert.match(review.prompt, /--- docs\/more\/extra\.md ---\nEXTRA-BODY/);
  assert.doesNotMatch(review.prompt, /TOKEN=1/);
  assert.match(review.prompt, /\n\n\/review FileLoader\.ts$/);
  assert.ok(review.mentions.includes(path.join('docs', 'guide.md')));

  const user = await resolveCustomCommand(root, '/test abc', { env, home, commands });
  assert.equal(user.prompt, 'USER-TEST abc');
});
