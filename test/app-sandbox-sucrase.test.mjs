import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InlineSandbox } from '../app/core/sandbox.mjs';
import { buildSucrase, SUCRASE_PATH } from '../scripts/vendor-sucrase.mjs';

const run = (code, files = {}) => new InlineSandbox().run(code, { files });

test('the committed Sucrase bundle matches scripts/vendor-sucrase.mjs', async () => {
  assert.equal(await readFile(SUCRASE_PATH, 'utf8'), await buildSucrase(), 'run node scripts/vendor-sucrase.mjs');
});

test('project files may be TypeScript, TSX or ES modules, resolved the way bundlers do', async () => {
  const files = {
    'src/math.ts': 'export interface Pair { a: number; b: number }\nexport const add = ({ a, b }: Pair): number => a + b;\nexport default class Counter { private n = 0; inc(): number { return ++this.n; } }',
    'src/view.tsx': 'const h = (tag: string, props: object | null, ...kids: unknown[]) => ({ tag, kids });\nconst React = { createElement: h };\nexport const view = (name: string) => <b>{name}</b>;',
    'src/index.ts': "export * from './math.js';\nexport { view } from './view';",
    'lib/cjs.js': 'module.exports = { kind: "cjs" };',
    'lib/esm.mjs': "import cjs from './cjs.js';\nexport const kind = cjs.kind + '+esm';"
  };
  const result = await run("import Counter, { add } from './src/math';\nimport * as api from './src';\nimport { kind } from './lib/esm.mjs';\nconst c: Counter = new Counter(); c.inc();\nreturn [add({ a: 2, b: 3 }), c.inc(), api.view('x').kids[0], kind].join(' ');", files);
  assert.equal(result.error, undefined);
  assert.equal(result.value, '"5 2 x cjs+esm"');
});

test('the snippet itself may be TypeScript, use top-level await and return', async () => {
  const result = await run('type N = number;\nconst xs: N[] = [1, 2, 3];\nawait null;\nreturn xs.map((x): N => x * 2).join();');
  assert.equal(result.value, '"2,4,6"');
  assert.equal((await run('return 1 < 2 && 3 > 2')).value, 'true', 'comparisons are not JSX');
});

test('compile errors name the file, line and column; runtime errors keep the line', async () => {
  const bad = await run("require('./bad.ts')", { 'bad.ts': 'const ok = 1;\nconst x: = 2;' });
  assert.match(bad.error, /bad\.ts: Unexpected token \(2:/);
  const thrown = await run("require('./boom.ts')", { 'boom.ts': 'type T = string;\n\nthrow new Error("line three" as T);' });
  assert.match(thrown.error, /line three\n\s+at eval \(boom\.ts:3:7\)[\s\S]*oasis-run\.js:1:1/);
  assert.match((await run('const = 1')).error, /Unexpected token/);
});

test('CommonJS files are left as written', async () => {
  const result = await run("return require('./sloppy.js')", { 'sloppy.js': 'leaked = 5; module.exports = leaked;' });
  assert.equal(result.value, '5', 'not forced into strict mode');
});
