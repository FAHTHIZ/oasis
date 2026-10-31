// `oasis watch`: act on instructions left as code comments, like Aider's watch mode.
//
// Write a comment that ends with `AI!` to ask for a change, or `AI?` to ask a
// question, in any file of the workspace, from any editor:
//
//   // Validate the email before saving. AI!
//   # why does this retry forever? AI?
//
// Comments that merely end with `AI` are collected as extra context for the next
// trigger. OASIS sends the comments (with surrounding code) to the agent, which
// makes the change or answers, then removes the AI comments it handled.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sensitivePath } from './tools.mjs';

const COMMENT = /^\s*(?:\/\/+|#+|--|;+|\/\*+|\*|<!--|%|'|rem\b)\s*(.*?)\s*(?:\*\/|-->)?\s*$/i;
const TRAILING = /(?:\/\/+|#+|--|\/\*+|<!--)\s*(.*?)\s*(?:\*\/|-->)?\s*$/;
const MARKER = /(?:^|\s)AI([!?]?)\s*$|^AI([!?]?)(?:[\s:,-]|$)/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 8000;
const CONTEXT_LINES = 6;

function commentText(line) {
  const full = COMMENT.exec(line);
  if (full && full[1] !== undefined && !/^\s*['"]/.test(line)) return full[1];
  // Trailing comment after code: `x = 1  # tidy this AI!`
  const index = line.search(/\s(?:\/\/|#|--)\s/);
  if (index > 0) {
    const tail = TRAILING.exec(line.slice(index + 1));
    if (tail) return tail[1];
  }
  return null;
}

/** Find AI comments in file text. Returns [{ line, text, kind: 'change'|'question'|'context' }]. */
export function findAiComments(text) {
  const found = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000 || !/\bai\b/i.test(line)) continue;
    const body = commentText(line);
    if (body == null) continue;
    const match = MARKER.exec(body);
    if (!match) continue;
    const mark = match[1] || match[2] || '';
    found.push({ line: i + 1, text: body.replace(/(?:^|\s)AI[!?]?\s*$/i, '').replace(/^AI[!?]?[\s:,-]*/i, '').trim(), kind: mark === '!' ? 'change' : mark === '?' ? 'question' : 'context' });
  }
  return found;
}

/** True when the comment set contains an actionable marker. */
export function hasTrigger(comments) {
  return comments.some((item) => item.kind === 'change' || item.kind === 'question');
}

/** Stable fingerprint of actionable comments so the same request never fires twice. */
export function triggerFingerprint(byFile) {
  const hash = createHash('sha256');
  for (const [file, comments] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const item of comments) if (item.kind !== 'context') hash.update(file + '\0' + item.kind + '\0' + item.text + '\n');
  }
  return hash.digest('hex');
}

/** Build the agent prompt for a set of files with AI comments. */
export function buildAiCommentPrompt(byFile, fileTexts = new Map()) {
  const all = [...byFile.values()].flat();
  const asksChange = all.some((item) => item.kind === 'change');
  const asksQuestion = all.some((item) => item.kind === 'question');
  const parts = [
    'I left instructions for you as code comments marked with "AI". Comments ending in "AI!" ask for a change, comments ending in "AI?" ask a question, and comments ending in plain "AI" are extra context.',
    asksChange
      ? 'Make the requested changes with minimal edits, following the existing code style. Then remove every AI comment you handled (only the comment, not surrounding code) and run the most relevant check if one exists.'
      : 'Do not edit code unless I asked for a change.',
    asksQuestion ? 'Answer each AI? question directly in your reply, citing file:line. Remove the AI? comment after answering only if you also made a change in that file.' : '',
    ''
  ];
  for (const [file, comments] of byFile) {
    parts.push('## ' + file);
    const lines = String(fileTexts.get(file) || '').split('\n');
    for (const item of comments) {
      const label = item.kind === 'change' ? 'AI!' : item.kind === 'question' ? 'AI?' : 'AI';
      parts.push('- line ' + item.line + ' [' + label + ']: ' + (item.text || '(see the surrounding code)'));
      if (lines.length > 1) {
        const start = Math.max(0, item.line - 1 - CONTEXT_LINES);
        const end = Math.min(lines.length, item.line + CONTEXT_LINES);
        parts.push('```', ...lines.slice(start, end).map((text, offset) => String(start + offset + 1).padStart(5) + '  ' + text), '```');
      }
    }
    parts.push('');
  }
  return parts.filter((part, index) => part !== '' || index > 3).join('\n').trim();
}

function gitFiles(root) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout).split('\0').filter(Boolean).slice(0, MAX_FILES));
    });
  });
}

async function listFiles(root) {
  const fromGit = await gitFiles(root);
  if (fromGit) return fromGit;
  const { walkFiles } = await import('./tools.mjs');
  const walked = await walkFiles(root, { maxFiles: MAX_FILES, maxDepth: 12 });
  return walked.map((item) => path.relative(root, item.absolute).split(path.sep).join('/'));
}

/**
 * Poll the workspace for AI comments. Calls onTrigger({ byFile, prompt, fingerprint })
 * when a new actionable set appears; the next scan waits until onTrigger resolves.
 * Returns { stop, scan } (scan is exported for tests and one-shot use).
 */
export function watchAiComments(root, { onTrigger, onError = () => {}, intervalMs = 1000, autoStart = true } = {}) {
  const mtimes = new Map();
  const comments = new Map();
  let lastFingerprint = null;
  let stopped = false;
  let timer = null;
  let primed = false;

  async function scan() {
    const files = await listFiles(root);
    const seen = new Set();
    const changed = [];
    for (const relative of files) {
      if (sensitivePath(relative)) continue;
      seen.add(relative);
      const absolute = path.join(root, relative);
      const info = await stat(absolute).catch(() => null);
      if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) { comments.delete(relative); continue; }
      const key = info.mtimeMs + ':' + info.size;
      if (mtimes.get(relative) === key) continue;
      mtimes.set(relative, key);
      let text;
      try { text = await readFile(absolute, 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue;
      const found = findAiComments(text);
      if (found.length) comments.set(relative, found); else comments.delete(relative);
      changed.push(relative);
    }
    for (const relative of [...mtimes.keys()]) if (!seen.has(relative)) { mtimes.delete(relative); comments.delete(relative); }
    const byFile = new Map([...comments].filter(([, items]) => items.length));
    const actionable = [...byFile.values()].some(hasTrigger);
    const fingerprint = actionable ? triggerFingerprint(byFile) : null;
    const wasPrimed = primed;
    primed = true;
    // Existing comments at startup do not fire; only newly written ones do.
    if (!wasPrimed) { lastFingerprint = fingerprint; return { byFile, triggered: false }; }
    if (!actionable || fingerprint === lastFingerprint || !changed.length) {
      if (!actionable) lastFingerprint = null;
      return { byFile, triggered: false };
    }
    lastFingerprint = fingerprint;
    const texts = new Map();
    for (const file of byFile.keys()) texts.set(file, await readFile(path.join(root, file), 'utf8').catch(() => ''));
    const prompt = buildAiCommentPrompt(byFile, texts);
    if (onTrigger) await onTrigger({ byFile, prompt, fingerprint });
    // Absorb the agent's own edits (including removed AI comments) without re-triggering.
    for (const file of [...mtimes.keys()]) {
      const info = await stat(path.join(root, file)).catch(() => null);
      if (!info) continue;
      const key = info.mtimeMs + ':' + info.size;
      if (mtimes.get(file) === key) continue;
      mtimes.set(file, key);
      const text = await readFile(path.join(root, file), 'utf8').catch(() => '');
      const found = findAiComments(text);
      if (found.length) comments.set(file, found); else comments.delete(file);
    }
    const after = new Map([...comments].filter(([, items]) => items.length));
    lastFingerprint = [...after.values()].some(hasTrigger) ? triggerFingerprint(after) : null;
    return { byFile, triggered: true };
  }

  async function loop() {
    if (stopped) return;
    try { await scan(); } catch (error) { onError(error); }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  }
  if (autoStart) timer = setTimeout(loop, 0);
  return {
    scan,
    stop() { stopped = true; if (timer) clearTimeout(timer); }
  };
}
