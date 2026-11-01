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
const { summarize } = await load('src/query.mjs');
const { run } = await load('src/cli.mjs');
const list = [
  { id: 1, priority: 'normal', status: 'open', due: '2026-10-30', tags: [] },
  { id: 2, priority: 'high', status: 'open', due: '2026-11-01', tags: [] },
  { id: 3, priority: 'normal', status: 'open', due: null, tags: [] },
  { id: 4, priority: 'high', status: 'done', due: '2026-10-01', tags: [] }
];
assert.deepEqual(summarize(list, NOW), { open: 3, done: 1, overdue: 1, byPriority: { high: 1, normal: 2, low: 0 } });
assert.deepEqual(summarize([], NOW), { open: 0, done: 0, overdue: 0, byPriority: { high: 0, normal: 0, low: 0 } });
const file = await tempFile();
const env = { TASKFLOW_FILE: file };
for (const args of [['add', 'a', '--due', '2026-10-30'], ['add', 'b', '--priority', 'high', '--due', 'today'], ['add', 'c'], ['add', 'd', '--priority', 'high']]) await run(args, { stdout: sink(), env, now: () => NOW });
await run(['done', '4'], { stdout: sink(), env, now: () => NOW });
const out = sink();
assert.equal(await run(['stats'], { stdout: out, env, now: () => NOW }), 0);
assert.equal(out.text, 'Open: 3\nDone: 1\nOverdue: 1\nBy priority: high 1, normal 2, low 0\n');
