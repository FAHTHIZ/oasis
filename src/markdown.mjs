// Terminal markdown rendering for streamed assistant replies, plus colored
// diffs for file edits. Line-oriented so it works while text streams in: the
// partial line is shown raw and replaced by its rendered form once complete.
import { stringWidth } from './line-editor.mjs';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m', underline: '\x1b[4m',
  noBold: '\x1b[22m', noItalic: '\x1b[23m', noUnderline: '\x1b[24m', fg: '\x1b[39m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
  bgRed: '\x1b[48;5;52m', bgGreen: '\x1b[48;5;22m', bg: '\x1b[49m'
};

export function colorEnabled(stream = process.stdout, env = process.env) {
  if (env.NO_COLOR || env.OASIS_NO_COLOR === '1') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY);
}

const KEYWORDS = new Set(('abstract and as async await break case catch class const continue def del do elif else enum except export extends ' +
  'false final finally fn for from func function go if impl import in interface is let match mod module mut new nil none not null ' +
  'or package pass private protected pub public raise return self static struct super switch this throw true try type typeof use var ' +
  'void while with yield None True False').split(' '));

const HASH_COMMENT_LANGS = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'console', 'rb', 'ruby', 'yaml', 'yml', 'toml', 'ini', 'r', 'perl', 'pl', 'makefile', 'make', 'dockerfile', 'ps1', 'powershell']);

export function highlightCode(line, lang = '') {
  const language = String(lang || '').toLowerCase();
  if (language === 'diff' || language === 'patch') {
    if (line.startsWith('+') && !line.startsWith('+++')) return C.green + line + C.fg;
    if (line.startsWith('-') && !line.startsWith('---')) return C.red + line + C.fg;
    if (line.startsWith('@@')) return C.cyan + line + C.fg;
    return line;
  }
  const hashComments = HASH_COMMENT_LANGS.has(language);
  const pattern = hashComments
    ? /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.xXa-fA-F]*\b)|([A-Za-z_$][\w$]*)/g
    : /(\/\/.*$|\/\*.*?\*\/|<!--.*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.xXa-fA-F]*\b)|([A-Za-z_$][\w$]*)/g;
  return line.replace(pattern, (match, comment, string, number, word) => {
    if (comment) return C.gray + comment + C.fg;
    if (string) return C.green + string + C.fg;
    if (number) return C.yellow + number + C.fg;
    if (word && KEYWORDS.has(word)) return C.magenta + word + C.fg;
    return match;
  });
}

export function renderInline(text, { color = true } = {}) {
  if (!color) return text;
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => { codes.push(C.cyan + code + C.fg); return '\u0000' + (codes.length - 1) + '\u0000'; });
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => '\x1b]8;;' + url + '\x07' + C.underline + C.blue + label + C.fg + C.noUnderline + '\x1b]8;;\x07');
  out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => C.bold + (a || b) + C.noBold);
  out = out.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, (_, pre, body) => pre + C.italic + body + C.noItalic);
  out = out.replace(/~~([^~]+)~~/g, (_, body) => '\x1b[9m' + body + '\x1b[29m');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

// Renders one complete markdown line given fence state; returns null when the
// line should be hidden (fence markers).
export function renderMarkdownLine(line, state, { color = true, columns = 80 } = {}) {
  const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
  if (fence) {
    if (!state.fence) { state.fence = fence[1]; state.lang = fence[2] || ''; return color ? C.dim + '  ' + (state.lang || 'code') + C.noBold : null; }
    if (fence[1] === state.fence) { state.fence = null; state.lang = ''; return null; }
  }
  if (state.fence) return '  ' + (color ? highlightCode(line, state.lang) : line);
  if (!color) return line;
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const body = renderInline(heading[2], { color });
    return heading[1].length === 1 ? C.bold + C.underline + body + C.noUnderline + C.noBold : C.bold + body + C.noBold;
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return C.dim + '─'.repeat(Math.min(60, Math.max(10, columns - 2))) + C.noBold;
  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) return C.dim + '│ ' + C.noBold + C.italic + renderInline(quote[1], { color }) + C.noItalic;
  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) return task[1] + (task[2] === ' ' ? '☐ ' : C.green + '☑ ' + C.fg) + renderInline(task[3], { color });
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return bullet[1] + '• ' + renderInline(bullet[2], { color });
  const numbered = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);
  if (numbered) return numbered[1] + numbered[2] + ' ' + renderInline(numbered[3], { color });
  if (/^\s*\|.*\|\s*$/.test(line)) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return C.dim + line.replace(/[-:]/g, '─') + C.noBold;
    return line.split('|').map((cell) => renderInline(cell, { color })).join(C.dim + '│' + C.noBold);
  }
  return renderInline(line, { color });
}

export function renderMarkdown(text, options = {}) {
  const state = { fence: null, lang: '' };
  return String(text || '').split('\n').map((line) => renderMarkdownLine(line, state, options)).filter((line) => line !== null).join('\n');
}

// Streaming renderer. push() receives new text; end() flushes.
export class MarkdownStream {
  constructor({ write, color = true, columns = () => 80, prefix = '' }) {
    this.write = write;
    this.color = color;
    this.columns = columns;
    this.prefix = prefix;
    this.state = { fence: null, lang: '' };
    this.partial = '';
    this.shownPartialWidth = 0;
    this.started = false;
  }

  begin() {
    if (this.started) return;
    this.started = true;
    this.write('\n' + this.prefix);
    this.lineStartWidth = stringWidth(this.prefix);
  }

  erasePartial() {
    const width = this.shownPartialWidth + (this.lineStartWidth || 0);
    if (!this.shownPartialWidth) { this.shownChars = 0; return; }
    const cols = Math.max(10, this.columns());
    const up = width > 0 ? Math.floor((width - 1) / cols) : 0;
    this.write((up ? '\x1b[' + up + 'A' : '') + '\r\x1b[J' + (this.lineStartWidth ? this.prefix : ''));
    this.shownPartialWidth = 0;
    this.shownChars = 0;
  }

  push(text) {
    if (!text) return;
    this.begin();
    this.partial += text;
    let newline;
    while ((newline = this.partial.indexOf('\n')) !== -1) {
      const line = this.partial.slice(0, newline);
      this.partial = this.partial.slice(newline + 1);
      this.erasePartial();
      const rendered = renderMarkdownLine(line, this.state, { color: this.color, columns: this.columns() });
      if (rendered !== null) this.write(rendered + '\n');
      else if (this.lineStartWidth) this.write('\n');
      this.lineStartWidth = 0;
    }
    if (this.partial) {
      const fresh = this.partial.slice(this.shownChars || 0);
      if (fresh) { this.write(fresh); this.shownPartialWidth += stringWidth(fresh); this.shownChars = this.partial.length; }
    }
  }

  end() {
    if (!this.started) return false;
    if (this.partial) {
      this.erasePartial();
      const rendered = renderMarkdownLine(this.partial, this.state, { color: this.color, columns: this.columns() });
      if (rendered !== null) this.write(rendered);
    }
    this.write('\n');
    this.partial = '';
    this.shownPartialWidth = 0;
    this.shownChars = 0;
    this.started = false;
    this.state = { fence: null, lang: '' };
    return true;
  }
}

// ---------------------------------------------------------------------------
// Diffs

// Minimal line diff (LCS) for edit previews. Bounded to keep it cheap.
export function lineDiff(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  if (a.length * b.length > 250000) return [...a.map((line) => ({ op: '-', line })), ...b.map((line) => ({ op: '+', line }))];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: ' ', line: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', line: a[i] }); i += 1; }
    else { out.push({ op: '+', line: b[j] }); j += 1; }
  }
  while (i < a.length) out.push({ op: '-', line: a[i++] });
  while (j < b.length) out.push({ op: '+', line: b[j++] });
  return out;
}

export function diffStats(ops) {
  return { added: ops.filter((op) => op.op === '+').length, removed: ops.filter((op) => op.op === '-').length };
}

export function renderDiff(before, after, { color = true, context = 2, maxLines = 40 } = {}) {
  const ops = lineDiff(before, after);
  const keep = new Set();
  ops.forEach((op, index) => { if (op.op !== ' ') for (let k = index - context; k <= index + context; k += 1) keep.add(k); });
  const lines = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!keep.has(index)) { if (!skipped && lines.length) lines.push(color ? C.dim + '    ⋮' + C.noBold : '    ...'); skipped = true; return; }
    skipped = false;
    const text = op.op + ' ' + op.line;
    if (!color) lines.push('    ' + text);
    else if (op.op === '+') lines.push('    ' + C.bgGreen + C.green + text + C.fg + C.bg);
    else if (op.op === '-') lines.push('    ' + C.bgRed + C.red + text + C.fg + C.bg);
    else lines.push('    ' + C.dim + text + C.noBold);
  });
  const stats = diffStats(ops);
  if (lines.length > maxLines) {
    const hidden = lines.length - maxLines;
    lines.length = maxLines;
    lines.push((color ? C.dim : '') + '    … ' + hidden + ' more diff lines' + (color ? C.noBold : ''));
  }
  return { text: lines.join('\n'), ...stats };
}

export const ANSI = C;
