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
const { toCsv } = await load('src/format.mjs');
const { run } = await load('src/cli.mjs');
const header = 'id,title,priority,status,due,tags,notes\r\n';
assert.equal(toCsv([]), header);
assert.equal(toCsv([
  { id: 2, title: 'Second', priority: 'high', status: 'done', due: '2026-11-02', tags: [], notes: 'line1\nline2' },
  { id: 1, title: 'Say "hi", then go', priority: 'low', status: 'open', due: null, tags: ['a', 'b'], notes: '' }
]), header + '1,"Say ""hi"", then go",low,open,,a;b,\r\n2,Second,high,done,2026-11-02,,"line1\nline2"\r\n');
assert.equal(toCsv([{ id: 3, title: '=SUM(A1:A9)', priority: 'normal', status: 'open', due: null, tags: [], notes: '@cmd' }]), header + "3,'=SUM(A1:A9),normal,open,,,'@cmd\r\n");
assert.equal(toCsv([{ id: 4, title: '-1, really', priority: 'normal', status: 'open', due: null, tags: [], notes: '' }]), header + '4,"\'-1, really",normal,open,,,\r\n');
const file = await tempFile();
const env = { TASKFLOW_FILE: file };
await run(['add', 'Write,', 'docs'], { stdout: sink(), env, now: () => NOW });
await run(['add', 'Ship'], { stdout: sink(), env, now: () => NOW });
await run(['done', '2'], { stdout: sink(), env, now: () => NOW });
const csv = sink();
await run(['export'], { stdout: csv, env, now: () => NOW });
assert.equal(csv.text, header + '1,"Write, docs",normal,open,,,\r\n2,Ship,normal,done,,,\r\n');
const json = sink();
await run(['export', '--format=json'], { stdout: json, env, now: () => NOW });
assert.deepEqual(JSON.parse(json.text).map((t) => [t.id, t.status]), [[1, 'open'], [2, 'done']]);
await assert.rejects(run(['export', '--format', 'xml'], { stdout: sink(), env, now: () => NOW }), /Unknown export format: xml/);
