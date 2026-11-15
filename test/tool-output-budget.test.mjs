// Budget pruning of old tool output (OpenCode's PRUNE_PROTECT/PRUNE_MINIMUM):
// the newest tool output stays, older bulk becomes re-run stubs, and only
// when the saving is large enough to be worth rebuilding the cached prefix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneOldToolOutput, toolOutputPruneSettings } from '../src/context.mjs';

const blob = (n) => Array.from({ length: n }, (_, i) => 'const value' + i + ' = compute(' + i + ');').join('\n');

function history(count, size) {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'c' + i, name: 'read_file', content: blob(size) });
  }
  return messages;
}

test('keeps everything while tool output fits the budget', () => {
  const messages = history(4, 200);
  const result = pruneOldToolOutput(messages, { protectTokens: 40_000, minimumTokens: 20_000 });
  assert.equal(result.pruned, 0);
  assert.equal(result.messages, messages);
});

test('stubs the oldest outputs beyond the budget and keeps the newest intact', () => {
  const messages = history(12, 600);
  const result = pruneOldToolOutput(messages, { protectTokens: 20_000, minimumTokens: 5_000 });
  assert.ok(result.pruned > 0 && result.savedTokens >= 5_000, JSON.stringify({ pruned: result.pruned, saved: result.savedTokens }));
  const tools = result.messages.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /^\[Older tool output compacted/);
  assert.equal(tools.at(-1).content, blob(600));
  assert.equal(result.messages.length, messages.length, 'call/result pairs stay');
  assert.equal(messages.filter((m) => m.role === 'tool')[0].content, blob(600), 'input is not mutated');
});

test('does nothing when the saving is below the minimum', () => {
  const messages = history(12, 600);
  assert.equal(pruneOldToolOutput(messages, { protectTokens: 20_000, minimumTokens: 1_000_000 }).pruned, 0);
});

test('checklists and skills are never pruned', () => {
  const messages = history(12, 600);
  messages[3] = { ...messages[3], name: 'load_skill' };
  const result = pruneOldToolOutput(messages, { protectTokens: 20_000, minimumTokens: 5_000 });
  assert.equal(result.messages[3].content, blob(600));
});

test('settings: on by default at 40K/20K, off with OASIS_PRUNE_PROTECT_TOKENS=0', () => {
  assert.deepEqual(toolOutputPruneSettings({}, {}), { protectTokens: 40_000, minimumTokens: 20_000 });
  assert.equal(toolOutputPruneSettings({}, { OASIS_PRUNE_PROTECT_TOKENS: '0' }), null);
  assert.equal(toolOutputPruneSettings({ pruneToolOutputTokens: false }, {}), null);
  assert.deepEqual(toolOutputPruneSettings({}, { OASIS_PRUNE_PROTECT_TOKENS: '60000' }), { protectTokens: 60_000, minimumTokens: 30_000 });
});
