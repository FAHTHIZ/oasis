// Memory kinds (src/auto-memory.mjs): instructions, decisions, facts,
// procedures, lessons, hypotheses and references are kept apart and
// recalled differently. A hypothesis is never recalled as fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { findMemory, memoryFreshness, memoryIndexPrompt, memoryKind, memoryRoots, recallForPrompt, runMemoryTool, saveMemory, verifyMemory } from '../src/auto-memory.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-kinds-root-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-kinds-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: home, HOME: home, OASIS_AUTO_MEMORY: '', OASIS_MEMORY_WRITE_APPROVAL: 'off' } };
}

test('the kind is given, or inferred from category and wording', () => {
  assert.equal(memoryKind({ category: 'preferences', content: 'Use tabs.' }), 'instruction');
  assert.equal(memoryKind({ category: 'decisions', content: 'We chose Postgres for JSONB.' }), 'decision');
  assert.equal(memoryKind({ category: 'project', content: 'The API is served from api/.' }), 'fact');
  assert.equal(memoryKind({ category: 'project', content: 'The flaky test is probably a race in the cache.' }), 'hypothesis');
  assert.equal(memoryKind({ category: 'project', content: 'To release, run `npm run release` then push the tag.' }), 'procedure');
  assert.equal(memoryKind({ category: 'lessons', content: 'Mocking the clock fixed the timeout.' }), 'experience');
  assert.equal(memoryKind({ category: 'project', kind: 'decision', content: 'maybe' }), 'decision', 'an explicit kind wins');
});

test('a hypothesis is saved, indexed and recalled as not established', async (t) => {
  const { root, env } = await setup(t);
  const saved = await saveMemory(root, { name: 'Flaky cache test', content: 'The flaky cache test is probably a race between two writers.', category: 'project' }, { env });
  assert.equal(saved.kind, 'hypothesis');
  await saveMemory(root, { name: 'Indent', content: 'Always indent with two spaces.', category: 'preferences', scope: 'user' }, { env });
  const index = await memoryIndexPrompt(root, { env });
  assert.match(index, /Instructions:\n- user:preferences\/indent/);
  assert.match(index, /Hypotheses \(not established\):\n- project:project\/flaky-cache-test/);
  const recalled = await recallForPrompt(root, 'why is the cache test flaky race writers', { env });
  assert.match(recalled.text, /kind="hypothesis"/);
  assert.match(recalled.text, /Not established: this is a hypothesis, not a fact/);
});

test('verifying a hypothesis current promotes it to a fact, with the history', async (t) => {
  const { root, env } = await setup(t);
  const saved = await saveMemory(root, { name: 'Cache race', content: 'The cache test likely fails from a race.', category: 'project' }, { env });
  const result = await verifyMemory(root, saved.id, { status: 'current', evidence: 'test/cache.test.mjs fails 3/10 runs without the lock, 0/50 with it', env });
  assert.equal(result.kind, 'fact');
  assert.match(result.promoted, /confirmed/);
  const memory = await findMemory(root, saved.id, { env });
  assert.equal(memory.kind, 'fact');
  assert.equal(memory.revisions.at(-1).reason, 'hypothesis confirmed');
  const refuted = await saveMemory(root, { name: 'Disk theory', content: 'The slowdown might be the disk.', category: 'project' }, { env });
  await verifyMemory(root, refuted.id, { status: 'outdated', evidence: 'iostat idle during the slowdown', env });
  const after = await findMemory(root, refuted.id, { env });
  assert.equal(after.kind, 'hypothesis', 'a refuted hypothesis is not promoted');
  assert.equal(after.revisions.at(-1).reason, 'hypothesis refuted');
});

test('a hypothesis does not overwrite a fact, an instruction or a decision', async (t) => {
  const { root, env } = await setup(t);
  const fact = await saveMemory(root, { name: 'Database', content: 'The project uses Postgres 16 in production.', category: 'project' }, { env });
  const same = await runMemoryTool('memory_save', { name: 'Database', content: 'The project probably uses Postgres 14 in production.', category: 'project', kind: 'hypothesis' }, { root, env, autoApprove: true });
  assert.equal(same.action, 'conflict');
  assert.match(same.note, /hypothesis does not overwrite it/);
  assert.match((await findMemory(root, fact.id, { env })).content, /Postgres 16/);
  const other = await saveMemory(root, { name: 'Prod DB guess', content: 'The project uses Postgres 14 in production.', category: 'project', kind: 'hypothesis' }, { env });
  assert.equal(other.action, 'created');
  assert.equal(other.superseded, undefined, 'the fact is not superseded');
  assert.equal(other.contested[0].id, fact.id);
  assert.equal((await findMemory(root, fact.id, { env })).verificationStatus, 'unverified', 'the fact keeps its status');
  assert.equal((await findMemory(root, other.id, { env })).verificationStatus, 'uncertain');
  // A fact still supersedes a hypothesis.
  const hypothesis = await saveMemory(root, { name: 'Port', content: 'The dev server probably runs on port 3000.', category: 'project' }, { env });
  const corrected = await saveMemory(root, { name: 'Dev port', content: 'The dev server runs on port 5173.', category: 'project', evidence: 'vite.config.js line 4' }, { env });
  assert.equal(corrected.superseded[0].id, hypothesis.id);
});

test('instructions do not go stale with age; facts do', async (t) => {
  const { root, env } = await setup(t);
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  assert.equal(memoryFreshness({ category: 'project', kind: 'instruction', updated: old, verificationStatus: 'unverified' }), 'personal');
  assert.equal(memoryFreshness({ category: 'project', kind: 'fact', updated: old, verificationStatus: 'unverified' }), 'stale');
  assert.equal(memoryFreshness({ category: 'project', kind: 'instruction', updated: old, verificationStatus: 'outdated' }), 'outdated', 'a revised instruction is still outdated');
  // A note written before kinds existed reads as its category's kind, not
  // reinterpreted from its wording.
  const dir = path.join(memoryRoots(root, env).project, 'project');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'legacy.md'), '---\nname: "legacy"\ndescription: "Probably uses yarn"\ncategory: "project"\n---\nProbably uses yarn.\n');
  assert.equal((await findMemory(root, 'project:project/legacy', { env })).kind, 'fact');
  const search = await runMemoryTool('memory_search', { query: 'yarn', kind: 'hypothesis' }, { root, env });
  assert.equal(search.results.length, 0, 'the kind filter applies');
  const file = await readFile(path.join(dir, 'legacy.md'), 'utf8');
  assert.doesNotMatch(file, /kind:/, 'reading does not rewrite');
});
