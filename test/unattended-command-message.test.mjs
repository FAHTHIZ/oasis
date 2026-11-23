import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { executeTool, unattendedCommandMessage } from '../src/tools.mjs';

// Seen live (gpt-oss-20b, oasis eval sales-region-report): python -c and a
// run_shell heredoc were refused with "tell the user the exact command to
// run", and there was no user. The refusal stands; the message changes.
test('a high-risk command with nobody to approve it is refused with the reason and what runs instead', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-unattended-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = "import os; os.makedirs('report', exist_ok=True)";
  const result = await executeTool('run_command', { command: 'python3', args: ['-c', code] }, { root, autoApprove: true });
  assert.equal(result.approved, false);
  assert.equal(result.unattended, true);
  assert.match(result.message, /no one is available to approve/);
  assert.match(result.message, /inline code/);
  assert.match(result.message, /write_file/);
  assert.doesNotMatch(result.message, /tell the user/);
  assert.deepEqual(await readdir(root), [], 'nothing ran');
});

test('a run_shell line with nobody to approve it points at run_command', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-unattended-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await executeTool('run_shell', { command: "python3 - <<'PY'\nopen('made.txt', 'w').write('x')\nPY" }, { root, autoApprove: true });
  assert.equal(result.approved, false);
  assert.equal(result.unattended, true);
  assert.match(result.message, /run_command with a program and an argument list/);
  assert.deepEqual(await readdir(root), [], 'nothing ran');
});

test('with someone to ask, a refusal keeps its usual wording', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-unattended-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await executeTool('run_command', { command: 'python3', args: ['-c', 'print(1)'] }, { root, autoApprove: true, approval: async () => false });
  assert.equal(result.approved, false);
  assert.equal(result.unattended, undefined);
  assert.match(result.message, /Command was not approved/);
});

test('the message names the reason without inventing one', () => {
  assert.match(unattendedCommandMessage('runs inline code (python -c)'), /because it runs inline code \(python -c\)/);
  assert.doesNotMatch(unattendedCommandMessage(null), /because/);
  assert.match(unattendedCommandMessage(null, 'shell'), /not auto-approved outside an OS sandbox/);
});

test('an agent turn with no approver gets the unattended refusal', async (t) => {
  const { createServer } = await import('node:http');
  const { createSession, runAgentTurn } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-unattended-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    bodies.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    const message = bodies.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'python3', args: ['-c', "open('made.txt','w').write('x')"] }) } }] }
      : { role: 'assistant', content: 'Could not run it.' };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, '.cfg') };
  delete env.NODE_TEST_CONTEXT;
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'Hello.', { autoApprove: true, env });
  const tool = bodies[1].messages.find((m) => m.role === 'tool');
  assert.match(tool.content, /no one is available to approve/);
  assert.doesNotMatch(tool.content, /tell the user/);
  assert.ok(!(await readdir(root)).includes('made.txt'), 'nothing ran');
});
