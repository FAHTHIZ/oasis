import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRepoMap, extractDefinitions, languageForFile } from '../src/repo-map.mjs';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-repomap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(root, 'src', 'core.js'), 'export function parseConfig(text) {\n  return JSON.parse(text);\n}\nexport class Engine {\n  start() {\n  }\n}\n');
  await writeFile(path.join(root, 'src', 'a.js'), "import { parseConfig, Engine } from './core.js';\nexport const run = () => new Engine(parseConfig('{}'));\n");
  await writeFile(path.join(root, 'src', 'b.js'), "import { parseConfig } from './core.js';\nexport function loadAll() { return parseConfig('[]'); }\n");
  await writeFile(path.join(root, 'src', 'lonely.py'), 'class Lonely:\n    def helper(self):\n        pass\n\ndef standalone():\n    pass\n');
  await writeFile(path.join(root, 'test', 'core.test.js'), "import { parseConfig } from '../src/core.js';\nfunction testParse() { parseConfig('1'); }\n");
  await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'export function hidden() {}\n');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  await writeFile(path.join(root, 'README.md'), '# not code\n');
  return root;
}

test('definitions are extracted per language with line numbers', () => {
  assert.equal(languageForFile('x/y.tsx'), 'js');
  assert.equal(languageForFile('x/y.go'), 'go');
  assert.equal(languageForFile('README.md'), null);
  const js = extractDefinitions('export async function foo(a) {\n}\nclass Bar extends Baz {\n  method(x) {\n  }\n}\nconst arrow = async (x) => x;\nif (x) {\n}\n', 'js');
  assert.deepEqual(js.map((d) => [d.name, d.line]), [['foo', 1], ['Bar', 3], ['method', 4], ['arrow', 7]]);
  assert.deepEqual(extractDefinitions('func (s *Server) Handle(w http.ResponseWriter) {\n}\ntype Server struct {\n}\n', 'go').map((d) => d.name), ['Handle', 'Server']);
  assert.deepEqual(extractDefinitions('pub fn run() {}\npub struct App;\nimpl Display for App {\n', 'rs').map((d) => d.name), ['run', 'App', 'App']);
  assert.deepEqual(extractDefinitions('# def commented():\ndef real():\n    pass\n', 'py').map((d) => d.name), ['real']);
});

test('files are ranked by cross-file references; dependencies, secrets and non-code are skipped', async (t) => {
  const root = await fixture(t);
  const result = await buildRepoMap(root);
  const order = result.map.split('\n').filter((line) => line && !line.startsWith(' '));
  assert.equal(order[0], 'src/core.js', 'the most-referenced module ranks first');
  assert.ok(order.indexOf('test/core.test.js') > order.indexOf('src/b.js'), 'tests rank below source');
  assert.match(result.map, /1│ export function parseConfig\(text\)/);
  assert.match(result.map, /4│ export class Engine/);
  assert.doesNotMatch(result.map, /node_modules|\.env|README/);
  assert.equal(result.files, 5);
});

test('focus moves a file or symbol to the top and the budget degrades to header lines', async (t) => {
  const root = await fixture(t);
  const focused = await buildRepoMap(root, { focus: ['standalone'] });
  assert.match(focused.map.split('\n')[0], /src\/lonely\.py/);
  const byFile = await buildRepoMap(root, { focus: 'src/b.js' });
  assert.match(byFile.map.split('\n')[0], /src\/b\.js/);
  const tiny = await buildRepoMap(root, { maxChars: 1000 });
  assert.ok(tiny.map.length <= 1000);
  const scoped = await buildRepoMap(root, { path: 'src' });
  assert.doesNotMatch(scoped.map, /test\/core/);
  await assert.rejects(buildRepoMap(root, { path: '../..' }), /inside the workspace/);
});

test('repo_map is a registered read-only tool and /map renders or adds the map', async (t) => {
  const root = await fixture(t);
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'repo_map'));
  const result = await executeTool('repo_map', { focus: ['Engine'] }, { root });
  assert.match(result.map, /src\/core\.js/);
  await assert.rejects(executeTool('repo_map', { path: '../' }, { root }));
  const shown = await runBuiltinCommand('map', 'src parseConfig', { root });
  assert.match(shown.output, /Repository map · \d+ of \d+ source files · focus: parseConfig/);
  const session = { messages: [] };
  const added = await runBuiltinCommand('map', '--add', { root, session });
  assert.match(added.output, /Added to the conversation/);
  assert.match(session.messages[0].content, /<repo-map>[\s\S]*src\/core\.js/);
});

test('settings.repoMap / OASIS_REPO_MAP add a map to the first turn only', async (t) => {
  const root = await fixture(t);
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const { config, requests } = await scriptedModel(t, [{ content: 'one' }, { content: 'two' }]);
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false }, repoMap: true };
  const env = { ...process.env, HOME: root, OASIS_REPO_MAP: '' };
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'Where is Engine started?', { env, approval: async () => false });
  await runAgentTurn(session, 'thanks', { env, approval: async () => false });
  const users = session.messages.filter((m) => m.role === 'user').map((m) => String(m.content));
  assert.match(users[0], /<repo-map>[\s\S]*src\/core\.js[\s\S]*<\/repo-map>[\s\S]*Where is Engine started\?/);
  assert.ok(users.slice(1).every((content) => !content.includes('<repo-map>')));
  assert.ok(requests.length >= 2);
});

test('PageRank follows real imports, not coincidental names, and focus pulls in neighbours', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-repomap-rank-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'tools'), { recursive: true });
  await mkdir(path.join(root, 'pkg'), { recursive: true });
  // util.js is imported by three modules; decoy.js exports names that others only mention.
  await writeFile(path.join(root, 'src', 'util.js'), 'export function formatRecordList(items) { return items; }\n');
  await writeFile(path.join(root, 'src', 'decoy.js'), 'export function diff() {}\nexport function join() {}\nexport const toolCalls = [];\n');
  for (const name of ['a', 'b', 'c']) {
    await writeFile(path.join(root, 'src', name + '.js'), "import { formatRecordList } from './util.js';\nexport function " + name + "Main(toolCalls) { const diff = 1; const join = 2; return formatRecordList([diff, join, toolCalls]); }\n");
  }
  // A script (no exports) and a test file: their helpers are not linkable.
  await writeFile(path.join(root, 'tools', 'script.mjs'), 'function formatRecordList() {}\nformatRecordList();\n');
  await writeFile(path.join(root, 'src', 'a.test.js'), "import { aMain } from './a.js';\nfunction formatRecordList() {}\naMain(); assert.diff();\n");
  // Python: relative and package imports resolve; leaf.py is only reached through them.
  await writeFile(path.join(root, 'pkg', '__init__.py'), '');
  await writeFile(path.join(root, 'pkg', 'leaf.py'), 'def compute_total_amount(rows):\n    return sum(rows)\n');
  await writeFile(path.join(root, 'pkg', 'mid.py'), 'from .leaf import compute_total_amount\n\ndef report_totals(rows):\n    return compute_total_amount(rows)\n');
  await writeFile(path.join(root, 'app.py'), 'from pkg.mid import report_totals\n\ndef main():\n    report_totals([1])\n');

  const map = await buildRepoMap(root, { maxChars: 20000, includeRanking: true });
  const order = map.ranking.map((file) => file.path);
  assert.ok(order.indexOf('src/util.js') < order.indexOf('src/decoy.js'), order.join(' '));
  const util = map.ranking.find((file) => file.path === 'src/util.js');
  assert.equal(util.symbols.find((s) => s.name === 'formatRecordList').refs, 3, 'script and test helpers with the same name do not count');
  const decoy = map.ranking.find((file) => file.path === 'src/decoy.js');
  assert.ok(decoy.symbols.every((s) => !s.refs), 'local variables named like its exports are not uses');
  assert.ok(order.indexOf('pkg/leaf.py') < order.indexOf('app.py'), 'the imported leaf outranks the entry point');

  const focused = await buildRepoMap(root, { maxChars: 20000, focus: ['pkg/mid.py'], includeRanking: true });
  const near = focused.ranking.slice(0, 3).map((file) => file.path);
  assert.equal(near[0], 'pkg/mid.py');
  assert.ok(near.includes('pkg/leaf.py'), near.join(' '));
  assert.ok(near.includes('app.py'), 'its caller rises with it: ' + near.join(' '));
});
