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
assert.ok(passed >= 20, 'expected at least 20 passing project tests (existing tests kept, plus new ones), found ' + passed);
const load = (rel) => import(pathToFileURL(path.join(workspace, rel)).href);
const NOW = new Date(2026, 10, 1, 15, 30);
const sink = () => { const out = { text: '', write(chunk) { out.text += chunk; } }; return out; };
const { mkdtemp } = await import('node:fs/promises');
const os = await import('node:os');
const tempFile = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'taskflow-verify-')), 'tasks.json');
const { filterTasks } = await load('src/query.mjs');
const { run, parseArgs } = await load('src/cli.mjs');
const list = [
  { id: 1, title: 'Buy MILK', notes: '', status: 'open', priority: 'normal', due: null, tags: ['home'] },
  { id: 2, title: 'Email Sam', notes: 'Ask about the milk order', status: 'open', priority: 'high', due: null, tags: ['work'] },
  { id: 3, title: 'Milk run', notes: '', status: 'done', priority: 'normal', due: null, tags: [] },
  { id: 4, title: 'Other', notes: '', status: 'open', priority: 'normal', due: null, tags: [] }
];
assert.deepEqual(filterTasks(list, { search: 'milk' }).map((t) => t.id), [1, 2, 3]);
assert.deepEqual(filterTasks(list, { search: 'MILK', status: 'open' }).map((t) => t.id), [1, 2]);
assert.deepEqual(filterTasks(list, { search: 'milk', tag: 'work' }).map((t) => t.id), [2]);
assert.deepEqual(filterTasks(list, { search: '   ' }).map((t) => t.id), [1, 2, 3, 4]);
assert.equal(parseArgs(['list', '--search=milk']).flags.search, 'milk');
const file = await tempFile();
const env = { TASKFLOW_FILE: file };
for (const args of [['add', 'Buy', 'milk'], ['add', 'Walk', 'dog', '--notes', 'MILK the cow'], ['add', 'Read']]) await run(args, { stdout: sink(), env, now: () => NOW });
const out = sink();
await run(['list', '--search', 'milk'], { stdout: out, env, now: () => NOW });
assert.match(out.text, /Buy milk/);
assert.match(out.text, /Walk dog/);
assert.doesNotMatch(out.text, /Read/);
