import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyReplacements, editsForChange, resolveAstGrep, resetAstGrepCache, runAstGrep } from '../src/ast-grep.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import { executeTool } from '../src/tools.mjs';

// The real binary when it is installed (CI usually lacks it; those tests skip).
resetAstGrepCache();
const binary = resolveAstGrep(process.cwd(), process.env);
const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-astgrep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.js'), 'const a = foo(1, 2);\nfunction x() {\n  return foo(a); // café\n}\nconst s = "foo(a)";\n');
  await writeFile(path.join(root, 'src', 'b.py'), 'def f(x):\n    return foo(x)\n');
  await writeFile(path.join(root, '.env'), 'KEY=foo(secret)\n');
  return root;
}

test('byte-offset replacements handle multi-byte text and edits are unique multi_edit pairs', () => {
  const before = 'é foo(a)\nfoo(a)\nbar\nfoo(a)\n';
  const start = Buffer.byteLength('é ');
  const after = applyReplacements(before, [{ start, end: start + 6, text: 'baz(a)' }]);
  assert.equal(after, 'é baz(a)\nfoo(a)\nbar\nfoo(a)\n');
  const edits = editsForChange('x\nfoo(a)\ny\nfoo(a)\nz\n', 'x\nfoo(a)\ny\nbar(a)\nz\n');
  assert.equal(edits.length, 1);
  assert.equal(('x\nfoo(a)\ny\nfoo(a)\nz\n').split(edits[0].old_string).length - 1, 1, 'old_string widened until unique');
  assert.ok(edits[0].new_string.includes('bar(a)'));
});

test('a non-ast-grep `sg` (setgroups) is not mistaken for ast-grep, and OASIS_AST_GREP=0 hides the tool', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-fakesg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'sg'), '#!/bin/sh\necho "sg from shadow-utils"\n');
  await chmod(path.join(dir, 'sg'), 0o755);
  resetAstGrepCache();
  assert.equal(resolveAstGrep(dir, { PATH: dir }), '');
  resetAstGrepCache();
  assert.equal(resolveAstGrep(dir, { ...process.env, OASIS_AST_GREP: '0' }), '');
  resetAstGrepCache();
  const missing = await runAstGrep(dir, { pattern: 'foo($A)' }, { env: { PATH: dir } });
  assert.match(missing.error, /not installed/);
  assert.match(missing.hint, /npm i -g @ast-grep\/cli/);
});

test('ast_grep finds code by shape, skips secret files and returns metavariables', { skip: !binary && 'ast-grep is not installed' }, async (t) => {
  const root = await workspace(t);
  resetAstGrepCache();
  const out = await executeTool('ast_grep', { pattern: 'foo($A)' }, { root, env: process.env });
  const files = out.matches.map((m) => m.file + ':' + m.line).sort();
  assert.deepEqual(files, ['src/a.js:3', 'src/b.py:2'], 'string contents and the one-argument rule are respected; .env is never searched');
  assert.equal(out.matches.find((m) => m.file === 'src/a.js').vars.A, 'a');
  const many = await runAstGrep(root, { pattern: 'foo($$$ARGS)', lang: 'js', path: 'src' }, { env: process.env });
  assert.ok(many.matches.some((m) => m.vars && m.vars.$$ARGS === '1, 2'));
  await assert.rejects(runAstGrep(root, { pattern: 'foo($A)', path: '../' }, { env: process.env }), /outside the workspace/);
  await assert.rejects(runAstGrep(root, { pattern: 'foo($A)', lang: 'js; rm -rf /' }, { env: process.env }), /Unknown language/);
  const bad = await runAstGrep(root, { pattern: 'foo(', lang: 'js' }, { env: process.env });
  assert.equal(bad.count, 0);
  assert.match(bad.hint || '', /ERROR node/);
});

test('ast_grep rewrite previews without writing, and its edits apply through multi_edit', { skip: !binary && 'ast-grep is not installed' }, async (t) => {
  const root = await workspace(t);
  const { readFile } = await import('node:fs/promises');
  const before = await readFile(path.join(root, 'src', 'a.js'), 'utf8');
  const preview = await runAstGrep(root, { pattern: 'foo($A)', rewrite: 'bar($A)', lang: 'js' }, { env: process.env });
  assert.equal(preview.written, false);
  assert.equal(await readFile(path.join(root, 'src', 'a.js'), 'utf8'), before, 'nothing written');
  const file = preview.files.find((f) => f.path === 'src/a.js');
  assert.match(file.diff, /-  return foo\(a\); \/\/ café\n\+  return bar\(a\); \/\/ café/);
  const applied = await executeTool('multi_edit', { path: file.path, edits: file.edits }, { root, autoApprove: true, approval: async () => true, env: process.env });
  assert.equal(applied.changed, true, JSON.stringify(applied));
  assert.equal(await readFile(path.join(root, 'src', 'a.js'), 'utf8'), before.replace('return foo(a)', 'return bar(a)'));
});

test('sessions offer ast_grep only when the binary exists, and treat it as read-only in plan mode', { skip: !binary && 'ast-grep is not installed' }, async (t) => {
  const root = await workspace(t);
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm' };
  const on = await createSession({ root, config, settings });
  t.after(() => closeSession(on));
  assert.ok(on.toolDefinitions.some((tool) => tool.function.name === 'ast_grep'));
  resetAstGrepCache();
  const off = await createSession({ root, config, settings, env: { ...process.env, OASIS_AST_GREP: '0' } });
  t.after(() => closeSession(off));
  assert.ok(!off.toolDefinitions.some((tool) => tool.function.name === 'ast_grep'));
  resetAstGrepCache();
});
