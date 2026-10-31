import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { executeTool } from '../src/tools.mjs';
import { editNotebook, renderNotebook } from '../src/notebook.mjs';
import { PermissionPolicy } from '../src/permissions.mjs';

const NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', id: 'intro', metadata: {}, source: ['# Analysis\n', 'Load data'] },
    { cell_type: 'code', id: 'load', metadata: {}, execution_count: 3, source: ['import pandas as pd\n', 'df = pd.read_csv("x.csv")'], outputs: [
      { output_type: 'stream', name: 'stdout', text: ['loaded 10 rows\n'] },
      { output_type: 'display_data', data: { 'image/png': 'AAAA', 'text/plain': ['<Figure>'] }, metadata: {} }
    ] }
  ],
  metadata: { language_info: { name: 'python' } },
  nbformat: 4,
  nbformat_minor: 5
};

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-nb-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.ipynb'), JSON.stringify(NOTEBOOK, null, 1) + '\n');
  return root;
}

test('read_file renders notebooks as cells with ids and outputs', async (t) => {
  const root = await setup(t);
  const result = await executeTool('read_file', { path: 'a.ipynb' }, { root, env: process.env });
  assert.equal(result.notebook, true);
  assert.equal(result.cells, 2);
  assert.match(result.content, /<cell id="intro" type="markdown">\n# Analysis\nLoad data\n<\/cell>/);
  assert.match(result.content, /<cell id="load" type="code" execution_count="3">/);
  assert.match(result.content, /loaded 10 rows/);
  assert.match(result.content, /\[image\/png output\]/);
  assert.doesNotMatch(result.content, /AAAA/);
  const ranged = await executeTool('read_file', { path: 'a.ipynb', offset: 1, limit: 3 }, { root, env: process.env });
  assert.equal(ranged.notebook, undefined);
});

test('notebook_edit replaces, inserts, retypes and deletes cells', async (t) => {
  const root = await setup(t);
  const file = path.join(root, 'a.ipynb');
  const replaced = await editNotebook(root, { path: 'a.ipynb', cell_id: 'load', new_source: 'df = load()\nprint(df)\n' });
  assert.equal(replaced.cell_id, 'load');
  let nb = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(nb.cells[1].source, ['df = load()\n', 'print(df)\n']);
  assert.deepEqual(nb.cells[1].outputs, []);
  assert.equal(nb.cells[1].execution_count, null);
  assert.match(await readFile(file, 'utf8'), /^\{\n "cells"/);

  const inserted = await editNotebook(root, { path: 'a.ipynb', cell_id: 'intro', edit_mode: 'insert', cell_type: 'code', new_source: 'x = 1' });
  nb = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(nb.cells.length, 3);
  assert.equal(nb.cells[1].id, inserted.cell_id);
  assert.match(inserted.cell_id, /^[a-f0-9]{8}$/);
  await editNotebook(root, { path: 'a.ipynb', edit_mode: 'insert', cell_type: 'markdown', new_source: 'Top' });
  nb = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(nb.cells[0].source, ['Top']);
  assert.equal(nb.cells[0].outputs, undefined);

  await editNotebook(root, { path: 'a.ipynb', cell_id: 'cell-0', cell_type: 'code', new_source: 'print(1)' });
  nb = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(nb.cells[0].cell_type, 'code');
  assert.deepEqual(nb.cells[0].outputs, []);

  await editNotebook(root, { path: 'a.ipynb', cell_id: 'intro', edit_mode: 'delete' });
  nb = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(nb.cells.some((cell) => cell.id === 'intro'), false);

  await assert.rejects(editNotebook(root, { path: 'a.ipynb', cell_id: 'nope', new_source: 'x' }), /No cell with id nope/);
  await assert.rejects(editNotebook(root, { path: 'a.ipynb', edit_mode: 'insert', new_source: 'x' }), /cell_type is required/);
  await assert.rejects(editNotebook(root, { path: 'x.py', cell_id: '0', new_source: 'x' }), /only works on \.ipynb/);
  await assert.rejects(editNotebook(root, { path: '../a.ipynb', cell_id: '0', new_source: 'x' }));
});

test('NotebookEdit permission rules and rendering of old notebooks without ids', () => {
  const policy = new PermissionPolicy({ permissions: { deny: ['NotebookEdit'] } });
  assert.equal(policy.evaluate('notebook_edit', { path: 'a.ipynb' }).decision, 'deny');
  const rendered = renderNotebook({ cells: [{ cell_type: 'code', source: 'a = 1', outputs: [{ output_type: 'error', ename: 'NameError', evalue: 'b' }] }], nbformat: 4, nbformat_minor: 2 });
  assert.match(rendered.content, /<cell id="cell-0" type="code">\na = 1\n<outputs>\nNameError: b/);
});

test('notebook_edit refuses elision placeholders and warns when a cell is gutted', async (t) => {
  const root = await setup(t);
  await assert.rejects(
    editNotebook(root, { path: 'a.ipynb', cell_id: 'load', new_source: 'import pandas as pd\n# ... rest of code unchanged ...' }),
    /placeholder/
  );
  const big = Array.from({ length: 40 }, (_, i) => 'x' + i + ' = ' + i).join('\n');
  await editNotebook(root, { path: 'a.ipynb', cell_id: 'load', new_source: big });
  const shrunk = await editNotebook(root, { path: 'a.ipynb', cell_id: 'load', new_source: 'x0 = 0' });
  assert.match(shrunk.warning, /shrank a\.ipynb cell load/);
  const fine = await editNotebook(root, { path: 'a.ipynb', cell_id: 'load', new_source: big + '\ny = 1' });
  assert.equal(fine.warning, undefined);
});
