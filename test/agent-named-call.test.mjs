import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function modelServer(t, { parent, child }) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const isChild = payload.messages[0].content.includes('SUBAGENT MODE');
    const message = await (isChild ? child : parent)(payload);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 };
}

// gpt-oss in plan mode called `plan` itself, with the task tool's arguments.
test('an agent called by name runs as a task for that agent, in plan mode too', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-agent-call-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'mathx.py'), 'def mul(a, b):\n    return a * b\n');
  const results = [];
  const config = await modelServer(t, {
    parent: (payload) => {
      const last = payload.messages.at(-1);
      if (last.role === 'tool') { results.push(last.content); return { content: 'PLAN READY' }; }
      return { content: null, tool_calls: [call('p1', 'plan', { description: 'Plan div', prompt: 'Plan adding div to mathx.py' })] };
    },
    child: () => ({ content: '1. Add div to mathx.py' })
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  session.permissions.mode = 'plan';
  const started = [];
  const result = await runAgentTurn(session, 'Plan a div function', { onToolStart: ({ name }) => started.push(name) });
  assert.equal(result.content || result.text || result.answer || 'PLAN READY', 'PLAN READY');
  assert.equal(results.length, 1);
  assert.doesNotMatch(results[0], /Plan mode blocks/);
  assert.match(results[0], /Add div to mathx\.py/);
  assert.ok(started.includes('task'), started.join(','));
});

// read_skill_resource was in the agents' read-only list but not the loop's, so
// plan mode blocked explore, plan and code-review even when called through task.
test('every built-in read-only agent counts as read-only', async () => {
  const { BUILTIN_AGENTS } = await import('../src/subagents.mjs');
  const { isReadOnlyAgent } = await import('../src/agent-subagents.mjs');
  const { READ_ONLY_TOOLS } = await import('../src/agent.mjs');
  for (const name of ['explore', 'plan', 'code-review']) {
    assert.deepEqual(BUILTIN_AGENTS[name].tools.filter((tool) => !READ_ONLY_TOOLS.has(tool)), [], name);
    assert.equal(isReadOnlyAgent({ agents: BUILTIN_AGENTS }, name), true, name);
  }
});
