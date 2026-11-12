import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { compactSystemPrompt, systemPrompt } from '../src/system-prompt.mjs';
import { buildTimeline } from '../app/core/timeline.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NARRATION = ['I\u2019ll read the notes file to see what it says.', 'I\u2019ll read it once more to check the second line.'];

// Each provider streams one narration sentence, waits, then sends a tool
// call. The narration must reach onDelta before the tool call is even sent,
// so the page shows it while the model is still writing the call.
const PROVIDERS = {
  'openai-compatible': {
    path: '/v1',
    async step(res, index, mark) {
      const sse = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      if (index < NARRATION.length) {
        sse({ choices: [{ delta: { content: NARRATION[index] } }] });
        await pause(150);
        mark();
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + index, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) } }] } }] });
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        sse({ choices: [{ delta: { content: 'The notes say hello.' } }] });
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    }
  },
  anthropic: {
    path: '',
    async step(res, index, mark) {
      const ev = (obj) => res.write('event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n');
      ev({ type: 'message_start', message: { id: 'm' + index, model: 'fixture', usage: { input_tokens: 3, output_tokens: 0 } } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      if (index < NARRATION.length) {
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: NARRATION[index] } });
        ev({ type: 'content_block_stop', index: 0 });
        await pause(150);
        mark();
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_' + index, name: 'read_file', input: {} } });
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'notes.txt' }) } });
        ev({ type: 'content_block_stop', index: 1 });
        ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
      } else {
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The notes say hello.' } });
        ev({ type: 'content_block_stop', index: 0 });
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
      }
      ev({ type: 'message_stop' });
      res.end();
    }
  }
};

test('the system prompt asks for one short sentence before each batch of tool calls', () => {
  for (const prompt of [systemPrompt('/tmp/x', ''), compactSystemPrompt('/tmp/x', '')]) {
    assert.match(prompt, /Before each batch of tool calls, write one short first-person sentence \(under 25 words\)/);
    assert.match(prompt, /Do not repeat earlier narration/);
    assert.match(prompt, /Give the final answer separately/);
  }
});

for (const [protocol, provider] of Object.entries(PROVIDERS)) {
  test('narration streams before its tool call through ' + protocol, async (t) => {
    const log = [];
    const systems = [];
    let requests = 0;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      systems.push(protocol === 'anthropic' ? JSON.stringify(parsed.system) : String((parsed.messages || [])[0]?.content || ''));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const index = requests++;
      await provider.step(res, index, () => log.push({ type: 'server_sent_tool', index }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-narration-'));
    await writeFile(path.join(root, 'notes.txt'), 'hello\nsecond line\n');
    const config = { protocol, baseURL: 'http://127.0.0.1:' + server.address().port + provider.path, model: 'fixture', apiKey: 'test-key', configured: true, maxSteps: 6, maxToolCalls: 6, maxTokens: 100000 };
    const session = await createSession({ root, config, permissionMode: 'bypassPermissions', bare: true });
    t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });

    let shown = '';
    const result = await runAgentTurn(session, 'what do the notes say?', {
      onDelta: (text) => { if (text && text !== shown) { log.push({ type: 'delta', text }); shown = text; } },
      onToolStart: ({ name }) => { shown = ''; log.push({ type: 'tool_start', name }); },
      onToolResult: ({ name }) => log.push({ type: 'tool_result', name })
    });
    assert.equal(result.text, 'The notes say hello.');
    assert.ok(systems.every((system) => /Before each batch of tool calls/.test(system)), 'every request carries the narration instruction');

    for (let index = 0; index < NARRATION.length; index++) {
      const said = log.findIndex((entry) => entry.type === 'delta' && entry.text === NARRATION[index]);
      const sent = log.findIndex((entry) => entry.type === 'server_sent_tool' && entry.index === index);
      assert.ok(said >= 0, 'narration ' + index + ' was streamed');
      assert.ok(said < sent, 'narration ' + index + ' reached the page before the tool call was sent');
    }
    // As the page sees it: prose, step, prose, step, answer, never prose folded into a group.
    const entries = [];
    let text = '';
    let tools = [];
    const flush = () => { if (text || tools.length) entries.push({ role: 'assistant', content: text, tools }); text = ''; tools = []; };
    for (const entry of log) {
      if (entry.type === 'delta') { if (tools.length) flush(); text = entry.text; }
      if (entry.type === 'tool_start') tools.push({ id: 't' + entries.length, name: entry.name, ok: true, startedAt: 1, endedAt: 2 });
    }
    flush();
    const kinds = buildTimeline(entries).map((block) => block.type);
    assert.deepEqual(kinds, ['text', 'group', 'text', 'group', 'text']);
  });
}
