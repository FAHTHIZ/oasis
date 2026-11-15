import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/tools.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { readEvents } from '../src/event-stream.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// interactive=true used to answer "running" at once with no output, even for a
// test run that ends in a second. A small local model (qwen3 1.7B, seen live)
// then started `npm test` again and again and never saw a result, and each
// unfinished start was logged as a failed check.
const hasPty = await import('node-pty').then(() => true).catch(() => false);

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-interactive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'quick.mjs'), "console.log('quick done');\nprocess.exit(3);\n");
  await writeFile(path.join(root, 'slow.mjs'), "console.log('waiting for input');\nsetInterval(() => {}, 1000);\n");
  await writeFile(path.join(root, 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  await writeFile(path.join(root, 'slow.test.mjs'), "import test from 'node:test';\ntest('slow', () => new Promise((resolve) => setTimeout(resolve, 20000)));\n");
  return root;
}

test('an interactive command that exits quickly returns its output and exit code', { skip: !hasPty && 'node-pty not installed' }, async (t) => {
  const root = await project(t);
  const session = {};
  t.after(() => session.ptyManager && session.ptyManager.closeAll());
  const result = await executeTool('run_command', { command: 'node', args: ['quick.mjs'], interactive: true }, { root, session, autoApprove: true, approval: async () => true });
  assert.equal(result.state, 'exited', JSON.stringify(result));
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /quick done/);
  assert.match(result.message, /finished within/);
});

test('an interactive command still running returns the output so far and its id', { skip: !hasPty && 'node-pty not installed' }, async (t) => {
  const root = await project(t);
  const session = {};
  t.after(() => session.ptyManager && session.ptyManager.closeAll());
  const env = { ...process.env, OASIS_INTERACTIVE_SETTLE_MS: '1500' };
  const started = Date.now();
  const result = await executeTool('run_command', { command: 'node', args: ['slow.mjs'], interactive: true }, { root, session, env, autoApprove: true, approval: async () => true });
  assert.ok(Date.now() - started < 10000, 'returned after the settle window');
  assert.equal(result.state, 'running');
  assert.equal(result.exitCode, undefined);
  assert.match(result.output, /waiting for input/);
  assert.ok(result.id && Number.isInteger(result.nextOffset));
  assert.match(result.message, /terminal_read/);
});

async function verificationEvents(t, args, env) {
  const root = await project(t);
  const { config } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: 'node', args, interactive: true }),
    { content: 'Checked.' }
  ]);
  const session = await createSession({ root, config, settings: { permissions: { allow: ['run_command(node:*)'], ask: [], deny: [] } }, bare: true });
  session.sessionId = '0123456789abcdef0123456789abcdef';
  t.after(() => session.ptyManager && session.ptyManager.closeAll());
  const previous = process.env.OASIS_INTERACTIVE_SETTLE_MS;
  // The child test run must not think it is nested inside this runner.
  const nested = process.env.NODE_TEST_CONTEXT;
  if (env) process.env.OASIS_INTERACTIVE_SETTLE_MS = env;
  delete process.env.NODE_TEST_CONTEXT;
  try { await runAgentTurn(session, 'Run the tests.', { approval: async () => true }); }
  finally {
    if (previous === undefined) delete process.env.OASIS_INTERACTIVE_SETTLE_MS; else process.env.OASIS_INTERACTIVE_SETTLE_MS = previous;
    if (nested !== undefined) process.env.NODE_TEST_CONTEXT = nested;
  }
  const toolMessage = session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(toolMessage, 'tool result recorded');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const events = await readEvents(root, session.sessionId).catch(() => []);
  return { body: JSON.parse(toolMessage.content), checks: (Array.isArray(events) ? events : events.events || []).filter((e) => e.type === 'verification') };
}

test('a check run interactively is recorded once it exits', { skip: !hasPty && 'node-pty not installed' }, async (t) => {
  const { body, checks } = await verificationEvents(t, ['--test', 'ok.test.mjs']);
  assert.equal(body.exitCode, 0, JSON.stringify(body));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].exitCode, 0);
});

test('a check still running in a terminal is not recorded as a failed check', { skip: !hasPty && 'node-pty not installed' }, async (t) => {
  const { body, checks } = await verificationEvents(t, ['--test', 'slow.test.mjs'], '1000');
  assert.equal(body.state, 'running', JSON.stringify(body).slice(0, 1500));
  assert.deepEqual(checks, []);
});
