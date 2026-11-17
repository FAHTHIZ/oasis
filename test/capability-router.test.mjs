import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { buildRoutingTable, classifyTaskClass, routesFromTable, sanitizeRoutes } from '../src/capability-router.mjs';
import { selectTaskModel } from '../src/model-routing.mjs';
import { runEvalCommand } from '../src/eval.mjs';
import { loadSettings } from '../src/settings.mjs';

// Two classes, three trials each. "cheap" is as good as "strong" on input
// validation, worse on network safety; "mid" is in between.
const rows = (spec) => Object.entries(spec).flatMap(([category, [passes, cost]]) =>
  Array.from({ length: 10 }, (_, index) => ({ taskId: category + '-' + index, category, passed: index < passes, costUSD: cost })));
const runs = [
  { label: 'strong', model: 'vendor/strong', results: rows({ 'input-validation': [10, 0.1], 'network-safety': [10, 0.1] }) },
  { label: 'mid', model: 'vendor/mid', results: rows({ 'input-validation': [9, 0.05], 'network-safety': [9, 0.05] }) },
  { label: 'cheap', model: 'vendor/cheap', results: rows({ 'input-validation': [10, 0.01], 'network-safety': [7, 0.01] }) }
];

test('the table picks the cheapest model above the floor and within the allowed drop', () => {
  const table = buildRoutingTable(runs, { floor: 0.8, maxDrop: 0.1 });
  assert.equal(table.baseline, 'strong');
  assert.equal(table.classes['input-validation'].model, 'vendor/cheap');
  assert.equal(table.classes['network-safety'].model, 'vendor/mid', 'cheap is below the floor there');
  // Over the whole suite cheap passes 85%, more than 10 points below strong; mid passes 90%.
  assert.equal(table.classes.overall.model, 'vendor/mid');
});

test('a stricter drop keeps the stronger model, and the table is reproducible', () => {
  const strict = buildRoutingTable(runs, { floor: 0.8, maxDrop: 0.02 });
  assert.equal(strict.classes['network-safety'].model, 'vendor/strong');
  assert.equal(strict.classes['input-validation'].model, 'vendor/cheap');
  const again = buildRoutingTable(JSON.parse(JSON.stringify(runs)), { floor: 0.8, maxDrop: 0.02 });
  assert.equal(again.digest, strict.digest);
  assert.notEqual(buildRoutingTable(runs, { floor: 0.95, maxDrop: 0.02 }).digest, strict.digest);
  assert.deepEqual(routesFromTable(strict)['network-safety'], 'vendor/strong');
});

test('unknown cost is never treated as cheap, and bad input is refused', () => {
  const unknown = runs.map((run) => run.label === 'cheap' ? { ...run, results: run.results.map((row) => ({ ...row, costUSD: null })) } : run);
  assert.equal(buildRoutingTable(unknown, { floor: 0.8, maxDrop: 0.1 }).classes['input-validation'].model, 'vendor/mid');
  assert.throws(() => buildRoutingTable(runs.slice(0, 1)), /at least two/);
  assert.throws(() => buildRoutingTable([runs[0], { ...runs[1], label: 'strong' }]), /distinct label/);
  assert.throws(() => buildRoutingTable(runs, { baseline: 'nope' }), /not one of the report labels/);
});

test('task classes are named only when the signals are clear', () => {
  assert.equal(classifyTaskClass('Reject archive entries with a path traversal (../) or an absolute path outside the workspace root.'), 'security-boundaries');
  assert.equal(classifyTaskClass('Redact API keys and credentials from the log lines; scrub secrets in .env values.'), 'secret-handling');
  assert.equal(classifyTaskClass('Add a stats command.'), '');
});

test('capability mode routes by class, falls back to the overall route, and keeps pins', () => {
  const routing = { enabled: true, mode: 'capability', strongModel: 'vendor/strong', routes: { 'secret-handling': 'vendor/cheap', overall: 'vendor/mid' } };
  const secret = selectTaskModel('Redact API keys and credentials from log output; scrub the secrets.', 'vendor/strong', routing);
  // Security-sensitive wording is pinned to the strong model by the existing rules.
  assert.equal(secret.model, 'vendor/strong');
  assert.equal(secret.tier, 'strong');
  const plain = selectTaskModel('Add a stats command to the taskflow project.', 'vendor/strong', routing);
  assert.equal(plain.model, 'vendor/mid');
  assert.equal(plain.mode, 'capability');
  assert.equal(plain.tier, 'work');
  assert.equal(plain.escalateTo, 'vendor/strong', 'a stuck run can still move to the strong model');
  const cache = selectTaskModel('Implement a TTL cache with pagination and a priority queue sorted by id.', 'vendor/strong', { ...routing, routes: { 'data-structures': 'vendor/cheap' } });
  assert.equal(cache.model, 'vendor/cheap');
  assert.equal(cache.taskClass, 'data-structures');
  const none = selectTaskModel('Add a stats command.', 'vendor/strong', { ...routing, routes: { 'secret-handling': 'vendor/cheap' } });
  assert.equal(none.model, 'vendor/strong');
  assert.deepEqual(sanitizeRoutes({ 'secret-handling': ' m \n', bogus: 'x', overall: 5 }), { 'secret-handling': 'm' });
});

test('oasis eval --route-table writes the table and prints the settings to use', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-route-'));
  const files = [];
  for (const run of runs) {
    const file = path.join(dir, run.label + '.json');
    await writeFile(file, JSON.stringify({ label: run.label, provider: { model: run.model }, results: run.results }));
    files.push(file);
  }
  let printed = '';
  const out = path.join(dir, 'table.json');
  const result = await runEvalCommand(['--route-table', ...files, '--floor', '0.8', '--max-drop', '0.1', '--out', out], { output: { write: (text) => { printed += text; } } });
  assert.equal(result.ok, true);
  assert.match(printed, /input-validation\s+vendor\/cheap/);
  assert.match(printed, /"mode":"capability"/);
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(saved.digest, result.table.digest);
  await assert.rejects(runEvalCommand(['--route-table', files[0]], { output: { write() {} } }), /Usage/);
});

test('settings keep capability routes and turn routing on without an easy model', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-route-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-route-root-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  await (await import('node:fs/promises')).mkdir(env.OASIS_CONFIG_DIR, { recursive: true });
  await writeFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), JSON.stringify({ modelRouting: { enabled: true, mode: 'capability', strongModel: 'vendor/strong', routes: { overall: 'vendor/mid', nope: 'x' } } }));
  const settings = await loadSettings(root, { env });
  assert.equal(settings.modelRouting.enabled, true);
  assert.equal(settings.modelRouting.mode, 'capability');
  assert.deepEqual(settings.modelRouting.routes, { overall: 'vendor/mid' });
});
