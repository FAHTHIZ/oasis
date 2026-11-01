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
const { sortTasks } = await load('src/query.mjs');
const tasks = [
  { id: 5, priority: 'low' }, { id: 1, priority: 'normal' }, { id: 3, priority: 'high' },
  { id: 2, priority: 'low' }, { id: 4, priority: 'high' }, { id: 6, priority: 'normal' }
];
assert.deepEqual(sortTasks(tasks, 'priority').map((t) => t.id), [3, 4, 1, 6, 2, 5]);
assert.deepEqual(tasks.map((t) => t.id), [5, 1, 3, 2, 4, 6], 'sortTasks must not reorder its input');
