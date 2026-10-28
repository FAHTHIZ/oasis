// Jupyter notebook (.ipynb) support: render cells for read_file and edit them
// structurally with notebook_edit (Claude Code's NotebookEdit).
import { readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotFile } from './backups.mjs';
import { resolveWorkspacePath } from './tools.mjs';

const MAX_NOTEBOOK_FILE = 8 * 1024 * 1024;
const MAX_RENDERED = 256 * 1024;
const MAX_OUTPUT_PER_CELL = 4000;

export function isNotebookPath(file) {
  return /\.ipynb$/i.test(String(file || ''));
}

function sourceText(source) {
  return Array.isArray(source) ? source.join('') : String(source || '');
}

function toSourceLines(text) {
  const parts = String(text).split(/(?<=\n)/);
  return parts.length === 1 && parts[0] === '' ? [] : parts;
}

function parseNotebook(text) {
  let notebook;
  try { notebook = JSON.parse(text); } catch (error) { throw new Error('This notebook is not valid JSON: ' + error.message); }
  if (!notebook || typeof notebook !== 'object' || !Array.isArray(notebook.cells)) throw new Error('This file does not look like a Jupyter notebook (no cells array).');
  return notebook;
}

function cellLabel(cell, index) {
  return typeof cell.id === 'string' && cell.id ? cell.id : 'cell-' + index;
}

function renderOutputs(outputs) {
  const pieces = [];
  for (const output of outputs || []) {
    if (output.output_type === 'stream') pieces.push(sourceText(output.text));
    else if (output.output_type === 'error') pieces.push(output.ename + ': ' + output.evalue);
    else if (output.data) {
      if (output.data['text/plain']) pieces.push(sourceText(output.data['text/plain']));
      const rich = Object.keys(output.data).filter((type) => type !== 'text/plain');
      if (rich.length) pieces.push('[' + rich.join(', ') + ' output]');
    }
  }
  let text = pieces.join('\n').trim();
  if (text.length > MAX_OUTPUT_PER_CELL) text = text.slice(0, MAX_OUTPUT_PER_CELL) + '\n... (output truncated)';
  return text;
}

export function renderNotebook(notebook) {
  const language = notebook.metadata && (notebook.metadata.language_info && notebook.metadata.language_info.name || notebook.metadata.kernelspec && notebook.metadata.kernelspec.language) || 'python';
  const blocks = [];
  notebook.cells.forEach((cell, index) => {
    const head = '<cell id="' + cellLabel(cell, index) + '" type="' + (cell.cell_type || 'code') + '"' + (cell.execution_count ? ' execution_count="' + cell.execution_count + '"' : '') + '>';
    const body = [head, sourceText(cell.source)];
    const outputs = cell.cell_type === 'code' ? renderOutputs(cell.outputs) : '';
    if (outputs) body.push('<outputs>', outputs, '</outputs>');
    body.push('</cell>');
    blocks.push(body.join('\n'));
  });
  let content = blocks.join('\n\n');
  let truncated = false;
  if (content.length > MAX_RENDERED) { content = content.slice(0, MAX_RENDERED); truncated = true; }
  return { language, cells: notebook.cells.length, content, truncated };
}

async function loadNotebookFile(root, rawPath, options = {}) {
  if (!isNotebookPath(rawPath)) throw new Error('notebook_edit only works on .ipynb files.');
  const target = await resolveWorkspacePath(root, rawPath, { rejectSymlinks: options.rejectSymlinks });
  let info;
  try { info = await lstat(target.absolute); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('That notebook does not exist.');
    throw error;
  }
  if (!info.isFile()) throw new Error('That path is not a regular file.');
  if (info.size > MAX_NOTEBOOK_FILE) throw new Error('Notebook is larger than the 8 MiB limit.');
  const text = await readFile(target.absolute, 'utf8');
  return { target, text, notebook: parseNotebook(text) };
}

export async function readNotebook(root, rawPath) {
  const { target, notebook } = await loadNotebookFile(root, rawPath);
  return { path: target.relative.split(path.sep).join('/'), notebook: true, ...renderNotebook(notebook) };
}

function findCell(notebook, cellId) {
  const id = String(cellId);
  let index = notebook.cells.findIndex((cell) => cell.id === id);
  if (index < 0) {
    const match = id.match(/^cell-(\d+)$/) || id.match(/^(\d+)$/);
    if (match && Number(match[1]) < notebook.cells.length) index = Number(match[1]);
  }
  if (index < 0) throw new Error('No cell with id ' + id + '. Read the notebook to see cell ids.');
  return index;
}

function newCell(notebook, type, source) {
  const cell = { cell_type: type, metadata: {}, source: toSourceLines(source) };
  if (notebook.nbformat > 4 || (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)) cell.id = randomUUID().replace(/-/g, '').slice(0, 8);
  if (type === 'code') { cell.execution_count = null; cell.outputs = []; }
  return cell;
}

export async function editNotebook(root, args = {}) {
  const mode = args.edit_mode || 'replace';
  if (!['replace', 'insert', 'delete'].includes(mode)) throw new Error('edit_mode must be replace, insert, or delete.');
  const { target, text, notebook } = await loadNotebookFile(root, args.path, { rejectSymlinks: true });
  const hasId = args.cell_id !== undefined && args.cell_id !== null && args.cell_id !== '';
  if (mode !== 'delete' && typeof args.new_source !== 'string') throw new Error('Provide new_source for ' + mode + '.');
  if (args.cell_type && !['code', 'markdown', 'raw'].includes(args.cell_type)) throw new Error('cell_type must be code, markdown, or raw.');
  let index;
  let cellId;
  if (mode === 'insert') {
    if (!args.cell_type) throw new Error('cell_type is required when inserting a cell.');
    index = hasId ? findCell(notebook, args.cell_id) + 1 : 0;
    const cell = newCell(notebook, args.cell_type, args.new_source);
    notebook.cells.splice(index, 0, cell);
    cellId = cellLabel(cell, index);
  } else {
    if (!hasId) throw new Error('Provide cell_id for ' + mode + '.');
    index = findCell(notebook, args.cell_id);
    cellId = cellLabel(notebook.cells[index], index);
    if (mode === 'delete') notebook.cells.splice(index, 1);
    else {
      const cell = notebook.cells[index];
      const type = args.cell_type || cell.cell_type || 'code';
      if (type !== cell.cell_type) {
        const replacement = newCell(notebook, type, args.new_source);
        if (cell.id) replacement.id = cell.id;
        replacement.metadata = cell.metadata || {};
        notebook.cells[index] = replacement;
      } else {
        cell.source = toSourceLines(args.new_source);
        if (type === 'code') { cell.outputs = []; cell.execution_count = null; }
      }
    }
  }
  const indentMatch = text.match(/^\{\s*\n(\s+)"/);
  const next = JSON.stringify(notebook, null, indentMatch ? indentMatch[1].length : 1) + (text.endsWith('\n') ? '\n' : '');
  await snapshotFile(target.root, target.absolute, 'before-agent-notebook-edit');
  await writeFile(target.absolute, next, 'utf8');
  return { path: target.relative.split(path.sep).join('/'), changed: true, edit_mode: mode, cell_id: cellId, cells: notebook.cells.length, backupCreated: true };
}
