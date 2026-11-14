import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAttemptsArgs, planAttempts, rankAttempts, pickWinner, runBestOfN, formatAttemptsReport } from '../src/best-of-n.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', OASIS_HOME: '' };

function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oasis-bon-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-bon-home-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' }).toString();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  writeFileSync(path.join(root, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
  mkdirSync(path.join(root, 'test'));
  writeFileSync(path.join(root, 'test', 'sum.test.js'), "const assert = require('assert');\nconst sum = require('../sum.js');\nassert.strictEqual(sum(2, 3), 5);\nassert.strictEqual(sum(-1, 1), 0);\n");
  run('add', '-A'); run('commit', '-q', '-m', 'init');
  return { root, run, env: { ...env, HOME: home, OASIS_HOME: path.join(home, '.oasis') }, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

// Scripted attempts: #1 wrong fix, #2 right fix plus a new file, #3 "passes" by deleting the assertions.
async function scripted({ worktree, index }) {
  if (index === 1) writeFileSync(path.join(worktree.path, 'sum.js'), 'module.exports = (a, b) => a * b;\n');
  if (index === 2) {
    writeFileSync(path.join(worktree.path, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(path.join(worktree.path, 'NOTES.md'), 'fixed sum\n');
  }
  if (index === 3) writeFileSync(path.join(worktree.path, 'test', 'sum.test.js'), "const assert = require('assert');\nconst sum = require('../sum.js');\n");
  return { isError: false, subtype: 'success', result: 'done', verificationIncomplete: false };
}

test('parseAttemptsArgs reads count, models, verify and the task', () => {
  const o = parseAttemptsArgs(['3', '--models', 'a,b', '--verify', 'npm test', '--apply', 'fix', 'the', 'bug']);
  assert.equal(o.count, 3);
  assert.deepEqual(o.models, ['a', 'b']);
  assert.equal(o.verify, 'npm test');
  assert.equal(o.apply, true);
  assert.equal(o.prompt, 'fix the bug');
  assert.equal(parseAttemptsArgs(['--models', 'a,b,c', 'x']).count, 3, 'one attempt per model by default');
  assert.equal(parseAttemptsArgs(['x']).count, 2);
  assert.throws(() => parseAttemptsArgs(['9', 'x']), /1 to 8/);
  assert.throws(() => parseAttemptsArgs(['--count', '2']), /Give the task/);
  assert.equal(parseAttemptsArgs(['--attempts', '4', 'x']).count, 4);
  assert.equal(parseAttemptsArgs(['fix', '3', 'bugs']).prompt, 'fix 3 bugs', 'numbers inside the task stay in the task');
  assert.equal(parseAttemptsArgs(['3']).prompt, '3', 'a lone number is the task');
  assert.throws(() => parseAttemptsArgs(['--bogus', 'x']), /Unknown option/);
  assert.deepEqual(planAttempts({ count: 3, models: ['a', 'b'] }).map((p) => p.model), ['a', 'b', 'a']);
});

test('rankAttempts prefers verified, untampered, smaller diffs', () => {
  const base = { agent: { isError: false }, tamper: [], durationMs: 1 };
  const ranked = rankAttempts([
    { ...base, index: 1, diff: { changed: 40 }, verify: { passed: true } },
    { ...base, index: 2, diff: { changed: 4 }, verify: { passed: true } },
    { ...base, index: 3, diff: { changed: 1 }, verify: { passed: false } },
    { ...base, index: 4, diff: { changed: 2 }, verify: { passed: true }, tamper: [{ file: 't', reason: 'removed 1 assertion(s)' }] },
    { ...base, index: 5, diff: { changed: 0 }, verify: null }
  ]);
  assert.deepEqual(ranked.map((r) => r.index), [2, 1, 4, 3, 5]);
  assert.equal(pickWinner(ranked).index, 2);
  assert.equal(ranked.find((r) => r.index === 4).verified, false, 'weakened tests never count as verified');
  assert.equal(pickWinner(rankAttempts([{ ...base, index: 1, diff: { changed: 3 }, verify: null }])), null, 'no check, no winner');
});

test('runBestOfN verifies each attempt in its own worktree and applies only the honest passing one', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  const options = parseAttemptsArgs(['3', '--verify', 'node test/sum.test.js', '--apply', 'fix sum']);
  const outcome = await runBestOfN(r.root, options, { env: r.env, runAttempt: scripted });
  const byIndex = Object.fromEntries(outcome.ranked.map((x) => [x.index, x]));
  assert.equal(byIndex[1].verify.passed, false);
  assert.equal(byIndex[2].verify.passed, true);
  assert.equal(byIndex[3].verify.passed, true, 'deleting the assertions makes the check pass');
  assert.ok(byIndex[3].tamper.length > 0, 'but the tamper check flags it');
  assert.equal(outcome.winner.index, 2);
  assert.ok(outcome.applied && !outcome.applied.error, JSON.stringify(outcome.applied));
  assert.match(readFileSync(path.join(r.root, 'sum.js'), 'utf8'), /a \+ b/);
  assert.equal(readFileSync(path.join(r.root, 'NOTES.md'), 'utf8'), 'fixed sum\n', 'new files come back with the patch');
  assert.match(readFileSync(path.join(r.root, 'test', 'sum.test.js'), 'utf8'), /strictEqual/, 'tests untouched');
  for (const i of [1, 2, 3]) assert.ok(existsSync(path.join(r.root, outcome.dir, 'attempt-' + i + '.patch')));
  assert.ok(existsSync(path.join(r.root, outcome.dir, 'report.json')));
  assert.doesNotMatch(r.run('worktree', 'list'), /attempt-/, 'worktrees are removed');
  assert.doesNotMatch(r.run('branch'), /attempt-/, 'attempt branches are removed');
  const status = r.run('status', '--porcelain');
  assert.doesNotMatch(status, /\.oasis/, 'saved patches stay out of git status');
  assert.match(formatAttemptsReport(outcome, options), /Winner: attempt #2/);
});

test('without a verify command nothing is applied', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  const options = parseAttemptsArgs(['2', '--apply', 'fix sum']);
  const outcome = await runBestOfN(r.root, options, { env: r.env, runAttempt: scripted });
  assert.equal(outcome.winner, null);
  assert.equal(outcome.applied, null);
  assert.match(readFileSync(path.join(r.root, 'sum.js'), 'utf8'), /a - b/);
  assert.match(formatAttemptsReport(outcome, options), /Pass --verify/);
});

test('--apply refuses a dirty checkout and attempts outside Git fail clearly', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  writeFileSync(path.join(r.root, 'sum.js'), '// local edit\n');
  await assert.rejects(runBestOfN(r.root, parseAttemptsArgs(['--verify', 'true', '--apply', 'x']), { env: r.env, runAttempt: scripted }), /clean checkout/);
  const plain = mkdtempSync(path.join(os.tmpdir(), 'oasis-bon-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  await assert.rejects(runBestOfN(plain, parseAttemptsArgs(['x']), { env: { ...r.env, GIT_CEILING_DIRECTORIES: os.tmpdir() }, runAttempt: scripted }), /needs a Git repository/);
});

// End to end through real `oasis -p` children and a scripted OpenAI-compatible server:
// model "good" fixes the bug, model "bad" breaks it differently.
test('oasis attempts runs real agent processes and keeps the attempt that passes', { timeout: 120000 }, async (t) => {
  const { createServer } = await import('node:http');
  const r = repo();
  t.after(r.cleanup);
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const model = payload.model;
      seen.push(model);
      const toolTurns = (payload.messages || []).filter((m) => m.role === 'tool').length;
      const fix = model === 'good' ? 'a + b' : 'a * b';
      const message = toolTurns === 0
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'sum.js' }) } }] }
        : toolTurns === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'sum.js', old_string: 'a - b', new_string: fix }) } }] }
          : { role: 'assistant', content: 'Changed sum.js.' };
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) } : { role: 'assistant', content: message.content };
        res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model, choices: [{ index: 0, finish_reason: finish, message }], usage }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port + '/v1';
  const childEnv = { ...r.env, OASIS_CONFIG_DIR: path.join(r.env.HOME, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: url, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', NO_COLOR: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const options = parseAttemptsArgs(['--models', 'bad,good', '--verify', 'node test/sum.test.js', '--apply', '--timeout-seconds', '90', 'fix sum']);
  const outcome = await runBestOfN(r.root, options, { env: childEnv });
  const good = outcome.ranked.find((x) => x.model === 'good');
  const bad = outcome.ranked.find((x) => x.model === 'bad');
  assert.ok(seen.includes('good') && seen.includes('bad'), 'each attempt used its own model: ' + seen.join(','));
  assert.equal(bad.verify && bad.verify.passed, false, JSON.stringify(bad, null, 1).slice(0, 1500));
  assert.equal(good.verify && good.verify.passed, true, JSON.stringify(good, null, 1).slice(0, 1500));
  assert.equal(outcome.winner.model, 'good');
  assert.match(readFileSync(path.join(r.root, 'sum.js'), 'utf8'), /a \+ b/);
});
