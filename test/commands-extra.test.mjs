import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolveCustomCommand, commandOptions, expandInlineShell } from '../src/commands.mjs';
import { PermissionPolicy } from '../src/permissions.mjs';
import { createSession, runAgentTurn, runForkedTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-cmdx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const node = JSON.stringify(process.execPath);

test('front matter options: allowed-tools, effort, context fork, agent', () => {
  assert.deepEqual(commandOptions({ 'allowed-tools': 'Bash(git status:*), Bash(git diff:*), Read', effort: 'HIGH', context: 'fork', agent: 'Explore' }), {
    allowedTools: ['Bash(git status:*)', 'Bash(git diff:*)', 'Read'], effort: 'high', context: 'fork', agent: 'Explore'
  });
  assert.deepEqual(commandOptions({ effort: 'ultra' }), { allowedTools: null, effort: null, context: null, agent: null });
});

test('!`cmd` runs in trusted workspaces and is skipped otherwise', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  await mkdir(path.join(root, '.oasis', 'commands'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'commands', 'status.md'), '---\ndescription: show status\neffort: low\n---\nCurrent output:\n!`' + node + ' -e "console.log(40+2)"`\nNow summarize $ARGUMENTS.');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const trusted = await resolveCustomCommand(root, '/status quickly', { env, home, trusted: true });
  assert.match(trusted.prompt, /Current output:\n42\nNow summarize quickly\./);
  assert.equal(trusted.shell[0].code, 0);
  assert.equal(trusted.command.effort, 'low');
  const untrusted = await resolveCustomCommand(root, '/status', { env, home, trusted: false });
  assert.match(untrusted.prompt, /\[skipped !`.*`: project commands run shell only in trusted workspaces/);
  assert.doesNotMatch(untrusted.prompt, /\n42\n/);
  assert.equal(untrusted.grantTools, null);
});

test('allowed-tools Bash rules and deny rules gate inline shell', async (t) => {
  const root = await tmp(t);
  const allowedTools = ['Bash(echo:*)'];
  const allowed = await expandInlineShell('a !`echo hi` b !`printf nope`', { root, allowed: true, allowedTools });
  assert.equal(allowed.text, 'a hi b [skipped !`printf nope`: not covered by the allowed-tools Bash rules]');
  const policy = new PermissionPolicy({ permissions: { allow: [], ask: [], deny: ['Bash(echo:*)'], defaultMode: 'default' } });
  const denied = await expandInlineShell('!`echo hi`', { root, allowed: true, policy });
  assert.match(denied.text, /skipped !`echo hi`: blocked by permission rule Bash\(echo:\*\)/);
  const failing = await expandInlineShell('!`exit 3`', { root, allowed: true });
  assert.match(failing.text, /\(exit 3\)/);
});

test('skills with context: fork run in a subagent and return a report', async (t) => {
  const root = await tmp(t);
  await mkdir(path.join(root, '.oasis', 'skills', 'audit'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'skills', 'audit', 'SKILL.md'), '---\nname: audit\ndescription: Audit dependencies\ncontext: fork\nagent: Explore\n---\nAudit the dependencies for: $ARGUMENTS\nReport findings only.');
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'load_skill', { name: 'audit', arguments: 'license problems' }),
    { content: 'No license problems found.' },
    { content: 'The audit is clean.' }
  ]);
  const session = await createSession({ root, config, settings });
  const result = await runAgentTurn(session, 'audit deps', { autoApprove: true });
  assert.equal(result.text, 'The audit is clean.');
  assert.match(requests[1].messages.at(-1).content, /Audit the dependencies for: license problems\nReport findings only\./);
  const toolMessage = JSON.parse(requests[2].messages.find((m) => m.role === 'tool').content);
  assert.equal(toolMessage.context, 'fork');
  assert.equal(toolMessage.agent, 'explore');
  assert.equal(toolMessage.report, 'No license problems found.');
  assert.equal(toolMessage.content, undefined, 'the skill body stays out of the main context');
  closeSession(session);
});

test('runForkedTurn runs a prompt in a subagent and records the exchange', async (t) => {
  const root = await tmp(t);
  const { config } = await scriptedModel(t, [{ content: 'forked report' }]);
  const session = await createSession({ root, config, settings });
  let shown = '';
  const result = await runForkedTurn(session, 'Investigate the build.', { label: '/investigate', autoApprove: true, onText: (text) => { shown = text; } });
  assert.equal(result.text, 'forked report');
  assert.equal(shown, 'forked report');
  assert.match(session.messages.at(-2).content, /I ran \/investigate in a forked general-purpose subagent/);
  assert.equal(session.messages.at(-1).content, 'forked report');
  closeSession(session);
});

test('oasis -p "/command args" and "/skill args" expand before running', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  await mkdir(path.join(root, '.oasis', 'commands'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'commands', 'greet.md'), 'Say hello to $1. !`echo inline`');
  await mkdir(path.join(root, '.oasis', 'skills', 'haiku'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'skills', 'haiku', 'SKILL.md'), '---\nname: haiku\ndescription: Write a haiku\n---\nWrite a 5-7-5 haiku.');
  const run = async (prompt) => {
    const { config, requests } = await scriptedModel(t, [{ content: 'ok' }]);
    const child = spawn(process.execPath, [CLI, '-C', root, '-p', prompt], { env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, err);
    return { user: requests[0].messages.filter((m) => m.role === 'user').at(-1).content, err };
  };
  const greet = await run('/greet Ada');
  assert.match(greet.user, /Say hello to Ada\. \[skipped !`echo inline`/);
  assert.match(greet.err, /Skipped !`echo inline`/);
  const haiku = await run('/haiku about rain');
  assert.match(haiku.user, /Use the "haiku" skill[\s\S]*Write a 5-7-5 haiku\.[\s\S]*Request: about rain/);
});
