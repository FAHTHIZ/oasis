import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, subagentMaxDepth } from '../src/agent.mjs';
import { listAgents } from '../src/agent-tasks.mjs';

test('subagentMaxDepth defaults to 1 and is clamped to 1-3', () => {
  assert.equal(subagentMaxDepth({}, {}), 1);
  assert.equal(subagentMaxDepth({ subagentMaxDepth: 2 }, {}), 2);
  assert.equal(subagentMaxDepth({ subagentMaxDepth: 2 }, { OASIS_SUBAGENT_MAX_DEPTH: '9' }), 3);
  assert.equal(subagentMaxDepth({}, { OASIS_SUBAGENT_MAX_DEPTH: '0' }), 1);
  assert.equal(subagentMaxDepth({}, { OASIS_SUBAGENT_MAX_DEPTH: 'x' }), 1);
});

// main -> general-purpose (depth 1) -> explore (depth 2)
async function run(t, maxDepth) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-nest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    const system = payload.messages[0].content;
    const role = /SUBAGENT MODE \(explore\)/.test(system) ? 'explore' : /SUBAGENT MODE \(general-purpose\)/.test(system) ? 'worker' : 'main';
    const tools = (payload.tools || []).map((tool) => tool.function.name);
    const toolMessage = payload.messages.findLast((message) => message.role === 'tool');
    seen.push({ role, tools, toolMessage: toolMessage ? toolMessage.content : null });
    let message;
    const call = (args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + seen.length, type: 'function', function: { name: 'task', arguments: JSON.stringify(args) } }] });
    if (role === 'explore') message = { role: 'assistant', content: 'leaf report: config at a.json' };
    else if (role === 'worker') message = toolMessage ? { role: 'assistant', content: 'worker relayed: ' + toolMessage.content.slice(0, 200) } : call({ description: 'look', prompt: 'find config', subagent_type: 'explore' });
    else message = toolMessage ? { role: 'assistant', content: 'done' } : call({ description: 'work', prompt: 'do the job' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_SUBAGENT_MAX_DEPTH: String(maxDepth), OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '' };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  return { seen, session };
}

test('with subagentMaxDepth 2 a writing subagent delegates to a read-only leaf', async (t) => {
  const { seen, session } = await run(t, 2);
  const worker = seen.find((entry) => entry.role === 'worker');
  const leaf = seen.find((entry) => entry.role === 'explore');
  assert.ok(worker.tools.includes('task'), 'depth-1 writer gets the task tool');
  assert.ok(leaf, 'the nested explore agent ran');
  assert.ok(!leaf.tools.includes('task'), 'the depth-2 leaf cannot delegate further');
  const relay = seen.findLast((entry) => entry.role === 'worker');
  assert.match(relay.toolMessage, /leaf report/);
  const agents = listAgents(session);
  assert.equal(agents.length, 2);
});

test('the default depth keeps subagents from delegating', async (t) => {
  const { seen } = await run(t, 1);
  const worker = seen.find((entry) => entry.role === 'worker');
  assert.ok(!worker.tools.includes('task'));
  assert.ok(!seen.some((entry) => entry.role === 'explore'));
});
