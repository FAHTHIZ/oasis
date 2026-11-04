import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { runMemoryTool, listMemories, listPendingMemoryWrites, memoryWriteApproval, saveMemory } from '../src/auto-memory.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { loadSettings } from '../src/settings.mjs';

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-memapp-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj');
  await mkdir(root);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'cfg'), XDG_CONFIG_HOME: path.join(base, 'xdg'), HOME: base, OASIS_MEMORY_WRITE_APPROVAL: '' };
  return { root, env, base };
}

test('memoryWriteApproval reads env then settings and defaults to off', () => {
  assert.equal(memoryWriteApproval({}, {}), 'off');
  assert.equal(memoryWriteApproval({ memoryWriteApproval: 'queue' }, {}), 'queue');
  assert.equal(memoryWriteApproval({ memoryWriteApproval: 'queue' }, { OASIS_MEMORY_WRITE_APPROVAL: 'ask' }), 'ask');
  assert.equal(memoryWriteApproval({ memoryWriteApproval: 'bogus' }, {}), 'off');
});

test('ask mode prompts for memory_save and memory_delete; a refusal saves nothing', async (t) => {
  const { root, env } = await setup(t);
  const session = { settings: { memoryWriteApproval: 'ask' }, sessionId: 's1' };
  const asked = [];
  const refused = await runMemoryTool('memory_save', { name: 'Uses pnpm', content: 'Project uses pnpm, token=abcdef123456' }, { root, env, session, approval: async (m) => { asked.push(m); return false; } });
  assert.equal(refused.approved, false);
  assert.match(asked[0], /save project memory "Uses pnpm"/);
  assert.doesNotMatch(asked[0], /abcdef123456/);
  assert.equal((await listMemories(root, { env })).length, 0);
  const saved = await runMemoryTool('memory_save', { name: 'Uses pnpm', content: 'Project uses pnpm' }, { root, env, session, approval: async () => true });
  assert.equal(saved.action, 'created');
  const del = await runMemoryTool('memory_delete', { id: saved.id }, { root, env, session, approval: async () => false });
  assert.equal(del.approved, false);
  assert.equal((await listMemories(root, { env })).length, 1);
});

test('queue mode stores pending writes that /memory approve and reject resolve', async (t) => {
  const { root, env } = await setup(t);
  const session = { settings: { memoryWriteApproval: 'queue' }, sessionId: 's2' };
  const first = await runMemoryTool('memory_save', { name: 'Deploy target', content: 'Deploys go to Fly.io' }, { root, env, session });
  const second = await runMemoryTool('memory_save', { name: 'Wrong fact', content: 'Something false' }, { root, env, session });
  assert.ok(first.queued && first.pending_id);
  assert.equal((await listMemories(root, { env })).length, 0);
  assert.equal((await listPendingMemoryWrites(root, { env })).length, 2);
  const listing = await runBuiltinCommand('memory', 'pending', { root, env, session });
  assert.match(listing.output, /Deploy target/);
  assert.match((await runBuiltinCommand('memory', 'reject ' + second.pending_id, { root, env, session })).output, /rejected/);
  assert.match((await runBuiltinCommand('memory', 'approve all', { root, env, session })).output, /created/);
  const items = await listMemories(root, { env });
  assert.deepEqual(items.map((m) => m.name), ['Deploy target']);
  assert.match((await runBuiltinCommand('memory', 'pending', { root, env, session })).output, /No memory writes/);
  // ask mode without anyone to ask (headless) queues instead of saving silently.
  const headless = await runMemoryTool('memory_save', { name: 'Headless', content: 'x' }, { root, env, session: { settings: { memoryWriteApproval: 'ask' } } });
  assert.ok(headless.queued);
  // User commands are never gated.
  await saveMemory(root, { name: 'Direct', content: 'by the user' }, { env });
  assert.equal((await listMemories(root, { env })).length, 2);
});

test('settings loader keeps memoryWriteApproval, autoCommit and optional tool switches', async (t) => {
  const { root, env } = await setup(t);
  await mkdir(path.join(env.OASIS_CONFIG_DIR), { recursive: true });
  await writeFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), JSON.stringify({ memoryWriteApproval: 'queue', autoCommit: true, executeCode: false, sessionSearch: false, imageGeneration: { model: 'dall-e-3', baseUrl: 'https://img.example/v1' } }));
  const settings = await loadSettings(root, { env });
  assert.equal(settings.memoryWriteApproval, 'queue');
  assert.equal(settings.autoCommit, true);
  assert.equal(settings.executeCode, false);
  assert.equal(settings.sessionSearch, false);
  assert.deepEqual(settings.imageGeneration, { model: 'dall-e-3', baseUrl: 'https://img.example/v1' });
});
