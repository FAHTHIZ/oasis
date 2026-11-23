import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { runBuiltinCommand, BUILTIN_COMMANDS, COMMAND_ALIASES } from '../src/slash.mjs';
import { compactionThresholdChars } from '../src/context.mjs';

test('/diff shows tracked changes and untracked files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const env = { ...process.env, NO_COLOR: '1' };
  assert.match((await runBuiltinCommand('diff', '', { root, env })).output, /No uncommitted changes/);
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  await writeFile(path.join(root, 'new.txt'), 'x\n');
  const out = (await runBuiltinCommand('diff', '', { root, env })).output;
  assert.match(out, /-one\n\+two/);
  assert.match(out, /Untracked files:\n  new\.txt/);
  assert.match((await runBuiltinCommand('diff', '--stat', { root, env })).output, /a\.txt \| 2/);
  const plain = await mkdtemp(path.join(os.tmpdir(), 'oasis-nogit-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  assert.match((await runBuiltinCommand('diff', '', { root: plain, env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(plain) } })).output, /Not a Git repository/);
});

test('/autocompact and CLAUDE_AUTOCOMPACT_PCT_OVERRIDE move the compaction threshold', async () => {
  const config = { contextWindow: 200000 };
  const session = { config, messages: [] };
  assert.equal(compactionThresholdChars(config, {}), 480000);
  assert.equal(compactionThresholdChars(config, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' }), 400000);
  assert.match((await runBuiltinCommand('autocompact', '75%', { root: '.', session, env: {} })).output, /75%/);
  assert.equal(compactionThresholdChars(config, {}), 600000);
  assert.match((await runBuiltinCommand('autocompact', '', { root: '.', session, env: {} })).output, /150,000 tokens \(75%/);
  await runBuiltinCommand('autocompact', 'off', { root: '.', session, env: {} });
  assert.equal(compactionThresholdChars(config, {}), 8000000);
  await runBuiltinCommand('autocompact', 'reset', { root: '.', session, env: {} });
  assert.equal(compactionThresholdChars(config, {}), 480000);
  assert.match((await runBuiltinCommand('autocompact', '150', { root: '.', session, env: {} })).output, /Usage/);
});

test('Claude Code aliases, /list-agents, /reload-* and prompt commands', async () => {
  for (const target of Object.values(COMMAND_ALIASES)) assert.ok(Object.hasOwn(BUILTIN_COMMANDS, target), target);
  assert.match((await runBuiltinCommand('swarm', 'migrate src/api', { root: '.', env: {} })).prompt, /in parallel: migrate src\/api[\s\S]*isolation "worktree"/);
  assert.match((await runBuiltinCommand('peers', '', { root: '.', session: { messages: [] }, env: {} })).output, /No subagents, teammates/);
  assert.deepEqual(await runBuiltinCommand('reload-plugins', '', { root: '.', session: { messages: [] }, env: {} }), { output: '', reload: 'plugins' });
  assert.match((await runBuiltinCommand('reload-skills', '', { root: '.', env: {} })).output, /Nothing to reload/);
  assert.match((await runBuiltinCommand('statusline', 'show git branch', { root: '.', env: {} })).prompt, /show git branch[\s\S]*statusLine/);
  assert.match((await runBuiltinCommand('update-config', 'allow npm test', { root: '.', env: {} })).prompt, /allow npm test/);
});

test('/reload-skills rebuilds the session with new skills and keeps the conversation', async (t) => {
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const { createSession, runAgentTurn, rebuildSession, closeSession } = await import('../src/agent.mjs');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'first answer' }, { content: 'second answer' }]);
  const home = path.join(root, '.home');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'oasis'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  let session = await createSession({ root, config, env });
  await runAgentTurn(session, 'hello', { autoApprove: true, env });
  await mkdir(path.join(root, '.claude', 'skills', 'fresh-skill'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'skills', 'fresh-skill', 'SKILL.md'), '---\nname: fresh-skill\ndescription: Brand new skill for reload testing\n---\nBody\n');
  session.sessionName = 'my work';
  const rebuilt = await rebuildSession(session, { root, env }, 'skills');
  session = rebuilt.session;
  t.after(() => closeSession(session));
  assert.match(rebuilt.summary, /^Reloaded \d+ skill\(s\), \d+ agent/);
  assert.equal(session.sessionName, 'my work');
  await runAgentTurn(session, 'again', { autoApprove: true, env });
  assert.ok(!/fresh-skill/.test(requests[0].messages[0].content));
  assert.match(requests[1].messages[0].content, /fresh-skill/);
  assert.ok(requests[1].messages.some((m) => m.role === 'assistant' && m.content === 'first answer'), 'the conversation survived the reload');
});

test('Claude Code skill folders (.claude/skills and ~/.claude/skills) are loaded with resources', async (t) => {
  const { listAvailableSkills, loadSkillText, loadSkillResource } = await import('../src/tools.mjs');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-claude-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, '.home');
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_CONFIG_DIR: path.join(home, 'oasis') };
  const make = async (dir, name, body) => { await mkdir(path.join(dir, name, 'references'), { recursive: true }); await writeFile(path.join(dir, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + body + '\n---\nRun ${CLAUDE_SKILL_DIR}/scripts/go.sh\n'); await writeFile(path.join(dir, name, 'references', 'notes.md'), 'notes for ' + name); };
  await make(path.join(root, '.claude', 'skills'), 'proj-skill', 'Project skill');
  await make(path.join(home, '.claude', 'skills'), 'user-skill', 'Personal skill');
  await make(path.join(root, '.claude', 'skills'), 'shared', 'Project version');
  await make(path.join(home, '.claude', 'skills'), 'shared', 'Personal version');
  const skills = await listAvailableSkills(root, { env });
  const by = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(by['proj-skill'].source, 'claude-project');
  assert.equal(by['user-skill'].source, 'claude-user');
  assert.equal(by.shared.description, 'Personal version', 'personal skills win, as in Claude Code');
  const text = await loadSkillText(root, 'proj-skill', { env });
  assert.match(text.content, new RegExp(path.join(root, '.claude', 'skills', 'proj-skill').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/scripts/go.sh'));
  assert.match((await loadSkillText(root, 'user-skill', { env })).content, /Run .*user-skill\/scripts\/go\.sh/);
  assert.match(JSON.stringify(await loadSkillResource(root, 'proj-skill', 'references/notes.md', { env })), /notes for proj-skill/);
  assert.match(JSON.stringify(await loadSkillResource(root, 'user-skill', 'references/notes.md', { env })), /notes for user-skill/);
});

test('/bisect, /flaky, /mutate and /minimize hand the right tool and arguments to the agent', async () => {
  const state = { root: process.cwd(), env: process.env, sessionOptions: {} };
  const usage = await runBuiltinCommand('bisect', '', state);
  assert.match(usage.output, /Usage: \/bisect GOOD-REVISION/);
  assert.equal(usage.prompt, undefined);
  const bisect = await runBuiltinCommand('bisect', 'v1.4.0 npm test -- test/api.test.mjs', state);
  assert.match(bisect.prompt, /bisect_regression with good "v1\.4\.0"/);
  assert.match(bisect.prompt, /"npm test -- test\/api\.test\.mjs"/);
  const flaky = await runBuiltinCommand('flaky', '12 pytest -q tests/test_cache.py', state);
  assert.match(flaky.prompt, /flaky_check with that command and runs 12/);
  assert.match(flaky.prompt, /"pytest -q tests\/test_cache\.py"/);
  assert.match((await runBuiltinCommand('flaky', '', state)).prompt, /most recently/);
  const mutate = await runBuiltinCommand('mutate', 'npm test', state);
  assert.match(mutate.prompt, /mutation_probe/);
  assert.match(mutate.prompt, /never to the source/);
  assert.match((await runBuiltinCommand('minimize', 'data/big.json', state)).output, /Usage: \/minimize FILE/);
  const minimize = await runBuiltinCommand('minimize', 'data/big.json node parse.mjs data/big.json', state);
  assert.match(minimize.prompt, /minimize_repro with file "data\/big\.json" and command "node parse\.mjs data\/big\.json"/);
});

test('/localize and /hunt chain the evidence tools', async () => {
  const state = { root: process.cwd(), env: process.env, sessionOptions: {} };
  const localize = await runBuiltinCommand('localize', 'node --test -- test/a.test.mjs test/b.test.mjs', state);
  assert.match(localize.prompt, /"node --test"/);
  assert.match(localize.prompt, /\["test\/a\.test\.mjs","test\/b\.test\.mjs"\]/);
  assert.match(localize.prompt, /localize_fault/);
  assert.match((await runBuiltinCommand('hunt', '', state)).output, /Usage: \/hunt CHECK/);
  const hunt = await runBuiltinCommand('hunt', 'npm test -- test/cart.test.mjs --good v2.3.0', state);
  assert.match(hunt.prompt, /"npm test -- test\/cart\.test\.mjs"/);
  assert.match(hunt.prompt, /bisect_regression with good "v2\.3\.0"/);
  for (const tool of ['flaky_check', 'localize_fault', 'minimize_repro', 'mutation_probe']) assert.match(hunt.prompt, new RegExp(tool));
  assert.match(hunt.prompt, /Do not weaken or delete existing tests/);
});
