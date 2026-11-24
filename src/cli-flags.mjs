// Command-line flags for `oasis` runs: the options a prompt, interactive or
// headless run takes, parsed into the session options and the run's flags.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OUTPUT_FORMATS } from './headless.mjs';
import { permissionModeList } from './permission-modes.mjs';
import { normalizePermissionMode } from './settings.mjs';

// `--model -p hi` would otherwise take -p as the model id. A flag value never
// looks like a lone option (`-p`, `--print`, `--max-turns=3`).
export const looksLikeFlag = (value) => /^(?:-[a-zA-Z]|--[a-zA-Z][\w-]*(?:=.*)?)$/.test(String(value));

// Command-line flags for a normal run (prompt, interactive or headless): sets
// SESSION_OPTIONS and environment switches directly, and the run's own
// choices (approval, persistence, resume, workspace, worktree, headless
// settings, leftover words) on `flags`.
/** Splits a permission rule list on commas or spaces outside parentheses. */
export function splitRuleList(value) {
  const rules = [];
  let depth = 0;
  let current = '';
  for (const char of String(value || '')) {
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;
    if (depth === 0 && (char === ',' || /\s/.test(char))) { if (current.trim()) rules.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) rules.push(current.trim());
  return rules;
}

export async function parseMainFlags(rawArgs, flags, SESSION_OPTIONS) {
  for (let i = 0; i < rawArgs.length; i++) {
    const takeValue = () => { const value = rawArgs[i + 1]; if (value === undefined || looksLikeFlag(value)) return undefined; i += 1; return value; };
    const needValue = (flag) => { const value = rawArgs[i + 1]; if (value === undefined || looksLikeFlag(value)) throw new Error(flag + ' requires a value.'); i += 1; return value; };
    const arg = rawArgs[i];
    // Everything after -- is passed through untouched: it is the task text or
    // another program's command line (oasis mcp add fs -- npx -y PKG), whose
    // own -y, --model or -p must not be read as OASIS options.
    if (arg === '--') { flags.args.push(...rawArgs.slice(i)); break; }
    if (arg === '--yes' || arg === '-y' || arg === '--auto') { flags.autoApprove = true; if (arg !== '--auto') flags.explicitYes = true; continue; }
    if (arg === '--permission-mode' || arg.startsWith('--permission-mode=')) {
      // The Claude Agent SDK passes --permission-mode=MODE.
      const requestedMode = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      const mode = normalizePermissionMode(requestedMode);
      if (!mode) throw new Error('--permission-mode must be one of ' + permissionModeList() + '. The camelCase names (acceptEdits, dontAsk, bypassPermissions) work too.');
      SESSION_OPTIONS.permissionMode = mode;
      if (mode === 'bypassPermissions') flags.autoApprove = true;
      continue;
    }
    if (arg === '--allowedTools' || arg === '--allowed-tools' || arg === '--disallowedTools' || arg === '--disallowed-tools') {
      if (!rawArgs[i + 1] || looksLikeFlag(rawArgs[i + 1])) throw new Error(arg + ' requires a comma- or space-separated rule list.');
      const rules = splitRuleList(takeValue());
      // Like Claude Code, the flag takes several space-separated arguments:
      // `--allowedTools "run_command(npm:*)" "run_command(node:*)"`. Only
      // arguments shaped like a rule, Tool(...), are taken; the next plain
      // word is the task text.
      while (rawArgs[i + 1] !== undefined && /^[A-Za-z_][\w.:-]*\(.*\)$/s.test(rawArgs[i + 1].trim())) rules.push(...splitRuleList(rawArgs[++i]));
      (arg.toLowerCase().includes('disallowed') ? SESSION_OPTIONS.disallowedTools : SESSION_OPTIONS.allowedTools).push(...rules);
      continue;
    }
    if (arg === '--bare') { SESSION_OPTIONS.bare = true; continue; }
    if (arg === '--calm') { SESSION_OPTIONS.calm = true; process.env.OASIS_NO_ANIMATION = '1'; continue; }
    // --safe-mode: troubleshooting start without customizations (CLAUDE.md, skills, hooks, MCP, plugins,
    // custom commands, keybindings, themes, status line). Model, built-in tools and permissions stay.
    if (arg === '--safe-mode') { SESSION_OPTIONS.safeMode = true; process.env.OASIS_SAFE_MODE = '1'; process.env.CLAUDE_CODE_SAFE_MODE = '1'; continue; }
    // --restricted: no command execution or network tools (unless named in --tools), only managed and
    // --settings settings, and bypassPermissions is refused.
    if (arg === '--restricted') { SESSION_OPTIONS.restricted = true; process.env.OASIS_RESTRICTED = '1'; continue; }
    if (arg === '--allow-dangerously-skip-permissions') { SESSION_OPTIONS.allowBypass = true; continue; }
    if (arg === '--append-subagent-system-prompt') { const value = rawArgs[i + 1]; if (value === undefined) throw new Error(arg + ' requires a value.'); i += 1; SESSION_OPTIONS.subagentSystemAppend = [SESSION_OPTIONS.subagentSystemAppend, value].filter(Boolean).join('\n\n'); continue; }
    if (arg === '--append-subagent-system-prompt-file') { const value = rawArgs[i + 1]; if (value === undefined) throw new Error(arg + ' requires a file.'); i += 1; SESSION_OPTIONS.pendingFiles.push({ kind: 'subagent-append', file: value }); continue; }
    if (arg === '--permission-prompts') {
      const value = String(takeValue() || '').toLowerCase();
      if (!['none', 'host', 'default'].includes(value)) throw new Error('--permission-prompts must be none or host.');
      flags.headless.permissionPrompts = value; if (value === 'none') process.env.OASIS_PERMISSION_PROMPTS = 'none'; continue;
    }
    if (arg === '--autocompact') {
      // auto | off | PERCENT% (1-100) | a token window such as 500k or 1m (this session only).
      const value = String(takeValue() || '').trim().toLowerCase();
      const tokens = /^(\d+(?:\.\d+)?)\s*([km])$/.exec(value);
      if (value === 'auto') { delete process.env.OASIS_AUTOCOMPACT_PCT; continue; }
      if (value === 'off' || value === '0') { process.env.OASIS_AUTOCOMPACT_PCT = '0'; continue; }
      if (tokens || /^\d{5,}$/.test(value)) {
        const count = tokens ? Number(tokens[1]) * (tokens[2] === 'm' ? 1_000_000 : 1_000) : Number(value);
        process.env.OASIS_COMPACT_THRESHOLD_CHARS = String(Math.min(8_000_000, Math.max(10_000, Math.round(count * 4))));
        continue;
      }
      const pct = Number(value.replace(/%$/, ''));
      if (!(Number.isInteger(pct) && pct >= 1 && pct <= 100)) throw new Error('--autocompact takes auto, off, a percentage (70 or 70%), or a token count (500k, 1m).');
      process.env.OASIS_AUTOCOMPACT_PCT = String(pct);
      continue;
    }
    if (arg === '--append-system-prompt') { SESSION_OPTIONS.appendSystemPrompt = [SESSION_OPTIONS.appendSystemPrompt, needValue(arg)].filter(Boolean).join('\n\n'); continue; }
    if (arg === '--system-prompt') { SESSION_OPTIONS.systemPromptOverride = needValue(arg); continue; }
    if (arg === '--output-style' || arg.startsWith('--output-style=')) { const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : needValue(arg); if (!String(value).trim()) throw new Error('--output-style requires a style name.'); SESSION_OPTIONS.outputStyle = String(value).trim(); continue; }
    if (arg === '--system-prompt-file') { SESSION_OPTIONS.pendingFiles.push({ kind: 'system', file: needValue(arg) }); continue; }
    if (arg === '--append-system-prompt-file') { SESSION_OPTIONS.pendingFiles.push({ kind: 'append', file: needValue(arg) }); continue; }
    if (arg === '--fallback-model') { SESSION_OPTIONS.fallbackModel = needValue(arg); continue; }
    if (arg === '--advisor') { SESSION_OPTIONS.advisor = needValue(arg); continue; }
    if (arg === '--chrome' || arg === '--browser') { SESSION_OPTIONS.chrome = true; continue; }
    if (arg === '--computer-use') { SESSION_OPTIONS.computerUse = true; continue; }
    if (arg === '--computer-use=virtual') { SESSION_OPTIONS.computerUse = 'virtual'; continue; }
    if (arg === '--no-computer-use') { SESSION_OPTIONS.computerUse = false; continue; }
    if (arg === '--no-chrome' || arg === '--no-browser') { SESSION_OPTIONS.chrome = false; continue; }
    if (arg === '--bg' || arg === '--background') { SESSION_OPTIONS.background = true; continue; }
    if (arg === '--exec') { const value = rawArgs[i + 1]; if (value === undefined) throw new Error('--exec requires a shell command.'); i += 1; SESSION_OPTIONS.exec = value; continue; }
    if (arg === '--max-budget-usd') {
      const value = Number(needValue(arg));
      if (!Number.isFinite(value) || value <= 0) throw new Error('--max-budget-usd must be a positive dollar amount, for example 2.50.');
      SESSION_OPTIONS.maxBudgetUsd = value;
      continue;
    }
    // Zero-budget mode and request/token budgets live in the environment so
    // child agents (`oasis -p` subprocesses, best-of-N attempts) inherit them.
    if (arg === '--zero-budget') { process.env.OASIS_ZERO_BUDGET = '1'; continue; }
    if (arg === '--max-requests' || arg === '--max-total-tokens') {
      const value = Number(needValue(arg));
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(arg + ' must be a positive whole number.');
      process.env[arg === '--max-requests' ? 'OASIS_MAX_REQUESTS' : 'OASIS_MAX_TOTAL_TOKENS'] = String(value);
      continue;
    }
    if (arg === '--agent') { SESSION_OPTIONS.agent = needValue(arg).trim().toLowerCase(); continue; }
    if (arg === '--tools') { SESSION_OPTIONS.tools = needValue(arg).split(/[\s,]+/).filter(Boolean); continue; }
    if (arg === '--mcp-config') { SESSION_OPTIONS.pendingFiles.push({ kind: 'mcp', file: needValue(arg) }); continue; }
    if (arg === '--strict-mcp-config') { SESSION_OPTIONS.strictMcpConfig = true; continue; }
    if (arg === '--channels' || arg.startsWith('--channels=') || arg === '--dangerously-load-development-channels' || arg.startsWith('--dangerously-load-development-channels=')) {
      const dev = arg.startsWith('--dangerously');
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      if (!value) throw new Error(arg + ' needs a list like server:webhook or plugin:telegram@claude-plugins-official.');
      const { parseChannelEntries } = await import('./channels.mjs');
      const entries = parseChannelEntries(value);
      (dev ? SESSION_OPTIONS.devChannels : SESSION_OPTIONS.channels).push(...entries.map((entry) => entry.raw));
      continue;
    }
    if (arg === '--settings') { SESSION_OPTIONS.pendingFiles.push({ kind: 'settings', file: needValue(arg) }); continue; }
    if (arg === '--setting-sources') {
      const list = needValue(arg).split(/[\s,]+/).filter(Boolean);
      if (list.some((item) => !['user', 'project', 'local'].includes(item))) throw new Error('--setting-sources accepts user, project and local.');
      SESSION_OPTIONS.settingSources = list;
      continue;
    }
    if (arg === '--agents') { SESSION_OPTIONS.pendingFiles.push({ kind: 'agents', file: needValue(arg) }); continue; }
    if (arg === '--session-id') {
      const value = needValue(arg);
      if (!/^[a-f0-9-]{20,80}$/i.test(value)) throw new Error('--session-id must be a UUID.');
      SESSION_OPTIONS.sessionId = value.toLowerCase(); flags.persistSession = true; continue;
    }
    if (arg === '--fork-session') { SESSION_OPTIONS.forkSession = true; continue; }
    if (arg === '--name' || arg === '-n') { SESSION_OPTIONS.sessionName = needValue(arg); flags.persistSession = true; continue; }
    if (arg === '--verbose') { SESSION_OPTIONS.verbose = true; continue; }
    if (arg === '--debug-file') { SESSION_OPTIONS.debugFile = needValue(arg); process.env.OASIS_DEBUG_FILE = SESSION_OPTIONS.debugFile; if (!SESSION_OPTIONS.debug) { SESSION_OPTIONS.debug = 'all'; process.env.OASIS_DEBUG = 'all'; } continue; }
    if (arg === '--debug') { SESSION_OPTIONS.debug = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') && !/\s/.test(rawArgs[i + 1]) && /^[a-z,!]+$/i.test(rawArgs[i + 1]) ? rawArgs[++i] : 'all'; process.env.OASIS_DEBUG = SESSION_OPTIONS.debug; continue; }
    if (arg === '--disable-slash-commands') { SESSION_OPTIONS.disableSlashCommands = true; continue; }
    if (arg === '--input-format') {
      flags.headless.inputFormat = needValue(arg);
      if (!['text', 'stream-json'].includes(flags.headless.inputFormat)) throw new Error('--input-format must be text or stream-json.');
      continue;
    }
    if (arg === '--include-partial-messages') { flags.headless.includePartial = true; continue; }
    if (arg === '--replay-user-messages') { flags.headless.replayUser = true; continue; }
    if (arg === '--include-hook-events') { flags.headless.includeHookEvents = true; continue; }
    if (arg === '--forward-subagent-text') { flags.headless.forwardSubagentText = true; continue; }
    if (arg === '--prompt-suggestions') { flags.headless.promptSuggestions = true; continue; }
    if (arg === '--exclude-dynamic-system-prompt-sections') { SESSION_OPTIONS.excludeDynamicSections = true; continue; }
    if (arg === '--permission-prompt-tool') { flags.headless.permissionPromptTool = needValue(arg); continue; }
    if (arg === '--init' || arg === '--init-only') { SESSION_OPTIONS.runInit = arg === '--init-only' ? 'only' : 'continue'; continue; }
    if (arg === '--maintenance') { SESSION_OPTIONS.runMaintenance = true; continue; }
    if (arg === '--from-pr') { SESSION_OPTIONS.fromPr = needValue(arg); continue; }
    if (arg === '-p' || arg === '--print') {
      flags.headless.enabled = true;
      if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) flags.headless.prompt = rawArgs[++i];
      continue;
    }
    if (arg === '--output-format') {
      flags.headless.outputFormat = takeValue();
      if (!OUTPUT_FORMATS.includes(flags.headless.outputFormat)) throw new Error('--output-format must be one of ' + OUTPUT_FORMATS.join(', ') + '.');
      continue;
    }
    if (arg.startsWith('--output-format=')) { flags.headless.outputFormat = arg.slice(16); continue; }
    if (arg === '--goal') {
      if (!rawArgs[i + 1] || looksLikeFlag(rawArgs[i + 1])) throw new Error('--goal requires a condition, e.g. --goal "npm test passes".');
      flags.headless.goal = String(takeValue());
      if (flags.headless.goal.length > 4000) throw new Error('A goal can be at most 4,000 characters. Put the details in a file and point the goal at it.');
      flags.headless.enabled = true;
      continue;
    }
    if (arg === '--require-verified') { flags.headless.requireVerified = true; continue; }
    if (arg === '--goal-verify') { flags.headless.goalVerify = true; continue; }
    if (arg === '--review' || arg.startsWith('--review=')) {
      // --review [N]: the next argument is a round count only when it is a number.
      const inline = arg.startsWith('--review=') ? arg.slice('--review='.length) : /^\d+$/.test(String(rawArgs[i + 1] || '')) ? rawArgs[++i] : '1';
      const value = Number.parseInt(inline, 10);
      if (!Number.isInteger(value) || value < 0 || value > 3) throw new Error('--review takes 0 to 3 fix rounds (default 1).');
      flags.headless.review = value;
      continue;
    }
    if (arg === '--goal-turns') {
      const value = Number.parseInt(takeValue(), 10);
      if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('--goal-turns must be a whole number from 1 to 100.');
      flags.headless.goalMaxTurns = value;
      continue;
    }
    if (arg === '--max-turns') {
      const value = Number.parseInt(takeValue(), 10);
      if (!Number.isInteger(value) || value < 1 || value > 400) throw new Error('--max-turns must be a whole number from 1 to 400.');
      flags.headless.maxTurns = value;
      continue;
    }
    if (arg === '--model') {
      if (!rawArgs[i + 1] || looksLikeFlag(rawArgs[i + 1])) throw new Error('--model requires a model id.');
      SESSION_OPTIONS.model = takeValue();
      continue;
    }
    if (arg === '--effort') {
      const level = String(takeValue() || '').toLowerCase();
      if (!['low', 'medium', 'high', 'max', 'auto'].includes(level)) throw new Error('--effort must be low, medium, high, max or auto.');
      SESSION_OPTIONS.effort = level === 'auto' ? null : level;
      continue;
    }
    if (arg === '--json-schema' || arg === '--output-schema') {
      const value = takeValue();
      if (!value) throw new Error(arg + ' needs a JSON Schema (inline JSON or @path/to/schema.json).');
      // Codex's --output-schema takes a plain file path.
      flags.headless.jsonSchemaSource = arg === '--output-schema' && !/^\s*[{@]/.test(value) ? '@' + value : value;
      continue;
    }
    if (arg === '--receipt') {
      const value = takeValue();
      if (!value || value.startsWith('-')) throw new Error('--receipt needs a file path for the receipt.');
      flags.headless.receipt = value;
      continue;
    }
    if (arg.startsWith('--receipt=')) { flags.headless.receipt = arg.slice(10); continue; }
    if (arg === '-o' || arg === '--output-last-message') {
      const value = takeValue();
      if (!value || value.startsWith('-')) throw new Error(arg + ' needs a file path for the final message.');
      flags.headless.outputLastMessage = value;
      continue;
    }
    if (arg === '-w' || arg === '--worktree') {
      flags.worktreeName = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[++i] : 'session';
      continue;
    }
    if (arg === '--plan') { flags.headless.planOnly = true; continue; }
    if (arg === '--tmux' || arg === '--tmux=classic') { SESSION_OPTIONS.tmux = true; continue; }
    if (arg === '--ide') { process.env.OASIS_IDE = 'auto'; continue; }
    if (arg === '--teammate-mode' || arg.startsWith('--teammate-mode=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      if (!['auto', 'in-process', 'tmux'].includes(String(value))) throw new Error('--teammate-mode must be auto, in-process or tmux.');
      process.env.OASIS_TEAMMATE_MODE = value;
      continue;
    }
    if (arg === '--ax-screen-reader') { process.env.OASIS_AX_SCREEN_READER = '1'; continue; }
    if (arg === '--betas') {
      const values = [];
      while (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) values.push(...rawArgs[++i].split(','));
      if (!values.length) throw new Error('--betas needs one or more beta header names.');
      process.env.ANTHROPIC_BETAS = [process.env.ANTHROPIC_BETAS, ...values].filter(Boolean).join(',');
      continue;
    }
    if (arg === '--system-prompt-snapshot' || arg.startsWith('--system-prompt-snapshot=')) {
      const value = (arg.includes('=') ? arg.split('=')[1] : takeValue() || '').toLowerCase();
      if (!['on', 'off'].includes(value)) throw new Error('--system-prompt-snapshot must be on or off.');
      SESSION_OPTIONS.systemPromptSnapshot = value;
      continue;
    }
    if (arg === '--plugin-url') { const url = takeValue(); if (!url) throw new Error('--plugin-url needs a URL.'); (SESSION_OPTIONS.pluginUrls ||= []).push(url); continue; }
    if (arg === '--plugin-dir') { const dir = takeValue(); if (!dir) throw new Error('--plugin-dir needs a directory.'); process.env.OASIS_PLUGIN_DIRS = [process.env.OASIS_PLUGIN_DIRS, path.resolve(dir)].filter(Boolean).join(path.delimiter); continue; }
    if (arg === '--add-dir') { const dir = takeValue(); if (!dir) throw new Error('--add-dir needs a directory.'); SESSION_OPTIONS.addDirs.push(path.resolve(dir)); continue; }
    if (arg === '--dangerously-skip-permissions') { SESSION_OPTIONS.permissionMode = 'bypassPermissions'; SESSION_OPTIONS.allowBypass = true; flags.autoApprove = true; continue; }
    // Codex and Gemini CLI flags, mapped to the nearest OASIS policy. The runtime's
    // hard refusals (home deletion, force pushes, reset --hard, ...) still apply.
    if (arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') { SESSION_OPTIONS.permissionMode = 'bypassPermissions'; SESSION_OPTIONS.allowBypass = true; flags.autoApprove = true; process.env.OASIS_SANDBOX = '0'; continue; }
    if (arg === '--full-auto') { SESSION_OPTIONS.permissionMode = 'acceptEdits'; process.env.OASIS_SANDBOX = '1'; continue; }
    if (arg === '--sandbox' || arg === '-s' || arg.startsWith('--sandbox=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      flags.headless.codexSandbox = value;
      if (value === 'read-only') SESSION_OPTIONS.permissionMode = 'plan';
      else if (value === 'workspace-write') process.env.OASIS_SANDBOX = '1';
      else if (value === 'danger-full-access') process.env.OASIS_SANDBOX = '0';
      else throw new Error('--sandbox must be read-only, workspace-write or danger-full-access.');
      continue;
    }
    if (arg === '--ask-for-approval' || arg === '-a' || arg.startsWith('--ask-for-approval=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      // never: no prompts, like Codex; OASIS uses auto mode, whose risk check still blocks dangerous commands.
      flags.headless.codexApproval = value;
      if (value === 'never') SESSION_OPTIONS.permissionMode = 'auto';
      else if (value === 'on-request' || value === 'on-failure' || value === 'untrusted') SESSION_OPTIONS.permissionMode = SESSION_OPTIONS.permissionMode || 'default';
      else throw new Error('--ask-for-approval must be untrusted, on-failure, on-request or never.');
      continue;
    }
    if (arg === '--approval-mode' || arg.startsWith('--approval-mode=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      const mode = { default: 'default', auto_edit: 'acceptEdits', 'auto-edit': 'acceptEdits', yolo: 'bypassPermissions', plan: 'plan' }[value];
      if (!mode) throw new Error('--approval-mode must be default, auto_edit, yolo or plan.');
      SESSION_OPTIONS.permissionMode = mode;
      if (mode === 'bypassPermissions') { SESSION_OPTIONS.allowBypass = true; flags.autoApprove = true; }
      continue;
    }
    if (arg === '--include-directories' || arg.startsWith('--include-directories=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      if (!value) throw new Error('--include-directories needs a comma-separated list of directories.');
      for (const dir of value.split(',').map((item) => item.trim()).filter(Boolean)) SESSION_OPTIONS.addDirs.push(path.resolve(dir));
      continue;
    }
    if (arg === '--skip-git-repo-check') continue;
    if (flags.execMode && (arg === '--json' || arg === '--experimental-json')) { flags.headless.codexJson = true; continue; }
    if (flags.execMode && (arg === '--config' || arg.startsWith('--config=') || (arg === '-c' && /^[\w.-]+=/.test(rawArgs[i + 1] || '')))) {
      const pair = arg.includes('=') && arg.startsWith('--config=') ? arg.slice('--config='.length) : takeValue();
      if (!pair || !pair.includes('=')) throw new Error('--config needs key=value.');
      (flags.headless.codexConfig ||= []).push(pair);
      continue;
    }
    if (arg === '--image' || (flags.execMode && arg === '-i') || arg.startsWith('--image=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      if (!value) throw new Error('--image needs a file path.');
      for (const file of value.split(',').map((item) => item.trim()).filter(Boolean)) (flags.headless.images ||= []).push(path.resolve(file));
      continue;
    }
    if (flags.execMode && (arg === '--thread-source' || arg === '--color')) { i++; continue; }
    if (flags.execMode && arg === '--ephemeral') { flags.noPersist = true; continue; }
    if (flags.execMode && arg === 'resume' && !flags.args.length) {
      // The Codex SDK puts `resume THREAD_ID` after the flags.
      const next = rawArgs[i + 1];
      if (next === '--last') { i++; flags.persistSession = true; flags.continueSession = true; }
      else if (next && !next.startsWith('-')) { flags.resumeId = rawArgs[++i]; flags.persistSession = true; }
      continue;
    }
    // Gemini CLI: start the interactive session with this first message.
    if (arg === '-i' || arg === '--prompt-interactive' || arg.startsWith('--prompt-interactive=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      if (!value) throw new Error('--prompt-interactive needs a message.');
      SESSION_OPTIONS.initialPrompt = value; continue;
    }
    // Aider flags. --test-cmd plus --auto-test uses Oasis auto-test; commits use auto-commit.
    if (arg === '--yes-always') { flags.autoApprove = true; continue; }
    if (arg === '--message' || arg === '--msg' || arg.startsWith('--message=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      if (!value) throw new Error(arg.split('=')[0] + ' needs a message.');
      flags.headless.enabled = true; flags.headless.prompt = value; continue;
    }
    if (arg === '--message-file' || arg.startsWith('--message-file=')) {
      const file = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      if (!file) throw new Error('--message-file needs a file.');
      flags.headless.enabled = true; flags.headless.prompt = readFileSync(path.resolve(file), 'utf8'); continue;
    }
    if (arg === '--test-cmd' || arg.startsWith('--test-cmd=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : takeValue();
      if (!value) throw new Error('--test-cmd needs a command.');
      SESSION_OPTIONS.aiderTestCmd = value; continue;
    }
    if (arg === '--auto-test') { SESSION_OPTIONS.aiderAutoTest = true; continue; }
    if (arg === '--no-auto-test') { process.env.OASIS_AUTO_TEST = 'off'; continue; }
    if (arg === '--auto-commits') { process.env.OASIS_AUTO_COMMIT = '1'; continue; }
    if (arg === '--no-auto-commits') { process.env.OASIS_AUTO_COMMIT = '0'; continue; }
    if (arg === '--no-session-persistence') { flags.noPersist = true; continue; }
    if (arg === '--continue' || arg === '-c') { flags.persistSession = true; flags.continueSession = true; continue; }
    if (arg === '--resume' || arg === '-r') {
      // Without an ID (like `claude -r`), open the session picker.
      if (!rawArgs[i + 1] || rawArgs[i + 1].startsWith('-')) { SESSION_OPTIONS.resumePicker = true; flags.persistSession = true; continue; }
      flags.resumeId = takeValue(); flags.persistSession = true; continue;
    }
    if (arg === '--workspace' || arg === '-C' || arg === '--cd') {
      if (!rawArgs[i + 1] || looksLikeFlag(rawArgs[i + 1])) throw new Error('--workspace requires a path.');
      flags.workspace = path.resolve(takeValue());
      continue;
    }
    if (arg.startsWith('--workspace=')) { flags.workspace = path.resolve(arg.slice('--workspace='.length)); continue; }
    flags.args.push(arg);
  }
}
