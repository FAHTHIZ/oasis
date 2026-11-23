import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { createSession, runAgentTurn, droppedWorkspaceFolderPath } from '../src/agent.mjs';

async function layout(t) {
  const run = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-dropped-')));
  t.after(() => rm(run, { recursive: true, force: true }));
  const root = path.join(run, 'workspace');
  await mkdir(path.join(root, 'sources'), { recursive: true });
  await writeFile(path.join(root, 'sources', 'a.md'), 'The limit is 120 requests per minute.\n');
  return { run, root };
}

test('a path missing the workspace folder name is mapped back into the workspace', async (t) => {
  const { run, root } = await layout(t);
  // Seen live: qwen2.5 1.5B wrote /tmp/oasis-eval-run-X/sources/a.md for /tmp/oasis-eval-run-X/workspace.
  assert.equal(droppedWorkspaceFolderPath(root, path.join(run, 'sources', 'a.md')), 'sources/a.md');
  assert.equal(droppedWorkspaceFolderPath(root, path.join(run, 'sources')), 'sources');
  // Not rewritten: relative paths, paths already inside, paths with no match
  // inside, paths that exist where they are, and paths that climb out.
  assert.equal(droppedWorkspaceFolderPath(root, 'sources/a.md'), null);
  assert.equal(droppedWorkspaceFolderPath(root, path.join(root, 'sources', 'a.md')), null);
  assert.equal(droppedWorkspaceFolderPath(root, path.join(run, 'sources', 'missing.md')), null);
  assert.equal(droppedWorkspaceFolderPath(root, path.join(run, 'workspace')), null);
  assert.equal(droppedWorkspaceFolderPath(root, '/etc/passwd'), null);
  assert.equal(droppedWorkspaceFolderPath(root, path.join(run, '..', 'sources', 'a.md')), null);
  await writeFile(path.join(run, 'real.md'), 'outside\n');
  await writeFile(path.join(root, 'real.md'), 'inside\n');
  assert.equal(droppedWorkspaceFolderPath(root, path.join(run, 'real.md')), null, 'an existing outside file is never redirected');
  assert.equal(droppedWorkspaceFolderPath(root, 42), null);
  assert.equal(droppedWorkspaceFolderPath(null, path.join(run, 'sources', 'a.md')), null);
});

test('the read succeeds and the history shows the relative path', async (t) => {
  const { run, root } = await layout(t);
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    bodies.push(payload);
    res.writeHead(200, { 'content-type': 'application/json' });
    const message = bodies.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: path.join(run, 'sources', 'a.md') }) } }] }
      : { role: 'assistant', content: 'The limit is 120 requests per minute.' };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(run, '.cfg') };
  delete env.NODE_TEST_CONTEXT;
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  const result = await runAgentTurn(session, 'What is the rate limit in sources/a.md?', { autoApprove: true, env });
  assert.match(result.text, /120 requests/);
  const second = bodies[1].messages;
  const call = second.find((m) => m.role === 'assistant' && m.tool_calls).tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), { path: 'sources/a.md' });
  const toolResult = second.find((m) => m.role === 'tool');
  assert.match(toolResult.content, /120 requests per minute/);
  assert.doesNotMatch(toolResult.content, /outside the workspace/);
});
