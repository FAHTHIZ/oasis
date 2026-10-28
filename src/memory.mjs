// Hierarchical memory, like Claude Code's CLAUDE.md files.
//   user     ~/.config/oasis/OASIS.md and ~/.claude/CLAUDE.md  (all projects)
//   project  OASIS.md, AGENTS.md, CLAUDE.md                     (shared, committed)
//   local    OASIS.local.md, CLAUDE.local.md                    (personal, gitignored)
// README.md is still included as general project context.
// Lines starting with "@path" inside a memory file include that workspace file.
import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const MAX_MEMORY_FILE = 40 * 1024;
const MAX_TOTAL = 40000;
const PER_FILE_LIMIT = 9000;

export function memoryFiles(root, options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const workspace = path.resolve(root);
  const candidates = [
    { label: 'user', path: path.join(getConfigDirectory(env, home), 'OASIS.md') },
    { label: 'user', path: path.join(home, '.claude', 'CLAUDE.md') },
    { label: 'project', path: path.join(workspace, 'OASIS.md') },
    { label: 'project', path: path.join(workspace, 'AGENTS.md') },
    { label: 'project', path: path.join(workspace, 'CLAUDE.md') },
    { label: 'project', path: path.join(workspace, '.claude', 'CLAUDE.md') },
    { label: 'local', path: path.join(workspace, 'OASIS.local.md') },
    { label: 'local', path: path.join(workspace, 'CLAUDE.local.md') },
    { label: 'readme', path: path.join(workspace, 'README.md') }
  ];
  return Promise.all(candidates.map(async (item) => {
    try {
      const info = await lstat(item.path);
      return { ...item, exists: info.isFile() && info.size <= MAX_MEMORY_FILE * 4, size: info.size };
    } catch { return { ...item, exists: false }; }
  }));
}

async function readImports(root, text, depth = 0) {
  if (depth > 2) return text;
  const workspace = await realpath(root).catch(() => root);
  const lines = [];
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^@((?:\.{0,2}\/)?[\w.\-/]+)$/);
    if (!match) { lines.push(line); continue; }
    try {
      const target = await realpath(path.resolve(workspace, match[1]));
      const relative = path.relative(workspace, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { lines.push(line); continue; }
      const info = await lstat(target);
      if (!info.isFile() || info.size > MAX_MEMORY_FILE) { lines.push(line); continue; }
      const imported = await readFile(target, 'utf8');
      lines.push('--- imported ' + relative + ' ---', await readImports(root, imported.slice(0, PER_FILE_LIMIT), depth + 1), '--- end ' + relative + ' ---');
    } catch { lines.push(line); }
  }
  return lines.join('\n');
}

export async function loadMemory(root, options = {}) {
  const files = await memoryFiles(root, options);
  const parts = [];
  const seen = new Set();
  for (const file of files) {
    if (!file.exists) continue;
    let real;
    try { real = await realpath(file.path); } catch { continue; }
    if (file.label !== 'user') {
      const workspace = await realpath(path.resolve(root)).catch(() => path.resolve(root));
      const relative = path.relative(workspace, real);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let content;
    try { content = await readFile(real, 'utf8'); } catch { continue; }
    if (!content.trim() || content.includes('\0')) continue;
    if (file.label !== 'readme') content = await readImports(root, content);
    const name = file.label === 'user' ? file.path.replace(os.homedir(), '~') : path.relative(path.resolve(root), file.path);
    const heading = file.label === 'user' ? 'User memory (applies to all projects)' : file.label === 'local' ? 'Personal project memory' : 'Project context';
    parts.push('--- ' + heading + ': ' + name + ' ---\n' + content.slice(0, PER_FILE_LIMIT));
  }
  return parts.join('\n\n').slice(0, MAX_TOTAL);
}

// "# note" in the prompt: append a bullet to the project memory file.
export async function appendMemoryNote(root, note, options = {}) {
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!text) throw new Error('Write the note after #, for example: # use pnpm, not npm');
  const scope = options.scope || 'project';
  const target = scope === 'user'
    ? path.join(getConfigDirectory(options.env || process.env, options.home || os.homedir()), 'OASIS.md')
    : scope === 'local' ? path.join(path.resolve(root), 'OASIS.local.md') : path.join(path.resolve(root), 'OASIS.md');
  let existing = '';
  try { existing = await readFile(target, 'utf8'); } catch {}
  let prefix = '';
  if (!existing) prefix = '# Project memory\n\n';
  else if (!existing.endsWith('\n')) prefix = '\n';
  if (scope === 'user' && !existing) prefix = '# Oasis user memory\n\n';
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, prefix + '- ' + text + '\n', 'utf8');
  return target;
}
