import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const workspace = process.argv[2];
const testFiles = readdirSync(path.join(workspace, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('test', f));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], { cwd: workspace, encoding: 'utf8', timeout: 120000 });
if (result.error || result.status !== 0) throw new Error('Project tests failed:\n' + String(result.stdout || '').slice(-4000) + String(result.stderr || '').slice(-2000));
const passed = Number((/^# pass (\d+)/m.exec(result.stdout) || [])[1] || 0);
assert.ok(passed >= 22, 'expected at least 22 passing project tests (existing tests kept, plus new ones), found ' + passed);

const load = (rel) => import(pathToFileURL(path.join(workspace, rel)).href);
const NOW = new Date(2026, 10, 1, 15, 30);
const now = () => NOW;
const sink = () => { const out = { text: '', write(chunk) { out.text += chunk; } }; return out; };
const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
const os = await import('node:os');
const tempFile = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'taskflow-csv-')), 'tasks.json');
const { parseCsv, exportCsv } = await load('src/csv.mjs');
const { openStore } = await load('src/store.mjs');
const { run } = await load('src/cli.mjs');

// Parsing.
assert.deepEqual(parseCsv('a,b\r\n1,"two\r\nlines"\r\n'), [['a', 'b'], ['1', 'two\r\nlines']]);
assert.deepEqual(parseCsv('\ufeffx\n\n\n"say ""hi"""\n,\nlast'), [['x'], ['say "hi"'], ['', ''], ['last']]);
assert.deepEqual(parseCsv('a,,c\n'), [['a', '', 'c']]);
assert.deepEqual(parseCsv('\n'), []);
assert.throws(() => parseCsv('h\n"multi\nline"\nok\n"open\nrest'), { message: 'CSV line 5: unterminated quoted field' });
assert.throws(() => parseCsv('h\n"a\nb" c\n'), { message: 'CSV line 3: unexpected quote' });
assert.throws(() => parseCsv('h\nab"c\n'), { message: 'CSV line 2: unexpected quote' });

// Export.
const sample = [
  { id: 3, title: ' padded', priority: 'low', status: 'done', due: '2026-11-05', tags: ['x', 'y-z'], notes: '-5 reps', created: '2026-10-01T10:00:00.000Z', completed: '2026-10-02T11:00:00.000Z' },
  { id: 7, title: 'a\rb', priority: 'normal', status: 'open', due: null, tags: [], notes: '', created: '2026-10-03T00:00:00.000Z' },
  { id: 9, title: '@home, later', priority: 'high', status: 'open', due: null, tags: [], notes: '+1 "idea"', created: '2026-10-04T00:00:00.000Z' }
];
assert.equal(exportCsv(sample), [
  'id,title,priority,status,due,tags,notes,created,completed',
  '3," padded",low,done,2026-11-05,x;y-z,\'-5 reps,2026-10-01T10:00:00.000Z,2026-10-02T11:00:00.000Z',
  '7,"a\rb",normal,open,,,,2026-10-03T00:00:00.000Z,',
  '9,"\'@home, later",high,open,,,"\'+1 ""idea""",2026-10-04T00:00:00.000Z,'
].join('\n') + '\n');
assert.equal(exportCsv([]), 'id,title,priority,status,due,tags,notes,created,completed\n');

// Import: header rules, all-or-nothing, row numbers.
const file = await tempFile();
const store = await openStore(file, { now });
await store.add({ title: 'one' });
await store.add({ title: 'two' });
await store.add({ title: 'three' });
await store.remove(2);
const before = await readFile(file, 'utf8');
const refuse = async (text, message) => {
  await assert.rejects(store.importCsv(text), { message });
  assert.equal(await readFile(file, 'utf8'), before, 'a refused import must not save: ' + message);
  assert.equal(store.all().length, 2, 'a refused import must not add tasks: ' + message);
};
await refuse('title,owner\nx,me\n', 'Unknown CSV column: owner');
await refuse('title,tags,title\nx,,y\n', 'Duplicate CSV column: title');
await refuse('notes,priority\nx,low\n', 'Missing CSV column: title');
await refuse('title,priority\nfine,low\nalso fine,\nbad,urgent\n', 'CSV row 3: Unknown priority: urgent');
await refuse('title,due\nok,2026-11-30\nlater,today\n', 'CSV row 2: Invalid due date: today');
await refuse('title,due\nx,2026-02-30\n', 'CSV row 1: Invalid due date: 2026-02-30');
await refuse('title,status\nx,closed\n', 'CSV row 1: Unknown status: closed');
await refuse('title,created\nx,yesterday-ish\n', 'CSV row 1: Invalid timestamp: yesterday-ish');
await refuse('title,tags\nx,ok;Bad Tag\n', 'CSV row 1: Invalid tag: Bad Tag');
await refuse('title,priority\n"a, b",low,extra\n', 'CSV row 1: expected 2 fields, found 3');
await refuse('title\nok\n   \n', 'CSV row 2: A task needs a title');
assert.deepEqual(await store.importCsv(''), []);
assert.deepEqual(await store.importCsv('title,priority\n'), []);
assert.equal(await readFile(file, 'utf8'), before, 'importing nothing must not change the file');

const seen = [];
store.events.on('added', (task) => seen.push([task.id, JSON.parse(readFileSync(file, 'utf8')).tasks.some((t) => t.id === task.id)]));
const added = await store.importCsv([
  'completed,status,id,title,tags,created,notes,due,priority',
  '2026-10-02T11:00:00Z,done,1,"\'=cmd",Docs;;Ops,2026-10-01T10:00:00Z,"\'@me, ""now""",2026-11-20,high',
  '2026-10-02T11:00:00Z,,99,plain,,,,,',
  ',done,,finished,,,,,low'
].join('\r\n'));
assert.deepEqual(added.map((task) => task.id), [4, 5, 6], 'new IDs continue after the largest existing ID, in file order');
assert.deepEqual(seen, [[4, true], [5, true], [6, true]], 'added is emitted per task, in order, after saving');
assert.equal(added[0].title, '=cmd');
assert.equal(added[0].notes, '@me, "now"');
assert.deepEqual(added[0].tags, ['docs', 'ops']);
assert.equal(added[0].priority, 'high');
assert.equal(added[0].due, '2026-11-20');
assert.equal(added[0].status, 'done');
assert.equal(added[0].created, '2026-10-01T10:00:00.000Z');
assert.equal(added[0].completed, '2026-10-02T11:00:00.000Z');
assert.equal(added[1].status, 'open');
assert.equal(added[1].priority, 'normal');
assert.equal(added[1].created, NOW.toISOString());
assert.ok(!('completed' in added[1]) || added[1].completed === undefined, 'an open task never has completed');
assert.equal(added[2].completed, NOW.toISOString());
const reopened = await openStore(file, { now });
assert.deepEqual(reopened.all().map((task) => task.id), [1, 3, 4, 5, 6]);
assert.equal(reopened.get(4).notes, '@me, "now"');

// Round trip through a fresh store keeps every field except the ID.
const tricky = await openStore(await tempFile(), { now });
await tricky.add({ title: 'comma, "quote"', notes: 'line one\nline two', tags: ['a'] });
await tricky.add({ title: ' lead and trail ', priority: 'high', due: '2026-12-24' });
await tricky.add({ title: '-minus', notes: '=formula' });
await tricky.update(2, { status: 'done' });
const exported = exportCsv(tricky.all());
const target = await openStore(await tempFile(), { now: () => new Date(2027, 0, 1) });
const copies = await target.importCsv(exported);
const strip = (task) => { const { id, ...rest } = task; return rest; };
assert.deepEqual(copies.map(strip), tricky.all().map(strip));

// CLI.
const env = { TASKFLOW_FILE: await tempFile() };
const say = async (...args) => { const out = sink(); await run(args, { stdout: out, env, now }); return out.text; };
await say('add', 'first', '--tag', 'x');
await say('add', 'second');
await say('add', 'third');
await say('done', '2');
const cliStore = await openStore(env.TASKFLOW_FILE, { now });
assert.equal(await say('export'), exportCsv(cliStore.all()));
assert.equal(await say('export', '--status', 'done'), exportCsv(cliStore.all().filter((task) => task.status === 'done')));
assert.equal(await say('export', '--status=open'), exportCsv(cliStore.all().filter((task) => task.status === 'open')));
const csvFile = env.TASKFLOW_FILE + '.import.csv';
await writeFile(csvFile, 'title,priority\nalpha,high\nbeta,low\n');
assert.equal(await say('import', csvFile), 'Imported 2 task(s).\n');
assert.deepEqual((await openStore(env.TASKFLOW_FILE, { now })).all().map((task) => task.title), ['first', 'second', 'third', 'alpha', 'beta']);
await writeFile(csvFile, 'title,priority\ngamma,high\ndelta,huge\n');
await assert.rejects(run(['import', csvFile], { stdout: sink(), env, now }), { message: 'CSV row 2: Unknown priority: huge' });
assert.equal((await openStore(env.TASKFLOW_FILE, { now })).all().length, 5);
const usage = await say('help');
assert.match(usage, /\bexport\b/);
assert.match(usage, /\bimport\b/);
assert.ok(existsSync(env.TASKFLOW_FILE));
console.log('taskflow-csv: all checks passed');
