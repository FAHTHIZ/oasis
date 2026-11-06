import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readdir, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeCode, grammarForFile, loadCodeGrammar } from '../src/code-ast.mjs';

const defs = async (key, source) => analyzeCode(await loadCodeGrammar(key), source).defs.map((d) => d.name + (d.member ? '()' : ''));

test('definitions come from the grammar for each bundled language', async () => {
  assert.deepEqual(await defs('js', 'export async function alpha() {\n  function inner() {}\n}\nexport const handler = async () => 1;\nexport const CONFIG = {};\nclass Widget {\n  render() {}\n}\n'), ['alpha', 'handler', 'CONFIG', 'Widget', 'render()']);
  assert.deepEqual(await defs('ts', 'export interface Shape {}\nexport type Id = string;\nexport enum Color { Red }\n'), ['Shape', 'Id', 'Color']);
  assert.deepEqual(await defs('py', 'class Alpha:\n    def meth(self):\n        def helper(): pass\n\nasync def top(x):\n    return x\n'), ['Alpha', 'meth()', 'top']);
  assert.deepEqual(await defs('go', 'package x\nfunc (s *Srv) Serve() error { return nil }\nfunc New() *Srv { return nil }\ntype Srv struct{}\n'), ['Serve', 'New', 'Srv']);
  assert.deepEqual(await defs('rs', 'pub struct Store;\nimpl Store { pub fn get(&self) {} }\n'), ['Store', 'Store', 'get()']);
  assert.deepEqual(await defs('php', '<?php\nfunction helper() {}\nclass Cart { public function total() {} }\n'), ['helper', 'Cart', 'total()']);
  assert.deepEqual(await defs('sh', 'deploy() { echo; }\n'), ['deploy']);
});

test('grammars map from file extensions; unknown languages return null for the regex fallback', async () => {
  assert.equal(grammarForFile('a/b.tsx'), 'tsx');
  assert.equal(grammarForFile('x.h'), 'cpp');
  assert.equal(grammarForFile('x.kt'), null);
  assert.equal(await loadCodeGrammar(null), null);
});

test('comments and strings are blanked so they do not count as symbol uses', async () => {
  const source = "// uses parseConfig here\nconst s = 'parseConfig';\nrun(é);\n";
  const { masked } = analyzeCode(await loadCodeGrammar('js'), source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.doesNotMatch(masked, /parseConfig/);
  assert.match(masked, /run\(é\)/);
});

test('repo map scans persist on disk and are reused or refreshed by mtime and size', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rmc-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rmc-'));
  const previous = process.env.OASIS_HOME;
  process.env.OASIS_HOME = home;
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'a.mjs'), 'export function alphaThing() {}\n');
    await writeFile(path.join(root, 'src', 'b.mjs'), "import { alphaThing } from './a.mjs';\nalphaThing();\n");
    const { buildRepoMap } = await import('../src/repo-map.mjs?first');
    const first = await buildRepoMap(root, {});
    assert.match(first.map, /alphaThing/);
    const cacheDir = path.join(home, 'cache', 'repo-map');
    assert.equal((await readdir(cacheDir)).filter((f) => f.endsWith('.json')).length, 1);
    // A fresh module instance (a new session) reads the saved scan; a changed
    // file is rescanned.
    await writeFile(path.join(root, 'src', 'a.mjs'), 'export function betaThing() {}\n');
    await utimes(path.join(root, 'src', 'a.mjs'), new Date(), new Date(Date.now() + 5000));
    const { buildRepoMap: fresh } = await import('../src/repo-map.mjs?second');
    const second = await fresh(root, {});
    assert.match(second.map, /betaThing/);
    assert.doesNotMatch(second.map, /alphaThing\(\)/);
  } finally {
    if (previous === undefined) delete process.env.OASIS_HOME; else process.env.OASIS_HOME = previous;
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
