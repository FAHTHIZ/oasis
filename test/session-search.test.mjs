import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveSession } from '../src/sessions.mjs';
import { searchSessions, formatSessionSearch, runSessionSearchTool, tokenize, SESSION_SEARCH_TOOL_DEFINITION } from '../src/session-search.mjs';
import { executeTool } from '../src/tools.mjs';

const chat = (root, user, assistant) => ({ root, config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: user }, { role: 'assistant', content: assistant }] });

test('session search ranks matching conversations, excludes the current one and redacts secrets', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-recall-'));
  const root = path.join(base, 'proj'); await mkdir(root);
  const env = { OASIS_CONFIG_DIR: path.join(base, 'config') };
  try {
    const a = await saveSession(chat(root, 'Fix the flaky websocket reconnect test', 'The reconnect backoff was missing jitter; added jitter and a fake clock. Key sk-ant-api03-' + 'x'.repeat(40)), { env });
    const b = await saveSession(chat(root, 'Add dark mode', 'Added a theme toggle in settings.'), { env });
    const found = await searchSessions(root, 'websocket reconnect jitter', { env });
    assert.equal(found.searched, 2);
    assert.equal(found.results[0].sessionId, a.id);
    assert.ok(!found.results.some((item) => item.sessionId === b.id));
    assert.ok(!JSON.stringify(found).includes('x'.repeat(40)), 'secrets are redacted');
    const excluded = await searchSessions(root, 'websocket', { env, excludeId: a.id });
    assert.equal(excluded.results.length, 0);
    const userOnly = await searchSessions(root, 'jitter', { env, role: 'user' });
    assert.equal(userOnly.results.length, 0);
    assert.match(formatSessionSearch(found, 'websocket'), /oasis --resume/);
    assert.match(await runSessionSearchTool({ query: 'dark mode' }, { root, env }), new RegExp(b.id));
    assert.match(await executeTool('session_search', { query: 'theme toggle' }, { root, env }), new RegExp(b.id));
    await assert.rejects(() => searchSessions(root, 'the and of', { env }), /keyword/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('session search scope all covers other workspaces; workspace scope does not', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-recall-all-'));
  const one = path.join(base, 'one'); const two = path.join(base, 'two');
  await mkdir(one); await mkdir(two);
  const env = { OASIS_CONFIG_DIR: path.join(base, 'config') };
  try {
    await saveSession(chat(two, 'Migrate postgres schema', 'Wrote the migration.'), { env });
    assert.equal((await searchSessions(one, 'postgres', { env })).results.length, 0);
    const all = await searchSessions(one, 'postgres', { env, scope: 'all' });
    assert.equal(all.results.length, 1);
    assert.equal(path.resolve(all.results[0].workspace), path.resolve(two));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('session search tool schema is strict and tokenizer drops stop words', () => {
  assert.equal(SESSION_SEARCH_TOOL_DEFINITION.function.parameters.additionalProperties, false);
  assert.deepEqual(tokenize('The Websocket and the API'), ['websocket', 'api']);
});
