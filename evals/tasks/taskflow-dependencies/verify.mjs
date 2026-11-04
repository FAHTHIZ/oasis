import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const workspace = process.argv[2];
const testFiles = readdirSync(path.join(workspace, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('test', f));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], { cwd: workspace, encoding: 'utf8', timeout: 120000 });
if (result.error || result.status !== 0) throw new Error('Project tests failed:\n' + String(result.stdout || '').slice(-4000) + String(result.stderr || '').slice(-2000));
const passed = Number((/^# pass (\d+)/m.exec(result.stdout) || [])[1] || 0);
assert.ok(passed >= 21, 'expected at least 21 passing project tests (existing tests kept, plus new ones), found ' + passed);

const load = (rel) => import(pathToFileURL(path.join(workspace, rel)).href);
const NOW = new Date(2026, 10, 1, 15, 30);
const sink = () => { const out = { text: '', write(chunk) { out.text += chunk; } }; return out; };
const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
const os = await import('node:os');
const tempFile = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'taskflow-deps-')), 'tasks.json');
const { openStore } = await load('src/store.mjs');
const { run } = await load('src/cli.mjs');
const now = () => NOW;

// Store API, ordering, and loop detection along a longer chain.
const storeFile = await tempFile();
const store = await openStore(storeFile, { now });
for (const title of ['one', 'two', 'three', 'four']) await store.add({ title });
assert.deepEqual(store.get(1).blockedBy, []);
assert.deepEqual((await store.block(4, [3, 1, 3])).blockedBy, [1, 3]);
await store.block(3, [2]);
await store.block(2, [1]);
await assert.rejects(store.block(1, [4]), { message: 'Dependency cycle: 1 -> 4 -> 1' });
await assert.rejects(store.block(1, [3]), { message: 'Dependency cycle: 1 -> 3 -> 2 -> 1' });
await assert.rejects(store.block(2, [2]), { message: 'A task cannot block itself' });
await assert.rejects(store.block(2, [42]), /No task with ID 42/);
await assert.rejects(store.block(42, [1]), /No task with ID 42/);
let saved = JSON.parse(await readFile(storeFile, 'utf8'));
assert.equal(saved.version, 1);
assert.deepEqual(saved.tasks.map((t) => t.blockedBy), [[], [1], [2], [1, 3]], 'refused blocks must not be saved');
assert.deepEqual((await store.unblock(4, [3, 99])).blockedBy, [1]);
await store.block(4, [3]);

// Completion is refused while blockers are open.
await assert.rejects(store.update(4, { status: 'done' }), { message: 'Task 4 is blocked by 1, 3' });
assert.equal(store.get(4).status, 'open');
await store.update(1, { status: 'done' });
await assert.rejects(store.update(4, { status: 'done' }), { message: 'Task 4 is blocked by 3' });

// Removal cleans up references, persisted across a reopen.
await store.remove(3);
const reopened = await openStore(storeFile, { now });
assert.deepEqual(reopened.get(4).blockedBy, [1]);
assert.equal((await reopened.update(4, { status: 'done' })).status, 'done');

// CLI behavior.
const env = { TASKFLOW_FILE: await tempFile() };
const say = async (...args) => { const out = sink(); await run(args, { stdout: out, env, now }); return out.text; };
await say('add', 'design', '--due', 'tomorrow');
await say('add', 'build');
await say('add', 'ship');
assert.equal(await say('block', '3', '2', '1'), 'Task 3 is blocked by 1, 2.\n');
assert.equal(await say('block', '2', '1'), 'Task 2 is blocked by 1.\n');
assert.equal(await say('list', '--status', 'blocked'), '  2 [ ] · build (blocked by #1)\n  3 [ ] · ship (blocked by #1, #2)\n');
assert.equal(await say('list', '--status', 'ready'), '  1 [ ] · design (tomorrow)\n');
await assert.rejects(run(['done', '3'], { stdout: sink(), env, now }), { message: 'Task 3 is blocked by 1, 2' });
await say('done', '1');
assert.equal(await say('list'), '  2 [ ] · build\n  3 [ ] · ship (blocked by #2)\n');
assert.equal(await say('list', '--status', 'ready'), '  2 [ ] · build\n');
assert.equal(await say('unblock', '3', '1'), 'Task 3 is blocked by 2.\n');
assert.equal(await say('unblock', '3', '2'), 'Task 3 is no longer blocked.\n');
await assert.rejects(run(['block', '2'], { stdout: sink(), env, now }));
const usage = sink();
await run(['nope'], { stdout: usage, env, now });
assert.match(usage.text, /block/);
assert.match(usage.text, /unblock/);

// Legacy files without blockedBy.
const legacy = await tempFile();
await writeFile(legacy, JSON.stringify({ version: 1, tasks: [
  { id: 1, title: 'old', priority: 'normal', status: 'open', due: null, tags: [], notes: '', created: NOW.toISOString() },
  { id: 2, title: 'older', priority: 'high', status: 'open', due: null, tags: [], notes: '', created: NOW.toISOString() }
] }));
const legacyEnv = { TASKFLOW_FILE: legacy };
const legacySay = async (...args) => { const out = sink(); await run(args, { stdout: out, env: legacyEnv, now }); return out.text; };
assert.equal(await legacySay('list', '--status', 'ready'), '  1 [ ] · old\n  2 [ ] ! older\n');
assert.equal(await legacySay('list', '--status', 'blocked'), 'No tasks.\n');
assert.equal(await legacySay('done', '1'), 'Completed 1 task(s).\n');
assert.equal(await legacySay('block', '2', '1'), 'Task 2 is blocked by 1.\n');
assert.equal(await legacySay('rm', '1'), 'Removed 1 task(s).\n');
saved = JSON.parse(await readFile(legacy, 'utf8'));
assert.equal(saved.version, 1);
assert.deepEqual(saved.tasks.map((t) => [t.id, t.blockedBy]), [[2, []]]);
