import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { executeTool, moduleSystemIssues } from '../src/tools.mjs';

test('CommonJS inside an ES module is flagged', () => {
  assert.match(moduleSystemIssues('src/lib.mjs', 'export const f = 1;\nif (require.main === module) main();\n'), /ES module but uses CommonJS require\.main/);
  assert.match(moduleSystemIssues('src/lib.mjs', "const fs = require('fs');\nexport const x = 1;"), /require\(\)/);
  assert.match(moduleSystemIssues('src/lib.js', 'module.exports = { f };', 'module'), /"type": "module"/);
  assert.match(moduleSystemIssues('src/lib.mjs', 'export const here = __dirname;'), /__dirname/);
  assert.match(moduleSystemIssues('src/lib.cjs', "import fs from 'node:fs';\nmodule.exports = {};"), /CommonJS file/);
});

test('correct or ambiguous code is not flagged', () => {
  assert.equal(moduleSystemIssues('src/lib.js', 'module.exports = { f };', 'commonjs'), '');
  assert.equal(moduleSystemIssues('src/lib.js', 'module.exports = { f };', ''), '');
  assert.equal(moduleSystemIssues('src/lib.mjs', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst x = require('./x.json');\nexport { x };"), '');
  assert.equal(moduleSystemIssues('src/lib.mjs', "import { fileURLToPath } from 'node:url';\nconst __dirname = fileURLToPath(new URL('.', import.meta.url));\nexport { __dirname };"), '');
  assert.equal(moduleSystemIssues('src/lib.mjs', "// require('old') was removed\nexport const msg = 'call require() in CommonJS';"), '');
  assert.equal(moduleSystemIssues('src/lib.mjs', 'export const r = obj.require(1);'), '');
  assert.equal(moduleSystemIssues('src/lib.cjs', "const x = require('x');\nmodule.exports = { x };"), '');
});

test('write_file and edit_file report the mismatch in their result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-modsys-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }));
  const written = await executeTool('write_file', { path: 'lib.js', content: 'export function f() { return 1; }\n' }, { root });
  assert.equal(written.warning, undefined);
  const edited = await executeTool('edit_file', { path: 'lib.js', old_string: 'export function f() { return 1; }\n', new_string: 'function f() { return 1; }\nmodule.exports = { f };\n' }, { root });
  assert.match(edited.warning || '', /ES module .*module\.exports/);
});

test('always-false "run when executed directly" guards are flagged', () => {
  for (const bad of [
    "if (import.meta.url===new URL('file://' + process.argv[1])){ run(); }",
    'if (import.meta.url === process.argv[1]) main();',
    'if (process.argv[1] === import.meta.url) main();'
  ]) assert.match(moduleSystemIssues('todo.mjs', bad), /always false[\s\S]*pathToFileURL\(process\.argv\[1\]\)\.href/, bad);
  for (const good of [
    'if (import.meta.url === pathToFileURL(process.argv[1]).href) main();',
    'if (import.meta.url === `file://${process.argv[1]}`) main();',
    "const here = new URL('.', import.meta.url);"
  ]) assert.equal(moduleSystemIssues('todo.mjs', good), '', good);
});
