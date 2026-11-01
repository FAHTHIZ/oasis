import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/tools.mjs';
import { createSession, runAgentTurn, assistedVerificationEnabled, detectProjectTestCommand } from '../src/agent.mjs';

function scriptedModel(t, decide) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    seen.push(payload);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: decide(payload.messages, seen.length) }] }));
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen })));
}

const write = (id, file, content) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content }) } }] });

test('assistedVerificationEnabled follows window size, local detection and overrides', () => {
  assert.equal(assistedVerificationEnabled({ config: { contextWindow: 16384 } }, {}), true);
  assert.equal(assistedVerificationEnabled({ config: { contextWindow: 200000 } }, {}), false);
  assert.equal(assistedVerificationEnabled({ config: {} }, {}), false);
  assert.equal(assistedVerificationEnabled({ config: {}, localContext: { contextLength: 8192 } }, {}), true);
  assert.equal(assistedVerificationEnabled({ config: { contextWindow: 16384 } }, { OASIS_ASSISTED_VERIFICATION: '0' }), false);
  assert.equal(assistedVerificationEnabled({ config: {} }, { OASIS_ASSISTED_VERIFICATION: '1' }), true);
  assert.equal(assistedVerificationEnabled({ config: {}, settings: { assistedVerification: true } }, {}), true);
});

test('detectProjectTestCommand ignores the npm placeholder script', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-av-detect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(await detectProjectTestCommand(root), null);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(await detectProjectTestCommand(root), { command: 'npm', args: ['test'] });
});

test('small-window model that edits and stops gets a harness-run diff and syntax check', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-av-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const { port, seen } = await scriptedModel(t, (messages, n) => {
    if (n === 1) return write('w1', 'lib.mjs', 'export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n');
    return { role: 'assistant', content: 'Done. I added clamp to lib.mjs.' };
  });
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 10, contextWindow: 16384 } });
  const ran = [];
  const result = await runAgentTurn(session, 'add a clamp helper in lib.mjs', {
    autoApprove: true,
    env: { ...process.env, OASIS_ASSISTED_VERIFICATION: '', OASIS_AUTO_TEST: '' },
    onToolResult: (event) => ran.push(event.name),
  });
  assert.ok(ran.includes('git_diff'), 'harness ran git_diff: ' + ran.join(','));
  assert.ok(ran.filter((name) => name === 'run_command').length >= 1, 'harness ran a syntax check');
  const toolText = seen.slice(1).flatMap((p) => p.messages).filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
  assert.match(toolText, /lib\.mjs/);
  if (process.env.AV_DEBUG) for (const p of seen) console.log('CALL', JSON.stringify(p.messages.slice(-2).map((x) => [x.role, String(x.content || '').slice(0, 300), (x.tool_calls || []).map((c) => c.function.name)])));
  assert.match(toolText, /syntax check \(no test suite found\)/);
  assert.ok(seen.length <= 3, 'bounded number of model calls: ' + seen.length);
  assert.ok(result);
});

test('large-window models are left alone', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-av-off-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const { port } = await scriptedModel(t, (messages, n) => n === 1 ? write('w1', 'a.mjs', 'export const a = 1;\n') : { role: 'assistant', content: 'Done.' });
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 10, contextWindow: 200000 } });
  const ran = [];
  await runAgentTurn(session, 'add a', { autoApprove: true, env: { ...process.env, OASIS_ASSISTED_VERIFICATION: '', OASIS_AUTO_TEST: '' }, onToolResult: (event) => ran.push(event.name) });
  assert.ok(!ran.includes('git_diff'));
});

test('git_diff works in a repository with no commits yet', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-av-nohead-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, 'new.mjs'), 'export const n = 1;\n');
  const result = await executeTool('git_diff', {}, { root, autoApprove: true });
  assert.equal(result.exitCode, 0, JSON.stringify(result).slice(0, 400));
  assert.match(String(result.stdout), /new\.mjs/);
});

test('a small model that refuses an ordinary coding task is nudged once to continue', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-av-refuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  let nudged = 0;
  const { port, seen } = await scriptedModel(t, (messages) => {
    const last = messages[messages.length - 1];
    if (last.role === 'user' && /ordinary software task/.test(String(last.content))) { nudged++; return write('w1', 'b.mjs', 'export const b = 2;\n'); }
    if (last.role === 'user') return { role: 'assistant', content: "I'm sorry, but I can't assist with that." };
    return { role: 'assistant', content: 'Created b.mjs.' };
  });
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 10, contextWindow: 16384 } });
  await runAgentTurn(session, 'create b.mjs exporting b = 2', { autoApprove: true, env: { ...process.env, OASIS_ASSISTED_VERIFICATION: '', OASIS_AUTO_TEST: '' } });
  assert.equal(nudged, 1);
  assert.ok(seen.length <= 5);
});

test('a small model that keeps pasting the new file as a code block gets it written and checked', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-av-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const code = '```javascript\nexport function twice(x) {\n  return x * 2;\n}\n```';
  const { port } = await scriptedModel(t, (messages) => {
    const last = messages[messages.length - 1];
    if (last.role === 'user') return { role: 'assistant', content: 'Here is the code for src/twice.mjs:\n' + code };
    return { role: 'assistant', content: 'Done; src/twice.mjs exports twice.' };
  });
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 10, contextWindow: 16384 } });
  const ran = [];
  await runAgentTurn(session, 'Create src/twice.mjs exporting twice(x)', { autoApprove: true, env: { ...process.env, OASIS_ASSISTED_VERIFICATION: '', OASIS_AUTO_TEST: '' }, onToolResult: (event) => ran.push(event.name) });
  const { readFile } = await import('node:fs/promises');
  assert.match(await readFile(path.join(root, 'src/twice.mjs'), 'utf8'), /return x \* 2/);
  assert.ok(ran.includes('write_file') && ran.includes('git_diff'), ran.join(','));
});

test('after a failed check, a corrected whole file pasted as a code block replaces the file the model created', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-av-fix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const { port } = await scriptedModel(t, (messages, n) => {
    if (n === 1) return write('w1', 'src/half.mjs', 'export function half(x) {\n  return x / 2;\n}}\n');
    const toolText = messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
    if (/SyntaxError/.test(toolText) && !/saved the code block/.test(toolText)) return { role: 'assistant', content: "Here's the corrected code:\n```javascript\nexport function half(x) {\n  return x / 2;\n}\n```" };
    return { role: 'assistant', content: 'Fixed; src/half.mjs passes node --check.' };
  });
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 12, contextWindow: 16384 } });
  const result = await runAgentTurn(session, 'Create src/half.mjs exporting half(x)', { autoApprove: true, env: { ...process.env, OASIS_ASSISTED_VERIFICATION: '', OASIS_AUTO_TEST: '' } });
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(path.join(root, 'src/half.mjs'), 'utf8'), 'export function half(x) {\n  return x / 2;\n}\n');
  assert.equal(result.verificationIncomplete, false, JSON.stringify(result.verificationIssues));
});

test('calls to made-up tools are answered with the real tool list', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-av-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let told = '';
  const { port } = await scriptedModel(t, (messages, n) => {
    const last = messages[messages.length - 1];
    if (n === 1) return { role: 'assistant', content: '{"name": "git_init", "arguments": {}}' };
    if (last.role === 'user' && /not a tool/.test(String(last.content))) told = String(last.content);
    return { role: 'assistant', content: 'Nothing to change.' };
  });
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 } });
  await runAgentTurn(session, 'init a repo', { autoApprove: true, env: { ...process.env, OASIS_AUTO_TEST: '' } });
  assert.match(told, /git_init is not a tool/);
  assert.match(told, /run_command/);
});
