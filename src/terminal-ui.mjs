// Terminal presentation for the interactive CLI: the animated startup banner,
// the prompt and footer, `!` shell mode, and tool activity lines with diffs.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wrapAnsi from 'wrap-ansi';
import { scrubEnvironment } from './tools.mjs';
import { motionLevel } from './activity-indicator.mjs';
import { ANSI, colorEnabled, renderDiff } from './markdown.mjs';
import { currentTheme, themeFg } from './themes.mjs';
import { fenLines, FEN_COLUMNS } from './mascot.mjs';

const LOGO = [
  '  ██████   █████  ███████ ██ ███████',
  ' ██    ██ ██   ██ ██      ██ ██     ',
  ' ██    ██ ███████ ███████ ██ ███████',
  ' ██    ██ ██   ██      ██ ██      ██',
  '  ██████  ██   ██ ███████ ██ ███████'
];

// OASIS portal palette: lime → growth green → signal green.
const STOPS = [[124, 255, 94], [50, 224, 122], [14, 209, 104]];

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

// Show paths under the home directory as ~/… (shorter, and it doesn't put a
// username on screen when you share a recording).
export function tildePath(target, env = process.env) {
  const home = String(env.HOME || env.USERPROFILE || '');
  const value = String(target || '');
  if (!home || home === '/' || !value) return value;
  if (value === home) return '~';
  return value.startsWith(home + path.sep) ? '~' + value.slice(home.length) : value;
}

export function animationEnabled(stream = process.stdout, env = process.env) {
  if (!colorEnabled(stream, env)) return false;
  if (env.OASIS_NO_ANIMATION === '1' || env.CI || env.TERM === 'dumb') return false;
  return motionLevel({ env, stream }) !== 'off';
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

// The startup banner: Fen beside the wordmark, the wordmark aligned with Fen's chin.
// `layout` is 'full' (Fen and wordmark), 'logo' (wordmark only) or 'fen' (Fen only).
const MASCOT_GAP = '   ';
export function bannerFrame({ reveal = 1, shine = -1, color = true, blink = false, layout = 'full' } = {}) {
  const logo = logoFrame(reveal, shine, color);
  if (layout === 'logo') return logo;
  const fen = fenLines({ color: color && Boolean(stops()), blink });
  if (layout === 'fen') return fen;
  const offset = fen.length - logo.length;
  return fen.map((line, i) => line + MASCOT_GAP + (i >= offset ? logo[i - offset] : ''));
}

export function bannerLayout(columns, env = process.env) {
  const cols = Number(columns || 0);
  const logoWidth = LOGO[0].length;
  const mascot = !/^(?:1|true|yes|on)$/i.test(String(env.OASIS_NO_MASCOT || ''));
  if (!cols || cols >= FEN_COLUMNS + MASCOT_GAP.length + logoWidth + 4) return mascot ? 'full' : 'logo';
  if (cols >= logoWidth + 4) return 'logo';
  return mascot && cols >= FEN_COLUMNS + 4 ? 'fen' : 'none';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function packageVersion() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(await readFile(file, 'utf8')).version || '';
  } catch { return ''; }
}

const STARTUP_TIPS = [
  'Ask Oasis to read the project and explain it before changing files.',
  'Use /plan before a large or risky change.',
  'Use /undo to review and rewind the last turn when needed.',
  'Use /doctor when setup or the model connection seems broken.',
  'Read each approval prompt; Oasis runs commands with your account permissions.',
  'Use /context to see how much of the model context is in use.',
  'Use /cost to review estimated usage for this session.',
  'Ask Oasis to run the relevant tests before it says a change is done.',
  'Type /connect github (or linear, notion, sentry, ...) to give Oasis an app in one step.'
];

// The banner's "via …": a server name people recognise instead of the wire
// protocol ("openai-compatible" said nothing about Ollama running locally).
// No network probe: loopback ports of the common local servers, else the host.
const LOCAL_SERVER_PORTS = { 11434: 'Ollama', 1234: 'LM Studio' };
export function bannerProviderLabel(config = {}) {
  const protocol = String(config.protocol || '');
  if (!config.baseURL) return protocol;
  let url;
  try { url = new URL(String(config.baseURL)); } catch { return protocol; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return (LOCAL_SERVER_PORTS[port] || 'local server :' + port) + ' (this device)';
  return protocol === 'openai-compatible' ? host : protocol;
}

export function startupTip(env = process.env, now = Date.now()) {
  if (String(env.OASIS_TIP || '').toLowerCase() === 'off' || env.OASIS_NO_TIPS === '1') return '';
  const day = Math.floor(Number(now) / 86_400_000);
  const index = ((day % STARTUP_TIPS.length) + STARTUP_TIPS.length) % STARTUP_TIPS.length;
  return STARTUP_TIPS[index];
}

export async function showStartupBanner({ root, model = '', provider = '', mode = 'default', output = process.stdout, env = process.env } = {}) {
  const color = colorEnabled(output, env);
  const animate = animationEnabled(output, env) && output.isTTY;
  const version = await packageVersion();
  const layout = bannerLayout(output.columns, env);
  const frame = (options = {}) => bannerFrame({ color, layout, ...options });
  const height = frame().length;
  const width = LOGO[0].length;
  output.write('\n');
  // Narrow terminals (a phone in Termux, a split pane) drop the wordmark or Fen instead of wrapping.
  if (layout === 'none') {}
  else if (animate) {
    output.write('\x1b[?25l');
    try {
      for (let i = 0; i < height; i += 1) output.write('\n');
      const draw = (lines) => output.write('\x1b[' + height + 'A\r' + lines.map((line) => '\x1b[2K' + line).join('\n') + '\n');
      // Low-power machines and SSH sessions get a short reveal with no sweep:
      // fewer full-logo redraws, same final frame.
      const lite = motionLevel({ env, stream: output }) === 'lite';
      const revealFrames = lite ? 4 : 16;
      for (let f = 1; f <= revealFrames; f += 1) { draw(frame({ reveal: f / revealFrames, shine: lite ? -1 : Math.round((f / revealFrames) * width) })); await sleep(lite ? 40 : 22); }
      if (!lite) for (let s = width; s >= -6; s -= 3) { draw(frame({ shine: s })); await sleep(16); }
      // Fen blinks once as the banner settles.
      if (!lite && layout !== 'logo') { draw(frame({ blink: true })); await sleep(120); }
      draw(frame());
    } finally { output.write('\x1b[?25h'); }
  } else {
    output.write(frame().join('\n') + '\n');
  }
  const dim = (text) => (color ? ANSI.dim + text + ANSI.noBold : text);
  const accent = (text) => (color ? rgb(gradientAt(0.15)) + text + ANSI.fg : text);
  const tagline = 'CODE. AUTOMATE. FLOURISH.';
  output.write('  ' + accent('✦') + ' ' + (color ? ANSI.bold : '') + 'OASIS' + (version ? ' v' + version : '') + (color ? ANSI.noBold : '') + '  ' + dim(tagline) + '\n');
  const rows = [
    ['workspace', tildePath(root || process.cwd(), env)],
    ...(model ? [['model', model + (provider ? dim('  via ' + provider) : '')]] : []),
    ['mode', mode]
  ];
  for (const [label, value] of rows) output.write('  ' + dim(label.padEnd(10)) + value + '\n');
  // Split the hint row between items rather than letting the terminal break "Shift+Tab modes".
  for (const hint of hintRows(['? shortcuts', '/ commands', '@ files', '! shell', '# memory', 'Shift+Tab modes'], (output.columns || 100) - 2)) output.write('  ' + dim(hint) + '\n');
  const tip = (await appTip(root, env).catch(() => '')) || startupTip(env);
  if (tip) output.write('  Tip: ' + tip + '\n');
}

/** Joins items with " · " into rows no wider than width, breaking only between items. */
export function hintRows(items, width) {
  const rows = [];
  let row = '';
  for (const item of items) {
    if (row && row.length + 3 + item.length > width) { rows.push(row); row = item; }
    else row = row ? row + ' · ' + item : item;
  }
  if (row) rows.push(row);
  return rows;
}

/** "This project uses Vercel and Stripe: /connect vercel stripe" when they are not connected yet. */
export async function appTip(root, env = process.env) {
  if (String(env.OASIS_TIP || '').toLowerCase() === 'off' || env.OASIS_NO_TIPS === '1') return '';
  const { unconnectedProjectApps } = await import('./connectors.mjs');
  const missing = await unconnectedProjectApps(root || process.cwd(), env);
  if (!missing.length) return '';
  const shown = missing.slice(0, 3);
  const names = shown.map((item) => item.name);
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  return 'This project uses ' + list + '. /connect ' + shown.map((item) => item.id).join(' ') + ' gives Oasis ' + (shown.length > 1 ? 'their' : 'its') + ' tools.';
}

// Prompt and footer -------------------------------------------------------

// /color: a per-session prompt color, so several Oasis terminals are easy to tell apart.
export const PROMPT_COLORS = { red: [239, 68, 68], blue: [59, 130, 246], green: [50, 224, 122], yellow: [234, 179, 8], purple: [168, 85, 247], orange: [249, 115, 22], pink: [236, 72, 153], cyan: [6, 182, 212] };
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
// "a\n" is one line, not two: a trailing newline ends the last line.
function lineCount(text) { if (!text) return 0; const value = String(text); return value.split('\n').length - (value.endsWith('\n') ? 1 : 0); }
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
      for (const row of wrapAnsi(line, cols - indent.length, { hard: true, trim: false }).split('\n')) rows.push(indent + row);
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
  dontAsk: '⏵ never ask (denies prompts)',
  bypassPermissions: '⏵⏵ bypass permissions on'
};

export function footerFor({
  text = '', mode = 'default', queued = 0, color = true,
  model = '', contextPercent = null, costLabel = '', budgetUsd = 0,
  spentUsd = null
} = {}) {
  const parts = [];
  if (model) parts.push('model ' + String(model).slice(0, 32));
  if (Number.isFinite(contextPercent)) {
    const percent = Math.max(0, Math.min(999, Math.round(contextPercent)));
    parts.push((percent >= 90 ? '! context ' : percent >= 50 ? 'context ' : 'context ') + percent + '%');
  }
  if (costLabel) {
    const budget = Number(budgetUsd) > 0 ? Number(budgetUsd) : 0;
    parts.push('cost ' + costLabel + (budget ? ' / ' + formatCompactUsd(budget) + ' budget' : ''));
    if (budget && Number.isFinite(spentUsd)) {
      const used = Math.max(0, spentUsd / budget * 100);
      if (used >= 90) parts.push('! budget ' + Math.min(999, Math.round(used)) + '% used');
      else if (used >= 50) parts.push('budget ' + Math.round(used) + '% used');
    }
  }
  if (String(text).startsWith('!')) parts.push('! shell mode — runs in your terminal; output is shared with Oasis');
  else if (MODE_LABELS[mode]) parts.push(MODE_LABELS[mode] + ' (shift+tab to cycle)');
  if (queued) parts.push(queued + ' queued');
  if (!parts.length) return '';
  const line = '  ' + parts.join(' · ');
  if (!color) return line;
  const urgent = (Number.isFinite(contextPercent) && contextPercent >= 90) ||
    (Number(budgetUsd) > 0 && Number.isFinite(spentUsd) && spentUsd / Number(budgetUsd) >= 0.9);
  const tone = urgent ? (themeFg('error') || '\x1b[31m')
    : (mode === 'plan' ? themeFg('planMode') : mode === 'bypassPermissions' ? themeFg('error') : mode === 'auto' || mode === 'acceptEdits' ? themeFg('autoAccept') : themeFg('warning')) || '\x1b[33m';
  return String(text).startsWith('!') ? (themeFg('bashBorder') || '\x1b[33m') + line + '\x1b[39m' : tone + line + '\x1b[39m';
}

function formatCompactUsd(value) {
  const amount = Number(value) || 0;
  if (amount === 0) return '$0.00';
  return amount < 0.01 ? '$' + amount.toFixed(4) : '$' + amount.toFixed(2);
}
export const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];

export function nextMode(current, { allowBypass = false } = {}) {
  const cycle = allowBypass ? [...MODE_CYCLE, 'bypassPermissions'] : MODE_CYCLE;
  const index = cycle.indexOf(current);
  return cycle[(index + 1) % cycle.length];
}

// `!` shell mode ------------------------------------------------------------

const MAX_CAPTURE = 30000;

// `signal` and `timeoutMs` stop the command (App Server thread/shellCommand);
// `trapSigint: false` leaves Ctrl+C to the host process.
export function runShellPassthrough(command, { root, output = process.stdout, env = process.env, powershell = null, signal = null, timeoutMs = null, trapSigint = true } = {}) {
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
    if (trapSigint) process.on('SIGINT', onInt);
    let timedOut = false;
    const stop = () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref(); };
    const onAbort = () => stop();
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : null;
    child.on('error', (error) => { captured += String(error.message); });
    child.on('close', (code, exitSignal) => {
      if (trapSigint) process.removeListener('SIGINT', onInt);
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code: code === null ? 130 : code, signal: exitSignal, timedOut, cancelled: Boolean(signal && signal.aborted), output: captured.length > MAX_CAPTURE ? '…' + captured.slice(-MAX_CAPTURE) : captured });
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
  fetch_url: 'Fetch', web_search: 'Web Search', task: 'Agent', todo_write: 'Update Todos', git_status: 'Git Status', git_diff: 'Review Diff',
  git_log: 'Git Log', git_commit: 'Git Commit', git_push: 'Git Push', git_branch: 'Git', create_pull_request: 'Pull Request',
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
  else if (name === 'monitor') detail = (args.description ? args.description + ' · ' : '') + (args.ws ? String(args.ws.url || '') : [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' '));
  else if (name === 'run_shell' || name === 'auto_test') detail = String(args.command || '');
  else if (name === 'task') detail = (args.subagent_type || 'general-purpose') + ': ' + (args.description || '');
  else if (['search_files', 'grep', 'ast_grep', 'glob_files'].includes(name) && (args.query || args.pattern)) detail = String(args.query || args.pattern) + (args.path && args.path !== '.' ? ' in ' + args.path : '');
  else if (args.path || args.pattern || args.query || args.url) detail = String(args.path || args.pattern || args.query || args.url);
  if (detail.length > 140) detail = detail.slice(0, 137) + '...';
  const indent = subagent ? '  ' : '';
  if (!color) return indent + (subagent ? '[' + subagent + '] ' : '[tool] ') + name + (detail ? ' ' + detail : '');
  const dot = (themeFg('claude') || '\x1b[36m') + '⏺\x1b[39m ';
  return indent + dot + (subagent ? ANSI.dim + subagent + ' › ' + ANSI.noBold : '') + ANSI.bold + toolLabel(name) + ANSI.noBold + (detail ? '(' + detail + ')' : '');
}

// Test-runner summaries recognised in command output: node --test / TAP,
// Jest/Vitest, pytest, Go, Cargo, Mocha. Returns e.g. "20 passed, 0 failed".
export function summarizeTestOutput(text) {
  const out = String(text || '');
  const tap = /^# pass (\d+)\s*$/m.exec(out);
  if (tap) {
    const fail = /^# fail (\d+)\s*$/m.exec(out);
    return tap[1] + ' passed, ' + (fail ? fail[1] : '0') + ' failed';
  }
  const jest = /^Tests:\s+(.+)$/m.exec(out);
  if (jest) return jest[1].trim();
  const pytest = /=+\s*((?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed)(?:, )?)+)(?: in [\d.]+s)?\s*=+/.exec(out);
  if (pytest) return pytest[1].trim();
  const cargo = /test result: (\w+)\. (\d+) passed; (\d+) failed/.exec(out);
  if (cargo) return cargo[2] + ' passed, ' + cargo[3] + ' failed';
  const mocha = /^\s*(\d+) passing\b.*$(?:\n\s*(\d+) failing)?/m.exec(out);
  if (mocha) return mocha[1] + ' passed, ' + (mocha[2] || '0') + ' failed';
  if (/^ok\s+\S+\s+[\d.]+s$/m.test(out) && !/^(FAIL|---\s*FAIL)/m.test(out)) return 'go test ok';
  return '';
}

function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

// The line of a failed command's output that explains the failure. Runtimes
// end crashes with noise ("Node.js v22.20.0", a stack frame, "^"), so prefer
// the error line itself: "AssertionError [ERR_ASSERTION]: Expected ...".
// Bare links and "see the docs" pointers (Jest ends a bad flag with its CLI
// docs URL) are noise too: the line above them says what went wrong.
const NOISE_LINE = /^(?:Node\.js v\d|at\s|\^+$|[~^\s]+$|\}$|\{$|throw\b|npm (?:ERR!|error) (?:A complete log|code|path|errno|command failed|cwd)|Traceback \(most recent call last\)|File "|https?:\/\/\S+$|[\w ]*Documentation:$|For more information|Run with --|Usage:)/i;
const ERROR_LINE = /\b(?:\w*Error|Exception|FAIL(?:ED)?|panic|fatal|error)\b[:\[ ]|^(?:● )?(?:Unrecognized|Unknown|Invalid|Cannot find|Could not|Missing|No such|Unexpected)\b|\bcommand not found\b|\bnot recognized as\b/i;
export function failureLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((line) => ERROR_LINE.test(line) && !NOISE_LINE.test(line));
  // Python tracebacks end with the real exception; most tools lead with it.
  if (errors.length) {
    const picked = /Traceback \(most recent call last\)/.test(text) ? errors[errors.length - 1] : errors[0];
    // A heading such as Jest's "● Unrecognized CLI Parameter:" says what kind
    // of failure it is; the next line says which one.
    if (/:$/.test(picked)) {
      const next = lines.slice(lines.indexOf(picked) + 1).find((line) => !NOISE_LINE.test(line));
      if (next) return picked.replace(/^● /, '') + ' ' + next;
    }
    return picked;
  }
  const useful = lines.filter((line) => !NOISE_LINE.test(line));
  return useful.length ? useful[useful.length - 1] : lastLine(text);
}

// One dim line under a tool call saying what happened, like "⎿ exit 0 · 20
// passed, 0 failed". Failures and policy blocks are red. '' means nothing
// worth showing (edits have their own diff summary).
export function describeToolResult(name, result, { color = true } = {}) {
  if (result === undefined || result === null || typeof result !== 'object') return '';
  const dim = color ? ANSI.dim : '';
  const red = color ? '\x1b[31m' : '';
  const green = color ? '\x1b[32m' : '';
  const off = color ? '\x1b[0m' : '';
  const clip = (text, max = 160) => { const t = String(text).replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
  if (result.error) return '  ⎿ ' + red + '✗ ' + clip(friendlyToolError(result.error), 300) + off;
  if (['edit_file', 'multi_edit', 'write_file'].includes(name)) return '';
  if (['run_command', 'run_shell', 'auto_test'].includes(name) && result.exitCode !== undefined) {
    const combined = String(result.stdout || '') + '\n' + String(result.stderr || '');
    const tests = summarizeTestOutput(combined);
    const ok = result.exitCode === 0;
    const detail = tests || (result.timedOut ? 'timed out' : clip(ok ? lastLine(result.stdout || result.stderr) : failureLine(result.stderr || result.stdout), 110));
    const mark = ok ? green + '✓' + off + dim : red + '✗';
    return '  ⎿ ' + dim + mark + ' exit ' + result.exitCode + (detail ? ' · ' + detail : '') + off;
  }
  if (name === 'read_file' && typeof result.content === 'string') {
    const lines = result.content.replace(/\n$/, '').split('\n').length;
    return '  ⎿ ' + dim + 'Read ' + lines + ' line' + (lines === 1 ? '' : 's') + (result.truncated ? ' (truncated)' : '') + off;
  }
  if ((name === 'search_files' || name === 'grep') && Array.isArray(result.matches)) {
    const files = new Set(result.matches.map((m) => m.path)).size;
    return '  ⎿ ' + dim + result.matches.length + ' match' + (result.matches.length === 1 ? '' : 'es') + ' in ' + files + ' file' + (files === 1 ? '' : 's') + (result.truncated ? ' (more not shown)' : '') + off;
  }
  // glob_files reports `matches` (paths); it printed nothing at all before.
  if (name === 'glob_files' && Array.isArray(result.matches)) {
    const count = result.matches.length;
    return '  ⎿ ' + dim + (count ? count + ' file' + (count === 1 ? '' : 's') : 'No files found') + (result.truncated ? ' (more not shown)' : '') + off;
  }
  if ((name === 'list_files' || name === 'glob_files') && Array.isArray(result.files)) {
    return '  ⎿ ' + dim + result.files.length + ' file' + (result.files.length === 1 ? '' : 's') + (result.truncated ? ' (more not shown)' : '') + off;
  }
  if (name === 'git_diff' && typeof result.stdout === 'string') {
    const files = (result.stdout.match(/^diff --git /gm) || []).length;
    const added = (result.stdout.match(/^\+(?!\+\+)/gm) || []).length;
    const removed = (result.stdout.match(/^-(?!--)/gm) || []).length;
    return '  ⎿ ' + dim + (files ? files + ' file' + (files === 1 ? '' : 's') + ' changed, ' + green + '+' + added + off + dim + ' ' + red + '-' + removed + off : 'No changes') + off;
  }
  // Web lookups used to leave no line at all, so a search that came back
  // empty (a keyless provider refusing the query) looked like it worked.
  if (name === 'web_search' && Array.isArray(result.results)) {
    const count = result.results.length;
    if (!count) {
      const why = result.error || (Array.isArray(result.providerErrors) && result.providerErrors[0] && result.providerErrors[0].error) || '';
      return '  ⎿ ' + red + 'No results' + (why ? ' · ' + clip(why, 140) : '') + off;
    }
    const hosts = [...new Set(result.results.map((item) => { try { return new URL(item.url).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean))];
    const via = result.backend && !['federated', 'duckduckgo'].includes(result.backend) ? ' via ' + result.backend : '';
    return '  ⎿ ' + dim + count + ' result' + (count === 1 ? '' : 's') + via + (hosts.length ? ' · ' + clip(hosts.slice(0, 3).join(', '), 90) : '') + off;
  }
  if (name === 'delete_file' && result.deleted) return '  ⎿ ' + dim + 'Deleted ' + result.path + (result.backupCreated ? ' (backup kept; /rewind restores it)' : '') + off;
  if (name === 'fetch_url') {
    if (result.redirect) return '  ⎿ ' + dim + 'Redirects to ' + clip(result.redirect, 110) + off;
    if (typeof result.content === 'string') {
      const size = result.totalLength || result.content.length;
      const kb = size >= 1024 ? Math.round(size / 1024) + ' KB' : size + ' chars';
      return '  ⎿ ' + dim + 'Read ' + (result.title ? clip(result.title, 70) + ' · ' : '') + kb + (result.truncated ? ' (more available)' : '') + off;
    }
  }
  return '';
}

// Returns a colored diff summary for a successful edit, or '' when not applicable.
// The edited lines in full, with up to two lines of context and their line
// numbers, located through the new text in the file after the edit. Null when
// the new text is not found exactly once (the plain fragment diff is shown).
const EDIT_CONTEXT_LINES = 2;
export function editHunk(fileText, before, after) {
  const text = String(fileText ?? '');
  if (!after || !text) return null;
  const at = text.indexOf(after);
  if (at < 0 || text.indexOf(after, at + 1) !== -1) return null;
  let start = text.lastIndexOf('\n', at - 1) + 1;
  let end = text.indexOf('\n', at + after.length);
  if (end < 0) end = text.length;
  for (let k = 0; k < EDIT_CONTEXT_LINES && start > 0; k += 1) start = text.lastIndexOf('\n', start - 2) + 1;
  for (let k = 0; k < EDIT_CONTEXT_LINES && end + 1 < text.length; k += 1) { const next = text.indexOf('\n', end + 1); end = next < 0 ? text.length : next; }
  const prefix = text.slice(start, at);
  const suffix = text.slice(at + after.length, end);
  const startLine = text.slice(0, start).split('\n').length;
  return { before: prefix + before + suffix, after: prefix + after + suffix, startLine };
}

export function describeEdit({ name, args = {}, result = {} }, { color = true, fileText = null } = {}) {
  if (!result || result.error) return '';
  const pairs = name === 'edit_file' ? [[args.old_string, args.new_string]]
    : name === 'multi_edit' && Array.isArray(args.edits) ? args.edits.map((edit) => [edit.old_string, edit.new_string])
      : [];
  if (name === 'write_file' && typeof args.content === 'string') {
    const lines = lineCount(args.content);
    return '  ⎿ ' + (color ? ANSI.dim : '') + (args.append === true ? 'Appended ' : 'Wrote ') + lines + ' line' + (lines === 1 ? '' : 's') + ' to ' + args.path + (color ? ANSI.noBold : '');
  }
  if (!pairs.length) return '';
  let added = 0;
  let removed = 0;
  const bodies = [];
  for (const [before, after] of pairs) {
    if (typeof before !== 'string' || typeof after !== 'string') continue;
    const hunk = fileText !== null && !(name === 'edit_file' && args.replace_all === true) ? editHunk(fileText, before, after) : null;
    const diff = hunk ? renderDiff(hunk.before, hunk.after, { color, maxLines: 24, startLine: hunk.startLine }) : renderDiff(before, after, { color, maxLines: 24 });
    added += diff.added;
    removed += diff.removed;
    bodies.push(diff.text);
  }
  if (!bodies.length) return '';
  const summary = '  ⎿ ' + (color ? ANSI.dim : '') + 'Updated ' + (args.path || 'file') + ' with ' + changeCounts(added, removed) + (color ? ANSI.noBold : '');
  return summary + '\n' + bodies.join('\n');
}

// --verbose: the tool's output under its call line, dimmed and indented (Claude Code's verbose
// transcript). Long output is capped; Ctrl+O still shows the whole transcript.
export function verboseToolOutput(name, result, { color = false, maxLines = 400 } = {}) {
  if (result === undefined || result === null) return '';
  let text = '';
  if (typeof result === 'string') text = result;
  else if (typeof result === 'object') {
    const parts = [];
    for (const key of ['stdout', 'output', 'content', 'text', 'diff', 'matches', 'files', 'results']) {
      const value = result[key];
      if (value === undefined || value === null || value === '') continue;
      const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      // Tool adapters sometimes expose the same payload under both `output`
      // and `content`. Keep verbose mode readable without hiding distinct
      // fields such as stdout and stderr.
      if (parts.includes(rendered)) continue;
      parts.push(rendered);
    }
    if (result.stderr) parts.push('[stderr]\n' + result.stderr);
    text = parts.length ? parts.join('\n') : JSON.stringify(result, null, 2);
  } else text = String(result);
  text = text.replace(/\s+$/, '');
  if (!text) return '';
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines).map((line) => '  ⎿ ' + line.slice(0, 2000));
  if (lines.length > maxLines) shown.push('  ⎿ … ' + (lines.length - maxLines) + ' more lines (Ctrl+O shows the full transcript; during a turn it expands the last output)');
  const body = shown.join('\n');
  return color ? '\x1b[2m' + body + '\x1b[22m' : body;
}

// One dim line after each interactive turn: how long it took and what it did.
export function formatTurnSummary({ ms = 0, toolCalls = 0, tokens = 0, finished = true, stopped = false } = {}) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const time = seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
  const parts = [(stopped ? 'Stopped' : finished ? 'Done' : 'Paused') + ' · ' + time];
  const calls = Number(toolCalls || 0);
  if (calls) parts.push(calls + ' tool call' + (calls === 1 ? '' : 's'));
  const used = Number(tokens || 0);
  if (used) parts.push((used >= 1000 ? (used / 1000).toFixed(used >= 100000 ? 0 : 1) + 'k' : String(used)) + ' tokens');
  return parts.join(' · ');
}

// "1 addition and 1 removal", "2 additions", "3 removals": no "and 0 ...".
export function changeCounts(added, removed) {
  const parts = [];
  if (added || !removed) parts.push(added + ' addition' + (added === 1 ? '' : 's'));
  if (removed) parts.push(removed + ' removal' + (removed === 1 ? '' : 's'));
  return parts.join(' and ');
}

// Read-only exploration calls the CLI folds into one line when a model sends
// several at once ("Read 3 files, searched 1 pattern"), like Claude Code's
// "Read 3 files" and Codex's "Explored" group.
export const EXPLORE_TOOLS = new Set(['read_file', 'list_files', 'glob_files', 'grep', 'search_files', 'ast_grep']);

function exploreTarget(name, args = {}) {
  if (name === 'read_file') return String(args.path || args.file || '?');
  if (name === 'list_files') return String(args.path || '.');
  const pattern = String(args.pattern || args.query || '?');
  return '"' + (pattern.length > 40 ? pattern.slice(0, 37) + '...' : pattern) + '"' + (args.path && args.path !== '.' ? ' in ' + args.path : '');
}

const plural = (count, one, many) => count + ' ' + (count === 1 ? one : many);

export function describeExploration(items, { color = true } = {}) {
  const groups = [
    ['read_file', (n) => 'Read ' + plural(n, 'file', 'files')],
    ['search', (n) => 'searched ' + plural(n, 'pattern', 'patterns')],
    ['list_files', (n) => 'listed ' + plural(n, 'directory', 'directories')]
  ];
  const kind = (name) => name === 'read_file' || name === 'list_files' ? name : 'search';
  const parts = [];
  for (const [key, label] of groups) {
    const count = items.filter((item) => kind(item.name) === key).length;
    if (count) parts.push(label(count));
  }
  let title = parts.join(', ');
  title = title.charAt(0).toUpperCase() + title.slice(1);
  let targets = items.map((item) => exploreTarget(item.name, item.args)).join(', ');
  if (targets.length > 100) targets = targets.slice(0, 97) + '...';
  if (!color) return '[tool] ' + title + ': ' + targets;
  const dot = (themeFg('claude') || '\x1b[36m') + '⏺\x1b[39m ';
  return dot + ANSI.bold + title + ANSI.noBold + '\n  ⎿ ' + ANSI.dim + targets + ANSI.noBold;
}

// Node's errno text ("ENOENT: no such file or directory, stat '/abs/x.mjs'")
// shown as people say it. The model still gets the full error.
export function friendlyToolError(error) {
  const text = String(error || '');
  const errno = /^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EEXIST): [^,]+, \w+ '([^']+)'/.exec(text);
  if (!errno) {
    // Edit misses carry instructions for the model; people need the gist.
    const near = /^old_string was not found\b[\s\S]*?Closest match \((\d+)% similar\) starts at line (\d+)/.exec(text);
    if (near) return 'Text to replace not found (closest match: line ' + near[2] + ', ' + near[1] + '% similar)';
    if (/^old_string was not found\b/.test(text)) return 'Text to replace not found';
    if (text.length > 160) { const first = /^[\s\S]{20,160}?[.!?](?=\s)/.exec(text); if (first) return first[0]; }
    return text;
  }
  const where = path.relative(process.cwd(), errno[2]) || errno[2];
  const shown = where.startsWith('..') ? errno[2] : where;
  const meaning = { ENOENT: 'Not found', EACCES: 'Permission denied', EPERM: 'Not permitted', EISDIR: 'Is a directory, not a file', ENOTDIR: 'Not a directory', EEXIST: 'Already exists' }[errno[1]];
  return meaning + ': ' + shown;
}
