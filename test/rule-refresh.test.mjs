import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractHardRules, extractBranchRules, ruleRefreshReminder, RULE_REFRESH_GROWTH_CHARS } from '../src/rule-refresh.mjs';
import { executeTool } from '../src/tools.mjs';
import { executePowerTool } from '../src/power-tools.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

const CONTEXT = '--- Project instructions: CLAUDE.md ---\n# Rules\n- NEVER commit directly to `main`.\n- Always run npm test before finishing.\n- Use tabs.\n```\nnever inside code\n```\n--- Project context: README.md ---\nYou must install node.';

test('extracts hard rules from instruction files only', () => {
  assert.deepEqual(extractHardRules(CONTEXT), ['NEVER commit directly to main.'.replace('main', '`main`'), 'Always run npm test before finishing.']);
  assert.deepEqual(extractBranchRules(CONTEXT), { commit: ['main'], push: ['main'] });
  assert.deepEqual(extractBranchRules('--- Project instructions: AGENTS.md ---\n**Do not** push to master or develop'), { commit: [], push: ['master', 'develop'] });
  assert.deepEqual(extractBranchRules('--- Project instructions: AGENTS.md ---\nNever commit secrets.'), { commit: [], push: [] });
});

test('reminder fires after enough growth or a compaction, not every turn', () => {
  const session = { hardRules: ['Never use var.'], rulesRefreshedAtChars: 1000 };
  assert.equal(ruleRefreshReminder(session, { historyChars: 5000, env: {} }), '');
  assert.match(ruleRefreshReminder(session, { historyChars: 1000 + RULE_REFRESH_GROWTH_CHARS, env: {} }), /<project-rules-reminder>[\s\S]*Never use var\./);
  assert.equal(ruleRefreshReminder(session, { historyChars: 2000 + RULE_REFRESH_GROWTH_CHARS, env: {} }), '');
  assert.match(ruleRefreshReminder(session, { historyChars: 500, env: {} }), /project-rules-reminder/, 'history shrank: compaction');
  assert.equal(ruleRefreshReminder(session, { historyChars: 999999, env: { OASIS_RULE_REFRESH: '0' } }), '');
});

test('"never commit to main" is enforced for git_commit, run_command and run_shell', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-branchrule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Rules\n- NEVER commit directly to main.\n');
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: '' } });
  assert.deepEqual(session.branchRules.commit, ['main']);
  const ctx = { root, session, autoApprove: true, approval: async () => true, env: process.env };
  const viaTool = await executeTool('git_commit', { message: 'x', paths: ['a.txt'] }, ctx);
  assert.match(viaTool.message, /Blocked by a project rule[\s\S]*commit on `main`/);
  execFileSync('git', ['add', 'a.txt'], { cwd: root });
  const viaCommand = await executeTool('run_command', { command: 'git', args: ['commit', '-m', 'x'] }, ctx);
  assert.equal(viaCommand.blocked, true);
  const viaShell = await executePowerTool('run_shell', { command: 'git commit -m x' }, ctx, root);
  assert.equal(viaShell.blocked, true);
  assert.throws(() => execFileSync('git', ['log'], { cwd: root, stdio: 'pipe' }), 'no commit was made');
  execFileSync('git', ['switch', '-q', '-c', 'feature'], { cwd: root });
  const onFeature = await executePowerTool('run_shell', { command: 'git commit -m ok' }, ctx, root);
  assert.equal(onFeature.exitCode, 0);
});

test('rules are restated in a long session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rulerefresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'AGENTS.md'), '- Always answer in British English.\n');
  await writeFile(path.join(root, 'big.txt'), 'y'.repeat(70000));
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    bodies.push(JSON.parse(body));
    const n = bodies.length;
    const message = n === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'r', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'big.txt' }) } }] } : { role: 'assistant', content: 'ok ' + n };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'read big.txt', { autoApprove: true });
  assert.doesNotMatch(JSON.stringify(bodies[0].messages.at(-1)), /project-rules-reminder/);
  session.messages.push({ role: 'user', content: 'z'.repeat(RULE_REFRESH_GROWTH_CHARS) }, { role: 'assistant', content: 'noted' });
  await runAgentTurn(session, 'and now?', { autoApprove: true });
  assert.match(bodies.at(-1).messages.at(-1).content, /<project-rules-reminder>[\s\S]*British English/);
});
