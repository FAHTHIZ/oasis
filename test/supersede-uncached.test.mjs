// A provider that never reports cached tokens gains nothing from keeping the
// history prefix unchanged, so stale tool results are replaced on every step
// rather than only once the history reaches half the context window.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const body = Array.from({ length: 80 }, (_, i) => 'line ' + i + ' of the file').join('\n') + '\n';

async function run(t, usage) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-supersede-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), body);
  const { config, requests } = await scriptedModel(t, [
    { ...toolCall('r1', 'read_file', { path: 'a.txt' }), usage },
    { ...toolCall('e1', 'edit_file', { path: 'a.txt', old_string: 'line 3 of the file', new_string: 'line three of the file' }), usage },
    { ...toolCall('r2', 'read_file', { path: 'a.txt' }), usage },
    { ...toolCall('l1', 'list_files', {}), usage },
    { content: 'Done.', usage }
  ]);
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  await runAgentTurn(session, 'Fix line 3.', { approval: async () => true, env: { ...process.env, OASIS_CONTEXT_WINDOW: '1000000' } });
  const last = requests[requests.length - 1].messages;
  const firstRead = last.find((message) => message.role === 'tool' && message.tool_call_id === 'r1');
  return String(firstRead && firstRead.content);
}

test('without cache hits, an older read of a re-read file is replaced early', async (t) => {
  const content = await run(t, { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 });
  assert.match(content, /"superseded":true/, content.slice(0, 200));
});

test('with cache hits, the history prefix is left alone in a roomy window', async (t) => {
  const content = await run(t, { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910, prompt_tokens_details: { cached_tokens: 800 } });
  assert.doesNotMatch(content, /"superseded":true/);
  assert.match(content, /line 79 of the file/);
});
