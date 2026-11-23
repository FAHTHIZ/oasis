import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { beliefConflicts, findMemory, listMemories, memoryIndexPrompt, recallForPrompt, runMemoryTool, saveMemory, verifyMemory } from '../src/auto-memory.mjs';
import { slotSubstitution, beliefConflict } from '../src/claim-conflict.mjs';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { createKnowledgeBoard, runKnowledgeTool } from '../src/knowledge-board.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rev-root-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rev-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: home, HOME: home, OASIS_AUTO_MEMORY: '', OASIS_MEMORY_WRITE_APPROVAL: 'off' } };
}

test('slot substitution: a new value in the same slot, but not a different relation or a list', () => {
  assert.equal(slotSubstitution('The test command is npm test.', 'The test command is pnpm vitest.').reason, '"npm test" vs "pnpm vitest"');
  assert.equal(slotSubstitution('The user prefers tabs for indentation.', 'The user prefers spaces for indentation.').reason, '"tabs" vs "spaces"');
  assert.equal(slotSubstitution('Deploy target: staging', 'Deploy target: production').reason, '"staging" vs "production"');
  assert.equal(slotSubstitution('The user is in Dhaka.', 'The user is a builder.'), null, 'different relation');
  assert.equal(slotSubstitution('Run lint before commit.', 'Run tests before commit.'), null, 'a list, not a revision');
  assert.equal(slotSubstitution('We use React for the UI.', 'We use React for the UI and Vite for builds.'), null, 'an addition');
  assert.equal(beliefConflict('The project uses Postgres 14.', 'The project uses Postgres 16.').kind, 'numbers');
  assert.deepEqual(beliefConflicts('Uses pnpm.\nThe test command is npm test.\nCI runs on push.', 'The test command is pnpm vitest.').map((item) => item.was), ['The test command is npm test.']);
});

test('a contradicting update revises the memory and keeps the old statement in its history', async (t) => {
  const { root, env } = await setup(t);
  await saveMemory(root, { name: 'Test command', content: 'The test command is npm test.\nCI runs on every push.', category: 'project' }, { env, source: 's1' });
  const revised = await saveMemory(root, { name: 'Test command', content: 'The test command is pnpm vitest.', evidence: 'package.json scripts.test' }, { env, source: 's2' });
  assert.equal(revised.action, 'updated');
  assert.deepEqual(revised.revised, [{ was: 'The test command is npm test.', now: 'The test command is pnpm vitest.', reason: '"npm test" vs "pnpm vitest"' }]);
  const memory = await findMemory(root, 'Test command', { env });
  assert.doesNotMatch(memory.content, /npm test\./, 'the old belief is gone from the body');
  assert.match(memory.content, /CI runs on every push/, 'unrelated statements are kept');
  assert.match(memory.content, /pnpm vitest/);
  assert.equal(memory.revisions.length, 1);
  assert.equal(memory.revisions[0].source, 's2');
  assert.equal(memory.revisions[0].evidence, 'package.json scripts.test');
  assert.equal(memory.evidence, 'package.json scripts.test');
  const read = await runMemoryTool('memory_read', { id: memory.id }, { root, env });
  assert.equal(read.revisions[0].was, 'The test command is npm test.');
  const recalled = await recallForPrompt(root, 'which test command runs the tests', { env });
  assert.match(recalled.text, /Revised \d{4}-\d\d-\d\d: was "The test command is npm test\." \("npm test" vs "pnpm vitest"\)/);
  assert.match(recalled.text, /Evidence when saved: package\.json scripts\.test/);
});

test('going back to a belief that was revised away marks it uncertain', async (t) => {
  const { root, env } = await setup(t);
  await saveMemory(root, { name: 'Indentation', content: 'The user prefers tabs for indentation.', scope: 'user' }, { env });
  await saveMemory(root, { name: 'Indentation', content: 'The user prefers spaces for indentation.', scope: 'user' }, { env });
  const back = await runMemoryTool('memory_save', { name: 'Indentation', content: 'The user prefers tabs for indentation.', scope: 'user' }, { root, env });
  assert.equal(back.flipflop, true);
  assert.match(back.note, /marked uncertain/);
  const memory = await findMemory(root, 'Indentation', { env });
  assert.equal(memory.verificationStatus, 'uncertain');
  assert.equal(memory.revisions.length, 2);
});

test('a new memory that contradicts another supersedes it; the old one leaves the index', async (t) => {
  const { root, env } = await setup(t);
  const old = await saveMemory(root, { name: 'Database', content: 'The project uses Postgres 14 in production.', category: 'project' }, { env });
  const fresh = await runMemoryTool('memory_save', { name: 'Production database version', content: 'The project uses Postgres 16 in production.', category: 'project' }, { root, env });
  assert.equal(fresh.action, 'created');
  assert.equal(fresh.superseded[0].id, old.id);
  assert.match(fresh.note, /Superseded project:project\/database .*14 vs 16/);
  const stale = await findMemory(root, old.id, { env });
  assert.equal(stale.verificationStatus, 'outdated');
  assert.equal(stale.supersededBy, fresh.id);
  assert.match(stale.verificationNote, /Superseded by .* "The project uses Postgres 14 in production\." is now "The project uses Postgres 16 in production\." \(14 vs 16\)/);
  const created = await findMemory(root, fresh.id, { env });
  assert.deepEqual(created.supersedes, [old.id]);
  const index = await memoryIndexPrompt(root, { env });
  assert.doesNotMatch(index, /Postgres 14/);
  const search = await runMemoryTool('memory_search', { query: 'postgres production' }, { root, env });
  assert.ok(search.results.some((item) => item.superseded_by === fresh.id));
});

test('a verified memory is not overturned by a bare assertion', async (t) => {
  const { root, env } = await setup(t);
  const saved = await saveMemory(root, { name: 'Deploy target', content: 'Deploy target: staging', category: 'decisions' }, { env });
  await verifyMemory(root, saved.id, { status: 'current', evidence: 'deploy.yml line 12', env });
  const refused = await runMemoryTool('memory_save', { name: 'Deploy target', content: 'Deploy target: production', category: 'decisions' }, { root, env });
  assert.equal(refused.action, 'conflict');
  assert.match(refused.note, /Not saved: this contradicts .*verified current on \d{4}-\d\d-\d\d \(deploy\.yml line 12\)/);
  assert.match((await findMemory(root, saved.id, { env })).content, /staging/);

  // Under another name it is kept, but as uncertain, and the verified one is untouched.
  const rival = await runMemoryTool('memory_save', { name: 'Where we deploy', content: 'Deploy target: production', category: 'decisions' }, { root, env });
  assert.equal(rival.action, 'created');
  assert.equal(rival.contested[0].id, saved.id);
  assert.equal((await findMemory(root, rival.id, { env })).verificationStatus, 'uncertain');
  assert.equal((await findMemory(root, saved.id, { env })).verificationStatus, 'current');

  // With evidence it goes through.
  const proven = await runMemoryTool('memory_save', { name: 'Deploy target', content: 'Deploy target: production', category: 'decisions', evidence: 'deploy.yml line 12 now says production (commit abc123)' }, { root, env });
  assert.equal(proven.action, 'updated');
  assert.equal(proven.revised[0].reason, '"staging" vs "production"');
});

test('memory_save from_finding carries the board finding and its provenance; contested findings wait', async (t) => {
  const { root, env } = await setup(t);
  const board = createKnowledgeBoard();
  const ledger = createEvidenceLedger();
  recordEvidence(ledger, { kind: 'fetch', tool: 'fetch_url', url: 'https://example.com/limits', numbers: ['500', '1000'] });
  const worker = { agentId: 'agent_1', knowledgeBoard: board, evidenceLedger: ledger, calibrationLedger: null };
  const rival = { agentId: 'agent_2', knowledgeBoard: board, evidenceLedger: ledger, calibrationLedger: null };
  const main = { agentId: '', knowledgeBoard: board, calibrationLedger: null };
  const good = runKnowledgeTool(worker, 'knowledge_post', { claim: 'The rate limits page is the source for the example API quotas.', sources: ['https://example.com/limits'] });
  const saved = await runMemoryTool('memory_save', { name: 'Example API quotas', from_finding: good.posted }, { root, env, session: main });
  assert.equal(saved.action, 'created');
  const memory = await findMemory(root, saved.id, { env });
  assert.match(memory.content, /rate limits page/);
  assert.match(memory.content, /Sources: https:\/\/example\.com\/limits/);
  assert.match(memory.evidence, /^knowledge board k_1 by agent_1 \(grounded.*\): https:\/\/example\.com\/limits/);

  const a = runKnowledgeTool(worker, 'knowledge_post', { claim: 'The example API allows 500 requests per minute per key.', sources: ['https://example.com/limits'] });
  runKnowledgeTool(rival, 'knowledge_post', { claim: 'The example API allows 1000 requests per minute per key.', sources: ['https://example.com/limits'] });
  await assert.rejects(runMemoryTool('memory_save', { name: 'Rate limit', from_finding: a.posted }, { root, env, session: main }), /contested by k_3.*Resolve the dispute/);
  runKnowledgeTool(main, 'knowledge_post', { retract: a.posted });
  await assert.rejects(runMemoryTool('memory_save', { name: 'Rate limit', from_finding: a.posted }, { root, env, session: main }), /was retracted/);
  await assert.rejects(runMemoryTool('memory_save', { name: 'Rate limit', from_finding: 'k_99' }, { root, env, session: main }), /Unknown finding k_99/);
  await assert.rejects(runMemoryTool('memory_save', { name: 'Nothing' }, { root, env, session: main }), /needs content/);
});

test('revision metadata survives the file format and plain additions still append', async (t) => {
  const { root, env } = await setup(t);
  await saveMemory(root, { name: 'Tooling', content: 'We use React for the UI.' }, { env });
  const added = await saveMemory(root, { name: 'Tooling', content: 'Vite builds the bundles.' }, { env });
  assert.equal(added.revised, undefined);
  const memory = (await listMemories(root, { env }))[0];
  assert.match(memory.content, /React[\s\S]*Vite/);
  await saveMemory(root, { name: 'Tooling', content: 'We use Svelte for the UI.' }, { env });
  const raw = await readFile((await findMemory(root, 'Tooling', { env })).file, 'utf8');
  assert.match(raw, /^revisions: "\[/m);
  const again = await findMemory(root, 'Tooling', { env });
  assert.equal(again.revisions[0].was, 'We use React for the UI.');
  assert.match(again.content, /Svelte[\s\S]*|Vite[\s\S]*Svelte/);
  assert.doesNotMatch(again.content, /React/);
});
