// oasis mcp share: register `oasis mcp serve` in other coding agents' MCP
// settings, so Claude Code, Cursor, VS Code / Copilot, Gemini CLI, Codex,
// OpenCode, Zed and Copilot CLI all get OASIS's tools, skills and every slash
// command it reads (see src/mcp-serve.mjs) from one place.
//
// Each agent's file is edited in place: JSON and JSONC through Microsoft's
// jsonc-parser (comments and formatting kept), Codex TOML by appending its own
// [mcp_servers.oasis] table. An existing "oasis" entry is left as it is unless
// --force; --remove takes it out again.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

export const SHARE_TARGETS = Object.freeze(['claude', 'cursor', 'vscode', 'gemini', 'codex', 'opencode', 'zed', 'copilot']);
const LABELS = { claude: 'Claude Code', cursor: 'Cursor', vscode: 'VS Code / Copilot', gemini: 'Gemini CLI', codex: 'Codex', opencode: 'OpenCode', zed: 'Zed', copilot: 'Copilot CLI' };
const NAME = 'oasis';

/** How other agents should start OASIS: `oasis` on PATH, else node + this checkout's entry point. */
export function oasisLaunch(env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['oasis.cmd', 'oasis.exe', 'oasis'] : ['oasis'];
  if (dirs.some((dir) => names.some((name) => existsSync(path.join(dir, name))))) return { command: 'oasis', args: ['mcp', 'serve'] };
  return { command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'oasis.mjs'), 'mcp', 'serve'] };
}

/** Where each agent keeps MCP servers, per scope. null: that scope has no file OASIS edits. */
export function shareFile(target, { root, home = os.homedir(), env = process.env, user = false }) {
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const project = {
    claude: path.join(root, '.mcp.json'),
    cursor: path.join(root, '.cursor', 'mcp.json'),
    vscode: path.join(root, '.vscode', 'mcp.json'),
    gemini: path.join(root, '.gemini', 'settings.json'),
    codex: path.join(root, '.codex', 'config.toml'),
    opencode: path.join(root, 'opencode.json'),
    zed: path.join(root, '.zed', 'settings.json'),
    copilot: null
  };
  const personal = {
    claude: null, // ~/.claude.json holds much more; use `claude mcp add --scope user`
    cursor: path.join(home, '.cursor', 'mcp.json'),
    vscode: null,
    gemini: path.join(home, '.gemini', 'settings.json'),
    codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    opencode: path.join(xdg, 'opencode', 'opencode.json'),
    zed: path.join(xdg, 'zed', 'settings.json'),
    copilot: path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'mcp-config.json')
  };
  return (user ? personal : project)[target];
}

// The JSON path and value for each JSON-based agent.
function jsonEntry(target, launch) {
  const { command, args } = launch;
  switch (target) {
    case 'vscode': return { key: ['servers', NAME], value: { type: 'stdio', command, args } };
    case 'opencode': return { key: ['mcp', NAME], value: { type: 'local', command: [command, ...args], enabled: true } };
    case 'zed': return { key: ['context_servers', NAME], value: { command, args } };
    case 'copilot': return { key: ['mcpServers', NAME], value: { type: 'local', command, args, tools: ['*'] } };
    default: return { key: ['mcpServers', NAME], value: { command, args } };
  }
}

const tomlString = (value) => JSON.stringify(String(value));
function codexBlock(launch) {
  return '[mcp_servers.' + NAME + ']\ncommand = ' + tomlString(launch.command) + '\nargs = [' + launch.args.map(tomlString).join(', ') + ']\n';
}
// The [mcp_servers.oasis] table (and its sub-tables) as one span of lines.
function codexSpan(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^\s*\[\s*mcp_servers\s*\.\s*"?oasis"?\s*\]\s*(#.*)?$/.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(/^\s*\[/.test(lines[end]) && !/^\s*\[\s*mcp_servers\s*\.\s*"?oasis"?\s*\./.test(lines[end]))) end += 1;
  return { lines, start, end };
}

async function shareOne(target, file, launch, { remove, force, dryRun }) {
  const text = existsSync(file) ? await readFile(file, 'utf8') : '';
  let next;
  let state;
  if (target === 'codex') {
    const span = codexSpan(text);
    if (remove) {
      if (!span) return { state: 'absent' };
      span.lines.splice(span.start, span.end - span.start);
      next = span.lines.join('\n').replace(/\n{3,}/g, '\n\n');
      state = 'removed';
    } else if (span && !force) return { state: 'present' };
    else {
      const base = span ? (span.lines.splice(span.start, span.end - span.start), span.lines.join('\n')) : text;
      next = (base.trim() ? base.replace(/\s*$/, '\n\n') : '') + codexBlock(launch);
      state = span ? 'updated' : 'added';
    }
  } else {
    const errors = [];
    const doc = text.trim() ? parseJsonc(text, errors, { allowTrailingComma: true }) : {};
    if (errors.length || !doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(file + ' is not a JSON object; fix it or add the server by hand.');
    const { key, value } = jsonEntry(target, launch);
    const present = doc[key[0]] && typeof doc[key[0]] === 'object' && Object.hasOwn(doc[key[0]], NAME);
    if (remove && !present) return { state: 'absent' };
    if (!remove && present && !force) return { state: 'present' };
    const source = text.trim() ? text : '{}\n';
    const edits = modify(source, key, remove ? undefined : value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
    next = applyEdits(source, edits);
    if (!next.endsWith('\n')) next += '\n';
    state = remove ? 'removed' : present ? 'updated' : 'added';
  }
  if (!dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, next);
  }
  return { state };
}

/**
 * Add (or remove) the OASIS MCP server in other agents' settings.
 * Returns [{ target, label, file, state }] with state added | updated | present | removed | absent | skipped | failed.
 */
export async function shareMcp({ root, targets = SHARE_TARGETS, user = false, remove = false, force = false, dryRun = false, env = process.env, home = os.homedir(), launch = oasisLaunch(env) } = {}) {
  const wanted = [...new Set(targets.map((t) => String(t).toLowerCase()))];
  for (const t of wanted) if (!SHARE_TARGETS.includes(t)) throw new Error('Unknown agent "' + t + '". Use ' + SHARE_TARGETS.join(', ') + ' or all.');
  const results = [];
  for (const target of wanted) {
    const file = shareFile(target, { root: path.resolve(root), home, env, user });
    if (!file) {
      results.push({ target, label: LABELS[target], file: '', state: 'skipped', note: user ? (target === 'claude' ? 'run: claude mcp add --scope user oasis -- ' + [launch.command, ...launch.args].join(' ') : 'no user-level file; run without --user') : 'only a user-level file; add --user' });
      continue;
    }
    try { results.push({ target, label: LABELS[target], file, ...(await shareOne(target, file, launch, { remove, force, dryRun })) }); }
    catch (error) { results.push({ target, label: LABELS[target], file, state: 'failed', note: error.message }); }
  }
  return results;
}

export function formatShareReport(results, { root, dryRun = false } = {}) {
  const words = { added: 'added', updated: 'updated', present: 'already there', removed: 'removed', absent: 'not there', skipped: 'skipped', failed: 'failed' };
  const show = (file) => (root && file.startsWith(path.resolve(root) + path.sep) ? path.relative(root, file) : file.replace(os.homedir(), '~'));
  const lines = results.map((r) => '  ' + r.label.padEnd(18) + words[r.state].padEnd(14) + (r.file ? show(r.file) : '') + (r.note ? '  (' + r.note + ')' : ''));
  const changed = results.some((r) => ['added', 'updated', 'removed'].includes(r.state));
  return (dryRun ? 'Dry run, nothing written:\n' : '') + lines.join('\n') + '\n'
    + (changed && !dryRun && results.some((r) => r.state === 'added' || r.state === 'updated') ? 'Those agents now start `oasis mcp serve` in the project: OASIS\'s tools, skills and every slash command it reads, as MCP prompts. Restart them to load it.\n' : '');
}

export async function shareCli(root, params, write) {
  const take = (flag) => { const i = params.indexOf(flag); if (i < 0) return null; const value = params[i + 1]; params.splice(i, 2); return value; };
  const to = take('--to');
  const flags = new Set(params.filter((p) => p.startsWith('--')));
  for (const flag of flags) if (!['--user', '--remove', '--force', '--dry-run'].includes(flag)) throw new Error('Unknown option ' + flag + '. Usage: oasis mcp share [--to ' + SHARE_TARGETS.join(',') + '] [--user] [--remove] [--force] [--dry-run]');
  const targets = !to || to === 'all' ? SHARE_TARGETS.filter((t) => flags.has('--user') ? shareFile(t, { root, user: true }) !== null : shareFile(t, { root, user: false }) !== null) : to.split(',').map((t) => t.trim()).filter(Boolean);
  const results = await shareMcp({ root, targets, user: flags.has('--user'), remove: flags.has('--remove'), force: flags.has('--force'), dryRun: flags.has('--dry-run') });
  write(formatShareReport(results, { root, dryRun: flags.has('--dry-run') }));
  if (results.some((r) => r.state === 'failed')) process.exitCode = 1;
}
