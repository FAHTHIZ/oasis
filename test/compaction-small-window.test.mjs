import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, closeSession, compactHistoryIfNeeded } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const sent = (request) => request.messages.map((m) => String(m.content || '')).join('').length;

for (const contextWindow of [8192, 16384]) {
  test('the compaction summary request fits a ' + contextWindow + '-token window', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-compact-small-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { config, requests } = await scriptedModel(t, [{ content: 'SUMMARY' }]);
    const session = await createSession({ root, config: { ...config, contextWindow }, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
    t.after(() => closeSession(session));
    for (let i = 0; i < 60; i++) session.messages.push({ role: 'user', content: 'ask ' + i + ' ' + 'u'.repeat(900) }, { role: 'assistant', content: 'answer ' + i + ' ' + 'a'.repeat(900) });
    const result = await compactHistoryIfNeeded(session, { force: true });
    assert.equal(result.compacted, true);
    assert.ok(sent(requests[0]) < contextWindow * 4 * 0.75, 'sent ' + sent(requests[0]) + ' characters');
    assert.match(requests[0].messages.at(-1).content, /answer 59 /);
  });
}
