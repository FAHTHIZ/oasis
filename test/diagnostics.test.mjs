import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDiagnostics, runDiagnostics, detectCheckers, formatDiagnostics, parseNodeCheck } from '../src/diagnostics.mjs';
import { TOOL_DEFINITIONS, executeTool } from '../src/tools.mjs';

async function workspace() { return await mkdtemp(path.join(tmpdir(), 'oasis-diag-')); }

test('diagnostics tool is registered', () => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'diagnostics'));
});

test('parses TypeScript, ESLint, Ruff, mypy, Pyright, go vet and cargo output', () => {
  const ts = parseDiagnostics('typescript', "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.deepEqual(ts[0], { file: 'src/a.ts', line: 3, column: 5, severity: 'error', message: "Type 'string' is not assignable to type 'number'.", code: 'TS2322', source: 'typescript' });
  const es = parseDiagnostics('eslint', "/w/src/a.js:2:7: 'x' is assigned a value but never used. [Warning/no-unused-vars]\n\n1 problem", '/w');
  assert.equal(es[0].file, 'src/a.js');
  assert.equal(es[0].severity, 'warning');
  assert.equal(es[0].code, 'no-unused-vars');
  const ruff = parseDiagnostics('ruff', 'app.py:1:8: F401 [*] `os` imported but unused');
  assert.equal(ruff[0].code, 'F401');
  assert.equal(ruff[0].message, '`os` imported but unused');
  const mypy = parseDiagnostics('mypy', 'app.py:4:9: error: Incompatible types in assignment  [assignment]');
  assert.equal(mypy[0].code, 'assignment');
  const pyright = parseDiagnostics('pyright', '  /w/app.py:5:1 - error: "y" is not defined (reportUndefinedVariable)', '/w');
  assert.equal(pyright[0].file, 'app.py');
  assert.equal(pyright[0].code, 'reportUndefinedVariable');
  const go = parseDiagnostics('go', '# example\n./main.go:7:2: fmt.Printf format %d has arg s of wrong type string');
  assert.equal(go[0].file, 'main.go');
  const cargo = parseDiagnostics('cargo', 'src/main.rs:3:18: error[E0308]: mismatched types\nsrc/lib.rs:1:5: warning: unused import');
  assert.equal(cargo.length, 2);
  assert.equal(cargo[1].severity, 'warning');
});

test('node --check output maps to a line and column', () => {
  const d = parseNodeCheck('bad.mjs', '/w/bad.mjs:2\nconst = 1;\n      ^\n\nSyntaxError: Unexpected token \'=\'\n    at foo');
  assert.equal(d.line, 2);
  assert.equal(d.column, 7);
  assert.match(d.message, /SyntaxError/);
});

test('built-in checks report JavaScript and JSON syntax errors without approval', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'bad.mjs'), 'export const a = ;\n');
  await writeFile(path.join(root, 'good.js'), 'module.exports = 1;\n');
  await writeFile(path.join(root, 'data.json'), '{\n  "a": 1,\n}\n');
  await writeFile(path.join(root, 'tsconfig.json'), '{ // comments are fine in tsconfig\n}\n');
  let asked = 0;
  const result = await runDiagnostics(root, { paths: ['.'] }, { approval: async () => { asked++; return false; } });
  const files = result.diagnostics.map((item) => item.file).sort();
  assert.deepEqual(files, ['bad.mjs', 'data.json']);
  assert.equal(result.summary.errors, 2);
  assert.equal(result.diagnostics.find((item) => item.file === 'data.json').line, 3);
  assert.ok(result.ran.some((entry) => entry.name === 'typescript' && entry.skipped), 'tsc missing is reported as skipped');
  assert.match(formatDiagnostics(result), /bad\.mjs:1:\d+ error/);
});

test('external checkers go through approval and results are filtered by path', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'tsconfig.json'), '{}');
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  const fake = path.join(root, 'node_modules', '.bin', 'tsc');
  await writeFile(fake, '#!/bin/sh\necho "src/a.ts(1,7): error TS2322: Bad type."\necho "other/b.ts(2,1): error TS1005: Expected."\nexit 2\n');
  await chmod(fake, 0o755);
  if (process.platform === 'win32') return;
  const prompts = [];
  const denied = await runDiagnostics(root, { checker: 'typescript' }, { approval: async (message) => { prompts.push(message); return false; } });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /tsc/);
  assert.match(denied.ran[0].skipped, /not approved/i);
  assert.equal(denied.diagnostics.length, 0);
  const all = await runDiagnostics(root, { checker: 'typescript' }, { autoApprove: true });
  assert.equal(all.summary.errors, 2);
  const focused = await executeTool('diagnostics', { checker: 'typescript', paths: ['src'] }, { root, autoApprove: true });
  assert.equal(focused.diagnostics.length, 1);
  assert.equal(focused.diagnostics[0].file, 'src/a.ts');
  assert.equal(focused.diagnostics[0].code, 'TS2322');
});

test('detects project checkers from config files', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'go.mod'), 'module x\n');
  await writeFile(path.join(root, 'Cargo.toml'), '[package]\n');
  const names = (await detectCheckers(root)).map((checker) => checker.name);
  assert.ok(names.includes('go'));
  assert.ok(names.includes('cargo'));
  assert.ok(names.includes('json'));
});

test('paths cannot escape the workspace', async () => {
  const root = await workspace();
  await assert.rejects(runDiagnostics(root, { paths: ['../outside'] }), /workspace|outside|escape/i);
});

test('/diagnostics sends a fix-and-verify prompt', async () => {
  const { runBuiltinCommand } = await import('../src/slash.mjs');
  const handled = await runBuiltinCommand('diagnostics', 'src/a.ts', { root: '.' });
  assert.match(handled.prompt, /diagnostics tool/);
  assert.match(handled.prompt, /src\/a\.ts/);
});
