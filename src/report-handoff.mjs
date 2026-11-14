// Artifact handoff for subagent reports (Neuron Network phase 4).
//
// A subagent's report used to come back as one tool result of up to a million
// characters. The parent's tool-result cap (24,000 characters, less on small
// windows) then kept the head and tail and silently dropped the middle, and
// several parallel agents each spent that much of the parent's context. Long
// reports are now written whole to the session scratch folder and the parent
// gets a preview plus the file path: nothing is lost, and the parent reads
// only the parts it needs (read_file with offset/limit, or grep).
import path from 'node:path';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { SCRATCH_ROOT, ensureScratch, isScratchPath } from './scratch.mjs';

export const DEFAULT_HANDOFF_CHARS = 12000;
const HEAD_CHARS = 6000;
const TAIL_CHARS = 2000;

export function reportHandoffThreshold(env = process.env) {
  const raw = String(env.OASIS_SUBAGENT_HANDOFF_CHARS || '').trim();
  if (/^(?:0|off|false|no)$/i.test(raw)) return Infinity;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 2000 ? n : DEFAULT_HANDOFF_CHARS;
}

/** Head and tail of a long report with a pointer to the full file. */
export function reportPreview(text, file) {
  const value = String(text || '');
  const omitted = value.length - HEAD_CHARS - TAIL_CHARS;
  const cut = (s, atEnd) => {
    // Break on a line boundary when one is close, so code blocks and tables are not split mid-line.
    if (atEnd) { const i = s.indexOf('\n'); return i >= 0 && i < 400 ? s.slice(i + 1) : s; }
    const i = s.lastIndexOf('\n'); return i >= 0 && s.length - i < 400 ? s.slice(0, i) : s;
  };
  return cut(value.slice(0, HEAD_CHARS), false) +
    '\n\n[... ' + omitted.toLocaleString('en-US') + ' characters of this report are not shown here. The full report (' + value.length.toLocaleString('en-US') + ' characters, ' + value.split('\n').length.toLocaleString('en-US') + ' lines) is in ' + file + '; read the parts you need with read_file offset/limit or grep. ...]\n\n' +
    cut(value.slice(-TAIL_CHARS), true);
}

/**
 * Store a long report under <root>/<scratchDir>/agents/ and return the handoff,
 * or null when the report is short, handoff is off, or the file cannot be
 * written safely (the caller then keeps the inline report).
 */
export async function handOffReport({ root, scratchDir, agentId, run = 1, text, env = process.env }) {
  const value = String(text || '');
  if (!root || !scratchDir || value.length <= reportHandoffThreshold(env)) return null;
  const relativeDir = scratchDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/agents';
  if (relativeDir.split('/').includes('..') || path.isAbsolute(relativeDir) || !isScratchPath(relativeDir)) return null;
  // The scratch folder's own .gitignore keeps the file out of commits, including
  // a worktree-isolated parent's automatic commit.
  if (!await ensureScratch(root, relativeDir.slice(SCRATCH_ROOT.length + 1).split('/')[0])) return null;
  // Never follow a symlinked .oasis or scratch folder out of the workspace.
  let probe = root;
  for (const part of relativeDir.split('/')) {
    probe = path.join(probe, part);
    const info = await lstat(probe).catch(() => null);
    if (info && info.isSymbolicLink()) return null;
  }
  const safeId = String(agentId || 'agent').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'agent';
  const relative = relativeDir + '/' + safeId + (run > 1 ? '-run' + run : '') + '.md';
  try {
    await mkdir(path.join(root, ...relativeDir.split('/')), { recursive: true });
    await writeFile(path.join(root, ...relative.split('/')), value.endsWith('\n') ? value : value + '\n');
  } catch { return null; }
  return { file: relative, chars: value.length, preview: reportPreview(value, relative) };
}
