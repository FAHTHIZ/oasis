import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';

async function run(t, { frontmatterEffort = '', env = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-subeffort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'agents', 'scout.md'), '---\nname: scout\ndescription: Finds files\n' + (frontmatterEffort ? 'effort: ' + frontmatterEffort + '\n' : '') + '---\nYou find files.\n');
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    payloads.push(payload);
    const isChild = /You find files/.test(payload.messages[0].content);
    const hasTaskResult = payload.messages.some((message) => message.role === 'tool');
    const message = isChild ? { role: 'assistant', content: 'found it' }
      : hasTaskResult ? { role: 'assistant', content: 'all done' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'find', prompt: 'find the config', subagent_type: 'scout' }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const fullEnv = { ...process.env, OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '', OASIS_REASONING_EFFORT: '', ...env };
  const session = await createSession({ root, env: fullEnv, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env: fullEnv });
  const child = payloads.find((payload) => /You find files/.test(payload.messages[0].content));
  const parent = payloads[0];
  return { child, parent };
}

test('agent frontmatter effort applies to that subagent only', async (t) => {
  const { child, parent } = await run(t, { frontmatterEffort: 'low' });
  assert.equal(child.reasoning_effort, 'low');
  assert.equal(parent.reasoning_effort, undefined);
});

test('OASIS_SUBAGENT_EFFORT / CLAUDE_CODE_SUBAGENT_EFFORT set every subagent', async (t) => {
  const { child } = await run(t, { env: { CLAUDE_CODE_SUBAGENT_EFFORT: 'high' } });
  assert.equal(child.reasoning_effort, 'high');
});

test('no setting leaves the subagent on the parent effort', async (t) => {
  const { child } = await run(t);
  assert.equal(child.reasoning_effort, undefined);
});
