import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';

async function fixture(t, plan) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(Date.now() + Math.random()); process.exit(1)"' } }));
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    const step = plan[payloads.length - 1] || { content: 'giving up' };
    const message = step.content !== undefined ? { role: 'assistant', content: step.content }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c' + payloads.length, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 12 } });
  return { session, payloads };
}

const npmTest = { tool: 'run_command', args: { command: 'npm', args: ['test'] } };

test('the same failing command is flagged on the 3rd try and stopped on the 5th', async (t) => {
  const { session, payloads } = await fixture(t, [npmTest, npmTest, npmTest, npmTest, npmTest, { content: 'should not be reached' }]);
  const result = await runAgentTurn(session, 'make tests pass', { autoApprove: true });
  const toolMessages = payloads.at(-1).messages.filter((message) => message.role === 'tool');
  assert.doesNotMatch(toolMessages[1].content, /failed 2 times/);
  assert.match(toolMessages[2].content, /This exact command has now failed 3 times with no file changes in between/);
  assert.match(result.text, /`npm test` has failed 5 times in a row/);
  assert.equal(payloads.length, 5);
});

test('an edit between retries resets the count', async (t) => {
  const edit = (from, to) => ({ tool: 'edit_file', args: { path: 'a.txt', old_string: from, new_string: to } });
  const { session, payloads } = await fixture(t, [npmTest, npmTest, edit('one', 'two'), npmTest, npmTest, { content: 'still failing, here is why' }]);
  await runAgentTurn(session, 'make tests pass', { autoApprove: true });
  const toolMessages = payloads.at(-1).messages.filter((message) => message.role === 'tool');
  assert.ok(toolMessages.every((message) => !/This exact command has now failed/.test(message.content)));
  assert.doesNotMatch(toolMessages[2].content, /error/i, 'the edit itself succeeded');
});

test('a failed edit does not reset the count', async (t) => {
  const badEdit = { tool: 'edit_file', args: { path: 'a.txt', old_string: 'absent', new_string: 'x' } };
  const { session, payloads } = await fixture(t, [npmTest, npmTest, badEdit, npmTest, { content: 'done' }]);
  await runAgentTurn(session, 'make tests pass', { autoApprove: true });
  const toolMessages = payloads.at(-1).messages.filter((message) => message.role === 'tool');
  assert.match(toolMessages[3].content, /failed 3 times/);
});
