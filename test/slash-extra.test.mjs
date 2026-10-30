import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinCommand, BUILTIN_COMMANDS } from '../src/slash.mjs';
import { applyEffort, thinkingBudgetFor, reasoningEffortFor } from '../src/agent.mjs';
import { clipboardCandidates, copyToClipboard } from '../src/clipboard.mjs';
import { loadSession } from '../src/sessions.mjs';
import { PermissionPolicy } from '../src/permissions.mjs';
import { killBackgroundEntry } from '../src/power-tools.mjs';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-slash-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-home-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  const session = {
    root,
    config: { model: 'gpt-5', protocol: 'openai-compatible' },
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'older reply' },
      { role: 'user', content: 'second' }, { role: 'assistant', content: 'latest reply' }
    ],
    permissions: new PermissionPolicy({ permissions: {} }),
    hooks: {}
  };
  return { root, home, env, session, state: { root, session, env, sessionOptions: {} } };
}

test('new commands are listed in /help', async () => {
  for (const name of ['usage', 'undo', 'effort', 'copy', 'fork', 'branch', 'skills', 'config', 'doctor', 'release-notes', 'keys', 'tips']) assert.ok(BUILTIN_COMMANDS[name], name);
  const { state, root, env } = await setup();
  delete env.OASIS_SAFE_MODE;
  await mkdir(path.join(root, '.claude', 'commands'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'commands', 'audit.md'), '# Custom audit\nThis deliberately collides with the built-in /audit command.\n');
  const output = (await runBuiltinCommand('help', '', state)).output;
  const auditLines = output.split('\n').filter((line) => /^  \/audit\s/.test(line));
  assert.equal(auditLines.length, 1, 'A custom command cannot duplicate a built-in help entry');
  assert.match(auditLines[0], /isolated security, performance, test-coverage, and dependency reviewers/);
  assert.match(output, /\/effort/);
  assert.match(output, /Core workflows:/);
  assert.match(output, /Getting started:/);
  assert.match(output, /Working:/);
  assert.match(output, /Safety:/);
  assert.match(output, /Settings:/);
  assert.match(output, /More commands:/);
  const firstGroup = output.split('Core workflows:')[1].split('Getting started:')[0].split('\n').filter((line) => /^  \/[a-z-]+\s/.test(line)).map((line) => line.trim().split(/\s+/)[0]);
  assert.deepEqual(firstGroup, ['/init', '/plan', '/fix', '/diagnose', '/review', '/rollback']);
  assert.match(output, /\/audit\s+Run isolated security/);
  // Check only built-in groups: a custom command may intentionally shadow a
  // built-in name and is displayed separately below the Custom commands heading.
  const builtInHelp = output.split('Custom commands:')[0];
  const listed = builtInHelp.split('\n')
    .filter((line) => /^  \/[a-z-]+\s/.test(line))
    .map((line) => line.trim().split(/\s+/)[0].slice(1))
    .filter((name) => Object.hasOwn(BUILTIN_COMMANDS, name));
  assert.equal(listed.length, Object.keys(BUILTIN_COMMANDS).length, 'Every built-in command should appear in grouped help.');
  assert.equal(new Set(listed).size, Object.keys(BUILTIN_COMMANDS).length, 'Every built-in command should appear once in grouped help.');
});

test('/keys opens the shortcut cheat sheet and /tips gives practical next steps', async () => {
  const { state, env } = await setup();
  const keys = (await runBuiltinCommand('keys', '', state)).output;
  assert.match(keys, /Keyboard shortcuts:/);
  assert.match(keys, /Esc/);

  delete env.OASIS_TIP;
  env.OASIS_NO_TIPS = '0';
  const tips = (await runBuiltinCommand('tips', '', state)).output;
  assert.match(tips, /OASIS tip:/);
  assert.match(tips, /Useful starting points:/);
  assert.match(tips, /\/context/);
});

test('/context separates startup tools and warns when setup is token-heavy', async () => {
  const { state, session } = await setup();
  session.toolDefinitions = [
    { type: 'function', function: { name: 'local_fixture', description: 'x'.repeat(65000) } },
    { type: 'function', function: { name: 'remote_fixture', description: 'remote tool description' } }
  ];
  session.mcpToolMap = new Map([['remote_fixture', {}]]);
  const output = (await runBuiltinCommand('context', '', state)).output;
  assert.match(output, /Startup before chat:/);
  assert.match(output, /Estimated context: \[#+\.+\] \d+% of/);
  assert.match(output, /Built-in tools \(1\)/);
  assert.match(output, /MCP tools \(1\)/);
  assert.match(output, /over 15,000 tokens/);
  assert.match(output, /These are estimates/);
});

test('/effort sets and restores reasoning effort and thinking budget', async () => {
  const { state, session } = await setup();
  assert.match((await runBuiltinCommand('effort', '', state)).output, /Reasoning effort: auto/);
  assert.match((await runBuiltinCommand('effort', 'max', state)).output, /set to max/);
  assert.equal(state.sessionOptions.effort, 'max');
  assert.equal(session.config.reasoningEffort, 'high');
  assert.equal(session.config.thinkingBudget, 63999);
  assert.equal(thinkingBudgetFor('fix it', session.config, {}), 63999);
  assert.equal(reasoningEffortFor('fix it', session.config, {}), 'high');
  await runBuiltinCommand('effort', 'low', state);
  assert.equal(reasoningEffortFor('fix it', session.config, {}), 'low');
  assert.equal(reasoningEffortFor('ultrathink about it', session.config, {}), 'high', 'prompt keywords still raise one turn');
  await runBuiltinCommand('effort', 'auto', state);
  assert.equal(state.sessionOptions.effort, null);
  assert.equal(session.config.reasoningEffort, undefined);
  assert.equal(session.config.thinkingBudget, undefined);
  assert.match((await runBuiltinCommand('effort', 'turbo', state)).output, /Unknown effort/);
  assert.deepEqual(applyEffort({ model: 'x', thinkingBudget: 2048 }, null, { thinkingBudget: 2048 }), { model: 'x', thinkingBudget: 2048 });
});

test('/usage matches /cost and /undo maps to /rewind', async () => {
  const { state } = await setup();
  state.usage = { inputTokens: 3, outputTokens: 4, totalTokens: 7, requests: 1, turns: 1 };
  assert.equal((await runBuiltinCommand('usage', '', state)).output, (await runBuiltinCommand('cost', '', state)).output);
  const undo = await runBuiltinCommand('undo', '', state);
  assert.equal(undo.output, (await runBuiltinCommand('rewind', '1', state)).output);
});

test('/copy pipes the latest or Nth reply to a clipboard program, else OSC 52', async () => {
  const { state, home, env } = await setup();
  const bin = path.join(home, 'bin');
  await mkdir(bin);
  const out = path.join(home, 'clip.txt');
  const script = path.join(bin, process.platform === 'darwin' ? 'pbcopy' : 'xsel');
  await writeFile(script, '#!/bin/sh\n/bin/cat > ' + JSON.stringify(out) + '\n');
  await chmod(script, 0o755);
  state.env = { ...env, PATH: bin, WAYLAND_DISPLAY: '' };
  const copied = await runBuiltinCommand('copy', '', state);
  assert.match(copied.output, /Copied 12 characters/);
  assert.equal(await readFile(out, 'utf8'), 'latest reply');
  await runBuiltinCommand('copy', '2', state);
  assert.equal(await readFile(out, 'utf8'), 'older reply');
  state.env = { ...env, PATH: path.join(home, 'empty') };
  const fallback = await runBuiltinCommand('copy', '', state);
  assert.equal(Buffer.from(fallback.osc52, 'base64').toString('utf8'), 'latest reply');
  assert.match((await runBuiltinCommand('copy', '9', state)).output, /no reply/);
  assert.deepEqual(clipboardCandidates('darwin', {})[0], ['pbcopy', []]);
  assert.equal(clipboardCandidates('linux', { WAYLAND_DISPLAY: 'wayland-0' })[0][0], 'wl-copy');
  assert.equal((await copyToClipboard('x', { env: { OASIS_CLIPBOARD: 'osc52' } })).ok, false);
});

test('/fork saves the original and continues under a new id', async () => {
  const { state, session, env } = await setup();
  session.sessionId = undefined;
  const result = await runBuiltinCommand('fork', '', state);
  assert.ok(result.forked.from && result.forked.to && result.forked.from !== result.forked.to);
  assert.equal(session.sessionId, result.forked.to);
  const original = await loadSession(session.root, result.forked.from, { env });
  assert.equal(original.messages.at(-1).content, 'latest reply');
  assert.match((await runBuiltinCommand('branch', '', state)).output, /Forked/);
});

test('/skills, /config, /doctor and /release-notes report useful information', async () => {
  const { state, root } = await setup();
  assert.match((await runBuiltinCommand('skills', '', state)).output, /code-review \[built-in\]/);
  await mkdir(path.join(root, '.oasis', 'skills', 'deploy'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship the app to production\n---\nSteps.\n');
  assert.match((await runBuiltinCommand('skills', '', state)).output, /deploy \[workspace\]\n\s+Ship the app/);
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
  const config = (await runBuiltinCommand('config', '', state)).output;
  assert.match(config, /settings\.json/);
  assert.match(config, /model\s+gpt-5/);
  assert.match(config, /1 deny rules/);
  const doctor = (await runBuiltinCommand('doctor', '', state)).output;
  assert.match(doctor, /Oasis doctor/);
  assert.match(doctor, /Context: about/);
  assert.match((await runBuiltinCommand('release-notes', '3', state)).output, /Oasis changes|commits\/main/);
});

test('/loop parses intervals and counts', async () => {
  const { parseLoopArgs, formatInterval } = await import('../src/slash.mjs');
  assert.deepEqual(parseLoopArgs('5m x3 check the deploy'), { intervalMs: 300000, times: 3, prompt: 'check the deploy' });
  assert.deepEqual(parseLoopArgs('run tests'), { intervalMs: 600000, times: null, prompt: 'run tests', selfPaced: true });
  assert.match(parseLoopArgs('2s ping').error, /shortest/);
  assert.match(parseLoopArgs('5m').error, /Usage/);
  assert.equal(formatInterval(7200000), '2h');
  assert.equal(formatInterval(45000), '45s');
  const { state } = await setup();
  const handled = await runBuiltinCommand('loop', '30s /review', state);
  assert.equal(handled.loop.prompt, '/review');
  assert.match(handled.output, /every 30s/);
});

test('/cd validates the target and /sandbox toggles the session sandbox', async () => {
  const { state, root, session } = await setup();
  await mkdir(path.join(root, 'sub'));
  assert.equal((await runBuiltinCommand('cd', 'sub', state)).cd, path.join(root, 'sub'));
  assert.match((await runBuiltinCommand('cd', 'missing', state)).output, /Not a directory/);
  assert.match((await runBuiltinCommand('sandbox', '', state)).output, /Sandbox: off/);
  await runBuiltinCommand('sandbox', 'network on', state);
  assert.equal(session.sandbox.enabled, true);
  assert.equal(session.sandbox.network, true);
  assert.deepEqual(session.sandbox.writable, [root]);
  await runBuiltinCommand('sandbox', 'off', state);
  assert.equal(session.sandbox.enabled, false);
  assert.match((await runBuiltinCommand('sandbox', 'maybe', state)).output, /Usage/);
});


test('/stop terminates background processes through process-tree cleanup', async () => {
  const { state, session } = await setup();
  const signals = [];
  const entry = {
    id: 'bg_stop_test',
    status: 'running',
    child: {
      pid: 0,
      kill(signal) { signals.push(signal); return true; }
    }
  };
  session.background = new Map([[entry.id, entry]]);
  const result = await runBuiltinCommand('stop', '', state);
  assert.equal(result.output, 'Stopped 0 background agent(s) and 1 process(es).');
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(entry.status, 'killed');
  assert.ok(entry.killTimer, 'the normal process-tree SIGKILL escalation should be scheduled');
  clearTimeout(entry.killTimer);
});
