import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession, replaysReasoning } from '../src/agent.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

// First reply: reasoning plus a read_file call. Second: reasoning plus answer.
async function reasoningServer(t, style) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const think = (text) => style === 'google'
      ? { content: text, extra_content: { google: { thought: true } } }
      : { reasoning_content: text };
    if (bodies.length === 1) {
      res.write(sse({ choices: [{ delta: think('I should read a.txt.') }] }));
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    } else {
      res.write(sse({ choices: [{ delta: think('It says hello.') }] }));
      res.write(sse({ choices: [{ delta: { content: 'The file says hello.' } }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, bodies };
}

async function run(t, server, model) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-reasoning-'));
  await writeFile(path.join(root, 'a.txt'), 'hello\n');
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.port + '/v1', model, apiKey: '', maxSteps: 4 };
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  let shown = '';
  const result = await runAgentTurn(session, 'What does a.txt say?', { onDelta: (text) => { shown += text; } });
  return { result, shown };
}

test('DeepSeek streamed reasoning stays hidden and is replayed on the next request', async (t) => {
  const server = await reasoningServer(t, 'deepseek');
  const { result, shown } = await run(t, server, 'deepseek-reasoner');
  assert.equal(result.text, 'The file says hello.');
  assert.doesNotMatch(shown, /I should read/);
  const replayed = server.bodies[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.equal(replayed.reasoning_content, 'I should read a.txt.');
});

test('Gemini thought chunks are not shown as the answer, and are not replayed', async (t) => {
  const server = await reasoningServer(t, 'google');
  const { result, shown } = await run(t, server, 'gemma-4-31b-it');
  assert.equal(result.text, 'The file says hello.');
  assert.doesNotMatch(shown, /I should read|It says hello/);
  const replayed = server.bodies[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.equal('reasoning_content' in replayed, false);
});

test('reasoning is replayed where the catalog or the model family expects it', () => {
  // models.dev marks GLM and MiMo as interleaved-thinking models.
  assert.equal(replaysReasoning({ protocol: 'openai-compatible', baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-5' }), true);
  assert.equal(replaysReasoning({ protocol: 'openai-compatible', baseURL: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-pro' }), true);
  // An explicit setting wins over both the catalog and the name.
  assert.equal(replaysReasoning({ protocol: 'openai-compatible', baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-5', replayReasoning: false }), false);
  assert.equal(replaysReasoning({ protocol: 'openai-compatible', baseURL: 'http://localhost:8000/v1', model: 'my-finetune', replayReasoning: true }), true);
  assert.equal(replaysReasoning({ protocol: 'openai-compatible', baseURL: 'http://localhost:8000/v1', model: 'my-finetune' }), false);
  assert.equal(replaysReasoning({ protocol: 'openai-compatible', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' }), true);
  assert.equal(replaysReasoning({ protocol: 'openai-compatible', baseURL: 'https://api.moonshot.ai/v1', model: 'kimi-k2-thinking' }), true);
  assert.equal(replaysReasoning({ protocol: 'openai-compatible', baseURL: 'https://api.openai.com/v1', model: 'gpt-5' }), false);
  assert.equal(replaysReasoning({ protocol: 'openai-responses', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' }), false);
});
