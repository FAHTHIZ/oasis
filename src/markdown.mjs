// Terminal markdown rendering for streamed assistant replies, plus colored
// diffs for file edits. Line-oriented so it works while text streams in: the
// partial line is shown raw and replaced by its rendered form once complete.
import { Lexer } from 'marked';
import { createRequire } from 'node:module';
import { diffArrays } from 'diff';
import { stringWidth } from './line-editor.mjs';
import { renderMermaid } from './mermaid-ascii.mjs';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m', underline: '\x1b[4m',
  noBold: '\x1b[22m', noItalic: '\x1b[23m', noUnderline: '\x1b[24m', fg: '\x1b[39m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
  bgRed: '\x1b[48;5;52m', bgGreen: '\x1b[48;5;22m', bg: '\x1b[49m'
};

export function colorEnabled(stream = process.stdout, env = process.env) {
  if (env.NO_COLOR || env.OASIS_NO_COLOR === '1' || env.OASIS_AX_SCREEN_READER === '1' || env.CLAUDE_AX_SCREEN_READER === '1') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY);
}

// Code blocks are highlighted with lowlight (highlight.js grammars, the same
// pairing Gemini CLI uses). Each scope maps to one ANSI colour; nested scopes
// restore their parent's colour when they end. Unknown languages stay plain.
// lowlight loads every grammar on import (~70 ms), so it is required on the
// first highlighted line rather than at startup.
let lowlight;
function highlighter() {
  if (lowlight === undefined) {
    try {
      const { common, createLowlight } = createRequire(import.meta.url)('lowlight');
      lowlight = createLowlight(common);
      lowlight.registerAlias({ diff: ['patch'] });
    } catch { lowlight = null; }
  }
  return lowlight;
}
const SCOPE_COLORS = {
  keyword: C.magenta, built_in: C.cyan, type: C.cyan, literal: C.yellow, number: C.yellow,
  string: C.green, regexp: C.green, symbol: C.yellow, char: C.green, comment: C.gray, doctag: C.gray, quote: C.gray,
  meta: C.gray, title: C.blue, section: C.blue, name: C.blue, tag: C.blue, attr: C.yellow, attribute: C.yellow,
  selector: C.blue, 'selector-tag': C.blue, 'selector-class': C.yellow, 'selector-id': C.yellow,
  variable: C.cyan, 'template-variable': C.cyan, property: C.cyan, bullet: C.yellow, link: C.blue,
  addition: C.green, deletion: C.red, subst: C.fg
};

function scopeColor(className) {
  for (const name of className || []) {
    const scope = String(name).replace(/^hljs-/, '').replace(/_+$/, '');
    if (SCOPE_COLORS[scope]) return SCOPE_COLORS[scope];
  }
  return null;
}

function paintTree(nodes, parent) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') { out += node.value; continue; }
    const color = node.type === 'element' ? scopeColor(node.properties && node.properties.className) : null;
    if (color) out += color + paintTree(node.children || [], color) + parent;
    else out += paintTree(node.children || [], parent);
  }
  return out;
}

export function highlightCode(line, lang = '') {
  const language = String(lang || '').toLowerCase();
  const engine = language ? highlighter() : null;
  if (!engine || !engine.registered(language)) return line;
  try { return paintTree(engine.highlight(language, line).children, C.fg); }
  catch { return line; }
}

// Inline Markdown (emphasis, code, links, strikethrough, escapes) is parsed
// by marked's GFM inline lexer and drawn with ANSI styles.
function inlineTokens(tokens) {
  let out = '';
  for (const token of tokens || []) {
    switch (token.type) {
      case 'strong': out += C.bold + inlineTokens(token.tokens) + C.noBold; break;
      case 'em': out += C.italic + inlineTokens(token.tokens) + C.noItalic; break;
      case 'del': out += '\x1b[9m' + inlineTokens(token.tokens) + '\x1b[29m'; break;
      case 'codespan': out += C.cyan + token.text + C.fg; break;
      case 'link':
        out += /^https?:\/\//i.test(token.href)
          ? '\x1b]8;;' + token.href + '\x07' + C.underline + C.blue + inlineTokens(token.tokens) + C.fg + C.noUnderline + '\x1b]8;;\x07'
          : token.raw;
        break;
      case 'escape': out += token.text; break;
      case 'br': out += '\n'; break;
      default: out += token.tokens ? inlineTokens(token.tokens) : (token.raw ?? token.text ?? '');
    }
  }
  return out;
}

export function renderInline(text, { color = true } = {}) {
  if (!color) return text;
  return inlineTokens(Lexer.lexInline(String(text), { gfm: true }));
}

// Renders one complete markdown line given fence state; returns null when the
// line should be hidden (fence markers).
export function renderMarkdownLine(line, state, options = {}) {
  const { color = true, columns = 80 } = options;
  const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
  const diagrams = options.diagrams ?? (color && process.env.OASIS_MERMAID !== '0');
  if (fence) {
    if (!state.fence) {
      state.fence = fence[1]; state.lang = fence[2] || '';
      if (diagrams && state.lang.toLowerCase() === 'mermaid') { state.mermaid = []; return null; }
      // No language label: a dim "bash" above the commands read as part of
      // them and was copied with them. Highlighting already marks the block.
      return null;
    }
    if (fence[1] === state.fence) {
      const source = state.mermaid;
      state.fence = null; state.lang = ''; state.mermaid = null;
      if (source) {
        const drawn = renderMermaid(source.join('\n'), { columns: Math.max(40, columns - 2) });
        const body = drawn !== null ? drawn : source.map((row) => highlightCode(row, 'mermaid')).join('\n');
        const title = color ? C.dim + '  ' + (drawn !== null ? 'diagram' : 'mermaid') + C.noBold + '\n' : '';
        return title + body.split('\n').map((row) => '  ' + row).join('\n');
      }
      return null;
    }
  }
  if (state.fence && state.mermaid) { state.mermaid.push(line); return null; }
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
  const out = String(text || '').split('\n').map((line) => renderMarkdownLine(line, state, options)).filter((line) => line !== null);
  if (state.mermaid && state.mermaid.length) out.push(...state.mermaid.map((row) => '  ' + row));
  return out.join('\n');
}

// Word-wrap a rendered (possibly colored) line so words never split at the
// terminal edge. `offset` is the width already used on the first row (the
// reply bullet); continuation rows are indented to line up with the text.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/y;
export function wrapRendered(text, columns, { offset = 0, indent = null } = {}) {
  const width = Math.max(20, Number(columns) || 80) - 1;
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (offset + stringWidth(plain) <= width) return text;
  const lead = /^(\s*(?:[•*+-]\s+|\d+[.)]\s+|>\s*)?)/.exec(plain)[1];
  const pad = ' '.repeat(indent === null ? Math.min(Math.floor(width / 2), offset + stringWidth(lead)) : indent);
  const tokens = [];
  for (let i = 0; i < text.length;) {
    ANSI_RE.lastIndex = i;
    const esc = ANSI_RE.exec(text);
    if (esc) { tokens.push({ esc: esc[0] }); i += esc[0].length; continue; }
    const ch = text[i];
    const space = ch === ' ';
    const last = tokens[tokens.length - 1];
    if (last && !last.esc && last.space === space) last.text += ch;
    else tokens.push({ text: ch, space });
    i += 1;
  }
  let out = '';
  let col = offset;
  let pendingSpace = '';
  for (const token of tokens) {
    if (token.esc) { out += token.esc; continue; }
    if (token.space) { pendingSpace += token.text; continue; }
    let word = token.text;
    const wordWidth = stringWidth(word);
    if (col > stringWidth(pad) && col + stringWidth(pendingSpace) + wordWidth > width) {
      out += '\n' + pad;
      col = stringWidth(pad);
      pendingSpace = '';
    }
    out += pendingSpace;
    col += stringWidth(pendingSpace);
    pendingSpace = '';
    // A single word longer than the row (a URL, a path) is split as a last resort.
    while (col + stringWidth(word) > width && word.length > 1) {
      let take = 0, used = 0;
      for (const c of word) { const w = stringWidth(c); if (col + used + w > width) break; used += w; take += c.length; }
      if (!take) { out += '\n' + pad; col = stringWidth(pad); continue; }
      out += word.slice(0, take) + '\n' + pad;
      word = word.slice(take);
      col = stringWidth(pad);
    }
    out += word;
    col += stringWidth(word);
  }
  return out;
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

  // Writes a full line (a notice) while a reply is streaming: the shown
  // partial line is lifted out, the notice printed, and the partial redrawn
  // below it, so the reply is not left half above and repeated below.
  interject(line) {
    const text = String(line || '').replace(/\n+$/, '') + '\n';
    if (!this.started || (!this.shownPartialWidth && !this.lineStartWidth)) { this.write(text); return; }
    const width = this.shownPartialWidth + (this.lineStartWidth || 0);
    const cols = Math.max(10, this.columns());
    const up = width > 0 ? Math.floor((width - 1) / cols) : 0;
    const prefix = this.lineStartWidth ? this.prefix : '';
    const shown = this.partial.slice(0, this.shownChars || 0);
    this.write((up ? '\x1b[' + up + 'A' : '') + '\r\x1b[J' + text + prefix + shown);
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
      const prose = !this.state.fence && !/^\s*(```|~~~|\|)/.test(line);
      const rendered = renderMarkdownLine(line, this.state, { color: this.color, columns: this.columns() });
      // Blank prose lines wait for more text: runs collapse to one, and a
      // reply's trailing blank lines never print (no gap before tool lines).
      if (rendered !== null && prose && !line.trim() && !this.lineStartWidth) { this.pendingBlank = true; continue; }
      if (rendered !== null && this.pendingBlank) { this.write('\n'); this.pendingBlank = false; }
      if (rendered !== null) this.write((prose ? wrapRendered(rendered, this.columns(), { offset: this.lineStartWidth || 0 }) : rendered) + '\n');
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
    if (this.partial && this.partial.trim() && this.pendingBlank) { this.erasePartial(); this.write('\n'); }
    this.pendingBlank = false;
    if (this.partial) {
      this.erasePartial();
      const prose = !this.state.fence && !/^\s*(```|~~~|\|)/.test(this.partial);
      const rendered = renderMarkdownLine(this.partial, this.state, { color: this.color, columns: this.columns() });
      if (rendered !== null) this.write(prose ? wrapRendered(rendered, this.columns(), { offset: this.lineStartWidth || 0 }) : rendered);
    }
    // An unclosed mermaid fence: show what was buffered instead of dropping it.
    if (this.state.mermaid && this.state.mermaid.length) this.write('\n' + this.state.mermaid.map((row) => '  ' + row).join('\n'));
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

// Line diff for edit previews: jsdiff's Myers O(ND) diff, bounded by edit
// distance and time; past either bound the change is shown as a replacement.
export function lineDiff(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  const parts = diffArrays(a, b, { maxEditLength: 5000, timeout: 250 });
  if (!parts) return [...a.map((line) => ({ op: '-', line })), ...b.map((line) => ({ op: '+', line }))];
  const out = [];
  for (const part of parts) {
    const op = part.added ? '+' : part.removed ? '-' : ' ';
    for (const line of part.value) out.push({ op, line });
  }
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
    // On a tinted background the code stays in the normal text color so it is
    // readable; only the +/- sign carries the color. Themes without diff
    // backgrounds (ANSI, colorblind) color the whole line instead.
    else if (op.op === '+') lines.push('    ' + (C.bgGreen ? C.bgGreen + C.green + C.bold + '+' + C.noBold + C.fg + ' ' + op.line : C.green + text) + C.fg + C.bg);
    else if (op.op === '-') lines.push('    ' + (C.bgRed ? C.bgRed + C.red + C.bold + '-' + C.noBold + C.fg + ' ' + op.line : C.red + text) + C.fg + C.bg);
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
