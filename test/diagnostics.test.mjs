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

test('diagnostics reports cancellation instead of a clean empty result', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'good.js'), 'module.exports = 1;\\n');
  const controller = new AbortController();
  controller.abort();

  const result = await runDiagnostics(root, { checker: 'node', paths: ['.'] }, { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.ran, []);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.message, /cancelled/i);
  assert.doesNotMatch(result.message, /No problems found|No checkers applied/);
  assert.match(formatDiagnostics(result), /cancelled/i);
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
  assert.equal(asked, 0, 'built-in parsers run without asking');
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

test('parses oxlint, Biome, ShellCheck, hadolint and actionlint output (captured from the real tools)', () => {
  const ox = parseDiagnostics('oxlint', 'b.js:2:17: `debugger` statement is not allowed [Warning/eslint(no-debugger)]\n\n2 problems');
  assert.deepEqual(ox, [{ file: 'b.js', line: 2, column: 17, severity: 'warning', message: '`debugger` statement is not allowed', code: 'eslint(no-debugger)', source: 'oxlint' }]);
  const biome = parseDiagnostics('biome', '::error title=lint/suspicious/noDebugger,file=/w/b.js,line=2,endLine=2,col=17,endColumn=26::This is an unexpected use of the debugger statement.\nlint ━━━━', '/w');
  assert.deepEqual(biome, [{ file: 'b.js', line: 2, column: 17, severity: 'error', message: 'This is an unexpected use of the debugger statement.', code: 'lint/suspicious/noDebugger', source: 'biome' }]);
  const sc = parseDiagnostics('shellcheck', 'a.sh:3:6: warning: Quote this to prevent word splitting. [SC2046]\na.sh:3:6: note: Use $(...) notation instead of legacy backticks `...`. [SC2006]');
  assert.equal(sc.length, 2);
  assert.deepEqual([sc[0].severity, sc[0].code, sc[1].severity], ['warning', 'SC2046', 'info']);
  const hado = parseDiagnostics('hadolint', 'hadolint:Dockerfile:2: DL3008 warning: Pin versions in apt get install.');
  assert.deepEqual(hado[0], { file: 'Dockerfile', line: 2, column: 1, severity: 'warning', message: 'Pin versions in apt get install.', code: 'DL3008', source: 'hadolint' });
  const al = parseDiagnostics('actionlint', '.github/workflows/ci.yml:6:23: "github.event.issue.title" is potentially untrusted. avoid using it directly in inline scripts. [expression]');
  assert.equal(al[0].file, '.github/workflows/ci.yml');
  assert.equal(al[0].code, 'expression');
  assert.match(al[0].message, /potentially untrusted/);
  const embedded = parseDiagnostics('actionlint', '.github/workflows/a.yml:121:9: shellcheck reported issue in this script: SC2129:style:42:3: Consider using { cmd1; cmd2; } >> file instead of individual redirects [shellcheck]');
  assert.equal(embedded[0].severity, 'info', 'embedded ShellCheck style notes are not errors');
});

test('file-based linters run only when installed and matching files exist, and stay under the argument limit', { skip: process.platform === 'win32' }, async () => {
  const root = await workspace();
  const bin = path.join(root, '..', path.basename(root) + '-bin');
  await mkdir(bin, { recursive: true });
  for (const name of ['shellcheck', 'hadolint', 'actionlint', 'cargo', 'cargo-clippy']) {
    await writeFile(path.join(bin, name), '#!/bin/sh\necho "$0 $*" >> "' + path.join(bin, 'calls.log') + '"\n');
    await chmod(path.join(bin, name), 0o755);
  }
  const env = { PATH: bin + ':/usr/bin:/bin' };
  let checkers = await detectCheckers(root, { env });
  assert.deepEqual(checkers.filter((c) => !c.builtin).map((c) => c.name), [], 'nothing to lint yet');
  await mkdir(path.join(root, 'scripts'));
  for (let i = 0; i < 75; i++) await writeFile(path.join(root, 'scripts', 'job' + String(i).padStart(2, '0') + '.sh'), 'echo hi\n');
  await writeFile(path.join(root, 'Dockerfile'), 'FROM node:22\n');
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  await writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "x"\n');
  checkers = await detectCheckers(root, { env });
  const byName = Object.fromEntries(checkers.map((c) => [c.name, c]));
  assert.deepEqual(byName.shellcheck.args.slice(0, 3), ['-f', 'gcc', '-x']);
  assert.ok(byName.shellcheck.args.length <= 80, 'runWorkspaceCommand accepts at most 80 arguments');
  assert.equal(byName.shellcheck.filesSkipped, 5);
  assert.deepEqual(byName.hadolint.args, ['--no-color', '-f', 'gnu', 'Dockerfile']);
  assert.deepEqual(byName.actionlint.args, ['-no-color', '-oneline']);
  assert.equal(byName.cargo.args[0], 'clippy', 'clippy replaces cargo check when installed');
  const focused = await detectCheckers(root, { env, paths: ['Dockerfile'] });
  assert.deepEqual(focused.filter((c) => !c.builtin && c.name !== 'cargo').map((c) => c.name), ['hadolint']);
  const result = await runDiagnostics(root, { checker: 'shellcheck', paths: ['scripts/job01.sh'] }, { env, autoApprove: true });
  assert.deepEqual(result.ran.map((r) => r.name), ['shellcheck']);
  const missing = await runDiagnostics(root, { checker: 'hadolint' }, { env: { PATH: '/usr/bin:/bin' }, autoApprove: true });
  assert.match(missing.message, /hadolint is not installed/);
});
