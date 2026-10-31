import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';

const base = (port) => ({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 });
const names = (session) => session.toolDefinitions.map((tool) => tool.function.name);

test('rare built-in tools are deferred, listed, and opt-out works', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-lean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lean = await createSession({ root, config: base(9) });
  assert.ok(!names(lean).includes('configure_provider'));
  assert.ok(names(lean).includes('tool_search'));
  assert.ok(names(lean).includes('read_file'));
  assert.ok(lean.deferredTools.has('configure_provider'));
  assert.match(lean.messages[0].content, /Deferred tools \(\d+\):.*configure_provider/);
  const full = await createSession({ root, config: { ...base(9), leanTools: false } });
  assert.ok(names(full).includes('configure_provider'));
  assert.ok(!full.deferredTools || !full.deferredTools.has('configure_provider'));
});

test('calling a deferred tool directly auto-loads it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-lean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    const message = payloads.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'cron_list', arguments: '{}' } }] }
      : { role: 'assistant', content: 'done' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: base(server.address().port) });
  assert.ok(session.deferredTools.has('cron_list'));
  await runAgentTurn(session, 'list cron jobs', { autoApprove: true });
  const toolMessage = session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.ok(toolMessage, 'tool result recorded');
  assert.doesNotMatch(toolMessage.content, /Unknown or unavailable tool|no tool named/i);
  assert.ok(names(session).includes('cron_list'));
  assert.ok(payloads[1].tools.some((tool) => tool.function.name === 'cron_list'), 'schema sent after first use');
});
