import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { saveMemory, listMemories, rankMemories, redactSecrets, memoryIndexPrompt, recallForPrompt, deleteMemory, memoryRoots, runMemoryTool } from '../src/auto-memory.mjs';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mem-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function setup(t) {
  const root = await tmp(t);
  const home = await tmp(t);
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: home, HOME: home, OASIS_AUTO_MEMORY: '' } };
}

test('secrets and private text are redacted', () => {
  const { text, redacted } = redactSecrets('key sk-ant-abcdefghijklmnopqrstu and ghp_abcdefghijklmnopqrstuvwxyz12 token=hunter2secret <private>my address</private> https://bob:pw123@example.com/x');
  assert.ok(redacted);
  assert.doesNotMatch(text, /abcdefghijklmnop|hunter2|my address|pw123/);
  assert.match(text, /token=\[redacted\]/);
  assert.match(text, /https:\/\/bob:\[redacted\]@example.com/);
});

test('saving creates Markdown files and an index, and merges duplicates', async (t) => {
  const { root, env } = await setup(t);
  const first = await saveMemory(root, { name: 'Test command', description: 'Run tests with npm run test:unit', content: 'Use npm run test:unit; npm test also runs slow e2e.', category: 'project' }, { env });
  assert.equal(first.action, 'created');
  assert.equal(first.id, 'project:project/test-command');
  const again = await saveMemory(root, { name: 'Test command', content: 'Use npm run test:unit; npm test also runs slow e2e.' }, { env });
  assert.equal(again.action, 'unchanged');
  const merged = await saveMemory(root, { name: 'test command', content: 'CI uses node 22.' }, { env });
  assert.equal(merged.action, 'updated');
  const [only] = await listMemories(root, { env });
  assert.match(only.content, /test:unit[\s\S]*node 22/);
  const index = await readFile(path.join(memoryRoots(root, env).project, 'MEMORY.md'), 'utf8');
  assert.match(index, /\[Test command\]\(project\/test-command\.md\)/);
  await saveMemory(root, { name: 'Prefers tabs', content: 'The user wants tabs, never spaces.', scope: 'user' }, { env });
  assert.equal((await listMemories(root, { env })).length, 2);
  assert.equal((await listMemories(root, { env, scope: 'user' }))[0].category, 'preferences');
  await deleteMemory(root, 'prefers-tabs', { env });
  assert.equal((await listMemories(root, { env })).length, 1);
  await assert.rejects(saveMemory(root, { name: '', content: 'x' }, { env }), /short name/);
});

test('BM25 ranking finds the relevant memory', async (t) => {
  const { root, env } = await setup(t);
  await saveMemory(root, { name: 'Database', content: 'Postgres 16 runs in docker compose; migrations use prisma migrate deploy.', category: 'project' }, { env });
  await saveMemory(root, { name: 'Deploy', content: 'Deploys go through Fly.io with fly deploy from main only.', category: 'decisions' }, { env });
  await saveMemory(root, { name: 'Styling', content: 'Tailwind with the shared tokens file.', category: 'project' }, { env });
  const ranked = rankMemories(await listMemories(root, { env }), 'add a migration to the postgres database');
  assert.equal(ranked[0].memory.name, 'Database');
  const recalled = await recallForPrompt(root, 'how do we deploy this?', { env });
  assert.equal(recalled.ids[0], 'project:decisions/deploy');
  assert.match(recalled.text, /fly deploy/);
  assert.equal((await listMemories(root, { env })).find((m) => m.name === 'Deploy').recalls, 1);
  assert.equal((await recallForPrompt(root, 'unrelated question about bananas', { env })).ids.length, 0);
  const prompt = await memoryIndexPrompt(root, { env });
  assert.match(prompt, /project:decisions\/deploy \(Deploy\)/);
  const found = await runMemoryTool('memory_search', { query: 'tailwind' }, { root, env });
  assert.equal(found.results[0].name, 'Styling');
});

test('sessions see the index, recall memories per prompt, and save through tools', async (t) => {
  const { root, env } = await setup(t);
  await saveMemory(root, { name: 'Package manager', description: 'Use pnpm, not npm', content: 'This repo uses pnpm workspaces; npm install breaks the lockfile.' }, { env });
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'memory_save', { name: 'Release day', content: 'Releases happen on Fridays after QA signs off.', category: 'decisions' }),
    { content: 'saved' }
  ]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  assert.match(session.messages[0].content, /Use pnpm, not npm/);
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'memory_save'));
  await runAgentTurn(session, 'install the lodash package for me', { env, autoApprove: false, approval: async () => false });
  assert.match(requests[0].messages.at(-1).content, /<recalled-memories[\s\S]*pnpm workspaces/);
  assert.ok((await listMemories(root, { env })).some((m) => m.name === 'Release day'));
  const listing = (await runBuiltinCommand('memory', '', { root, session, env })).output;
  assert.match(listing, /Auto memory \(on\): 2 saved/);
  assert.match((await runBuiltinCommand('memory', 'search friday releases', { root, session, env })).output, /release-day/);
  assert.match((await runBuiltinCommand('memory', 'add user: always answer in short sentences', { root, session, env })).output, /created: user:preferences/);
  assert.ok((await runBuiltinCommand('remember', 'testing', { root, session, env })).prompt.includes('focusing on: testing'));
});

test('auto memory can be turned off', async (t) => {
  const { root, env } = await setup(t);
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, env: { ...env, OASIS_AUTO_MEMORY: '0' } });
  t.after(() => closeSession(session));
  assert.ok(!session.toolDefinitions.some((tool) => tool.function.name === 'memory_save'));
  assert.doesNotMatch(session.messages[0].content, /Auto memory/);
});

test('settings can turn auto memory off, even untrusted', async (t) => {
  const { root, env } = await setup(t);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ autoMemory: false }));
  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  assert.equal(session.autoMemory, undefined);
});
