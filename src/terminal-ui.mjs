// Terminal presentation for the interactive CLI: the animated startup banner,
// the prompt and footer, `!` shell mode, and tool activity lines with diffs.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubEnvironment } from './tools.mjs';
import { ANSI, colorEnabled, renderDiff } from './markdown.mjs';
import { currentTheme, themeFg } from './themes.mjs';
import { stringWidth, stripAnsi } from './line-editor.mjs';

const LOGO = [
  '  ██████   █████  ███████ ██ ███████',
  ' ██    ██ ██   ██ ██      ██ ██     ',
  ' ██    ██ ███████ ███████ ██ ███████',
  ' ██    ██ ██   ██      ██ ██      ██',
  '  ██████  ██   ██ ███████ ██ ███████'
];

// Desert-oasis palette: deep water teal → lagoon → sky → sand → sunset.
const STOPS = [[20, 184, 166], [45, 212, 191], [56, 189, 248], [251, 191, 36], [249, 115, 22]];

// The brand gradient; other themes blend their "claude" and "claudeShimmer" tokens.
function stops() {
  const theme = currentTheme();
  if (theme.id === 'dark') return STOPS;
  const a = theme.colors.claude && theme.colors.claude.rgb;
  const b = theme.colors.claudeShimmer && theme.colors.claudeShimmer.rgb;
  return a && b ? [a, b] : a ? [a, a] : null;
}

function gradientAt(t) {
  const list = stops();
  if (!list) return null;
  const x = Math.max(0, Math.min(1, t)) * (list.length - 1);
  const i = Math.min(list.length - 2, Math.floor(x));
  const f = x - i;
  return list[i].map((v, k) => Math.round(v + (list[i + 1][k] - v) * f));
}

// 16-color themes have no RGB accent: fall back to the theme's ANSI accent.
const rgb = (tone) => (tone ? '\x1b[38;2;' + tone[0] + ';' + tone[1] + ';' + tone[2] + 'm' : themeFg('claude') || '\x1b[36m');

export function animationEnabled(stream = process.stdout, env = process.env) {
  if (!colorEnabled(stream, env)) return false;
  if (env.OASIS_NO_ANIMATION === '1' || env.CI || env.TERM === 'dumb') return false;
  return true;
}

// Renders one logo frame. `reveal` (0..1) controls how many columns are drawn;
// `shine` (column index or -1) is a highlight sweeping across the letters.
export function logoFrame(reveal = 1, shine = -1, color = true) {
  const width = Math.max(...LOGO.map((line) => line.length));
  const visible = Math.round(width * reveal);
  return LOGO.map((line) => {
    let out = '';
    for (let col = 0; col < width; col += 1) {
      const ch = col < visible ? (line[col] || ' ') : ' ';
      if (!color || ch === ' ') { out += ch; continue; }
      const distance = shine >= 0 ? Math.abs(col - shine) : 99;
      const base = gradientAt(col / width);
      const glow = distance < 4 ? 1 - distance / 4 : 0;
      const tone = base && base.map((v) => Math.round(v + (255 - v) * glow * 0.85));
      out += rgb(tone) + ch;
    }
    return out + (color ? ANSI.reset : '');
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function packageVersion() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(await readFile(file, 'utf8')).version || '';
  } catch { return ''; }
}

export async function showStartupBanner({ root, model = '', provider = '', mode = 'default', output = process.stdout, env = process.env } = {}) {
  const color = colorEnabled(output, env);
  const animate = animationEnabled(output, env) && output.isTTY;
  const version = await packageVersion();
  const height = LOGO.length;
  const width = LOGO[0].length;
  output.write('\n');
  if (animate) {
    output.write('\x1b[?25l');
    try {
      for (let i = 0; i < height; i += 1) output.write('\n');
      const draw = (lines) => output.write('\x1b[' + height + 'A\r' + lines.map((line) => '\x1b[2K' + line).join('\n') + '\n');
      const revealFrames = 16;
      for (let f = 1; f <= revealFrames; f += 1) { draw(logoFrame(f / revealFrames, Math.round((f / revealFrames) * width), color)); await sleep(22); }
      for (let s = width; s >= -6; s -= 3) { draw(logoFrame(1, s, color)); await sleep(16); }
      draw(logoFrame(1, -1, color));
    } finally { output.write('\x1b[?25h'); }
  } else {
    output.write(logoFrame(1, -1, color).join('\n') + '\n');
  }
  const dim = (text) => (color ? ANSI.dim + text + ANSI.noBold : text);
  const accent = (text) => (color ? rgb(gradientAt(0.15)) + text + ANSI.fg : text);
  const tagline = 'the open coding agent · any model · your machine';
  output.write('  ' + accent('✦') + ' ' + (color ? ANSI.bold : '') + 'Oasis' + (version ? ' v' + version : '') + (color ? ANSI.noBold : '') + '  ' + dim(tagline) + '\n');
  const rows = [
    ['workspace', root || process.cwd()],
    ...(model ? [['model', model + (provider ? dim('  via ' + provider) : '')]] : []),
    ['mode', mode]
  ];
  for (const [label, value] of rows) output.write('  ' + dim(label.padEnd(10)) + value + '\n');
  output.write('  ' + dim('? shortcuts · / commands · @ files · ! shell · # memory · Shift+Tab modes') + '\n');
}

// Prompt and footer -------------------------------------------------------

// /color: a per-session prompt color, so several Oasis terminals are easy to tell apart.
export const PROMPT_COLORS = { red: [239, 68, 68], blue: [59, 130, 246], green: [34, 197, 94], yellow: [234, 179, 8], purple: [168, 85, 247], orange: [249, 115, 22], pink: [236, 72, 153], cyan: [6, 182, 212] };
let promptColor = null;
export function setPromptColor(name) {
  let key = String(name || '').trim().toLowerCase();
  if (!key || key === 'default' || key === 'reset') { promptColor = null; return 'default'; }
  if (key === 'random') { const keys = Object.keys(PROMPT_COLORS).filter((k) => k !== promptColor); key = keys[Math.floor(Math.random() * keys.length)]; }
  if (!PROMPT_COLORS[key]) throw new Error('Unknown color ' + name + '. Choose ' + Object.keys(PROMPT_COLORS).join(', ') + ', random or default.');
  promptColor = key;
  return key;
}
export function getPromptColor() { return promptColor; }

export function promptFor(text, color = true) {
  const bash = String(text || '').startsWith('!');
  if (!color) return '> ';
  if (bash) return (themeFg('bashBorder') || '\x1b[33m') + '❯\x1b[39m ';
  return rgb(promptColor ? PROMPT_COLORS[promptColor] : gradientAt(0.2)) + '❯' + ANSI.fg + ' ';
}

// /focus: the last prompt, one line per tool call (with +/- line counts for edits) and the final reply.
function lineCount(text) { return text ? String(text).split('\n').length : 0; }
function editStats(name, args) {
  if (name === 'write_file') return '+' + lineCount(args.content);
  const pairs = name === 'edit_file' ? [[args.old_string, args.new_string]] : name === 'multi_edit' && Array.isArray(args.edits) ? args.edits.map((e) => [e.old_string, e.new_string]) : [];
  if (!pairs.length) return '';
  let add = 0; let del = 0;
  for (const [a, b] of pairs) { add += lineCount(b); del += lineCount(a); }
  return '+' + add + ' -' + del;
}
export function focusView(messages, { color = true, width = 100 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let start = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].role === 'user' && typeof list[i].content === 'string' && !/^<(?:system|agent|hook)/.test(list[i].content)) { start = i; break; }
  if (start < 0) return 'Nothing to focus on yet. Send a prompt first.';
  const dim = (t) => (color ? '\x1b[2m' + t + '\x1b[22m' : t);
  const bold = (t) => (color ? '\x1b[1m' + t + '\x1b[22m' : t);
  const clip = (t, n) => { const one = String(t).replace(/\s+/g, ' ').trim(); return one.length > n ? one.slice(0, n - 1) + '…' : one; };
  const out = [bold('Prompt'), '  ' + String(list[start].content).trim().split('\n').slice(0, 12).join('\n  '), ''];
  const tools = [];
  let reply = '';
  const failed = new Set();
  for (const m of list.slice(start + 1)) if (m && m.role === 'tool' && /^\{"error"/.test(String(m.content || ''))) failed.add(m.tool_call_id);
  for (const m of list.slice(start + 1)) {
    if (!m || m.role !== 'assistant') continue;
    for (const call of m.tool_calls || []) {
      const fn = call.function || {};
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch {}
      const target = args.path || args.file_path || args.command || args.pattern || args.query || args.url || args.description || '';
      const stats = editStats(fn.name, args);
      tools.push('  ' + (failed.has(call.id) ? '✗ ' : '• ') + fn.name + (target ? ' ' + clip(target + (Array.isArray(args.args) ? ' ' + args.args.join(' ') : ''), Math.max(20, width - 30)) : '') + (stats ? ' ' + dim(stats) : ''));
    }
    if (m.content) reply = String(m.content);
  }
  out.push(bold('Tools (' + tools.length + ')'), ...(tools.length ? tools : ['  (none)']), '', bold('Response'), reply ? '  ' + reply.trim().split('\n').join('\n  ') : '  (no reply yet)');
  return out.join('\n');
}

// Ctrl+O transcript (Claude Code's transcript mode): every prompt, reply, tool call and tool
// result, expanded, as wrapped lines for the full-screen pager.
export function transcriptLines(messages, { color = true, width = 100, maxResult = 4000 } = {}) {
  const dim = (t) => (color ? '\x1b[2m' + t + '\x1b[22m' : t);
  const bold = (t) => (color ? '\x1b[1m' + t + '\x1b[22m' : t);
  const tone = (code, t) => (color ? '\x1b[' + code + 'm' + t + '\x1b[39m' : t);
  const cols = Math.max(20, width - 2);
  const wrap = (text, indent = '  ') => {
    const rows = [];
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      let line = raw.replace(/\t/g, '  ');
      if (!line) { rows.push(''); continue; }
      while (line.length > cols - indent.length) { rows.push(indent + line.slice(0, cols - indent.length)); line = line.slice(cols - indent.length); }
      rows.push(indent + line);
    }
    return rows;
  };
  const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part && part.type === 'text' ? part.text : part && part.type ? '[' + part.type + ']' : '')).join('\n') : '');
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'user') {
      const text = textOf(m.content);
      const injected = /^<(?:system|agent|hook)/.test(text);
      out.push(injected ? dim('▸ context') : bold(tone('36', '> You')), ...wrap(injected ? text.slice(0, 600) + (text.length > 600 ? '…' : '') : text), '');
    } else if (m.role === 'assistant') {
      const text = textOf(m.content);
      if (m.reasoning || m.reasoning_content) out.push(dim('∴ thinking'), ...wrap(String(m.reasoning || m.reasoning_content)).map(dim), '');
      if (text.trim()) out.push(bold('● Oasis'), ...wrap(text.trim()), '');
      for (const call of m.tool_calls || []) {
        const fn = call.function || {};
        let args = fn.arguments || '{}';
        try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
        out.push(tone('33', '⏺ ' + (fn.name || 'tool')), ...wrap(args, '    ').map(dim));
      }
    } else if (m.role === 'tool') {
      const text = String(textOf(m.content));
      const failed = /^\{"error"/.test(text);
      const shown = text.length > maxResult ? text.slice(0, maxResult) + '\n… (' + (text.length - maxResult) + ' more characters)' : text;
      out.push(tone(failed ? '31' : '32', '  ⎿ ' + (failed ? 'error' : 'result')), ...wrap(shown, '    '), '');
    }
  }
  return out.length ? out : ['Nothing in the transcript yet.'];
}

const MODE_LABELS = {
  acceptEdits: '⏵⏵ accept edits on',
  plan: '⏸ plan mode on',
  auto: '⏵⏵ auto mode on',
  bypassPermissions: '⏵⏵ bypass permissions on'
};

export function footerFor({ text = '', mode = 'default', queued = 0, color = true } = {}) {
  const parts = [];
  if (String(text).startsWith('!')) parts.push('! shell mode — runs in your terminal; output is shared with Oasis');
  else if (MODE_LABELS[mode]) parts.push(MODE_LABELS[mode] + ' (shift+tab to cycle)');
  if (queued) parts.push(queued + ' queued');
  if (!parts.length) return '';
  const line = '  ' + parts.join(' · ');
  if (!color) return line;
  const tone = (mode === 'plan' ? themeFg('planMode') : mode === 'bypassPermissions' ? themeFg('error') : mode === 'auto' || mode === 'acceptEdits' ? themeFg('autoAccept') : themeFg('warning')) || '\x1b[33m';
  return String(text).startsWith('!') ? (themeFg('bashBorder') || '\x1b[33m') + line + '\x1b[39m' : tone + line + '\x1b[39m';
}

export const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];

export function nextMode(current, { allowBypass = false } = {}) {
  const cycle = allowBypass ? [...MODE_CYCLE, 'bypassPermissions'] : MODE_CYCLE;
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length];
}

// `!` shell mode ------------------------------------------------------------

const MAX_CAPTURE = 30000;

export function runShellPassthrough(command, { root, output = process.stdout, env = process.env, powershell = null } = {}) {
  return new Promise((resolve) => {
    // "defaultShell": "powershell" routes ! commands through PowerShell.
    const shell = powershell || (process.platform === 'win32' ? (env.ComSpec || 'cmd.exe') : (env.SHELL || '/bin/sh'));
    const args = powershell ? ['-NoProfile', '-Command', command] : process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    let captured = '';
    const capture = (chunk) => {
      const text = chunk.toString('utf8');
      output.write(text);
      captured += text;
      if (captured.length > MAX_CAPTURE * 2) captured = captured.slice(-MAX_CAPTURE);
    };
    let child;
    try { child = spawn(shell, args, { cwd: root, env: scrubEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: 1, output: String(error.message) }); return; }
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const onInt = () => { try { child.kill('SIGINT'); } catch {} };
    process.on('SIGINT', onInt);
    child.on('error', (error) => { captured += String(error.message); });
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', onInt);
      resolve({ code: code === null ? 130 : code, signal, output: captured.length > MAX_CAPTURE ? '…' + captured.slice(-MAX_CAPTURE) : captured });
    });
  });
}

export function shellContextBlock(entries) {
  return entries.map((entry) => '<bash-input>' + entry.command + '</bash-input>\n<bash-output exit-code="' + entry.code + '">\n' + entry.output.trimEnd() + '\n</bash-output>').join('\n\n');
}

// Tool activity -------------------------------------------------------------

const TOOL_LABELS = {
  read_file: 'Read', write_file: 'Write', edit_file: 'Update', multi_edit: 'Update', delete_file: 'Delete',
  list_files: 'List', glob_files: 'Search', grep: 'Search', search_files: 'Search', run_command: 'Bash', run_shell: 'Bash',
  fetch_url: 'Fetch', web_search: 'Web Search', task: 'Agent', todo_write: 'Update Todos', git_status: 'Git', git_diff: 'Git',
  git_log: 'Git', git_commit: 'Git Commit', git_push: 'Git Push', git_branch: 'Git', create_pull_request: 'Pull Request',
  diagnostics: 'Diagnostics', lsp: 'LSP', notebook_edit: 'Notebook', load_skill: 'Skill', install_package: 'Install', monitor: 'Monitor'
};

export function toolLabel(name) {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (String(name).startsWith('mcp__')) return String(name).split('__').slice(1).join(' · ');
  return String(name).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function describeTool({ name, args = {}, subagent }, { color = true } = {}) {
  let detail = '';
  if (name === 'run_command') detail = [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ');
  if (name === 'monitor') detail = (args.description ? args.description + ' · ' : '') + (args.ws ? String(args.ws.url || '') : [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' '));
  else if (name === 'run_shell') detail = String(args.command || '');
  else if (name === 'task') detail = (args.subagent_type || 'general-purpose') + ': ' + (args.description || '');
  else if (args.path || args.pattern || args.query || args.url) detail = String(args.path || args.pattern || args.query || args.url);
  if (detail.length > 140) detail = detail.slice(0, 137) + '...';
  const indent = subagent ? '  ' : '';
  if (!color) return indent + (subagent ? '[' + subagent + '] ' : '[tool] ') + name + (detail ? ' ' + detail : '');
  const dot = (themeFg('claude') || '\x1b[36m') + '⏺\x1b[39m ';
  return indent + dot + (subagent ? ANSI.dim + subagent + ' › ' + ANSI.noBold : '') + ANSI.bold + toolLabel(name) + ANSI.noBold + (detail ? '(' + detail + ')' : '');
}

// Returns a colored diff summary for a successful edit, or '' when not applicable.
export function describeEdit({ name, args = {}, result = {} }, { color = true } = {}) {
  if (!result || result.error) return '';
  const pairs = name === 'edit_file' ? [[args.old_string, args.new_string]]
    : name === 'multi_edit' && Array.isArray(args.edits) ? args.edits.map((edit) => [edit.old_string, edit.new_string])
      : [];
  if (name === 'write_file' && typeof args.content === 'string') {
    const lines = args.content.split('\n').length;
    return '  ⎿ ' + (color ? ANSI.dim : '') + 'Wrote ' + lines + ' line' + (lines === 1 ? '' : 's') + ' to ' + args.path + (color ? ANSI.noBold : '');
  }
  if (!pairs.length) return '';
  let added = 0;
  let removed = 0;
  const bodies = [];
  for (const [before, after] of pairs) {
    if (typeof before !== 'string' || typeof after !== 'string') continue;
    const diff = renderDiff(before, after, { color, maxLines: 24 });
    added += diff.added;
    removed += diff.removed;
    bodies.push(diff.text);
  }
  if (!bodies.length) return '';
  const summary = '  ⎿ ' + (color ? ANSI.dim : '') + 'Updated ' + (args.path || 'file') + ' with ' + added + ' addition' + (added === 1 ? '' : 's') + ' and ' + removed + ' removal' + (removed === 1 ? '' : 's') + (color ? ANSI.noBold : '');
  return summary + '\n' + bodies.join('\n');
}

export function visibleWidth(text) { return stringWidth(stripAnsi(text)); }
