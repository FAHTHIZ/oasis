import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  addMustPreserve,
  appendMustPreserveContext,
  createCompactionPreview,
  compactionPreviewIsCurrent,
  sanitizeMustPreserve
} from '../src/context.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { PermissionPolicy } from '../src/permissions.mjs';
import { loadSession, saveSession } from '../src/sessions.mjs';

test('context preservation records are bounded, normalized, and retained in summary text', () => {
  const session = { mustPreserve: [] };
  addMustPreserve(session, 'goal', 'Keep the API response shape backwards compatible.');
  addMustPreserve(session, 'path', 'src/api.ts');
  addMustPreserve(session, 'unknown-kind', 'Never remove access checks.');
  addMustPreserve(session, 'goal', 'Keep the API response shape backwards compatible.');
  assert.deepEqual(session.mustPreserve.map((item) => item.kind), ['goal', 'path', 'rule']);
  const block = appendMustPreserveContext('A concise summary.', session.mustPreserve);
  assert.match(block, /Keep the API response shape backwards compatible/);
  assert.match(block, /\[path\] src\/api\.ts/);
  assert.match(block, /\[rule\] Never remove access checks/);
  assert.deepEqual(sanitizeMustPreserve([{ kind: 'goal', text: 'x'.repeat(2000) }])[0].text.length, 600);
});

test('compaction preview identifies summarization scope, paths, large messages, and redacts secrets', () => {
  const session = {
    messages: [
      { role: 'system', content: 'Base prompt' },
      { role: 'user', content: 'Fix src/api.ts and keep the API stable.' },
      { role: 'tool', name: 'read_file', content: ('const apiKey = sk-abcdefghijklmnopqrstuvwxyz1234567890; '.repeat(80)) },
      { role: 'assistant', content: 'The type check failed; rerun verification.' }
    ],
    mustPreserve: [{ kind: 'goal', text: 'Keep the API stable.' }]
  };
  const preview = createCompactionPreview(session, 'focus on API correctness');
  assert.equal(preview.focus, 'focus on API correctness');
  assert.equal(preview.summarizedMessages, 3);
  assert.equal(preview.byRole.user, 1);
  assert.equal(preview.byRole.tool, 1);
  assert.ok(preview.beforeTokens > preview.systemTokens);
  assert.ok(preview.largestMessages.length);
  assert.ok(preview.recentPaths.includes('src/api.ts'));
  assert.ok(preview.largestMessages.every((item) => !item.preview.includes('sk-abcdefghijklmnopqrstuvwxyz1234567890')));
  assert.match(preview.mustPreserve[0].text, /Keep the API stable/);
});

test('/compact previews first and cancel leaves history untouched; preserve records can be listed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-context-control-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-context-home-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  const session = {
    root,
    sessionId: randomUUID(),
    config: { model: 'gpt-5' },
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Fix src/api.ts' },
      { role: 'assistant', content: 'I will inspect src/api.ts.' },
      { role: 'user', content: 'Keep this endpoint backwards compatible.' }
    ],
    mustPreserve: [],
    permissions: new PermissionPolicy({ permissions: {} }),
    hooks: {}
  };
  const original = JSON.stringify(session.messages);
  const state = { root, env, session, sessionOptions: {} };
  const preview = await runBuiltinCommand('compact', 'focus on API compatibility', state);
  assert.match(preview.output, /COMPACTION PREVIEW/);
  assert.match(preview.output, /\/compact confirm/);
  assert.equal(JSON.stringify(session.messages), original);
  const added = await runBuiltinCommand('compact', 'preserve goal: Keep API behavior stable.', state);
  assert.match(added.output, /Must-preserve record saved/);
  const listed = await runBuiltinCommand('compact', 'preserve list', state);
  assert.match(listed.output, /Keep API behavior stable/);
  const cancelled = await runBuiltinCommand('compact', 'cancel', state);
  assert.match(cancelled.output, /history is unchanged/);
  assert.equal(JSON.stringify(session.messages), original);

  await runBuiltinCommand('compact', 'preview API compatibility', state);
  session.messages[1].content = 'The conversation changed while the preview was open.';
  const changed = JSON.stringify(session.messages);
  const stale = await runBuiltinCommand('compact', 'confirm', state);
  assert.match(stale.output, /conversation changed after this preview/i);
  assert.equal(JSON.stringify(session.messages), changed, 'stale confirmation must not mutate history');
  assert.equal(session.pendingCompactionPreview, undefined);
});

test('compaction preview becomes stale when conversation history changes', () => {
  const session = {
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Keep src/api.ts backwards compatible.' }
    ]
  };
  const preview = createCompactionPreview(session, 'API compatibility');
  assert.equal(compactionPreviewIsCurrent(session, preview), true);
  session.messages[1].content = 'Actually, remove the old API.';
  assert.equal(compactionPreviewIsCurrent(session, preview), false);
});

test('must-preserve records survive session save and resume', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-preserve-session-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-preserve-home-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  const id = randomUUID();
  const session = {
    root, sessionId: id, sessionName: 'preserve test',
    config: { protocol: 'openai-compatible', model: 'test-model', baseURL: 'http://localhost' },
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'start' }],
    todos: [], sharedTasks: null,
    mustPreserve: [{ kind: 'error', text: 'TS2322 in src/api.ts must be resolved.' }]
  };
  await saveSession(session, { env });
  const restored = await loadSession(root, id, { env });
  assert.deepEqual(restored.mustPreserve, session.mustPreserve);
});
