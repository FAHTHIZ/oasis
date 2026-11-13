import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { staticFileCheck } from '../src/static-check.mjs';
import { runHeadless } from '../src/headless.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

process.env.OASIS_REQUIRE_READ_BEFORE_EDIT = '0';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-static-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('valid HTML, CSS, JSON, YAML and TOML pass', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'index.html'), '<!doctype html>\n<html><head><link rel="stylesheet" href="style.css"><style>h1 { color: red; }</style></head>\n<body><a href="#top">top</a><img src="https://x.test/a.png"><script>const a = 1; console.log(a);</script>\n<script type="module">import x from "./x.js"; await x();</script></body></html>\n');
  await writeFile(path.join(root, 'style.css'), 'h1 { color: blue; }\n@media (max-width: 600px) { h1 { font-size: 2rem; } }\n');
  await writeFile(path.join(root, 'tsconfig.json'), '{\n  // comments are fine here\n  "compilerOptions": { "strict": true, },\n}\n');
  await writeFile(path.join(root, 'data.json'), '{"a": [1, 2]}\n');
  await writeFile(path.join(root, 'ci.yml'), 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n');
  await writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "x"\n');
  const result = await staticFileCheck(root, ['index.html', 'style.css', 'tsconfig.json', 'data.json', 'ci.yml', 'Cargo.toml', 'missing.html', 'app.js']);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.checked, ['index.html', 'style.css', 'tsconfig.json', 'data.json', 'ci.yml', 'Cargo.toml']);
});

test('broken scripts, styles, references and data files are reported with lines', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'index.html'), '<!doctype html>\n<link rel="stylesheet" href="missing.css">\n<script>\nfunction f( {\n  return 1;\n}\n</script>\n<img src="img/logo.png">\n');
  await writeFile(path.join(root, 'a.css'), 'h1 { color: red;\n');
  await writeFile(path.join(root, 'a.json'), '{"a": 1,}\n');
  await writeFile(path.join(root, 'a.yml'), 'a: [1, 2\n');
  await writeFile(path.join(root, 'a.toml'), 'x = \n');
  const { problems } = await staticFileCheck(root, ['index.html', 'a.css', 'a.json', 'a.yml', 'a.toml']);
  const all = problems.join('\n');
  assert.match(all, /index\.html <script> line 4: syntax error/);
  assert.match(all, /index\.html line 2: href="missing\.css" points to a file that does not exist/);
  assert.match(all, /index\.html line 8: src="img\/logo\.png" points to a file that does not exist/);
  assert.match(all, /a\.css/);
  assert.match(all, /a\.json line 1: property name expected/);
  assert.match(all, /a\.yml/);
  assert.match(all, /a\.toml/);
});

test('a page-only change is checked in-process and its problems go back to the model', async (t) => {
  const root = await tmp(t);
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'write_file', { path: 'index.html', content: '<!doctype html>\n<link rel="stylesheet" href="style.css">\n<h1>Hi</h1>\n' }),
    { content: 'Created index.html.' },
    toolCall('c2', 'write_file', { path: 'style.css', content: 'h1 { color: teal; }\n' }),
    { content: 'Added style.css.' }
  ]);
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'acceptEdits' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const { exitCode, summary } = await runHeadless({ prompt: 'make a page', root, config, outputFormat: 'json', sessionOptions: { settings }, write: () => {} });
  assert.equal(exitCode, 0);
  assert.match(JSON.stringify(requests[2].messages), /style\.css\\" points to a file that does not exist/);
  assert.equal(summary.verification.complete, true, JSON.stringify(summary.verification));
  assert.equal(summary.verification.lastCheck.kind, 'static');
  assert.equal(summary.verification.lastCheck.passed, true);
  assert.equal(requests.length, 4, 'no extra gate round trip after the clean parse');
});
