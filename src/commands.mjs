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
// Other agents' command and workflow folders are read too, below all of those
// (OASIS_OTHER_AGENT_RULES=0 skips them): Cursor .cursor/commands and
// ~/.cursor/commands, Devin Desktop / Windsurf .devin/workflows and
// .windsurf/workflows (workspace and parents up to the git root) and
// ~/.codeium/windsurf/global_workflows, Antigravity .agents/workflows,
// .agent/workflows and ~/.gemini/config/workflows, Cline .clinerules/workflows,
// Roo Code .roo/commands and ~/.roo/commands (their `mode:` is not applied).
// Their files are plain prompts: inline shell and allowed-tools are not honoured.
// OpenCode .opencode/commands (and command/), ~/.config/opencode/commands and opencode.json
// "commands" keep OpenCode's $ARGUMENTS/$N and !`cmd` rules (see renderOpencodeTemplate).
// Gemini CLI .gemini/commands/**/*.toml and ~/.gemini/commands are read with Gemini's
// own {{args}}, !{...} and @{...} syntax (see renderGeminiPrompt).
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { parseFrontMatter } from './frontmatter.mjs';
import { sensitivePath } from './tools.mjs';
import { agentIgnoreMatch } from './agent-ignore.mjs';
import { imageMediaType, MAX_SOURCE_IMAGE_BYTES } from './images.mjs';

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

// Folders above the workspace up to the git root (nearest last), as Devin Desktop
// searches for workflows. Without a git root, only the workspace itself.
async function gitRootChain(workspace) {
  const chain = [workspace];
  for (let dir = workspace, i = 0; i < 20; i++) {
    try { await lstat(path.join(dir, '.git')); return chain; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    chain.unshift(dir);
  }
  return [workspace];
}

/** Command and workflow folders of other coding agents, lowest precedence first. */
export async function foreignCommandDirectories(root, env = process.env, home = os.homedir()) {
  if (env.OASIS_OTHER_AGENT_RULES === '0') return [];
  const workspace = path.resolve(root);
  const dirs = [
    { dir: path.join(home, '.gemini', 'commands'), scope: 'user', foreign: 'Gemini CLI', gemini: true },
    { dir: path.join(home, '.gemini', 'config', 'workflows'), scope: 'user', foreign: 'Antigravity' },
    { dir: path.join(home, '.codeium', 'windsurf', 'global_workflows'), scope: 'user', foreign: 'Windsurf' },
    { dir: path.join(home, '.cursor', 'commands'), scope: 'user', foreign: 'Cursor' },
    { dir: path.join(home, '.roo', 'commands'), scope: 'user', foreign: 'Roo Code' },
    { dir: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'command'), scope: 'user', foreign: 'OpenCode', opencode: true },
    { dir: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'commands'), scope: 'user', foreign: 'OpenCode', opencode: true },
    { dir: path.join(workspace, '.clinerules', 'workflows'), scope: 'project', foreign: 'Cline' },
    { dir: path.join(workspace, '.agent', 'workflows'), scope: 'project', foreign: 'Antigravity' },
    { dir: path.join(workspace, '.agents', 'workflows'), scope: 'project', foreign: 'Antigravity' },
    { dir: path.join(workspace, '.cursor', 'commands'), scope: 'project', foreign: 'Cursor' },
    { dir: path.join(workspace, '.roo', 'commands'), scope: 'project', foreign: 'Roo Code' },
    { dir: path.join(workspace, '.gemini', 'commands'), scope: 'project', foreign: 'Gemini CLI', gemini: true },
    { dir: path.join(workspace, '.opencode', 'command'), scope: 'project', foreign: 'OpenCode', opencode: true },
    { dir: path.join(workspace, '.opencode', 'commands'), scope: 'project', foreign: 'OpenCode', opencode: true }
  ];
  // Devin Desktop prefers .devin/workflows over the legacy .windsurf/workflows; nearer folders win.
  for (const dir of await gitRootChain(workspace)) {
    dirs.push({ dir: path.join(dir, '.windsurf', 'workflows'), scope: 'project', foreign: 'Windsurf', outside: dir !== workspace });
    dirs.push({ dir: path.join(dir, '.devin', 'workflows'), scope: 'project', foreign: 'Devin Desktop', outside: dir !== workspace });
  }
  return dirs;
}

async function collect(dir, prefix, depth, out, ext = '.md') {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < MAX_DEPTH) await collect(full, prefix.concat(entry.name), depth + 1, out, ext);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) out.push({ file: full, parts: prefix.concat(entry.name.slice(0, -ext.length)) });
  }
}

export async function loadCustomCommands(root, options = {}) {
  const commands = new Map();
  // --safe-mode starts without custom commands.
  if ((options.env || process.env).OASIS_SAFE_MODE === '1') return commands;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const workspaceReal = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  let parseToml = null;
  const opencodeJsonRead = new Set();
  for (const { dir, scope, foreign, outside, gemini, opencode } of [...await foreignCommandDirectories(root, env, home), ...commandDirectories(root, env, home)]) {
    // OpenCode commands defined under "commands" (or legacy "command") in opencode.json(c);
    // Markdown commands of the same scope override them.
    if (opencode && !opencodeJsonRead.has(scope)) {
      opencodeJsonRead.add(scope);
      for (const [file, configScope] of opencodeConfigFiles(root, env, home)) {
        if (configScope !== scope) continue;
        for (const item of await opencodeJsonCommands(file)) commands.set(item.name, { ...item, file, scope, foreign: 'OpenCode', opencode: true });
      }
    }
    const found = [];
    // Other agents' folders are flat, except Gemini CLI's and OpenCode's, whose sub-folders are
    // namespaces as in OASIS's own (git/commit.toml -> /git:commit; OpenCode's /team/review is /team:review).
    await collect(dir, [], foreign && !gemini && !opencode ? MAX_DEPTH : 0, found, gemini ? '.toml' : '.md');
    for (const { file, parts } of found) {
      const name = parts.join(':').toLowerCase();
      if (!/^[a-z0-9][a-z0-9:_-]{0,100}$/.test(name)) continue;
      let info;
      try { info = await lstat(file); } catch { continue; }
      if (!info.isFile() || info.size > MAX_COMMAND_FILE) continue;
      // A project folder's command file must stay inside the workspace (or, for
      // workflows found above it, inside that folder) after symlinks are resolved.
      if (foreign && scope === 'project') {
        const real = await realpath(file).catch(() => null);
        const base = outside ? await realpath(path.dirname(path.dirname(dir))).catch(() => null) : workspaceReal;
        const relative = real && base ? path.relative(base, real) : '..';
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      }
      let text;
      try { text = await readFile(file, 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue;
      if (gemini) {
        // Gemini CLI TOML (v1): prompt (required) and description.
        parseToml ||= (await import('./importers.mjs')).parseToml;
        let data;
        try { data = parseToml(text); } catch { continue; }
        if (typeof data.prompt !== 'string' || !data.prompt.trim()) continue;
        const firstPromptLine = data.prompt.split('\n').find((line) => line.trim()) || '';
        commands.set(name, {
          name,
          description: (String(typeof data.description === 'string' && data.description.trim() ? data.description : firstPromptLine.replace(/^#+\s*/, '')).slice(0, 180) + ' (' + foreign + ')').trim(),
          argumentHint: '',
          model: null, allowedTools: null, effort: null, context: null, agent: null,
          body: data.prompt,
          file,
          scope,
          foreign,
          gemini: true
        });
        continue;
      }
      const { data: meta, body } = parseFrontMatter(text);
      const firstLine = body.split('\n').find((line) => line.trim()) || '';
      if (opencode) {
        commands.set(name, { ...opencodeCommand(name, meta, body), file, scope, foreign, opencode: true });
        continue;
      }
      if (foreign) {
        commands.set(name, {
          name,
          description: (String((Array.isArray(meta.description) ? meta.description.join(', ') : meta.description) || firstLine.replace(/^#+\s*/, '')).slice(0, 180) + ' (' + foreign + ')').trim(),
          argumentHint: '',
          model: null, allowedTools: null, effort: null, context: null, agent: null,
          body: body.trim(),
          file,
          scope,
          foreign
        });
        continue;
      }
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
  // Commands from enabled Claude Code plugins: /plugin-name:command (project commands win on clashes).
  try {
    const { loadEnabledPlugins, pluginCommands } = await import('./claude-plugins.mjs');
    const env = options.env || process.env;
    for (const item of await pluginCommands(await loadEnabledPlugins(root, { env }), { env, root })) {
      if (commands.has(item.name) || !/^[a-z0-9][a-z0-9:_.-]{0,100}$/.test(item.name) || item.body.includes('\0')) continue;
      const { data: meta, body } = parseFrontMatter(item.body);
      const firstLine = body.split('\n').find((line) => line.trim()) || '';
      commands.set(item.name, {
        name: item.name,
        description: String((Array.isArray(meta.description) ? meta.description.join(', ') : meta.description) || firstLine.replace(/^#+\s*/, '')).slice(0, 200) + ' (plugin ' + item.plugin + ')',
        argumentHint: Array.isArray(meta['argument-hint']) ? '[' + meta['argument-hint'].join(', ') + ']' : String(meta['argument-hint'] || ''),
        model: meta.model && meta.model !== 'inherit' ? String(meta.model) : null,
        ...commandOptions(meta),
        body: body.trim(),
        file: item.file,
        scope: 'user',
        plugin: item.plugin
      });
    }
  } catch { /* Plugins are optional. */ }
  // Saved dynamic workflows run as /name (Claude Code saves workflows as commands).
  try {
    const { loadWorkflows } = await import('./workflows.mjs');
    for (const item of (await loadWorkflows(root, { env: options.env || process.env })).values()) {
      if (commands.has(item.name)) continue;
      commands.set(item.name, {
        name: item.name,
        description: (item.description || 'Saved workflow') + ' (workflow)',
        argumentHint: '[args]',
        model: null, allowedTools: null, effort: null, context: null, agent: null,
        body: 'Run the saved workflow "' + item.name + '" now with the workflow tool (action "run", name "' + item.name + '") and pass args: $ARGUMENTS\nWhen it finishes, report the result.',
        file: item.file,
        scope: item.scope === 'project' ? 'project' : 'user',
        workflow: true
      });
    }
  } catch { /* Workflows are optional. */ }
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
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(shell.cmd, shell.args, {
        cwd: root,
        env: inlineEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...processTreeSpawnOptions()
      });
    } catch (error) {
      finish({ output: error.message, code: null });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const add = (chunk) => {
      if (output.length < MAX_INLINE_OUTPUT) {
        output += chunk.toString('utf8').slice(0, MAX_INLINE_OUTPUT - output.length);
      }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (error) => finish({ output: error.message, code: null }));
    child.on('close', (code) => finish({
      output: output.slice(0, MAX_INLINE_OUTPUT) + (timedOut ? '\n(timed out)' : ''),
      code: timedOut ? null : code
    }));
  });
}

// Why a command-file shell snippet may not run: untrusted project, or a deny/ask permission rule.
function shellSkipReason(command, options) {
  if (options.disabledByPolicy) return 'disabled by policy';
  if (!options.allowed) return 'project commands run shell only in trusted workspaces (run oasis trust)';
  if (options.policy) {
    const verdict = options.policy.evaluate('run_shell', { command });
    if (verdict.decision === 'deny') return 'blocked by permission rule ' + verdict.rule;
    if (verdict.decision === 'ask') return 'requires explicit approval under permission rule ' + verdict.rule;
  }
  return '';
}

// Replaces each !`cmd` with its output. Returns { text, ran: [{ command, code, skipped }] }.
export async function expandInlineShell(text, options = {}) {
  const source = String(text || '');
  const matches = [...source.matchAll(INLINE_SHELL)];
  if (!matches.length) return { text: source, ran: [] };
  const { parseRule, ruleMatches } = await import('./permissions.mjs');
  const { readOnlyShellLine, readOnlyCommandsEnabled } = await import('./read-only-commands.mjs');
  const bashRules = (options.allowedTools || []).map(parseRule).filter((rule) => rule && rule.tools.includes('run_shell'));
  const ran = [];
  let out = '';
  let last = 0;
  for (const match of matches.slice(0, 10)) {
    const command = match[1].trim();
    out += source.slice(last, match.index);
    last = match.index + match[0].length;
    let skipped = shellSkipReason(command, options);
    // Read-only inspection (git status/diff/log, ls, cat inside the workspace)
    // runs without a matching rule, as in Claude Code; permission rules still apply.
    if (!skipped && options.allowedTools && !bashRules.some((rule) => ruleMatches(rule, 'run_shell', { command }))
      && !(readOnlyCommandsEnabled(options.env || process.env) && readOnlyShellLine(command, { root: options.root }))) skipped = 'not covered by the allowed-tools Bash rules';
    if (skipped) {
      ran.push({ command, skipped });
      // Claude Code's disableSkillShellExecution placeholder.
      out += options.disabledByPolicy ? '[shell command execution disabled by policy]' : '[skipped !`' + command + '`: ' + skipped + ']';
      continue;
    }
    const result = await runInline(command, options.root, options.env, (options.timeoutSeconds || 30) * 1000);
    ran.push({ command, code: result.code });
    out += result.output.trim() + (result.code ? '\n(exit ' + result.code + ')' : '');
  }
  out += source.slice(last);
  return { text: out, ran };
}

// OpenCode commands (opencode.ai/docs/commands, MIT; reimplemented from the docs):
// .opencode/commands/**/*.md (and legacy command/), ~/.config/opencode/commands, or
// "commands": { name: { template, description, agent, model, subagent } } in opencode.json(c).
// `subagent: true` (or the older `subtask`) runs the command in a forked subagent; `agent`
// and `model` name OpenCode agents and provider/model ids, so they are not applied.
function opencodeConfigFiles(root, env, home) {
  const global = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  return [[path.join(global, 'opencode.json'), 'user'], [path.join(global, 'opencode.jsonc'), 'user'], [path.join(path.resolve(root), 'opencode.json'), 'project'], [path.join(path.resolve(root), 'opencode.jsonc'), 'project']];
}

function opencodeCommand(name, meta, body) {
  const sub = meta.subagent !== undefined ? meta.subagent : meta.subtask;
  const firstLine = String(body).split('\n').find((line) => line.trim()) || '';
  return {
    name,
    description: (String(meta.description || firstLine.replace(/^#+\s*/, '')).slice(0, 180) + ' (OpenCode)').trim(),
    argumentHint: '',
    model: null, allowedTools: null, effort: null, agent: null,
    context: sub === true || String(sub).toLowerCase() === 'true' ? 'fork' : null,
    body: String(body).trim()
  };
}

async function opencodeJsonCommands(file) {
  let data;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 512 * 1024) return [];
    data = (await import('./importers.mjs')).parseJsonc(await readFile(file, 'utf8'));
  } catch { return []; }
  const table = data && typeof data === 'object' ? (data.commands && typeof data.commands === 'object' ? data.commands : data.command) : null;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return [];
  const out = [];
  for (const [rawName, entry] of Object.entries(table).slice(0, 200)) {
    const name = String(rawName).toLowerCase().replace(/\//g, ':');
    if (!/^[a-z0-9][a-z0-9:_-]{0,100}$/.test(name) || !entry || typeof entry !== 'object' || typeof entry.template !== 'string' || !entry.template.trim() || entry.template.includes('\0')) continue;
    out.push(opencodeCommand(name, entry, entry.template));
  }
  return out;
}

// Splits arguments like a shell would for grouping: single or double quotes group words and are removed.
function opencodeArguments(text) {
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(text))) out.push({ value: match[1] ?? match[2] ?? match[3], start: match.index });
  return out;
}

/** OpenCode template: $ARGUMENTS, $1..$N (the highest takes the rest), else arguments appended. */
export function renderOpencodeTemplate(template, argumentText = '') {
  const args = String(argumentText || '');
  const body = String(template || '');
  const numbers = [...body.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])).filter((n) => n > 0);
  const highest = numbers.length ? Math.max(...numbers) : 0;
  const positional = opencodeArguments(args);
  let used = false;
  const rendered = body.replace(/\$ARGUMENTS|\$(\d+)/g, (match, digits) => {
    used = true;
    if (match === '$ARGUMENTS') return args;
    const index = Number(digits);
    if (!index) return match;
    if (index === highest && positional.length > index) {
      const rest = positional.slice(index - 1);
      return rest.map((item) => item.value).join(' ');
    }
    return positional[index - 1] ? positional[index - 1].value : '';
  });
  return used || !args.trim() ? rendered : rendered + '\n\n' + args;
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
  if (command.gemini) {
    const rendered = await renderGeminiPrompt(root, command.body, argumentText, { rawInput: String(rawInput).trim(), env: options.env, allowed: command.scope === 'user' || Boolean(options.trusted), policy: options.policy, disabledByPolicy: options.disableShell === true });
    return { name: command.name, args: argumentText, command, prompt: rendered.text, mentions: rendered.files, shell: rendered.ran, grantTools: null };
  }
  if (command.opencode) {
    // OpenCode runs !`cmd` blocks (after placeholders) and leaves @path as plain text.
    const shell = await expandInlineShell(renderOpencodeTemplate(command.body, argumentText), { root, env: options.env, allowed: command.scope === 'user' || Boolean(options.trusted), policy: options.policy, disabledByPolicy: options.disableShell === true });
    return { name: command.name, args: argumentText, command, prompt: shell.text, mentions: [], shell: shell.ran, grantTools: null };
  }
  const { text, usedArguments } = command.foreign ? { text: command.body, usedArguments: false } : renderCommandBody(command.body, argumentText);
  let prompt = command.foreign ? foreignWorkflowPrompt(command, commands) : text;
  if (argumentText && !usedArguments) prompt += '\n\nArguments: ' + argumentText;
  // Other agents' command files have no inline-shell syntax; never run !`...` from them.
  const shell = command.foreign ? { text: prompt, ran: [] } : await expandInlineShell(prompt, { root, env: options.env, allowed: command.scope === 'user' || Boolean(options.trusted), allowedTools: command.allowedTools, policy: options.policy, disabledByPolicy: options.disableShell === true });
  const expanded = await expandFileMentions(root, shell.text);
  return { name: command.name, args: argumentText, command, prompt: expanded.text, mentions: expanded.files, shell: shell.ran, grantTools: command.scope === 'user' || options.trusted ? command.allowedTools : null };
}

// Gemini CLI custom-command prompts (docs/cli/custom-commands.md in google-gemini/gemini-cli,
// Apache-2.0; reimplemented from the documented behaviour):
//   @{path}   the file's content, or every file under a directory (workspace only;
//             sensitive and agent-ignored paths are left out)
//   !{cmd}    the command's output (stdout and stderr); a failure adds
//             "[Shell command exited with code N]". {{args}} inside it is shell-escaped.
//   {{args}}  the text typed after the command, unchanged.
// Without {{args}}, typed arguments are appended after a blank line as the whole command
// line. Braces inside @{...} and !{...} must balance. The prompt is parsed once, so file
// content and command output are never expanded again. Gemini CLI asks before running
// !{...}; OASIS runs it for user commands and, for project commands, only in trusted
// workspaces, and skips it when a permission rule says deny or ask.
const MAX_GEMINI_SNIPPETS = 10;
const MAX_GEMINI_DIR_FILES = 50;

export function geminiPromptSegments(prompt) {
  const source = String(prompt || '');
  const parts = [];
  let text = '';
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if ((ch === '@' || ch === '!') && source[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < source.length && depth; j++) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}') depth--;
      }
      if (depth === 0) {
        if (text) parts.push({ type: 'text', value: text });
        text = '';
        parts.push({ type: ch === '@' ? 'file' : 'shell', value: source.slice(i + 2, j - 1) });
        i = j;
        continue;
      }
    }
    text += ch;
    i++;
  }
  if (text) parts.push({ type: 'text', value: text });
  return parts;
}

export function shellEscapeArgument(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') return '"' + text.replace(/"/g, '""') + '"';
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

const ARGS_PLACEHOLDER = /\{\{\s*args\s*\}\}/g;

async function geminiFileInjection(workspace, rawPath, env, files) {
  const wanted = rawPath.trim();
  if (!wanted) return '';
  const absolute = path.resolve(workspace, wanted);
  let real;
  try { real = await realpath(absolute); } catch { return '[@{' + wanted + '}: not found]'; }
  const relative = path.relative(workspace, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '[@{' + wanted + '}: outside the workspace]';
  const readOne = async (file, rel) => {
    if (sensitivePath(rel.split(path.sep).join('/')) || await agentIgnoreMatch(file, { env })) return null;
    let info;
    try { info = await lstat(file); } catch { return null; }
    if (!info.isFile()) return null;
    const data = await readFile(file).catch(() => null);
    if (!data || data.includes(0)) return null;
    files.push(rel || path.basename(file));
    const text = data.subarray(0, MAX_MENTION_BYTES).toString('utf8');
    return data.length > MAX_MENTION_BYTES ? text + '\n[truncated]' : text;
  };
  let info;
  try { info = await lstat(real); } catch { return '[@{' + wanted + '}: not found]'; }
  if (!info.isDirectory()) {
    const content = await readOne(real, relative);
    return content === null ? '[@{' + wanted + '}: skipped (binary, sensitive or ignored)]' : content;
  }
  if (await agentIgnoreMatch(real, { env, isDir: true })) return '[@{' + wanted + '}: ignored]';
  const out = [];
  const walk = async (dir) => {
    let entries = [];
    try { entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_GEMINI_DIR_FILES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!await agentIgnoreMatch(full, { env, isDir: true })) await walk(full); continue; }
      const rel = path.relative(workspace, full);
      const content = await readOne(full, rel);
      if (content !== null) out.push('--- ' + rel.split(path.sep).join('/') + ' ---\n' + content);
    }
  };
  await walk(real);
  return out.join('\n\n');
}

export async function renderGeminiPrompt(root, prompt, argumentText = '', options = {}) {
  const workspace = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  const args = String(argumentText || '');
  const segments = geminiPromptSegments(prompt);
  const usesArgs = segments.some((part) => part.type !== 'file' && /\{\{\s*args\s*\}\}/.test(part.value));
  const files = [];
  const ran = [];
  let out = '';
  let snippets = 0;
  for (const part of segments) {
    if (part.type === 'text') { out += part.value.replace(ARGS_PLACEHOLDER, () => args); continue; }
    if (++snippets > MAX_GEMINI_SNIPPETS) { out += '[skipped: more than ' + MAX_GEMINI_SNIPPETS + ' @{...} and !{...} blocks]'; continue; }
    if (part.type === 'file') { out += await geminiFileInjection(workspace, part.value, options.env, files); continue; }
    const command = part.value.replace(ARGS_PLACEHOLDER, () => shellEscapeArgument(args)).trim();
    const skipped = command ? shellSkipReason(command, options) : 'empty command';
    if (skipped) { ran.push({ command, skipped }); out += options.disabledByPolicy ? '[shell command execution disabled by policy]' : '[skipped !{' + command + '}: ' + skipped + ']'; continue; }
    const result = await runInline(command, workspace, options.env, (options.timeoutSeconds || 30) * 1000);
    ran.push({ command, code: result.code });
    out += result.output.replace(/\n+$/, '') + (result.code ? '\n[Shell command exited with code ' + result.code + ']' : result.code === null ? '\n[Shell command did not finish]' : '');
  }
  if (!usesArgs && args.trim()) out = out.replace(/\s+$/, '') + '\n\n' + (options.rawInput || args);
  return { text: out, files, ran };
}

// Windsurf, Devin Desktop and Antigravity workflows can say "Call /other-workflow".
// OASIS has no tool for the model to run a slash command, so the workflows a
// workflow calls are appended once each (two levels deep) for the model to follow.
const MAX_CALLED_WORKFLOWS = 6;
function foreignWorkflowPrompt(command, commands) {
  const included = new Set([command.name]);
  const appended = [];
  const visit = (body, depth) => {
    if (depth > 2) return;
    for (const match of String(body).matchAll(/(?:^|[\s`'"(])\/([a-z0-9][a-z0-9:_-]{0,100})\b/gi)) {
      const called = commands.get(match[1].toLowerCase());
      if (!called || !called.foreign || included.has(called.name) || appended.length >= MAX_CALLED_WORKFLOWS) continue;
      included.add(called.name);
      appended.push('--- Workflow /' + called.name + ' (called above) ---\n' + called.body);
      visit(called.body, depth + 1);
    }
  };
  visit(command.body, 1);
  const header = command.foreign === 'Cursor' || command.foreign === 'Roo Code' ? '' : 'Follow the ' + command.foreign + ' workflow /' + command.name + ' step by step.';
  return [header, command.body, ...appended].filter(Boolean).join('\n\n');
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
  // @path, @path:42, @path:10-40 and @path#L10-L40 (the GitHub/IDE form) are understood.
  const pattern = /(^|[\s(["'`])@((?:\.{0,2}\/)?[\w.\-/]+[\w\-/])(?::(\d{1,7})(?:-(\d{1,7}))?|#L(\d{1,7})(?:-L?(\d{1,7}))?)?/g;
  let match;
  while ((match = pattern.exec(source)) && files.length < MAX_MENTIONS) {
    const raw = match[2];
    const startLine = Number(match[3] || match[5]) || 0;
    const endLine = Number(match[4] || match[6]) || 0;
    const key = raw + (startLine ? ':' + startLine + '-' + endLine : '');
    if (seen.has(key) || raw.includes('@')) continue;
    seen.add(key);
    const absolute = path.resolve(workspace, raw);
    let real;
    try { real = await realpath(absolute); } catch { continue; }
    const relative = path.relative(workspace, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (sensitivePath(relative.split(path.sep).join('/'))) continue;
    let info;
    try { info = await lstat(real); } catch { continue; }
    // Paths excluded by .cursorignore and similar files are not attached (Cursor blocks @ references too).
    if (await agentIgnoreMatch(absolute, { env: options.env, isDir: info.isDirectory() }) || (real !== absolute && await agentIgnoreMatch(real, { env: options.env, isDir: info.isDirectory() }))) continue;
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
      if (options.images === false || info.size > MAX_SOURCE_IMAGE_BYTES || images.length >= 4) continue;
      const data = await readFile(real).catch(() => null);
      if (!data) continue;
      images.push({ mediaType, data: data.toString('base64'), path: relative });
      attachments.push('<image path="' + relative + '">attached</image>');
      files.push(relative);
      continue;
    }
    let content = await readFile(real, 'utf8').catch(() => null);
    if (content === null || content.includes('\0')) continue;
    if (startLine) {
      // A line range attaches just those lines, numbered, so a big file is not truncated
      // before the part the user means. A single line comes with 20 lines either side.
      const lines = content.split(/\r?\n/);
      const focus = !endLine;
      const from = Math.max(1, focus ? startLine - 20 : Math.min(startLine, endLine));
      const to = Math.min(lines.length, focus ? startLine + 20 : Math.max(startLine, endLine));
      if (from > lines.length) {
        attachments.push('<file path="' + relative + '" lines="' + startLine + (endLine ? '-' + endLine : '') + '">(the file has only ' + lines.length + ' lines)</file>');
        files.push(relative);
        continue;
      }
      const width = String(to).length;
      let body = lines.slice(from - 1, to).map((line, index) => String(from + index).padStart(width) + '\t' + line).join('\n');
      let cut = '';
      if (Buffer.byteLength(body) > MAX_MENTION_BYTES) { body = body.slice(0, MAX_MENTION_BYTES); cut = ' truncated="true"'; }
      attachments.push('<file path="' + relative + '" lines="' + from + '-' + to + '"' + (focus ? ' focus="' + startLine + '"' : '') + ' total_lines="' + lines.length + '"' + cut + '>\n' + body + '\n</file>');
      files.push(relative + ':' + from + '-' + to);
      continue;
    }
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

// "/skill-name args" runs a skill directly, like Claude Code.
export async function resolveSkillCommand(root, text, context = {}) {
  const match = String(text).trim().match(/^\/([a-zA-Z][a-zA-Z0-9-]{0,63})(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const { loadSkillText } = await import('./tools.mjs');
  const { parseFrontMatter } = await import('./frontmatter.mjs');
  let skill;
  try { skill = await loadSkillText(root, match[1], { env: context.env || process.env }); } catch { return null; }
  const { data, body } = parseFrontMatter(skill.content);
  const request = String(match[2] || '').trim();
  const options = commandOptions(data);
  if (options.context === 'fork') {
    const prompt = body.trim().replace(/\$ARGUMENTS/g, request) + (request && !body.includes('$ARGUMENTS') ? '\n\nTask: ' + request : '');
    return { name: skill.name, prompt, options: { fork: { agent: options.agent, label: 'the ' + skill.name + ' skill' }, ...(data.model ? { model: String(data.model) } : {}) } };
  }
  const prompt = 'Use the "' + skill.name + '" skill for this request.\n\n<skill name="' + skill.name + '">\n' + body.trim() + '\n</skill>\n\n' + (request ? 'Request: ' + request : 'Follow the skill for the current workspace.');
  return { name: skill.name, prompt, options: data.model ? { model: String(data.model) } : {} };
}
