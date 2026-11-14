import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

test('a specialist review can read several files before reporting', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-specialist-room-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 8; i++) await writeFile(path.join(root, 'f' + i + '.js'), 'export const v' + i + ' = ' + i + ';\n');
  const usage = { prompt_tokens: 6000, completion_tokens: 50, total_tokens: 6050 };
  const reads = Array.from({ length: 8 }, (_, i) => ({ ...toolCall('s' + i, 'read_file', { path: 'f' + i + '.js' }), usage }));
  const { config, requests } = await scriptedModel(t, [
    toolCall('p1', 'run_specialist_review', { specialist: 'code-review', task: 'Review all eight modules.' }),
    ...reads,
    { content: 'Reviewed f0-f7: no issues.', usage },
    { content: 'The review found no issues.' }
  ]);
  const session = await createSession({ root, config: { ...config, maxSteps: 20 }, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'Get a code review.', { approval: async () => true });
  assert.equal(result.text, 'The review found no issues.');
  const tool = requests.at(-1).messages.find((m) => m.role === 'tool' && m.content.includes('"specialist"'));
  const review = JSON.parse(tool.content);
  assert.equal(review.review, 'Reviewed f0-f7: no issues.');
  assert.equal(review.finished, true);
  assert.equal(review.verificationIncomplete, false);
  assert.equal(review.toolCalls, 8);
});
