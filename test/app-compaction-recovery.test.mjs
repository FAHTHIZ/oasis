// The browser app's agent: a provider "context too long" error compacts and
// retries instead of failing; a failed summary falls back to a digest instead
// of wiping the history; long transcripts keep the original request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, Workspace } from '../app/core/workspace.mjs';
import { Agent, isContextOverflow } from '../app/core/agent.mjs';

async function agentWith(chatImpl, config = { mode: 'edits' }) {
  const ws = await Workspace.create(new MemoryStore(), { name: 'demo', files: [] });
  const events = [];
  const agent = new Agent({ getConfig: () => config, getContext: () => ({ workspace: ws }), approve: async () => true, onEvent: (e) => events.push(e), chatImpl });
  return { agent, events };
}

const history = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: (i === 0 ? 'ORIGINAL GOAL: port the parser. ' : '') + 'x'.repeat(3000) }));

test('context overflow errors are recognised', () => {
  assert.equal(isContextOverflow(Object.assign(new Error('prompt is too long: 210000 tokens > 200000 maximum'), { status: 400 })), true);
  assert.equal(isContextOverflow(Object.assign(new Error("This model's maximum context length is 8192 tokens."), { status: 400 })), true);
  assert.equal(isContextOverflow(Object.assign(new Error('The provider rejected the API key (401).'), { status: 401 })), false);
});

test('a context-length error compacts the history and asks again', async () => {
  let calls = 0;
  const { agent, events } = await agentWith(async (_config, request) => {
    calls++;
    if (!request.tools.length) return { content: 'Summary: porting the parser.', tool_calls: [] };
    if (calls === 1) throw Object.assign(new Error('prompt is too long: 300000 tokens > 200000 maximum'), { status: 400 });
    return { content: 'Finished.', tool_calls: [] };
  });
  agent.load(history(20));
  assert.equal(await agent.send('continue'), 'Finished.');
  assert.ok(events.some((e) => e.type === 'context_overflow'));
  assert.ok(events.some((e) => e.type === 'compacted'));
});

test('a failed summary falls back to a digest that keeps the user requests', async () => {
  const { agent, events } = await agentWith(async (_config, request) => {
    if (!request.tools.length) throw new Error('summary model unavailable');
    return { content: 'ok', tool_calls: [] };
  }, { mode: 'edits', contextChars: 10000 });
  agent.load(history(20));
  assert.equal(await agent.send('continue'), 'ok');
  assert.ok(events.some((e) => e.type === 'compaction_error'));
  assert.ok(events.some((e) => e.type === 'compacted' && e.mode === 'digest'));
  assert.match(agent.messages[0].content, /ORIGINAL GOAL: port the parser/);
});

test('a long transcript sent for summary keeps its beginning', async () => {
  let transcript = '';
  const { agent } = await agentWith(async (_config, request) => {
    if (!request.tools.length) { transcript = request.messages.at(-1).content; return { content: 'Summary.', tool_calls: [] }; }
    return { content: 'ok', tool_calls: [] };
  }, { mode: 'edits', contextChars: 10000 });
  agent.load(history(80));
  await agent.send('continue');
  assert.match(transcript, /ORIGINAL GOAL: port the parser/);
  assert.match(transcript, /characters of the middle of the session left out/);
});
