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
