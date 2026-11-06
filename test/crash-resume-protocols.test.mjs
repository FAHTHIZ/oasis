import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { saveSession, loadSession } from '../src/sessions.mjs';

// A crash (kill -9, power loss) mid-tool-call leaves a session file whose last
// assistant message has tool calls with no results, or only some of them.
// Resuming must send a request the provider accepts, for every protocol.

const REPLIES = {
  'openai-compatible': () => ({ choices: [{ message: { role: 'assistant', content: 'Resumed.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  'openai-responses': () => ({ id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Resumed.' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
  anthropic: () => ({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Resumed.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
};

async function provider(t, protocol) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(REPLIES[protocol]()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { requests, config: { protocol, baseURL: protocol === 'anthropic' ? base : base + '/v1', model: protocol === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-5', apiKey: 'test-key', maxSteps: 4 } };
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// Every tool call is answered exactly once, right after the message that made it.
function assertValid(protocol, body) {
  if (protocol === 'openai-compatible') {
    const messages = body.messages;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === 'tool') assert.fail('orphan tool result ' + message.tool_call_id);
      if (message.role !== 'assistant' || !message.tool_calls || !message.tool_calls.length) continue;
      const ids = message.tool_calls.map((item) => item.id).sort();
      const answers = [];
      while (messages[i + 1] && messages[i + 1].role === 'tool') answers.push(messages[++i].tool_call_id);
      assert.deepEqual(answers.sort(), ids);
    }
    assert.equal(messages.at(-1).role, 'user');
    return;
  }
  if (protocol === 'openai-responses') {
    const calls = body.input.filter((item) => item.type === 'function_call').map((item) => item.call_id);
    const outputs = body.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id);
    assert.deepEqual([...outputs].sort(), [...calls].sort());
    for (const id of calls) {
      assert.ok(body.input.findIndex((item) => item.type === 'function_call' && item.call_id === id) < body.input.findIndex((item) => item.type === 'function_call_output' && item.call_id === id));
    }
    assert.equal(body.input.at(-1).role, 'user');
    return;
  }
  const messages = body.messages;
  assert.equal(messages[0].role, 'user');
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (i) assert.notEqual(message.role, messages[i - 1].role, 'roles alternate');
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    for (const block of blocks) if (block.type === 'text') assert.ok(String(block.text).trim(), 'no empty text block');
    const uses = blocks.filter((block) => block.type === 'tool_use').map((block) => block.id);
    const results = blocks.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id);
    if (results.length) {
      const previous = messages[i - 1];
      const asked = (Array.isArray(previous.content) ? previous.content : []).filter((block) => block.type === 'tool_use').map((block) => block.id);
      assert.deepEqual([...results].sort(), [...asked].sort(), 'tool results answer the previous message');
    }
    if (uses.length) {
      const next = messages[i + 1];
      assert.ok(next && Array.isArray(next.content), 'tool_use is followed by results');
      assert.deepEqual(next.content.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id).sort(), [...uses].sort());
    }
  }
  assert.equal(messages.at(-1).role, 'user');
}

const crashes = {
  'no results': [
    { role: 'user', content: 'Look at both files.' },
    { role: 'assistant', content: '', tool_calls: [call('call_a', 'read_file', { path: 'a.txt' }), call('call_b', 'read_file', { path: 'b.txt' })] }
  ],
  'one of two results': [
    { role: 'user', content: 'Look at both files.' },
    { role: 'assistant', content: 'Reading.', tool_calls: [call('call_a', 'read_file', { path: 'a.txt' }), call('call_b', 'read_file', { path: 'b.txt' })] },
    { role: 'tool', tool_call_id: 'call_a', name: 'read_file', content: '{"content":"a"}' }
  ]
};

for (const protocol of Object.keys(REPLIES)) {
  for (const [label, tail] of Object.entries(crashes)) {
    test(protocol + ': resuming a session saved mid-tool-call (' + label + ') sends a valid request', async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-crash-resume-'));
      const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: root };
      t.after(() => rm(root, { recursive: true, force: true }));
      const { config, requests } = await provider(t, protocol);
      // Write the file as a crash would leave it.
      const first = await createSession({ root, config, env, permissionMode: 'bypassPermissions' });
      first.messages.push({ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' });
      const saved = await saveSession(first, { env });
      closeSession(first);
      const payload = JSON.parse(await readFile(saved.path, 'utf8'));
      payload.messages = [payload.messages[0], ...tail];
      if (protocol === 'openai-responses') {
        payload.messages[2].responseItems = [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          ...payload.messages[2].tool_calls.map((item) => ({ type: 'function_call', id: 'fc_' + item.id, call_id: item.id, name: item.function.name, arguments: item.function.arguments }))
        ];
      }
      await writeFile(saved.path, JSON.stringify(payload));

      const restored = await loadSession(root, saved.id, { env });
      const session = await createSession({ root, config, env, restore: restored, permissionMode: 'bypassPermissions' });
      t.after(() => closeSession(session));
      const result = await runAgentTurn(session, 'Please continue.', {});
      assert.equal(result.text, 'Resumed.');
      assert.equal(requests.length, 1);
      assertValid(protocol, requests[0].body);
    });
  }
}
