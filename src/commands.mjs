// Custom slash commands, compatible with Claude Code's .claude/commands format.
//
// A command is a Markdown file; its name is the file path without ".md", with
// sub-folders joined by ":" (".oasis/commands/git/pr.md" -> /git:pr).
//   ---
//   description: Open a pull request for the current branch
//   argument-hint: [title]
//   model: optional-model-id
//   ---
//   Create a PR titled "$ARGUMENTS". First check @CONTRIBUTING.md
//
// Placeholders: $ARGUMENTS (all text after the command), $1..$9 (positional).
// Inline shell: !`git status` is replaced by the command's output before the prompt
// is sent. It runs for user commands, and for project commands only in trusted
// workspaces. If `allowed-tools` lists Bash(...) rules, each command must match one;
// deny rules always apply.
// More front matter: allowed-tools (granted while the command runs), effort,
// context: fork (run in a subagent) with agent: TYPE.
// "@path" includes the content of a workspace file (also in normal prompts).
// Locations (later wins): ~/.claude/commands, ~/.config/oasis/commands,
// .claude/commands, .oasis/commands.
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { parseFrontMatter } from './subagents.mjs';
import { sensitivePath } from './tools.mjs';
import { imageMediaType, MAX_IMAGE_BYTES } from './images.mjs';

const MAX_COMMAND_FILE = 64 * 1024;
const MAX_MENTION_BYTES = 100 * 1024;
const MAX_MENTIONS = 20;
const MAX_DEPTH = 3;

export function commandDirectories(root, env = process.env, home = os.homedir()) {
  return [
    { dir: path.join(home, '.claude', 'commands'), scope: 'user' },
    { dir: path.join(getConfigDirectory(env, home), 'commands'), scope: 'user' },
    { dir: path.join(path.resolve(root), '.claude', 'commands'), scope: 'project' },
    { dir: path.join(path.resolve(root), '.oasis', 'commands'), scope: 'project' }
  ];
}

async function collect(dir, prefix, depth, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < MAX_DEPTH) await collect(full, prefix.concat(entry.name), depth + 1, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push({ file: full, parts: prefix.concat(entry.name.slice(0, -3)) });
  }
}

export async function loadCustomCommands(root, options = {}) {
  const commands = new Map();
  for (const { dir, scope } of commandDirectories(root, options.env || process.env, options.home || os.homedir())) {
    const found = [];
    await collect(dir, [], 0, found);
    for (const { file, parts } of found) {
      const name = parts.join(':').toLowerCase();
      if (!/^[a-z0-9][a-z0-9:_-]{0,100}$/.test(name)) continue;
      let info;
      try { info = await lstat(file); } catch { continue; }
      if (!info.isFile() || info.size > MAX_COMMAND_FILE) continue;
      let text;
      try { text = await readFile(file, 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue;
      const { data: meta, body } = parseFrontMatter(text);
      const firstLine = body.split('\n').find((line) => line.trim()) || '';
      commands.set(name, {
        name,
        description: String((Array.isArray(meta.description) ? meta.description.join(', ') : meta.description) || firstLine.replace(/^#+\s*/, '')).slice(0, 200),
        argumentHint: Array.isArray(meta['argument-hint']) ? '[' + meta['argument-hint'].join(', ') + ']' : String(meta['argument-hint'] || ''),
        model: meta.model && meta.model !== 'inherit' ? String(meta.model) : null,
        ...commandOptions(meta),
        body: body.trim(),
        file,
        scope
      });
    }
  }
  return commands;
}

// Front matter shared by commands and skills.
export function commandOptions(meta = {}) {
  const list = (value) => (Array.isArray(value) ? value : String(value || '').split(/,(?![^(]*\))/)).map((item) => String(item).trim()).filter(Boolean);
  const effort = String(meta.effort || '').toLowerCase();
  return {
    allowedTools: meta['allowed-tools'] ? list(meta['allowed-tools']).slice(0, 50) : null,
    effort: ['low', 'medium', 'high', 'max'].includes(effort) ? effort : null,
    context: String(meta.context || '').toLowerCase() === 'fork' ? 'fork' : null,
    agent: meta.agent ? String(meta.agent).slice(0, 64) : null
  };
}

const INLINE_SHELL = /!`([^`\n]{1,2000})`/g;
const MAX_INLINE_OUTPUT = 16 * 1024;

function inlineEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || process.env)) if (!/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION)/i.test(key)) out[key] = value;
  return out;
}

function runInline(command, root, env, timeoutMs) {
  const shell = process.platform === 'win32' ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { cmd: '/bin/sh', args: ['-c', command] };
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(shell.cmd, shell.args, { cwd: root, env: inlineEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); output += '\n(timed out)'; }, timeoutMs);
    const add = (chunk) => { if (output.length < MAX_INLINE_OUTPUT) output += chunk; };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (error) => { clearTimeout(timer); resolve({ output: error.message, code: null }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ output: output.slice(0, MAX_INLINE_OUTPUT), code }); });
  });
}

// Replaces each !`cmd` with its output. Returns { text, ran: [{ command, code, skipped }] }.
export async function expandInlineShell(text, options = {}) {
  const source = String(text || '');
  const matches = [...source.matchAll(INLINE_SHELL)];
  if (!matches.length) return { text: source, ran: [] };
  const { parseRule, ruleMatches } = await import('./permissions.mjs');
  const bashRules = (options.allowedTools || []).map(parseRule).filter((rule) => rule && rule.tools.includes('run_shell'));
  const ran = [];
  let out = '';
  let last = 0;
  for (const match of matches.slice(0, 10)) {
    const command = match[1].trim();
    out += source.slice(last, match.index);
    last = match.index + match[0].length;
    let skipped = '';
    if (!options.allowed) skipped = 'project commands run shell only in trusted workspaces (run oasis trust)';
    else if (options.allowedTools && !bashRules.some((rule) => ruleMatches(rule, 'run_shell', { command }))) skipped = 'not covered by the allowed-tools Bash rules';
    else if (options.policy) {
      const verdict = options.policy.evaluate('run_shell', { command });
      if (verdict.decision === 'deny') skipped = 'blocked by permission rule ' + verdict.rule;
    }
    if (skipped) {
      ran.push({ command, skipped });
      out += '[skipped !`' + command + '`: ' + skipped + ']';
      continue;
    }
    const result = await runInline(command, options.root, options.env, (options.timeoutSeconds || 30) * 1000);
    ran.push({ command, code: result.code });
    out += result.output.trim() + (result.code ? '\n(exit ' + result.code + ')' : '');
  }
  out += source.slice(last);
  return { text: out, ran };
}

export function renderCommandBody(body, argumentText = '') {
  const args = String(argumentText || '');
  const positional = args.trim() ? args.trim().split(/\s+/) : [];
  let used = false;
  const rendered = String(body).replace(/\$ARGUMENTS|\$\{(\d)\}|\$(\d)\b/g, (match, braced, plain) => {
    used = true;
    if (match === '$ARGUMENTS') return args;
    const index = Number(braced || plain);
    return index > 0 ? (positional[index - 1] || '') : match;
  });
  return { text: rendered, usedArguments: used };
}

// Resolve "/name args" against custom commands. Returns null when no command matches.
export async function resolveCustomCommand(root, rawInput, options = {}) {
  const match = String(rawInput || '').trim().match(/^\/([a-z0-9][a-z0-9:_-]{0,100})(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const commands = options.commands || await loadCustomCommands(root, options);
  const command = commands.get(match[1].toLowerCase());
  if (!command) return null;
  const argumentText = String(match[2] || '').slice(0, 8000);
  const { text, usedArguments } = renderCommandBody(command.body, argumentText);
  let prompt = text;
  if (argumentText && !usedArguments) prompt += '\n\nArguments: ' + argumentText;
  const shell = await expandInlineShell(prompt, { root, env: options.env, allowed: command.scope === 'user' || Boolean(options.trusted), allowedTools: command.allowedTools, policy: options.policy });
  const expanded = await expandFileMentions(root, shell.text);
  return { name: command.name, command, prompt: expanded.text, mentions: expanded.files, shell: shell.ran, grantTools: command.scope === 'user' || options.trusted ? command.allowedTools : null };
}

// Replace or annotate "@path" mentions with file contents from the workspace.
// Only existing, non-sensitive regular files inside the workspace are included.
// Image mentions (@shot.png) are returned in `images` for multimodal models.
export async function expandFileMentions(root, text, options = {}) {
  const source = String(text || '');
  const workspace = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  const seen = new Set();
  const files = [];
  const attachments = [];
  const images = [];
  const pattern = /(^|[\s(["'`])@((?:\.{0,2}\/)?[\w.\-/]+[\w\-/])/g;
  let match;
  while ((match = pattern.exec(source)) && files.length < MAX_MENTIONS) {
    const raw = match[2];
    if (seen.has(raw) || raw.includes('@')) continue;
    seen.add(raw);
    const absolute = path.resolve(workspace, raw);
    let real;
    try { real = await realpath(absolute); } catch { continue; }
    const relative = path.relative(workspace, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (sensitivePath(relative.split(path.sep).join('/'))) continue;
    let info;
    try { info = await lstat(real); } catch { continue; }
    if (info.isDirectory()) {
      let names = [];
      try { names = (await readdir(real)).filter((name) => !name.startsWith('.')).sort().slice(0, 200); } catch {}
      attachments.push('<directory path="' + relative + '">\n' + names.join('\n') + '\n</directory>');
      files.push(relative);
      continue;
    }
    if (!info.isFile()) continue;
    const mediaType = imageMediaType(relative);
    if (mediaType) {
      if (options.images === false || info.size > MAX_IMAGE_BYTES || images.length >= 4) continue;
      const data = await readFile(real).catch(() => null);
      if (!data) continue;
      images.push({ mediaType, data: data.toString('base64'), path: relative });
      attachments.push('<image path="' + relative + '">attached</image>');
      files.push(relative);
      continue;
    }
    let content = await readFile(real, 'utf8').catch(() => null);
    if (content === null || content.includes('\0')) continue;
    let note = '';
    if (Buffer.byteLength(content) > MAX_MENTION_BYTES) {
      content = content.slice(0, MAX_MENTION_BYTES);
      note = ' truncated="true"';
    }
    attachments.push('<file path="' + relative + '"' + note + '>\n' + content + '\n</file>');
    files.push(relative);
  }
  if (!attachments.length) return { text: source, files, images };
  return { text: source + '\n\nReferenced files:\n' + attachments.join('\n'), files, images };
}
