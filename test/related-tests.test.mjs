import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { findRelatedTests, isRunnableTestFile } from '../src/repo-map.mjs';
import { nearestRelatedTests, relatedTestCommand, relatedTestsHint } from '../src/turn-guards.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

async function project(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-related-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

const JS = {
  'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
  'src/math.mjs': 'export const add = (a, b) => a + b;\n',
  'src/stats.mjs': "import { add } from './math.mjs';\nexport const total = (xs) => xs.reduce(add, 0);\n",
  'src/report.mjs': "import { total } from './stats.mjs';\nexport const line = (xs) => 'total ' + total(xs);\n",
  'src/unrelated.mjs': 'export const x = 1;\n',
  'test/math.test.mjs': "import { add } from '../src/math.mjs';\n",
  'test/report.test.mjs': "import { line } from '../src/report.mjs';\n",
  'test/unrelated.test.mjs': "import { x } from '../src/unrelated.mjs';\n",
  'test/fixtures/math.test.mjs': "import { add } from '../../src/math.mjs';\n",
  'test/clock.test.mjs': "// tests the clock module through the CLI\n",
  'src/clock.mjs': 'export const now = () => 0;\n'
};

test('findRelatedTests walks the reverse import graph and skips fixtures', async (t) => {
  const root = await project(t, JS);
  const related = await findRelatedTests(root, ['src/math.mjs']);
  assert.deepEqual(related.map((r) => [r.path, r.distance]), [['test/math.test.mjs', 1], ['test/report.test.mjs', 3]]);
  assert.deepEqual((await findRelatedTests(root, ['src/clock.mjs'])).map((r) => r.path), ['test/clock.test.mjs'], 'name match when no import edge');
  assert.deepEqual((await findRelatedTests(root, ['test/unrelated.test.mjs'])).map((r) => r.path), ['test/unrelated.test.mjs'], 'a changed test is its own check');
  assert.deepEqual(await findRelatedTests(root, ['README.md']), []);
  assert.equal(isRunnableTestFile('test/fixtures/a.test.mjs'), false);
  assert.equal(isRunnableTestFile('tests/test_api.py'), true);
});

test('findRelatedTests follows Python package imports', async (t) => {
  const root = await project(t, {
    'pyproject.toml': '[project]\nname="p"\n',
    'src/pkg/__init__.py': '',
    'src/pkg/core.py': 'def f():\n    return 1\n',
    'src/pkg/api.py': 'from .core import f\n',
    'tests/test_api.py': 'from pkg.api import f\n',
    'tests/test_other.py': 'import os\n'
  });
  assert.deepEqual((await findRelatedTests(root, ['src/pkg/core.py'])).map((r) => r.path), ['tests/test_api.py']);
  assert.deepEqual(await relatedTestCommand(root, ['tests/test_api.py']), { command: 'python3', args: ['-m', 'pytest', '-q', 'tests/test_api.py'] });
});

test('nearestRelatedTests keeps the nearest group and the runner command fits the project', async (t) => {
  const many = Array.from({ length: 30 }, (_, i) => ({ path: 'test/t' + i + '.test.mjs', distance: 2 }));
  assert.deepEqual(nearestRelatedTests([{ path: 'test/a.test.mjs', distance: 1 }, { path: 'test/b.test.mjs', distance: 1 }, { path: 'test/c.test.mjs', distance: 1 }, ...many]), ['test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs']);
  assert.equal(nearestRelatedTests([{ path: 'a', distance: 1 }, ...many]).length, 8, 'few direct tests: add the next ring, capped');
  const root = await project(t, { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });
  assert.deepEqual(await relatedTestCommand(root, ['src/a.test.ts']), { command: 'npx', args: ['vitest', 'run', 'src/a.test.ts'] });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest --ci' } }));
  assert.deepEqual(await relatedTestCommand(root, ['a.test.js']), { command: 'npx', args: ['jest', 'a.test.js'] });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'mocha' } }));
  assert.equal(await relatedTestCommand(root, ['a.test.js']), null, 'unknown runner: no guessed command');
});

test('the post-edit gate names the tests that import the edited file', async (t) => {
  const root = await project(t, JS);
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.match(await relatedTestsHint(root, new Set(['src/stats.mjs'])), /test\/report\.test\.mjs.*`node --test test\/report\.test\.mjs`/);
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    seen.push(payload);
    const n = seen.length;
    const message = n === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/math.mjs' }) } }] }
      : n === 2
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'e1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/math.mjs', old_string: 'a + b', new_string: 'Number(a) + Number(b)' }) } }] }
        : { role: 'assistant', content: 'Done.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6, contextWindow: 200000 } });
  await runAgentTurn(session, 'coerce add arguments', { autoApprove: true, env: { ...process.env, OASIS_ASSISTED_VERIFICATION: '0', OASIS_AUTO_TEST: '' } });
  const gate = seen.flatMap((p) => p.messages).find((m) => m.role === 'user' && /post-edit verification gate/.test(String(m.content)));
  assert.ok(gate, 'the gate ran');
  assert.match(gate.content, /Tests that import the changed files: test\/math\.test\.mjs/);
  assert.match(gate.content, /`node --test test\/math\.test\.mjs/);
});
