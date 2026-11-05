#!/usr/bin/env node
import { FALLBACK_PROVIDERS } from './fallback-chain.mjs';
import { probeLocalContext, isLocalModelEndpoint, localContextAdvice, SMALL_CONTEXT_TOKENS, RECOMMENDED_LOCAL_CONTEXT } from './local-context.mjs';
import { notifyAttention } from './attention.mjs';
import { playSound, configureSounds, completedTodoCount, DONE_SOUND_AFTER_MS } from './sounds.mjs';
import { cronState, formatFindings } from './session-tools.mjs';
import { hasHooks as hasConfiguredHooks } from './hooks.mjs';
import { startPluginMonitorsFor } from './monitors.mjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { defaultCloudBaseURL } from './cloud-providers.mjs';
import { loadConfig, saveConfig, getProviderSummary, DEFAULT_BASE_URL, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_MODEL, validateBaseUrl, validateProtocol, isLoopbackUrl, isNodeVersionSupported, resolveSetupProviderPreset, inferSetupProviderPreset, shouldPromptForProviderBaseURL, carryLearnedContextWindow } from './config.mjs';
import { startIdleCompaction, idleCompactMinutes, idleCompactionNote } from './idle-compaction.mjs';
import { compactHistoryIfNeeded } from './agent.mjs';
import { applyEffort, createSession, runAgentTurn, runAgentPlan, runForkedTurn, closeSession, testProviderConnection, repairInterruptedHistory, resolveQuestionAnswer, stopFailureType, formatWait, steerSession, takeSteering } from './agent.mjs';
import { loadMcpServers, saveMcpServers, getMcpConfigPath, validateMcpServerConfig } from './mcp.mjs';
import { loadProjectMcpServers } from './mcp-project.mjs';
import { loadSession, saveSession, listSessions, deleteSession, staleSessions, pruneSessions } from './sessions.mjs';
import { executeTool, listAvailableSkills } from './tools.mjs';
import { resolveUninstallPlan } from './uninstall.mjs';
import { parseInstallIntent, planPackageInstall } from './installer.mjs';
import { listBackups, restoreBackup } from './backups.mjs';
import { runEvalCommand, evalModelPassthrough } from './eval.mjs';
import { managePlugins } from './plugins.mjs';
import { inspectGitHubExtension, inspectGitHubMcpServers, selectReviewedMcpServers, resolveImportedSlashCommand, installGitHubExtension, updateGitHubExtension, rollbackGitHubExtension, listInstalledExtensions, removeGitHubExtension } from './extensions.mjs';
import { startOasisWebServer } from './web.mjs';
import { loadSettings, setWorkspaceTrust, addPermissionRule, PERMISSION_MODES, normalizePermissionMode, userSettingsPath } from './settings.mjs';
import { detectSandbox, resolveSandbox } from './sandbox.mjs';
import { resolveCustomCommand, expandFileMentions, loadCustomCommands, resolveSkillCommand } from './commands.mjs';
import { visionEnabled } from './images.mjs';
import { searchBackend } from './web-search.mjs';
import { loadAgentDefinitions } from './subagents.mjs';
import { loadOutputStyles } from './output-styles.mjs';
import { renderStatusLine, statusLinePayload } from './status-line.mjs';
import { BUILTIN_COMMANDS, COMMAND_ALIASES, runBuiltinCommand, createUsageTracker, recordUsage, formatInterval } from './slash.mjs';
import { appendMemoryNote, memoryFiles } from './memory.mjs';
import { runHeadless, OUTPUT_FORMATS } from './headless.mjs';
import { fstatSync, readFileSync, rmSync } from 'node:fs';
import { runDiagnostics, formatDiagnostics, CHECKERS } from './diagnostics.mjs';
import { readInput, KeyDecoder } from './line-editor.mjs';
import { loadHistory, appendHistory } from './input-history.mjs';
import { createCompleter } from './completion.mjs';
import { MarkdownStream, colorEnabled, wrapRendered } from './markdown.mjs';
import { createActivityIndicator } from './activity-indicator.mjs';
import { formatApprovalMessage, redactApprovalSecrets } from './approval-language.mjs';
import { formatTurnSummary, showStartupBanner, promptFor, footerFor, nextMode, runShellPassthrough, shellContextBlock, describeTool, describeEdit, describeToolResult, verboseToolOutput } from './terminal-ui.mjs';
import { estimateTokens, contextWindowSize } from './context.mjs';
import { formatUsd, priceFor } from './pricing.mjs';
import { discoverLocalOllamaModels } from './ollama-discovery.mjs';
import { commandAvailable } from './command-lookup.mjs';
import { installProxyFromEnv, currentProxy } from './proxy.mjs';

// Options that shape every agent session created by this process.
const SESSION_OPTIONS = { permissionMode: null, allowedTools: [], disallowedTools: [], appendSystemPrompt: '', model: null, effort: null, outputStyle: null, addDirs: [], pendingFiles: [], mcpServers: [], settingsOverrides: [], tools: null, channels: [], devChannels: [] };

// --plugin-url archives are intentionally session-scoped. Remove their temporary
// extraction roots on every normal process exit, including startup/error paths.
const TEMPORARY_PLUGIN_DIRS = new Set();
process.once('exit', () => {
  for (const directory of TEMPORARY_PLUGIN_DIRS) {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
const USAGE = createUsageTracker();
let settingsWarningShown = false;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_URL = 'https://github.com/FAHTHIZ/oasis/archive/';

function printQuickHelp() {
  const rows = (items) => items.map(([cmd, text]) => '  ' + cmd.padEnd(34) + text);
  stdout.write([
    'OASIS — a plain-English coding agent',
    '',
    'Usage:',
    '  oasis [options] [command]',
    '',
    'Start',
    ...rows([
      ['oasis', 'Chat in the terminal (this folder is the workspace)'],
      ['oasis "fix the failing test"', 'Start with a first message'],
      ['oasis web --open', 'Open the OASIS app in your browser, working on this folder'],
      ['oasis app --lan', 'Serve the universal app to install on a phone or tablet'],
      ['oasis -p "explain src/"', 'Run once without prompts (scripts and CI)'],
      ['oasis -c  |  oasis -r ID', 'Continue the last chat, or resume a saved one']
    ]),
    '',
    'Set up and check',
    ...rows([
      ['oasis connect', 'Paste an API key, model link or local server; OASIS does the rest'],
      ['oasis setup', 'Same, with a step-by-step menu for every provider'],
      ['oasis doctor', 'Check Node, Git, provider, sandbox and config'],
      ['oasis update', 'Update to the latest stable release'],
      ['oasis init', 'Create OASIS.md project instructions'],
      ['oasis completion bash', 'Tab completion for bash, zsh, fish or powershell']
    ]),
    '',
    'Extend',
    ...rows([
      ['oasis mcp list|add|remove', 'Model Context Protocol servers'],
      ['oasis skills | oasis plugins', 'Agent Skills and native plugins'],
      ['oasis ide | oasis acp', 'VS Code, Cursor, Zed, JetBrains and other editors'],
      ['oasis gateway', 'Chat with OASIS from Telegram, Slack or Discord']
    ]),
    '',
    'Safety',
    ...rows([
      ['--permission-mode <mode>', 'manual (default), accept-edits, plan, auto'],
      ['--safe-mode', 'Start with skills, hooks, MCP and plugins off'],
      ['--restricted', 'No command or network tools; managed settings only'],
      ['-w, --worktree [name]', 'Work on an isolated Git worktree branch'],
      ['/rewind (in chat, or Esc Esc)', 'Undo file changes from earlier turns']
    ]),
    '',
    'More',
    ...rows([
      ['oasis help all', 'Every command and option'],
      ['oasis --version', 'Print the version']
    ]),
    '',
    'Docs: https://github.com/FAHTHIZ/oasis/blob/main/docs/USER_GUIDE.md',
    ''
  ].join('\n'));
}

function printHelp() {
  stdout.write([
    'OASIS — a plain-English coding agent',
    '',
    'Usage:',
    '  oasis                         Start an interactive agent session',
    '  oasis "fix the failing tests"  Give a task in plain English',
    '  oasis -p "task" [--output-format text|json|stream-json] [--max-turns N]  Run once without prompts (scripts/CI)',
    '  cat log.txt | oasis -p "explain this error"  Piped input is added to the prompt',
    '  oasis connect                 Paste an API key, model link or local server address; detects the provider, picks the best model and backups',
    '  oasis setup                   Configure a model provider (paste first; Enter for the step-by-step menu)',
    '  oasis setup --auto            Detect this computer (CPU, memory, GPU) and running model servers, then configure the best fit',
    '  oasis doctor [--test-provider] Check the environment; optionally verify live tool calling',
    '  oasis doctor --network        Check that the provider, MCP servers and GitHub are reachable (proxy, DNS, TLS)',
    '  oasis update [--check] [--yes] Check and install the latest stable GitHub release',
    '  oasis uninstall [--yes]      Remove the CLI package; keep projects and user data',
    '  oasis completion bash|zsh|fish|powershell  Print a Tab-completion script for your shell',
    '  oasis web [--open] [--host HOST] [--port PORT] [--tls-cert FILE --tls-key FILE]  Start browser workspace (--open opens it in your browser)',
    '  oasis app [--lan] [--port PORT] [--open]  Serve the universal app (runs fully in the browser that opens it; install it from there)',
    '  oasis exec PROMPT [flags]  Same as oasis -p (non-interactive run)',
    '  oasis watch [--yes]       Act on code comments ending in AI! (change) or AI? (question)',
    '  oasis init                    Create OASIS.md project instructions',
    '  oasis memory [list|search Q|show ID|forget ID|path]  View and manage auto memory',
    '  oasis -p PROMPT --json-schema SCHEMA  Return JSON that matches a schema (inline or @file.json)',
    '  oasis exec PROMPT --output-schema FILE -o FILE  Codex-style flags: schema from a file, final message to a file',
    '  oasis -p PROMPT --bare        Skip project instructions, skills, hooks, MCP, and memory',
    '  oasis --calm                 No animations; use stable, finished-line output',
    '  oasis --plugin-url URL        Load a plugin .zip from a URL for this session (repeatable)',
    '  oasis --safe-mode             Start with customizations off (CLAUDE.md, skills, hooks, MCP, plugins, commands, themes, keybindings)',
    '  oasis --restricted            No command/network tools, only managed + --settings settings, no bypassPermissions',
    '  oasis -p PROMPT --permission-prompts none   Deny anything not pre-approved instead of asking',
    '  oasis --autocompact 70|500k|off             Auto-compact threshold for this session',
    '  oasis --append-subagent-system-prompt TEXT  Extra system text for every subagent (also -file PATH)',
    '  oasis --allow-dangerously-skip-permissions  Add bypassPermissions to the Shift+Tab mode cycle',
    '  oasis -w [NAME]               Work in a new git worktree on its own branch',
    '  oasis diagnostics [PATH...] [--checker NAME] [--json]  Run type checkers/linters and list problems',
    '  oasis plan "task"             Inspect the workspace and produce a read-only implementation plan',
    '  oasis install pnpm            Install a tool using a detected manager',
    '  oasis sessions list           List locally saved sessions for this workspace',
    '  oasis sessions search QUERY [--all] [--json]  Search earlier saved conversations',
    '  oasis sessions export ID...|--all [--format sharegpt|openai] [--out FILE]  Export trajectories as JSONL',
    '  oasis batch PROMPTS.jsonl [--out FILE] [--concurrency N]  Run many prompts, one fresh session each, and save trajectories',
    '  oasis sessions clear ID       Delete one saved session',
    '  oasis sessions prune [--older-than DAYS]  Delete saved sessions unused for DAYS (default 30)',
    '  oasis --continue              Resume the most recent saved session and keep saving it',
    '  oasis --resume SESSION_ID     Resume one saved session',
    '  oasis mcp list                List configured Model Context Protocol servers',
    '  oasis ide [install|package]   Connect VS Code/Cursor/Windsurf: selection context, diff review, diagnostics',
    '  oasis mcp search QUERY        Search the official MCP Registry for servers',
    '  oasis mcp install NAME        Add a server from the MCP Registry (pinned version, asks first)',
    '  oasis mcp add NAME -- COMMAND Configure a stdio MCP server',
    '  oasis mcp add --transport http|sse NAME URL  Configure a remote MCP server',
    '  oasis insights [DAYS]          Write an HTML report about your recent sessions',
    '  oasis --bg "TASK"              Run a task in a background session; oasis bg list|logs|attach|stop|rm ID',
    '  oasis --bg --exec "CMD"        Run a shell command as a background job',
    '  oasis attach|logs|stop|rm|respawn ID|NAME   Manage background sessions (respawn --all restarts every running one)',
    '  oasis auto-mode defaults|config|critique|reset   Inspect or reset the auto mode classifier rules',
    '  oasis purge [PATH] [--dry-run] [-y] [-i] [--all] [--memory]   Delete local Oasis state for a project',
    '  oasis profile list|create|use|show|delete  Separate agents with their own config, memory, sessions and skills (--profile NAME)',
    '  oasis import [codex|gemini|cursor|claude|hermes|opencode|antigravity|windsurf|cline] [--dry-run] [--yes]  Import MCP servers, instructions, commands, rules, skills and memories',
    '  oasis mcp remove NAME         Remove a configured server',
    '  oasis mcp serve [--allow-edits] [--allow-commands]  Serve Oasis tools to other MCP clients over stdio',
    '  oasis gateway telegram        Chat with this workspace agent from Telegram (allowlisted chats only)',
    '  oasis gateway discord|slack   The same from a Discord bot or a Slack app (Socket Mode); allowlisted users only',
    '  oasis acp [--permission-mode MODE] [--editor-terminal]  Run as an Agent Client Protocol agent for Zed, JetBrains, Neovim and other ACP editors',
    '  oasis mcp login|logout NAME   Sign in to (or out of) a remote MCP server with OAuth',
    '  oasis skills list              List skills visible to Oasis',
    '  oasis skills find [query]      Search the skills.sh ecosystem',
    '  oasis skills inspect SOURCE    List skills available from a source',
    '  oasis skills add SOURCE --skill NAME [--global]  Install a selected skill',
    '  oasis skills add SOURCE --all [--global]  Install all skills from a source',
    '  oasis skills install NAME      Install a bundled Oasis workflow skill',
    '  oasis plugins list             Browse built-in capability bundles',
    '  oasis plugins install NAME    Install a reviewed capability bundle',
    '  oasis plugins remove NAME     Remove a bundle and its owned skills',
    '  oasis plugin eval DIR [--runs N] [--no-baseline] [--json]  Score a plugin or skill on its evals/evals.json cases against a no-plugin baseline',
    '  oasis plugin eval init DIR     Draft eval cases for a plugin or skill',
    '  oasis extensions list         List imported GitHub agent/skill collections',
    '  oasis extensions inspect URL  Review importable prompts and pinned commit',
    '  oasis extensions mcp-import URL [--servers name1,name2]  Import reviewed MCP configs disabled',
    '  oasis extensions install URL --scope both   Import prompts into Oasis + project',
    '  oasis extensions update URL --scope project  Update a verified install and keep rollback history',
    '  oasis extensions rollback NAME --commit SHA --scope project  Restore a verified extension backup',
    '  oasis extensions remove NAME --scope project Remove an unmodified import',
    '  oasis permissions [list]      Show permission rules, hooks, trust, and sandbox status',
    '  oasis permissions add allow "run_command(npm test:*)" [--scope user|project|local]',
    '  oasis trust [--revoke]        Trust this workspace so its allow rules and hooks apply',
    '  oasis backups                 List snapshots made before file changes',
    '  oasis restore BACKUP_ID       Restore one file snapshot after confirmation',
    '  oasis eval --validate         Validate evaluation tasks and reference patches',
    '  oasis eval [--task ID] [--trials N] --yes   Run agent evaluations (not OS-sandboxed)',
    '  oasis update                  Update the installed Oasis CLI from GitHub',
    '  oasis config                  Show provider settings (key is masked)',
    '',
    'Options:',
    '  --workspace PATH              Choose the workspace root',
    '  --yes, -y                     Auto-approve supported commands and installs',
    '                                (destructive operations remain blocked or gated)',
    '  --permission-mode MODE        manual/default | acceptEdits/accept-edits | plan | auto | bypassPermissions',
    '  --add-dir PATH                Let tools read and edit another directory (repeatable)',
    '  --dangerously-skip-permissions  Same as --permission-mode bypassPermissions --yes',
    '  --continue, -c                Continue the most recent saved session',
    '  --no-session-persistence      Do not save this session (sessions are saved by default)',
    '  --resume ID, -r ID            Resume a saved session (see oasis sessions list)',
    '  --model ID                    Use a different model for this run',
    '  --max-turns N                 Limit model steps for one task (1-400)',
    '  --allowedTools RULES          Extra allow rules, e.g. "run_command(npm test:*),Edit(src/**)"',
    '  --disallowedTools RULES       Extra deny rules for this run',
    '  --append-system-prompt TEXT   Add instructions to the system prompt',
    '  --agent NAME                  Run the session as a subagent (its prompt and tools), e.g. feature-dev:code-architect',
    '  --append-system-prompt-file F Add instructions from a file',
    '  --output-style NAME           Use an output style for this session (default, explanatory, learning, or a custom/plugin style)',
    '  --system-prompt TEXT | --system-prompt-file F  Replace the default system prompt',
    '  --fallback-model ID[,ID...]   Models to switch to, in order, when the main one runs out of credit, is rate-limited, overloaded or gone (provider:model for another provider)',
    '  --chrome, --no-chrome         Give the agent a Chrome browser tool (navigate, click, type, screenshot, console)',
    '  --max-budget-usd N            Stop once the estimated model cost reaches N dollars',
    '  --tools "Read,Edit,Bash"      Only offer these tools (Claude or Oasis names; "" for none)',
    '  --plugin-dir DIR              Load a Claude Code plugin directory for this session (repeatable)',
    '  --mcp-config FILE|JSON        Load MCP servers ({"mcpServers": {...}}); --strict-mcp-config uses only these',
    '  --channels server:NAME|plugin:NAME@MKT  Let these MCP channel servers push messages into the session (interactive)',
    '  --dangerously-load-development-channels LIST  Same, after a local-development confirmation',
    '  --settings FILE|JSON          Extra settings on top of the usual files; --setting-sources user,project,local',
    '  --agents JSON                 Define subagents inline: {"name": {"description", "prompt", "tools"}}',
    '  --session-id UUID | --name NAME | --fork-session  Control how the session is saved or resumed',
    '  --input-format stream-json    Read user messages as JSON lines on stdin (with -p)',
    '  --include-partial-messages    Stream text deltas as stream_event lines (with stream-json)',
    '  --replay-user-messages        Echo user messages back in stream-json output',
    '  --betas NAME[,NAME]           Extra anthropic-beta headers (Anthropic API keys; also ANTHROPIC_BETAS)',
    '  --system-prompt-snapshot on|off  On resume, reuse the recorded system prompt (on) or rebuild it (off, default)',
    '  --ide                         Connect to a running IDE on startup',
    '  --ax-screen-reader            Plain, screen-reader friendly output (no colors or decoration)',
    '  --teammate-mode MODE          Agent-team display: auto (tmux panes when inside tmux), in-process, tmux',
    '  --tmux                        With -w, run the session in its own tmux session or window',
    '  --include-hook-events         Stream hook_started/hook_response events for every hook (stream-json)',
    '  --forward-subagent-text       Stream subagent text as assistant messages tagged parent_tool_use_id',
    '  --prompt-suggestions          Emit a prompt_suggestion line (predicted next prompt) after each turn',
    '  --exclude-dynamic-system-prompt-sections  Move cwd, env, git and memory context into the first user message (cache-friendly)',
    '  --permission-prompt-tool NAME Ask this MCP tool to approve actions in -p mode (stdio: control_request over stream-json)',
    '  --from-pr N                   Start with a GitHub pull request\'s description and diff as context',
    '  --init | --init-only          Create project instructions first (and exit with --init-only); runs Setup hooks',
    '  --maintenance                 Run Setup hooks with trigger "maintenance" before starting',
    '  --disable-slash-commands      Treat /text as a normal message (built-ins still work)',
    '  --verbose | --debug [cats]    More detail; --debug logs api,tools,hooks,mcp,permissions to <config>/debug/',
    '  --debug-file PATH             Write the debug log to PATH',
    '  --help, -h                    Show this help',
    '  --version                     Show the installed version',
    '',
    'Setup: use the verified installer in the official README; update with: oasis update',
    'Then:  oasis setup',
    'MCP:   oasis mcp add docs -- npx -y @modelcontextprotocol/server-filesystem /path/to/share',
    'Safety: enable { "sandbox": { "enabled": true } } in settings for OS isolation. Review approvals; --yes increases risk.',
    ''
  ].join('\n'));
}

// While a turn runs, keystrokes are captured: Esc or Ctrl+C interrupts, Enter
// steers (the agent reads the line at its next step without stopping), and Tab
// queues the line as the next message after the turn ends.
const QUEUED_INPUT = [];
let IDLE_SUBMIT = null;

function attachCron(session) {
  if (!session) return;
  const state = cronState(session);
  state.onFire = (prompt) => {
    if (AUTO_HALT) { (state.pending ||= []).push(prompt); return; }
    if (IDLE_SUBMIT && IDLE_SUBMIT(prompt)) return;
    QUEUED_INPUT.push(prompt);
  };
  if (!AUTO_HALT && state.pending && state.pending.length) QUEUED_INPUT.push(...state.pending.splice(0));
}
// Monitor events and finished background commands wake an idle session, like
// Claude Code interjecting when a Monitor event arrives.
const WAKE_KINDS = new Set(['monitor', 'monitor-end', 'background-exit', 'background-stuck', 'agent-notice', 'channel']);
const WAKE_PREFIX = '[background event] ';
function pendingWake(session) {
  return session && Array.isArray(session.inbox) ? session.inbox.filter((entry) => WAKE_KINDS.has(entry.kind)) : [];
}
// After a non-recoverable account error (auth failure, billing, quota, account
// on hold) automatic continuations would only fail again and, on some
// providers, keep burning quota. Loops, cron prompts and background wake-ups
// pause until the user sends a message.
let AUTO_HALT = null;
function haltAutoContinue(error) {
  const kind = stopFailureType(error);
  if (kind !== 'billing_error' && kind !== 'authentication_failed') return false;
  if (!AUTO_HALT) stdout.write('[auto] Paused loops, scheduled prompts and background wake-ups after a ' + (kind === 'billing_error' ? 'billing/quota' : 'authentication') + ' error. They resume when you send the next message (fix the account or run /provider first).\n');
  AUTO_HALT = { kind, at: Date.now() };
  return true;
}
function wakeIfPending(session) {
  if (AUTO_HALT) return false;
  const pending = pendingWake(session);
  if (!pending.length || !IDLE_SUBMIT) return false;
  const labels = [...new Set(pending.map((entry) => entry.label).filter(Boolean))];
  return IDLE_SUBMIT(WAKE_PREFIX + (labels.join(', ') || pending.length + ' new event(s)').slice(0, 160));
}
let channelSession = null;
function attachMonitors(session) {
  if (!session || session.monitorsAttached) return;
  session.monitorsAttached = true;
  channelSession = session;
  let timer = null;
  session.onBackgroundEvent = (event) => {
    const last = session.inbox && session.inbox[session.inbox.length - 1];
    if (last && event) last.label = event.description || (event.kind === 'background-exit' ? 'background command ' + event.id + ' finished' : event.id);
    if (timer) return;
    timer = setTimeout(() => { timer = null; wakeIfPending(session); }, 300);
    timer.unref?.();
  };
  if (process.env.OASIS_DISABLE_PLUGIN_MONITORS !== '1') {
    session.pluginMonitorsEnabled = true;
    const started = startPluginMonitorsFor(session, 'always', { root: session.root, env: process.env });
    if (started.length) stdout.write('[monitors] ' + started.length + ' plugin monitor(s) running (/tasks to see them).\n');
    for (const error of (session.settings && session.settings.pluginMonitorErrors) || []) stdout.write('[monitors] ' + error + '\n');
  }
}
let queuedDraft = '';
let turnKeys = null;
function startTurnKeys(onInterrupt, onSteer = null) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function' || process.env.OASIS_SIMPLE_INPUT === '1') return null;
  const decoder = new KeyDecoder();
  let buffer = '';
  let active = false;
  const dim = (text) => (colorEnabled(stdout) ? '\x1b[2m' + text + '\x1b[22m' : text);
  const onData = (chunk) => {
    for (const key of decoder.feed(chunk.toString('utf8'))) {
      if (key.name === 'escape') onInterrupt('escape');
      else if (key.name === 'ctrlC') onInterrupt('ctrlC');
      else if (key.name === 'char' || key.name === 'paste') buffer += key.text;
      else if (key.name === 'backspace') buffer = buffer.slice(0, -1);
      else if ((key.name === 'enter' || key.name === 'tab') && buffer.trim()) {
        const preview = buffer.replace(/\s+/g, ' ').slice(0, 90);
        if (key.name === 'enter' && onSteer && onSteer(buffer)) {
          stdout.write('\n' + dim('  ↳ sent: ' + preview + ' · Oasis reads it at the next step (Tab queues for after the turn)') + '\n');
        } else {
          QUEUED_INPUT.push(buffer);
          stdout.write('\n' + dim('  ↳ queued for after this turn: ' + preview) + '\n');
        }
        buffer = '';
      }
    }
  };
  const handle = {
    resume() { if (active) return; active = true; try { stdin.setRawMode(true); } catch {} stdin.setEncoding('utf8'); stdin.resume(); stdin.on('data', onData); },
    suspend() { if (!active) return; active = false; stdin.off('data', onData); try { stdin.setRawMode(false); } catch {} stdin.pause(); },
    stop() { handle.suspend(); if (buffer.trim()) queuedDraft = buffer; buffer = ''; }
  };
  handle.resume();
  return handle;
}

async function askLine(question, external = null) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('This action needs an interactive terminal. Re-run it from a terminal session.');
  const paused = turnKeys;
  if (paused) paused.suspend();
  try { return await askLineRaw(question, external); } finally { if (paused && turnKeys === paused) paused.resume(); }
}

async function askLineRaw(question, external = null) {
  const rl = createInterface({ input: stdin, output: stdout });
  // Readline swallows Ctrl+C; forward it so a running task can be interrupted.
  const controller = new AbortController();
  if (external) { if (external.aborted) controller.abort(); else external.addEventListener('abort', () => controller.abort(), { once: true }); }
  rl.on('SIGINT', () => { controller.abort(); if (process.listenerCount('SIGINT')) process.emit('SIGINT'); });
  try { return await rl.question(question, { signal: controller.signal }); } finally { rl.close(); }
}

async function askQuestionInTerminal(question) {
  playSound('attention', { stream: stdout });
  const lines = ['', '[question] ' + (question.header ? question.header + ': ' : '') + question.question];
  question.options.forEach((option, index) => lines.push('  ' + (index + 1) + '. ' + option.label + (option.description ? ' - ' + option.description : '')));
  lines.push('  (' + (question.multiSelect ? 'numbers separated by spaces' : 'a number') + ', or type your own answer; Enter to skip)');
  stdout.write(lines.join('\n') + '\n');
  try { return resolveQuestionAnswer(question, await askLine('Answer> ')); } catch { return ''; }
}

async function askSecret(question) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Hidden API-key entry needs a real terminal. Set OASIS_API_KEY in the environment instead.');
  }
  return await new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let value = '';
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      stdin.off('data', onData);
      try { stdin.setRawMode(Boolean(wasRaw)); } catch {}
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (data) => {
      const text = data.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Setup cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ' && char !== '\u007f') {
          value += char;
          stdout.write('*');
        }
      }
    };
    stdout.write(question);
    try { stdin.setRawMode(true); } catch (error) { cleanup(); reject(error); return; }
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

// Hardware-aware setup: detect this computer and its local model servers, then
// save the best working route. Only a route that answers a real test request is
// saved; anything else prints the recommendation and the next step.
async function autoSetup(root, { dryRun = false } = {}) {
  const { profileThisComputer, describeRecommendation } = await import('./hardware.mjs');
  stdout.write('\nOASIS automatic setup — checking this computer…\n');
  let current = null;
  try { current = await loadConfig(); } catch {}
  const rec = await profileThisComputer({ configured: Boolean(current && current.configured) });
  stdout.write(describeRecommendation(rec) + '\n');
  const primary = rec.primary;
  if (primary.route !== 'local') {
    stdout.write(primary.route === 'local-install'
      ? '\nInstall Ollama and pull the model above, then run oasis setup --auto again.\n'
      : '\nRun oasis setup to connect a hosted model with an API key.\n');
    return rec;
  }
  if (dryRun) { stdout.write('\n--dry-run: nothing was saved.\n'); return rec; }
  const candidate = { protocol: primary.protocol, baseURL: primary.baseURL, model: primary.model, apiKey: '', ...(rec.settings.contextWindow ? { contextWindow: rec.settings.contextWindow } : {}) };
  stdout.write('\nTesting ' + primary.serverName + ' with ' + primary.model + ' (local models can take a minute to load)…\n');
  try {
    await testProviderConnection(candidate, { timeoutMs: 180000 });
  } catch (error) {
    stdout.write('The test request failed: ' + (error && error.message || error) + '\nNothing was saved. Check the server, then run oasis setup --auto again, or run oasis setup to choose manually.\n');
    process.exitCode = 1;
    return rec;
  }
  const configPath = await saveConfig(candidate);
  stdout.write('Saved: ' + primary.model + ' via ' + primary.serverName + (candidate.contextWindow ? ' (context window ' + candidate.contextWindow + ' tokens)' : '') + ' → ' + configPath + '\nNext: run oasis in a project folder, or oasis web --open.\n');
  return rec;
}

async function configureProvider(root = process.cwd(), options = {}) {
  stdout.write('\nOasis setup — choose and verify your model provider\n');
  stdout.write('A successful model response is required before settings are saved or coding tools are used. Presets include OpenAI, Anthropic, OpenRouter, Gemini, local Ollama, AWS Bedrock, Google Vertex AI, and Microsoft Foundry.\n');
  const rl = createInterface({ input: stdin, output: stdout });
  let protocol, baseURL, model, presetName;
  const presets = {
    openai: { protocol: 'openai-responses', baseURL: DEFAULT_BASE_URL, model: DEFAULT_MODEL },
    anthropic: { protocol: 'anthropic', baseURL: DEFAULT_ANTHROPIC_BASE_URL, model: 'claude-sonnet-5' },
    openrouter: { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: '' },
    gemini: { protocol: 'openai-compatible', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash' },
    ollama: { protocol: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: '' },
    bedrock: { protocol: 'bedrock', baseURL: defaultCloudBaseURL('bedrock', process.env), model: process.env.ANTHROPIC_MODEL || '' },
    vertex: { protocol: 'vertex', baseURL: defaultCloudBaseURL('vertex', process.env), model: process.env.ANTHROPIC_MODEL || '' },
    foundry: { protocol: 'foundry', baseURL: (() => { try { return defaultCloudBaseURL('foundry', process.env); } catch { return ''; } })() || 'https://RESOURCE.services.ai.azure.com/anthropic', model: process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '' }
  };
  const chooseApiPreset = async (preferredPreset) => {
    stdout.write('\nChoose your API-key provider:\n');
    stdout.write('  1. OpenAI\n  2. Anthropic\n  3. OpenRouter\n  4. Gemini\n  5. Other / compatible endpoint\n');
    const preferred = ({ openai: '1', anthropic: '2', openrouter: '3', gemini: '4', custom: '5' })[preferredPreset] || '1';
    const answer = (await rl.question('Choose [1/2/3/4/5] (default ' + preferred + '): ')).trim().toLowerCase() || preferred;
    const providers = { '1': 'openai', '2': 'anthropic', '3': 'openrouter', '4': 'gemini', '5': 'custom' };
    const selected = providers[answer] || (['openai', 'anthropic', 'openrouter', 'gemini', 'custom'].includes(answer) ? answer : '');
    if (!selected) throw new Error('Choose a number from 1 to 5 for the API-key provider.');
    return selected;
  };
  try {
    const currentConfig = options.defaultPreset === undefined
      ? await loadConfig().catch(() => null)
      : null;
    const defaultPreset = options.defaultPreset === undefined
      ? inferSetupProviderPreset(currentConfig)
      : resolveSetupProviderPreset(options.defaultPreset);
    if (options.skipPresetPrompt) {
      presetName = options.chooseKeyProvider ? await chooseApiPreset(defaultPreset) : defaultPreset;
    } else {
      stdout.write('\nChoose how you want to connect OASIS:\n');
      stdout.write('  1. I have an API key\n');
      stdout.write('  2. Use a model on this computer (Ollama)\n');
      stdout.write('  3. Advanced provider or custom endpoint\n');
      const defaultChoice = defaultPreset === 'ollama' ? '2'
        : ['bedrock', 'vertex', 'foundry', 'custom'].includes(defaultPreset) ? '3' : '1';
      const answer = (await rl.question('Choose [1/2/3] (default ' + defaultChoice + '): ')).trim().toLowerCase() || defaultChoice;
      const directPresets = ['openai', 'anthropic', 'openrouter', 'gemini', 'ollama', 'bedrock', 'vertex', 'foundry', 'custom'];
      if (directPresets.includes(answer)) {
        // Keep accepting named presets for existing scripts and experienced users.
        presetName = answer;
      } else if (answer === '2') {
        presetName = 'ollama';
      } else if (answer === '1') {
        presetName = await chooseApiPreset(defaultPreset);
      } else if (answer === '3') {
        stdout.write('\nChoose an advanced provider:\n');
        stdout.write('  1. AWS Bedrock\n  2. Google Vertex AI\n  3. Microsoft Foundry\n  4. Custom / compatible endpoint\n');
        const advancedDefault = ({ bedrock: '1', vertex: '2', foundry: '3', custom: '4' })[defaultPreset] || '4';
        const advancedAnswer = (await rl.question('Choose [1/2/3/4] (default ' + advancedDefault + '): ')).trim().toLowerCase() || advancedDefault;
        const advancedProviders = { '1': 'bedrock', '2': 'vertex', '3': 'foundry', '4': 'custom' };
        presetName = advancedProviders[advancedAnswer] || (['bedrock', 'vertex', 'foundry', 'custom'].includes(advancedAnswer) ? advancedAnswer : '');
        if (!presetName) throw new Error('Choose a number from 1 to 4 for the advanced provider.');
      } else {
        throw new Error('Choose 1, 2, or 3. No provider settings were changed.');
      }
    }
    if (shouldPromptForProviderBaseURL(presetName)) {
      protocol = validateProtocol((await rl.question('Protocol [openai-responses / anthropic / openai-compatible / bedrock / vertex / foundry] (default openai-responses): ')).trim().toLowerCase() || 'openai-responses');
      const defaultBase = protocol === 'bedrock' || protocol === 'vertex' || protocol === 'foundry' ? defaultCloudBaseURL(protocol, process.env) : protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
      baseURL = (await rl.question('Base URL [' + defaultBase + ']: ')).trim() || defaultBase;
      const defaultModel = protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : '');
      const modelPrompt = defaultModel ? 'Model name [' + defaultModel + ']: ' : 'Model name (exact model ID required): ';
      model = (await rl.question(modelPrompt)).trim() || defaultModel;
    } else {
      const selected = presets[presetName];
      if (!selected) throw new Error('Unknown provider preset. Choose openai, anthropic, openrouter, gemini, ollama, bedrock, vertex, foundry, or custom.');
      protocol = selected.protocol;
      baseURL = selected.baseURL;
      model = selected.model;
      if (presetName === 'ollama') {
        let detected = await discoverLocalOllamaModels();
        if (detected.available && detected.models.length) {
          stdout.write('Ollama is running. Installed models: ' + detected.models.join(', ') + '\n');
          model = detected.models[0];
        } else {
          // Keep the setup flow alive so a beginner can install/start Ollama in
          // another terminal and retry instead of being forced to guess an ID.
          while (!detected.available || !detected.models.length) {
            stdout.write(detected.message + '\n');
            stdout.write('Install/start Ollama from https://ollama.com/download. If it is running but has no model, use another terminal to run: ollama pull <model-name>\n');
            const answer = (await rl.question('Enter a model ID to continue, press Enter to check again, or type later to stop: ')).trim();
            if (/^(?:later|skip|cancel)$/i.test(answer)) {
              throw new Error('Local model setup was stopped. No provider settings were changed. Install and start Ollama, then run oasis setup again.');
            }
            if (answer) {
              model = answer;
              break;
            }
            detected = await discoverLocalOllamaModels();
          }
          if (detected.available && detected.models.length) {
            stdout.write('Ollama is running. Installed models: ' + detected.models.join(', ') + '\n');
            model = detected.models[0];
          }
        }
      }
      stdout.write('Using the standard ' + presetName + ' endpoint. To use a different URL, choose Advanced > Custom.\n');
      const modelPrompt = model ? 'Model name [' + model + ']: ' : 'Model name (exact model ID required, after installing a model): ';
      model = (await rl.question(modelPrompt)).trim() || model;
    }
    if (!model) throw new Error('Enter the exact model name supported by this provider before continuing.');
  } finally { rl.close(); }
  protocol = validateProtocol(protocol);
  baseURL = validateBaseUrl(baseURL);
  const existing = await loadConfig().catch(() => ({ apiKey: '', baseURL: '', protocol: '' }));
  let apiKey = '';
  const localEndpoint = isLoopbackUrl(baseURL);
  if (protocol === 'foundry') {
    stdout.write('Microsoft Foundry uses ANTHROPIC_FOUNDRY_AUTH_TOKEN, or an API key, or az login (Entra ID). Enter the model deployment name as the model.\n');
    apiKey = await askSecret('Foundry API key (input hidden; leave empty to use az login or ANTHROPIC_FOUNDRY_AUTH_TOKEN): ');
    if (!apiKey) apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY || '';
  } else if (protocol === 'bedrock' || protocol === 'vertex') {
    stdout.write(protocol === 'bedrock'
      ? 'Bedrock uses AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or AWS_PROFILE. Region: ' + (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1') + '.\n'
      : 'Vertex uses GOOGLE_OAUTH_ACCESS_TOKEN or gcloud auth print-access-token. Project: ' + (process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '(set ANTHROPIC_VERTEX_PROJECT_ID)') + '.\n');
  } else if (!localEndpoint || presetName === 'custom') {
    const label = localEndpoint ? 'Optional local endpoint key' : (protocol === 'anthropic' ? 'ANTHROPIC API key' : 'API key');
    apiKey = await askSecret(label + ' (input hidden; Enter keeps a key only if the endpoint is unchanged, otherwise use a matching environment variable): ');
    if (!apiKey && existing.baseURL === baseURL && existing.protocol === protocol) apiKey = existing.apiKey || '';
    if (localEndpoint) {
      if (!apiKey) apiKey = process.env.OASIS_LOCAL_API_KEY || '';
    } else {
      const host = new URL(baseURL).hostname.toLowerCase();
      const providerEnvKey = host === 'openrouter.ai' ? process.env.OPENROUTER_API_KEY :
        (host === 'generativelanguage.googleapis.com' ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) :
        (host === 'ollama.com' ? process.env.OLLAMA_API_KEY : ''));
      if (!apiKey) apiKey = process.env.OASIS_API_KEY || providerEnvKey || (protocol === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || '';
    }
  }
  stdout.write('\nTesting tool calling with an inert validation probe (the probe will not be executed)...\n');
  await testProviderConnection({ protocol, baseURL, model, apiKey }, { timeoutMs: 30000 });
  const configPath = await saveConfig({ protocol, baseURL, model, apiKey });
  stdout.write('Provider responded successfully. Saved settings to ' + configPath + '\n');
  stdout.write('Protocol: ' + protocol + '\n');
  stdout.write('Authentication: ' + (apiKey ? 'configured' : (isLoopbackUrl(baseURL) ? 'local endpoint; no API key required' : 'not configured')) + '\n');
  stdout.write('The provider is verified. Oasis can now inspect workspaces and use approved tools.\n');
}
// Paste-to-connect in the terminal: the same smart connect the app uses. Works
// out the provider from a key, model link or local server address, picks the
// best tool-calling model, keeps the next ones as automatic backups and saves.
async function connectFromTerminalPaste(text) {
  const { connectFromPaste } = await import('./provider-connect.mjs');
  let last = '';
  const result = await connectFromPaste(text, {
    onStatus: (status) => {
      const line = String(status && status.text || status || '').trim();
      if (!line || line === last || status && status.step === 'download' && last.startsWith(line.split(' — ')[0])) { if (status && status.step === 'download') last = line; return; }
      last = line;
      stdout.write('  ' + line + '\n');
    }
  });
  const configPath = await saveConfig(result.config);
  const backups = result.config.fallbackModel ? result.config.fallbackModel.split(',').filter(Boolean) : [];
  stdout.write('Locked in ' + result.config.model + ' on ' + result.label + '.' + (backups.length ? ' ' + backups.length + ' backup model' + (backups.length === 1 ? '' : 's') + ' ready if it runs out.' : '') + '\n');
  stdout.write('Saved to ' + configPath + (result.masked ? ' (key ' + result.masked + ')' : '') + '.\n');
  if (result.githubToken) stdout.write('A GitHub token was in the paste too. It was not saved; OASIS uses your git login for GitHub.\n');
  return result;
}

async function pasteFirstSetup(root, { announce = true } = {}) {
  if (announce) {
    stdout.write('\nConnect a model. Paste an API key (OpenAI, Anthropic, OpenRouter, Gemini, Groq, Hugging Face and more),\n');
    stdout.write('a model link, or a local server address like http://localhost:11434. OASIS works out the rest.\n');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let text;
    try { text = (await askSecret('Paste here (hidden; Enter for other options, "later" to skip): ')).trim(); }
    catch (error) { if (/cancel/i.test(String(error && error.message))) return 'skipped'; return 'menu'; }
    if (!text) return 'menu';
    if (/^(?:later|skip|q|quit|exit|\/exit|\/quit|n|no)$/i.test(text)) { stdout.write('Setup skipped. Run oasis connect when you are ready.\n'); return 'skipped'; }
    try {
      await connectFromTerminalPaste(text);
      return 'connected';
    } catch (error) {
      stdout.write('Could not connect: ' + redactSecretText(String(error && error.message || error), text) + '\n');
      if (attempt < 2) stdout.write('Try again, or press Enter for other options.\n');
    }
  }
  return 'menu';
}

function redactSecretText(message, secret) {
  let out = message;
  for (const part of String(secret || '').split(/\s+/)) if (part.length >= 12) out = out.split(part).join('[redacted]');
  return out.slice(0, 1200);
}

const CONNECT_USAGE = [
  'Usage: oasis connect [KEY | MODEL LINK | SERVER ADDRESS]',
  '       oasis connect --from-env [PROVIDER]',
  '',
  'Paste an API key, a model page link (Hugging Face, OpenRouter, Ollama) or a',
  'local server address. OASIS works out the provider, lists its models, tests',
  'the best ones with a real tool call and saves the first that works, plus',
  'backups for when it runs out of credit.',
  '',
  'With nothing after it, OASIS asks for the paste so the key stays out of your',
  'shell history. --from-env uses a key already in the environment, such as',
  'GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY or OPENAI_API_KEY.'
].join('\n') + '\n';

// Cloud provider keys already exported in the shell, in FALLBACK_PROVIDERS order.
function providerKeysInEnv(env = process.env) {
  const found = [];
  for (const [provider, entry] of Object.entries(FALLBACK_PROVIDERS)) {
    for (const name of entry.keyEnv || []) {
      const value = String(env[name] || '').trim();
      if (value && !found.some((item) => item.value === value)) { found.push({ provider, name, value }); break; }
    }
  }
  return found;
}

async function connectFromEnvironment(wanted = '') {
  const keys = providerKeysInEnv();
  const pick = wanted ? keys.find((item) => item.provider === wanted.toLowerCase() || item.name === wanted.toUpperCase()) : keys[0];
  if (!pick) {
    throw new Error(wanted
      ? 'No key for ' + wanted + ' in the environment. Known variables: ' + Object.values(FALLBACK_PROVIDERS).flatMap((entry) => entry.keyEnv).join(', ') + '.'
      : 'No provider API key found in the environment (looked for ' + Object.values(FALLBACK_PROVIDERS).flatMap((entry) => entry.keyEnv).join(', ') + ').');
  }
  if (keys.length > 1 && !wanted) stdout.write('Found keys for ' + keys.map((item) => item.provider).join(', ') + '; using ' + pick.name + ' (pass a provider name to choose).\n');
  else stdout.write('Using ' + pick.name + ' from the environment.\n');
  await connectFromTerminalPaste(pick.value);
}

async function connectCommand(rest, root) {
  if (['--help', '-h', 'help'].includes(rest[0])) { stdout.write(CONNECT_USAGE); return; }
  if (rest[0] === '--from-env') { await connectFromEnvironment(rest[1] || ''); return; }
  const inline = rest.join(' ').trim();
  if (inline) {
    await connectFromTerminalPaste(inline);
    stdout.write('Tip: paste at the prompt next time (run oasis connect with nothing after it) so the key stays out of your shell history.\n');
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    const piped = Buffer.concat(chunks).toString('utf8').trim();
    if (!piped && providerKeysInEnv().length) { await connectFromEnvironment(); return; }
    if (!piped) throw new Error('Usage: oasis connect, then paste a model API key, a model link or a local server address (or run oasis connect --help).');
    await connectFromTerminalPaste(piped);
    return;
  }
  const outcome = await pasteFirstSetup(root);
  if (outcome === 'menu') await configureProvider(root);
}

async function ensureModelProviderSetup(root, options = {}) {
  let configured = false;
  try { configured = Boolean((await loadConfig()).configured); } catch {}
  if (configured) return true;
  if (!stdin.isTTY || !stdout.isTTY) return false;

  if (options.announce !== false) stdout.write('\nNo model is connected yet.\n');
  if (typeof stdin.setRawMode === 'function') {
    const outcome = await pasteFirstSetup(root);
    if (outcome === 'connected') return true;
    if (outcome === 'skipped') return false;
  }
  stdout.write('\n  1. I have an API key (OpenAI, Anthropic, OpenRouter, Gemini, or a custom provider)\n');
  stdout.write('  2. Use a model on this computer (Ollama; smaller models may be weaker)\n');
  stdout.write('  3. Set this up later\n');
  const choices = { '1': 'openai', '2': 'ollama' };
  let preset = null;
  for (let attempt = 0; attempt < 3 && !preset; attempt++) {
    let answer;
    try { answer = (await askLine('Choose [1/2/3] (default 1): ')).trim().toLowerCase() || '1'; }
    catch { return false; }
    if (['3', 'later', 'n', 'no', 'skip', 'q', 'quit', 'exit', '/exit', '/quit'].includes(answer)) {
      stdout.write('Setup skipped. Run oasis setup when you are ready.\n');
      return false;
    }
    preset = choices[answer] || null;
    if (!preset) stdout.write(attempt < 2 ? 'Type 1, 2 or 3 and press Enter (3 sets this up later).\n' : 'No setup was run. Run oasis setup when you are ready.\n');
  }
  if (!preset) return false;
  try {
    await configureProvider(root, { defaultPreset: preset, skipPresetPrompt: true, chooseKeyProvider: preset === 'openai' });
  } catch (error) {
    stdout.write('Guided setup did not complete: ' + String(error && error.message || error) + '. Nothing new was saved unless the provider test succeeded. Run oasis setup to try again.\n');
  }
  try { return Boolean((await loadConfig()).configured); } catch { return false; }
}

async function doctor(args = [], root = process.cwd()) {
  if (args.includes('--network') || args.includes('--network-only')) {
    const { runNetworkDoctor, formatNetworkReport } = await import('./network-doctor.mjs');
    const { loadProjectMcpServers } = await import('./mcp-project.mjs');
    let config = {};
    try { config = await loadConfig(); } catch {}
    const { servers } = await loadProjectMcpServers(root).catch(() => ({ servers: [] }));
    const results = await runNetworkDoctor({ config, mcpServers: servers });
    stdout.write(formatNetworkReport(results));
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  // Plain summary first; the full environment list follows under Details.
  const details = [];
  const detail = (line) => { details.push(line); };
  detail('Environment details\n');
  detail('  OS / architecture: ' + process.platform + ' / ' + process.arch + '\n');
  detail('  Node.js: ' + process.version + (isNodeVersionSupported() ? ' (supported)' : ' (requires Node.js 22+)') + '\n');
  try {
    const { detectHardware, describeHardware, modelMemoryBudget, localModelTier } = await import('./hardware.mjs');
    const hw = await detectHardware();
    const tier = localModelTier(modelMemoryBudget(hw));
    detail('  Hardware: ' + describeHardware(hw) + '\n');
    detail('  Local model fit: ' + (tier ? 'up to ' + tier.model + ' (about ' + modelMemoryBudget(hw) + ' GB usable); run oasis setup --auto' : 'too little memory for a useful local model; use a hosted model') + '\n');
  } catch {}
  const probes = ['git', 'npm', 'python3', 'python', 'pipx', 'pkg', 'apt-get', 'dnf', 'pacman', 'brew', 'winget', 'ollama'];
  const nodeOK = isNodeVersionSupported();
  const gitOK = commandAvailable('git');
  let modelConfigured = false;
  const statusLabel = (ok) => colorEnabled(stdout)
    ? (ok ? '\x1b[32mOK\x1b[0m' : '\x1b[31mCHECK\x1b[0m')
    : (ok ? 'OK' : 'CHECK');
  for (const item of probes) detail('  ' + item + ': ' + (commandAvailable(item) ? 'available' : 'not found') + '\n');
  try {
    const config = await loadConfig();
    modelConfigured = Boolean(config.configured);
    const summary = getProviderSummary(config);
    detail('  Model provider: ' + (modelConfigured ? summary.provider + ' (' + summary.protocol + ')' : 'not set yet — run oasis setup') + '\n');
    detail('  Model: ' + (modelConfigured ? summary.model : 'not set yet') + '\n');
    detail('  Authentication: ' + summary.authentication + '\n');
    detail('  Config: ' + summary.configPath + '\n');
    try {
      const { parseFallbackChain, describeFallbackChain } = await import('./fallback-chain.mjs');
      const loaded = await loadSettings(root).catch(() => ({}));
      const chain = parseFallbackChain(SESSION_OPTIONS.fallbackModel || (loaded && loaded.fallbackModel) || '');
      detail('  Fallback models: ' + (chain.length ? describeFallbackChain(chain, config).map((item) => item.id + (item.usable ? '' : ' (skipped: set ' + item.missing + ')')).join(', ') : 'none (--fallback-model or fallbackModel in settings)') + '\n');
    } catch {}
    const proxyNote = currentProxy();
    detail('  Network proxy: ' + (proxyNote ? proxyNote + ((process.env.NO_PROXY || process.env.no_proxy) ? ' (NO_PROXY: ' + (process.env.NO_PROXY || process.env.no_proxy) + ')' : '') : 'none (set HTTPS_PROXY to use one)') + (process.env.NODE_EXTRA_CA_CERTS ? '; extra CA certificates: ' + process.env.NODE_EXTRA_CA_CERTS : '') + '\n');
    if (modelConfigured && isLoopbackUrl(config.baseURL)) await doctorLocalServer(config, detail);
    if (args.includes('--test-provider')) {
      detail('Checking the model connection (up to 30 seconds)…\n');
      try {
        const result = await testProviderConnection(config, { timeoutMs: 30000 });
        detail('  Live model/tool-call verification: passed (' + result.provider + ' / ' + result.model + ')\n');
      } catch (error) {
        detail('  Live model/tool-call verification: FAILED — ' + String(error && error.message || error) + '\n');
        process.exitCode = 1;
      }
    } else {
      detail('  Live model/tool-call verification: not run (use oasis doctor --test-provider; oasis doctor --network checks connectivity)\n');
    }
  } catch (error) {
    detail('  Provider config: invalid (' + error.message + ')\n');
    if (args.includes('--test-provider')) process.exitCode = 1;
  }
  const ptyAvailable = await import('node-pty').then(() => true).catch(() => false);
  stdout.write('OASIS check\n');
  stdout.write('  Node.js 22+: ' + statusLabel(nodeOK) + '\n');
  stdout.write('  Git: ' + (gitOK ? 'available (optional)' : 'not found (optional)') + '\n');
  stdout.write('  Model connection: ' + (modelConfigured ? statusLabel(true) : statusLabel(false) + ' — run oasis setup') + '\n');
  stdout.write('  Native terminal panel (PTY): ' + (ptyAvailable ? 'available' : 'not available (optional native component)') + '\n');
  const nextStep = !nodeOK ? 'install Node.js 22 or newer, then run oasis doctor again.'
    : !modelConfigured ? 'run oasis setup to connect a model.'
    : 'run oasis in a project folder, or oasis web --open for the browser workspace.';
  stdout.write('\nNext step: ' + nextStep + '\n\n');
  stdout.write(details.join(''));
  await doctorWorkspaceReport(root, { modelConfigured, nodeOK });
}

// Workspace-level checks: tools Oasis relies on, settings/trust, sandbox, MCP,
// memory and extension files. Problems are listed with a suggested fix.
async function updateOasis(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write([
      'Usage: oasis update [--check] [--yes]',
      '',
      'Installs the latest stable OASIS release for this CLI install (git checkout or npm).',
      '  --check   Show the installed and latest versions without changing anything.',
      '  --yes     Install without asking first.',
      '',
      'The desktop app updates itself: it offers new versions and installs them after',
      'checking SHA256SUMS. Set OASIS_NO_UPDATE_CHECK=1 to turn off update notices.',
      'If GitHub rate-limits the API, OASIS reads the release from github.com instead;',
      'setting GH_TOKEN or GITHUB_TOKEN raises the API limit.'
    ].join('\n') + '\n');
    return;
  }
  const unknown = args.filter((arg) => !['--check', '--yes', '-y'].includes(arg));
  if (unknown.length) {
    stderr.write('Unknown option for oasis update: ' + unknown.join(' ') + '. Run oasis update --help.\n');
    process.exitCode = 2;
    return;
  }
  const { latestReleaseCommit, installedVersion, updatePlan, describeUpdate } = await import('./update.mjs');
  const checkOnly = args.includes('--check');
  const yes = args.includes('--yes') || args.includes('-y');
  const nodeModules = path.dirname(APP_ROOT);
  let npmPrefix = null;
  if (path.basename(nodeModules) === 'node_modules') {
    const parent = path.dirname(nodeModules);
    npmPrefix = path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
  }
  const [installed, latest] = await Promise.all([
    installedVersion(APP_ROOT, { npmPrefix }),
    latestReleaseCommit()
  ]);
  const plan = updatePlan(installed, latest);
  stdout.write(describeUpdate(installed, latest, plan) + '\n');
  if (plan.upToDate || plan.blocked || checkOnly) { if (plan.blocked) process.exitCode = 1; return; }
  if (!yes) {
    const answer = (await askLine('Install the update now? [y/N] ')).trim().toLowerCase();
    if (!['y', 'yes'].includes(answer)) { stdout.write('Update skipped.\n'); return; }
  }
  const { spawnSync } = await import('node:child_process');
  for (const step of plan.steps || []) {
    const result = spawnSync(step.command, step.args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) {
      stderr.write('The update command failed (exit ' + result.status + ').\n');
      process.exitCode = 1;
      return;
    }
  }
  stdout.write('Oasis updated to ' + latest.tag + ' (' + latest.sha.slice(0, 7) + '). Restart any running oasis sessions.\n');
}


async function uninstallOasis(args = []) {
  const yes = args.includes('--yes') || args.includes('-y');
  if (args.some((arg) => !['--yes', '-y'].includes(arg))) {
    throw new Error('Usage: oasis uninstall [--yes]');
  }
  const { isHomebrewInstall } = await import('./update.mjs');
  if (isHomebrewInstall(APP_ROOT)) {
    stdout.write('OASIS was installed with Homebrew. Remove it with: brew uninstall oasis-cli\nYour projects, OASIS settings, saved sessions, memory and API keys are kept either way. Nothing was removed.\n');
    process.exitCode = 1;
    return;
  }
  const packageFile = path.join(APP_ROOT, 'package.json');
  const { readFile } = await import('node:fs/promises');
  const installedPackage = JSON.parse(await readFile(packageFile, 'utf8'));
  const uninstall = resolveUninstallPlan(APP_ROOT, installedPackage);
  const { packageName, prefix } = uninstall;
  stdout.write('OASIS uninstall plan\n');
  stdout.write('  Package: ' + packageName + '\n');
  stdout.write('  Install prefix: ' + prefix + '\n');
  stdout.write('  Will remove: ' + APP_ROOT + ' and the npm command links for OASIS.\n');
  stdout.write('  Will keep: your projects, OASIS settings, saved sessions, memory, and API keys.\n');
  if (!yes) {
    const answer = (await askLine('Remove the OASIS CLI now? [y/N] ')).trim().toLowerCase();
    if (!['y', 'yes'].includes(answer)) {
      stdout.write('Uninstall cancelled. Nothing was removed.\n');
      return;
    }
  } else {
    stdout.write('Uninstall approved by --yes.\n');
  }
  if (!commandAvailable('npm')) throw new Error('npm was not found. Nothing was removed.');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('npm', uninstall.args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    stderr.write('npm could not complete the uninstall. Your project and OASIS user data were not targeted.\n');
    process.exitCode = result.status || 1;
    return;
  }
  stdout.write('OASIS CLI has been uninstalled. Your projects and user data were kept.\n');
}

// Local servers: which one, its loaded window, and the tool profile OASIS will use.
// doctor is user-invoked, so it may probe any loopback port.
async function doctorLocalServer(config, write = (line) => stdout.write(line)) {
  try {
    const probe = await probeLocalContext(config, { env: { ...process.env, OASIS_LOCAL_CONTEXT_PROBE: '1' }, cache: false });
    const names = { ollama: 'Ollama', lmstudio: 'LM Studio', 'llama.cpp': 'llama-server' };
    if (!probe || !probe.contextLength) {
      write('  Local model server: no context window reported (the server is not running, or it does not publish one; set contextWindow in config if replies get cut off)\n');
      return;
    }
    const window = Number(probe.contextLength);
    const server = names[probe.server] || 'local server';
    write('  Local model server: ' + server + ', ' + window.toLocaleString('en-US') + '-token context window\n');
    write('  Tool profile for this window: ' + (window <= SMALL_CONTEXT_TOKENS
      ? 'small (essential tools up front, the rest behind tool_search) because the window is ' + SMALL_CONTEXT_TOKENS.toLocaleString('en-US') + ' tokens or less'
      : 'full') + '\n');
    if (!isLocalModelEndpoint(config, process.env)) write('  Note: OASIS reads this window during work only on default ports (Ollama 11434, LM Studio 1234, llama-server 8080). Set OASIS_LOCAL_CONTEXT_PROBE=1 for this server; otherwise the first request may overflow once and then resize itself.\n');
    if (window < RECOMMENDED_LOCAL_CONTEXT) write('  Advice: ' + localContextAdvice(config.model, window, probe.server) + '\n');
  } catch (error) {
    write('  Local model server: not reachable (' + String(error && error.message || error).slice(0, 160) + ')\n');
  }
}

async function doctorWorkspaceReport(root, status = {}) {
  const problems = [];
  stdout.write('\nTools\n');
  const rg = commandAvailable('rg');
  stdout.write('  ripgrep (rg): ' + (rg ? 'available (fast grep)' : 'not found (grep uses a slower built-in search)') + '\n');
  stdout.write('  gh: ' + (commandAvailable('gh') ? 'available (/review can read pull requests)' : 'not found (/review PR-number needs the GitHub CLI)') + '\n');
  const search = process.env.OASIS_WEB_SEARCH === 'off' ? 'off' : searchBackend(process.env);
  stdout.write('  Web search: ' + search + (search === 'duckduckgo' ? ' (no key; set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for more reliable results)' : '') + '\n');
  // Loaded here only: QuickJS is optional and never touched at startup.
  const { workflowRuntimeStatus } = await import('./workflow-sandbox.mjs');
  const workflow = await workflowRuntimeStatus();
  stdout.write('  Workflow runtime: ' + (workflow.available
    ? 'available (QuickJS; saved JavaScript workflows can run)'
    : (/need quickjs-emscripten/i.test(workflow.reason || '') ? 'not installed' : 'unavailable: ' + workflow.reason) + ' (only needed for saved JavaScript workflows; run npm install in ' + APP_ROOT + ' or reinstall OASIS)') + '\n');
  stdout.write('\nWorkspace: ' + root + '\n');
  let settings = null;
  try {
    settings = await loadSettings(root);
    stdout.write('  Trusted: ' + (settings.trusted ? 'yes' : 'no (project allow rules, hooks, .mcp.json servers, and status line are ignored; run oasis trust after reviewing them)') + '\n');
    stdout.write('  Settings files: ' + (settings.sources.length ? settings.sources.map((item) => item.scope + ' ' + item.file).join(', ') : 'none') + '\n');
    stdout.write('  Permission mode: ' + settings.permissions.defaultMode + '; rules: ' + settings.permissions.allow.length + ' allow, ' + settings.permissions.ask.length + ' ask, ' + settings.permissions.deny.length + ' deny\n');
    const hookCount = Object.values(settings.hooks || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    stdout.write('  Hooks: ' + hookCount + '\n');
    if (settings.ignoredUntrusted.length) problems.push('Untrusted workspace settings were ignored: ' + settings.ignoredUntrusted.join(', ') + '. Run oasis trust if you want them.');
  } catch (error) {
    stdout.write('  Settings: invalid (' + error.message + ')\n');
    problems.push('Fix the settings file: ' + error.message);
  }
  const sandbox = detectSandbox();
  const sandboxOn = Boolean(settings && settings.sandbox && settings.sandbox.enabled);
  stdout.write('  OS sandbox: ' + (sandbox.available ? sandbox.kind + ' available' : 'unavailable — ' + sandbox.reason) + '; ' + (sandboxOn ? 'enabled' : 'off (enable with "sandbox": {"enabled": true} or OASIS_SANDBOX=1)') + '\n');
  if (sandboxOn && !sandbox.available) problems.push('The sandbox is enabled but unavailable: ' + sandbox.reason);
  stdout.write('  User MCP config: ' + getMcpConfigPath() + '\n');
  try {
    const project = await loadProjectMcpServers(root, { env: process.env });
    if (project.file || project.failures.length) stdout.write('  Project .mcp.json: ' + project.servers.length + ' usable server(s)' + (project.failures.length ? ', ' + project.failures.length + ' with problems' : '') + '\n');
    for (const failure of project.failures) problems.push('.mcp.json server ' + failure.name + ': ' + failure.error);
  } catch (error) { problems.push('.mcp.json: ' + error.message); }
  const memory = await memoryFiles(root).catch(() => []);
  const present = memory.filter((file) => file.exists);
  stdout.write('  Memory files: ' + (present.length ? present.map((file) => file.label + ' ' + file.path).join(', ') : 'none (run /init to create OASIS.md)') + '\n');
  const [commands, agents, styles] = await Promise.all([
    loadCustomCommands(root).catch(() => new Map()),
    loadAgentDefinitions(root).catch(() => ({})),
    loadOutputStyles(root).catch(() => ({}))
  ]);
  stdout.write('  Custom commands: ' + commands.size + '; agents: ' + Object.keys(agents).length + '; output styles: ' + Object.keys(styles).length + '\n');
  if (!commandAvailable('git')) problems.push('git is not installed; checkpoints still work, but git context and /review do not.');
  const pending = status.nodeOK === false ? 'Install Node.js 22 or newer to finish.' : status.modelConfigured === false ? 'One step left: run oasis setup to connect a model.' : '';
  stdout.write('\n' + (problems.length ? 'Problems found:\n' + problems.map((item) => '  - ' + item).join('\n') : (pending ? 'No other problems found. ' + pending : 'No problems found.')) + '\n');
}

function scrubChildEnvironment() {
  const env = {};
  const allow = new Set(String(process.env.OASIS_COMMAND_ENV_ALLOWLIST || '').split(',').map((item) => item.trim()).filter(Boolean));
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION|GITHUB_TOKEN|GH_TOKEN)/i.test(key) && !allow.has(key)) continue;
    if (key === 'OASIS_COMMAND_ENV_ALLOWLIST') continue;
    env[key] = value;
  }
  return env;
}

async function runInteractiveCommand(command, args) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, windowsHide: true, env: scrubChildEnvironment() });
    child.on('error', (error) => resolve({ code: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

// Parallel subagents can request approval at the same time; ask one question at a time.
let approvalQueue = Promise.resolve();
// The interactive session connected to an IDE, if any: edit approvals open its diff view.
let ideSession = null;
const IDE_REVIEW_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file']);
function approve(prompt, forceInteractive = false, autoApprove = false, meta = {}) {
  if (autoApprove && !forceInteractive) return Promise.resolve(true);
  const next = approvalQueue.then(async () => {
    if (ideSession && ideSession.ide && meta && IDE_REVIEW_TOOLS.has(meta.tool)) {
      const { reviewEditInIde } = await import('./ide.mjs');
      stdout.write('\n[ide] Review the proposed change in ' + ideSession.ide.ideName + ' (Accept / Reject)...\n');
      const decision = await reviewEditInIde(ideSession, meta);
      if (decision !== null) { stdout.write('[ide] ' + (decision ? 'Accepted' : 'Rejected') + ' in ' + ideSession.ide.ideName + '.\n'); return decision; }
      stdout.write('[ide] The diff could not be shown in the IDE; answer here instead.\n');
    }
    return askApproval(prompt, forceInteractive, meta);
  });
  approvalQueue = next.catch(() => {});
  return next;
}

let CURRENT_TURN_STARTED_AT = 0;

async function askApproval(prompt, forceInteractive, meta) {
  // Channels that opted in to permission relay get the request too; the first answer wins.
  let relay = null;
  if (channelSession && channelSession.channels && channelSession.channels.length && meta && meta.tool) {
    const { startPermissionRelay } = await import('./channels.mjs');
    const { hookToolName } = await import('./agent.mjs');
    relay = startPermissionRelay(channelSession, { toolName: hookToolName(channelSession, meta.tool), description: String(prompt).split('\n')[0], input: meta.input });
  }
  if (!relay) return askApprovalLocal(prompt, forceInteractive, meta);
  const local = new AbortController();
  let remote = null;
  relay.promise.then((behavior) => { remote = behavior; local.abort(); });
  stdout.write('\n[channels] Also sent to your channel for approval.');
  try {
    const answer = await askApprovalLocal(prompt, forceInteractive, meta, local.signal);
    if (remote) { stdout.write('\n[channels] ' + (remote === 'allow' ? 'Approved' : 'Denied') + ' from ' + (relay.source || 'a channel') + '.\n'); return remote === 'allow'; }
    return answer;
  } finally { relay.cancel(); }
}

async function askApprovalLocal(prompt, forceInteractive, meta, signal = null) {
  const approval = formatApprovalMessage(prompt, meta || {});
  if (process.env.OASIS_PERMISSION_PROMPTS === 'none') { stdout.write('\n[permissions] Denied without asking (--permission-prompts none): ' + approval.message.split('\n').filter(Boolean)[0] + '\n'); return false; }
  try {
    stdout.write('\n' + approval.message + '\n');
    const approvalSound = playSound('attention', { stream: stdout });
    if (CURRENT_TURN_STARTED_AT) notifyAttention('OASIS needs your approval: ' + approval.message.split('\n').filter(Boolean)[0], { elapsedMs: Date.now() - CURRENT_TURN_STARTED_AT, soundPlayed: approvalSound, stream: stdout });
    const offerAlways = meta && meta.suggestion && !forceInteractive;
    if (signal && (!stdin.isTTY || !stdout.isTTY)) { await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); setTimeout(resolve, 300000).unref?.(); }); return false; }
    if (stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function' && process.env.OASIS_LINE_APPROVALS !== '1') {
      // Claude Code-style dialog: arrows/j/k + Enter, 1-3, y/n/a, Esc; rebindable via the Confirmation context.
      const { selectDialog } = await import('./select-dialog.mjs');
      const options = [{ label: 'Allow once', value: true, hotkey: 'yes' }];
      if (offerAlways) options.push({ label: 'Always allow this session for ' + meta.suggestion, value: 'always', hotkey: 'always' });
      options.push({ label: 'No', value: false, hotkey: 'no' });
      stdout.write('Do you want to proceed?\n');
      const paused = turnKeys;
      if (paused) paused.suspend();
      try { return await selectDialog({ input: stdin, output: stdout, options, color: colorEnabled(stdout), signal }); }
      finally { if (paused && turnKeys === paused) paused.resume(); }
    }
    const answer = (await askLine(offerAlways ? 'Allow once [y] / [N]o / [a]lways allow ' + meta.suggestion + ' this session: ' : 'Allow once? [y/N] ', signal)).trim().toLowerCase();
    if (offerAlways && ['a', 'always'].includes(answer)) return 'always';
    return ['y', 'yes'].includes(answer);
  } catch {
    if (signal && signal.aborted) return false;
    stdout.write('No interactive approval was available; action denied.\n');
    return false;
  }
}

// Streaming: print assistant text as it arrives; onText then only ends the line.
let streamedSoFar = '';
let markdownStream = null;
const richOutput = () => colorEnabled(stdout) && process.env.OASIS_PLAIN_OUTPUT !== '1';
let waitIndicator = null;
function onModelWait(event = {}) {
  if (event.phase === 'progress') { if (waitIndicator) waitIndicator.update({ promptProgress: event.promptProgress }); return; }
  if (event.phase !== 'start') { stopWaitIndicator(); return; }
  if (!waitIndicator) waitIndicator = createActivityIndicator({ stream: stdout, env: process.env, color: richOutput() });
  waitIndicator.start(event);
}
function stopWaitIndicator() { if (waitIndicator) waitIndicator.stop(); }
function streamDelta(accumulated) {
  stopWaitIndicator();
  const text = String(accumulated || '');
  // An empty update means the stream restarted; onStreamRestart ends the line.
  if (!text) return;
  if (richOutput()) {
    if (!markdownStream) markdownStream = new MarkdownStream({ write: (chunk) => stdout.write(chunk), color: true, columns: () => stdout.columns || 80, prefix: '\x1b[38;2;251;191;36m●\x1b[39m ' });
    if (text.startsWith(streamedSoFar)) markdownStream.push(text.slice(streamedSoFar.length));
    streamedSoFar = text || ' ';
    return;
  }
  if (!streamedSoFar) stdout.write('\nOasis> ');
  if (text.startsWith(streamedSoFar)) stdout.write(text.slice(streamedSoFar.length));
  streamedSoFar = text || ' ';
}
function endStream() {
  stopWaitIndicator();
  if (!streamedSoFar) return false;
  if (markdownStream) { markdownStream.end(); markdownStream = null; }
  else stdout.write('\n');
  streamedSoFar = '';
  return true;
}

function describeToolStart({ name, args = {}, subagent }) {
  let detail = '';
  if (name === 'run_command') detail = [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ');
  else if (name === 'run_shell' || name === 'auto_test') detail = String(args.command || '');
  else if (name === 'task') detail = (args.subagent_type || 'general-purpose') + ': ' + (args.description || '');
  else if (args.path || args.pattern || args.query || args.url) detail = String(args.path || args.pattern || args.query || args.url);
  if (detail.length > 140) detail = detail.slice(0, 137) + '...';
  return (subagent ? '  [' + subagent + '] ' : '[tool] ') + name + (detail ? ' ' + detail : '');
}

// Loads values for flags that accept a file path or inline JSON.
async function readFlagValue(value, root) {
  const text = String(value || '').trim();
  if (text.startsWith('{') || text.startsWith('[')) return text;
  return readFile(path.resolve(root, text.startsWith('@') ? text.slice(1) : text), 'utf8');
}

async function resolveFlagFiles(root) {
  for (const item of SESSION_OPTIONS.pendingFiles.splice(0)) {
    if (item.kind === 'subagent-append') {
      const text = await readFile(path.resolve(root, item.file), 'utf8').catch((error) => { throw new Error('Could not read ' + item.file + ': ' + error.message); });
      SESSION_OPTIONS.subagentSystemAppend = [SESSION_OPTIONS.subagentSystemAppend, text].filter(Boolean).join('\n\n');
      continue;
    }
    if (item.kind === 'system' || item.kind === 'append') {
      const text = await readFile(path.resolve(root, item.file), 'utf8').catch((error) => { throw new Error('Could not read ' + item.file + ': ' + error.message); });
      if (item.kind === 'system') SESSION_OPTIONS.systemPromptOverride = text;
      else SESSION_OPTIONS.appendSystemPrompt = [SESSION_OPTIONS.appendSystemPrompt, text].filter(Boolean).join('\n\n');
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(await readFlagValue(item.file, root)); }
    catch (error) { throw new Error('--' + (item.kind === 'mcp' ? 'mcp-config' : item.kind) + ' is not valid JSON or a readable JSON file: ' + error.message); }
    if (item.kind === 'mcp') {
      const { parseMcpServerEntries } = await import('./mcp-project.mjs');
      const { servers, failures } = parseMcpServerEntries(parsed, process.env, 'flag');
      for (const failure of failures) stderr.write('[mcp] ' + failure.name + ': ' + failure.error + '\n');
      SESSION_OPTIONS.mcpServers.push(...servers);
    } else if (item.kind === 'settings') {
      SESSION_OPTIONS.settingsOverrides.push({ settings: parsed, file: item.file.trim().startsWith('{') ? '--settings' : path.resolve(root, item.file) });
      if (parsed && typeof parsed.model === 'string' && !SESSION_OPTIONS.model) SESSION_OPTIONS.model = parsed.model;
    } else if (item.kind === 'agents') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--agents must be a JSON object like {"reviewer": {"description": "...", "prompt": "..."}}.');
      SESSION_OPTIONS.agentsInline = { ...(SESSION_OPTIONS.agentsInline || {}), ...parsed };
    }
  }
  if (SESSION_OPTIONS.fromPr) {
    const pr = spawnSync('gh', ['pr', 'view', String(SESSION_OPTIONS.fromPr), '--json', 'number,title,body,headRefName,baseRefName,url,files'], { cwd: root, encoding: 'utf8', timeout: 20000 });
    if (pr.status !== 0) throw new Error('--from-pr: could not read the pull request with the GitHub CLI: ' + (pr.stderr || pr.error && pr.error.message || 'unknown error').trim());
    const info = JSON.parse(pr.stdout);
    const diff = spawnSync('gh', ['pr', 'diff', String(SESSION_OPTIONS.fromPr)], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    SESSION_OPTIONS.appendSystemPrompt = [SESSION_OPTIONS.appendSystemPrompt, 'This session is linked to pull request #' + info.number + ' (' + info.url + '): ' + info.title + '\nBranch: ' + info.headRefName + ' → ' + info.baseRefName + '\nDescription:\n' + String(info.body || '').slice(0, 6000) + '\n\nChanged files: ' + (info.files || []).map((file) => file.path).join(', ').slice(0, 4000) + (diff.status === 0 ? '\n\nDiff (truncated):\n' + String(diff.stdout).slice(0, 40000) : '')].filter(Boolean).join('\n\n');
  }
}

function sessionCreateOptions() {
  // --session-id names only the first session; later ones (after /clear) get fresh ids.
  const firstSessionId = SESSION_OPTIONS.sessionId || null;
  SESSION_OPTIONS.sessionId = null;
  return {
    onHookStatus: (event) => { if (event.phase === 'start') onModelWait({ phase: 'start', label: event.label }); else stopWaitIndicator(); },
    permissionMode: SESSION_OPTIONS.permissionMode,
    allowedTools: SESSION_OPTIONS.allowedTools,
    disallowedTools: SESSION_OPTIONS.disallowedTools,
    appendSystemPrompt: SESSION_OPTIONS.appendSystemPrompt,
    outputStyle: SESSION_OPTIONS.outputStyle || null,
    addDirs: SESSION_OPTIONS.addDirs,
    bare: Boolean(SESSION_OPTIONS.bare || SESSION_OPTIONS.safeMode),
    restricted: Boolean(SESSION_OPTIONS.restricted),
    subagentSystemAppend: SESSION_OPTIONS.subagentSystemAppend || '',
    excludeDynamicSections: Boolean(SESSION_OPTIONS.excludeDynamicSections),
    systemPromptSnapshot: SESSION_OPTIONS.systemPromptSnapshot || null,
    systemPromptOverride: SESSION_OPTIONS.systemPromptOverride || '',
    tools: SESSION_OPTIONS.tools,
    mcpServers: SESSION_OPTIONS.mcpServers,
    strictMcpConfig: Boolean(SESSION_OPTIONS.strictMcpConfig),
    agentsInline: SESSION_OPTIONS.agentsInline || null,
    sessionName: SESSION_OPTIONS.sessionName || '',
    sessionId: firstSessionId,
    fallbackModel: SESSION_OPTIONS.fallbackModel || '',
    advisor: SESSION_OPTIONS.advisor || '',
    chrome: SESSION_OPTIONS.chrome === undefined ? null : SESSION_OPTIONS.chrome,
    maxBudgetUsd: SESSION_OPTIONS.maxBudgetUsd || 0,
    settingsOverrides: SESSION_OPTIONS.settingsOverrides,
    settingSources: SESSION_OPTIONS.settingSources || null,
    agent: SESSION_OPTIONS.agent || null,
    channels: [...SESSION_OPTIONS.channels, ...(SESSION_OPTIONS.devChannelsConfirmed ? SESSION_OPTIONS.devChannels : [])]
  };
}

function reportSessionNotices(session) {
  if (!session) return;
  if (!settingsWarningShown) {
    settingsWarningShown = true;
    if (session.settingsError) stdout.write('[settings] ' + session.settingsError + '\n');
    if (session.modelRestrictionNote) stdout.write('[settings] ' + session.modelRestrictionNote + '\n');
    if (session.styleWarning) stdout.write('[settings] ' + session.styleWarning + '\n');
    if (session.agentWarning) stdout.write('[settings] ' + session.agentWarning + '\n');
    else if (session.mainAgent) stdout.write('[agent] Running as ' + session.mainAgent + (session.settings && session.settings.agentSource && !SESSION_OPTIONS.agent ? ' (from ' + session.settings.agentSource + ' settings)' : '') + '.\n');
    for (const note of session.instructionNotices || []) stdout.write('[instructions] ' + note + ' Split it or move detail into @imports / .claude/rules/.\n');
    for (const note of session.localContextNotices || []) stdout.write('[local model] ' + note + '\n');
    for (const item of session.rejectedDirectories || []) stdout.write('[settings] Additional directory ' + item.dir + ' was not added: ' + item.error + '.\n');
    if (session.additionalDirectories && session.additionalDirectories.length) stdout.write('[settings] Additional directories: ' + session.additionalDirectories.join(', ') + '\n');
    const ignored = session.settings && session.settings.ignoredUntrusted || [];
    if (ignored.length) stdout.write('[settings] This workspace is not trusted, so allow rules, hooks, and mode/sandbox changes in ' + ignored.map((file) => path.relative(session.root, file)).join(', ') + ' were ignored. Deny/ask rules still apply. Run oasis trust after reviewing them.\n');
    if (session.sandbox && session.sandbox.enabled) stdout.write(session.sandbox.available ? '[sandbox] Commands run inside ' + session.sandbox.kind + (session.sandbox.network ? '' : ' with network disabled') + '.\n' : '[sandbox] Requested but unavailable: ' + session.sandbox.reason + '\n');
  }
  if (Array.isArray(session.hookMessages) && session.hookMessages.length) {
    for (const message of session.hookMessages.splice(0)) stdout.write('[hook] ' + String(message).slice(0, 800) + '\n');
  }
}

async function managePermissions(root, rest) {
  const sub = rest[0] || 'list';
  if (sub === 'list') {
    const settings = await loadSettings(root);
    stdout.write('Permission mode: ' + settings.permissions.defaultMode + (SESSION_OPTIONS.permissionMode ? ' (overridden: ' + SESSION_OPTIONS.permissionMode + ')' : '') + '\n');
    stdout.write('Workspace trusted: ' + (settings.trusted ? 'yes' : 'no') + '\n');
    for (const kind of ['allow', 'ask', 'deny']) stdout.write(kind + ': ' + (settings.permissions[kind].length ? settings.permissions[kind].join(', ') : '(none)') + '\n');
    const hookEvents = Object.entries(settings.hooks).map(([event, groups]) => event + ' x' + groups.reduce((n, g) => n + g.hooks.length, 0));
    stdout.write('hooks: ' + (hookEvents.length ? hookEvents.join(', ') : '(none)') + '\n');
    const probe = detectSandbox();
    stdout.write('sandbox: ' + (settings.sandbox.enabled ? 'enabled' : 'disabled') + ' (' + (probe.available ? probe.kind + ' available' : probe.reason) + ')\n');
    stdout.write('Settings files: ' + (settings.sources.map((item) => item.file).join(', ') || userSettingsPath() + ' (not created yet)') + '\n');
    if (settings.ignoredUntrusted.length) stdout.write('Ignored until trusted: ' + settings.ignoredUntrusted.join(', ') + '\n');
    return;
  }
  if (sub === 'add') {
    const kind = rest[1];
    const rule = rest[2];
    const scopeIndex = rest.indexOf('--scope');
    const scope = scopeIndex >= 0 ? rest[scopeIndex + 1] : 'local';
    const file = await addPermissionRule(scope, kind, rule, root);
    stdout.write('Added ' + kind + ' rule ' + rule + ' to ' + file + '\n');
    return;
  }
  stdout.write('Usage: oasis permissions [list] | oasis permissions add allow|ask|deny "RULE" [--scope user|project|local]\n');
}

async function authCommand(root, rest) {
  const auth = await import('./auth-cli.mjs');
  const [sub = 'status', ...more] = rest;
  const options = auth.parseAuthArgs(more);
  if (sub === 'status') {
    const status = await auth.authStatus(process.env);
    stdout.write(options.text ? auth.describeAuthStatus(status) + '\n' : JSON.stringify(status, null, 2) + '\n');
    process.exitCode = status.loggedIn ? 0 : 1;
    return;
  }
  if (sub === 'logout') {
    const out = await auth.authLogout(process.env);
    stdout.write((out.removed ? 'Removed the stored API key from ' + out.file + '.' : 'No stored API key in ' + out.file + '.') + (out.envKeys.length ? ' Still set in your environment: ' + out.envKeys.join(', ') + ' (unset them to fully sign out).' : '') + '\n');
    return;
  }
  if (sub === 'login') {
    if (options.apiKeyStdin) options.apiKey = (await readPipedStdin()).trim();
    if (options.ignored) stderr.write('[auth] ' + options.ignored.join(', ') + ' only apply to Anthropic account sign-in; OASIS signs in with a provider API key.\n');
    if (options.apiKey) {
      const status = await auth.authLoginWithKey(options, process.env);
      stdout.write(auth.describeAuthStatus(status) + '\n');
      return;
    }
    if (!stdin.isTTY) throw new Error('Usage: oasis auth login --api-key KEY | --api-key-stdin [--protocol anthropic|openai-compatible|openai-responses] [--base-url URL] [--model ID]');
    return await configureProvider(root);
  }
  throw new Error('Usage: oasis auth status [--text] | login [--api-key KEY|--api-key-stdin] [--protocol P] [--base-url URL] [--model ID] | logout');
}

// Claude's setup-token mints an OAuth token; OASIS uses provider keys, so it prints how to pass one to CI.
async function setupTokenCommand() {
  const auth = await import('./auth-cli.mjs');
  const status = await auth.authStatus(process.env);
  stdout.write([
    'OASIS uses your model provider\'s API key rather than an account token.',
    'For CI and scripts, store the key as a secret and expose it as an environment variable:',
    '  ' + (status.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : status.protocol === 'bedrock' ? 'AWS_BEARER_TOKEN_BEDROCK (or AWS credentials)' : status.protocol === 'vertex' ? 'GOOGLE_APPLICATION_CREDENTIALS' : status.protocol === 'foundry' ? 'ANTHROPIC_FOUNDRY_API_KEY' : 'OASIS_API_KEY') + '=<your key>',
    '  OASIS_PROTOCOL=' + (status.protocol || 'anthropic') + (status.model ? '  OASIS_MODEL=' + status.model : '') + (status.baseURL && !/api\.anthropic\.com|api\.openai\.com/.test(status.baseURL) ? '  OASIS_BASE_URL=' + status.baseURL : ''),
    'Then run: oasis -p "your task" --output-format json',
    'Or use an apiKeyHelper script in settings to fetch a short-lived key at request time.'
  ].join('\n') + '\n');
}

async function agentsCommand(rest) {
  const { agentsJson } = await import('./auth-cli.mjs');
  const cwdIndex = rest.indexOf('--cwd');
  const list = await agentsJson({ all: rest.includes('--all'), cwd: cwdIndex >= 0 ? rest[cwdIndex + 1] : null }, process.env);
  if (rest.includes('--json')) stdout.write(JSON.stringify(list, null, 2) + '\n');
  else stdout.write(list.length ? list.map((entry) => entry.id + '  ' + entry.status.padEnd(9) + ' ' + (entry.name || '') + '  ' + entry.prompt.replace(/\s+/g, ' ').slice(0, 70)).join('\n') + '\n' : 'No background sessions.\n');
}

// `oasis ultrareview [target] [--json] [--timeout MIN] [--post]`: the deep review, non-interactively.
async function ultrareviewCommand(root, rest, autoApprove, persistence) {
  const words = [];
  let json = false; let post = false; let minutes = 45;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') json = true;
    else if (arg === '--post') post = true;
    else if (arg === '--no-post') post = false;
    else if (arg === '--timeout') minutes = Math.max(1, Number.parseFloat(rest[++i]) || 45);
    else if (arg.startsWith('--timeout=')) minutes = Math.max(1, Number.parseFloat(arg.split('=')[1]) || 45);
    else words.push(arg);
  }
  const target = words.join(' ');
  if (post && !/^#?\d+$|github\.com\/.+\/pull\/\d+/.test(target)) throw new Error('--post needs a GitHub pull request target (a number or a github.com pull request URL).');
  const prNumber = (target.match(/\/pull\/(\d+)/) || [])[1];
  const { reviewPrompt } = await import('./slash.mjs');
  let prompt = reviewPrompt('review', 'ultra ' + (prNumber || target));
  prompt += post
    ? '\n\nWhen the review is complete, post the findings to the pull request as ONE plain comment with `gh pr comment ' + (prNumber || target.replace('#', '')) + ' --body-file -` and say that you did.'
    : '\n\nDo not post anything to GitHub and do not change files: print the findings only.';
  if (json) prompt += '\n\nRecord the confirmed findings with report_findings (pass [] when there are none); the JSON result carries them in its findings field.';
  const timer = setTimeout(() => { stderr.write('OASIS error: ultrareview timed out after ' + minutes + ' minutes.\n'); process.exit(1); }, minutes * 60000);
  timer.unref();
  try {
    if (post) SESSION_OPTIONS.allowedTools.push('Bash(gh pr comment:*)', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)');
    else SESSION_OPTIONS.allowedTools.push('Bash(gh pr view:*)', 'Bash(gh pr diff:*)');
    SESSION_OPTIONS.disallowedTools.push('Write', 'Edit');
    await printMode(root, { prompt, outputFormat: json ? 'json' : 'text' }, [], autoApprove, persistence);
  } finally { clearTimeout(timer); }
}

async function backgroundCommand(root, rest) {
  const bg = await import('./background-sessions.mjs');
  const [sub = 'list', query, ...more] = rest;
  if (sub === 'list' || sub === 'ls') {
    const entries = await bg.listBackgroundSessions(process.env);
    const activity = await Promise.all(entries.map((entry) => (entry.status === 'running' ? bg.readActivity(entry) : Promise.resolve(''))));
    const interrupted = entries.filter((entry) => entry.status === 'interrupted').length;
    if (interrupted) stdout.write(interrupted + ' run(s) stopped unexpectedly (crash, kill or reboot). oasis respawn --interrupted resumes them with their conversations.\n');
    const waiting = entries.filter((entry) => entry.pendingApproval).length;
    if (waiting) stdout.write(waiting + ' run(s) are waiting for your approval. oasis bg approve ID [--always] or oasis bg deny ID [reason] answers.\n');
    stdout.write(entries.length ? entries.map((entry, index) => bg.describeEntry(entry, activity[index])).join('\n') + '\n' : 'No background sessions. Start one with oasis --bg "task" or /background in a session.\n');
    return;
  }
  if (sub === 'respawn' && (query === '--all' || more.includes('--all'))) {
    const running = (await bg.listBackgroundSessions(process.env)).filter((entry) => entry.status === 'running');
    for (const entry of running) { await bg.respawnBackgroundSession(entry.id, process.env); stdout.write('Respawned ' + entry.id + '.\n'); }
    if (!running.length) stdout.write('No running background sessions to respawn.\n');
    return;
  }
  if (sub === 'respawn' && (query === '--interrupted' || more.includes('--interrupted'))) {
    const interrupted = (await bg.listBackgroundSessions(process.env)).filter((entry) => entry.status === 'interrupted');
    for (const entry of interrupted) { await bg.respawnBackgroundSession(entry.id, process.env); stdout.write('Resumed ' + entry.id + (entry.name ? ' (' + entry.name + ')' : '') + '.\n'); }
    if (!interrupted.length) stdout.write('No interrupted background sessions.\n');
    return;
  }
  if (!query) throw new Error('Usage: oasis bg [list] | logs ID [--follow] | send ID "message" | approve ID [--always] | deny ID [reason] | attach ID | stop ID | rm ID | respawn ID|--all|--interrupted');
  const id = await bg.resolveBackgroundId(query, process.env);
  if (sub === 'respawn') {
    const entry = await bg.respawnBackgroundSession(id, process.env);
    stdout.write('Respawned ' + entry.id + (entry.kind === 'exec' ? ' (re-running ' + entry.command + ')' : ' with its conversation intact') + '.\n  oasis logs ' + entry.id + ' --follow   watch progress\n');
    return;
  }
  if (sub === 'logs') {
    const entry = await bg.readEntry(id, process.env);
    const follow = more.includes('--follow') || more.includes('-f');
    let shown = 0;
    for (;;) {
      const text = await readFile(entry.logFile, 'utf8').catch(() => '');
      const complete = text.slice(0, text.lastIndexOf('\n') + 1);
      if (complete.length > shown) { const out = bg.renderLog(complete.slice(shown)); if (out) stdout.write(out + '\n'); shown = complete.length; }
      if (!follow || (await bg.readEntry(id, process.env)).status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return;
  }
  if (sub === 'send' || sub === 'message' || sub === 'steer') {
    const text = more.join(' ').trim();
    if (!text) throw new Error('Usage: oasis bg send ID "message"');
    await bg.sendToBackgroundSession(id, text, process.env);
    stdout.write('Sent to ' + id + '. It reads the message at its next step; oasis bg logs ' + id + ' --follow shows the reply.\n');
    return;
  }
  if (sub === 'approve' || sub === 'allow' || sub === 'deny' || sub === 'reject') {
    const allow = sub === 'approve' || sub === 'allow';
    const always = more.includes('--always');
    const reason = more.filter((word) => word !== '--always').join(' ').trim();
    const pending = await bg.answerBackgroundApproval(id, allow ? 'allow' : 'deny', process.env, { always, reason });
    stdout.write((allow ? 'Approved' : 'Denied') + (always && allow ? ' (and allowed for the rest of that run)' : '') + ': ' + (pending.message || pending.tool || 'action').slice(0, 160) + '\n');
    if (!allow && reason) await bg.sendToBackgroundSession(id, 'I denied that action: ' + reason, process.env).catch(() => {});
    return;
  }
  if (sub === 'stop' || sub === 'kill') { const result = await bg.stopBackgroundSession(id, process.env); stdout.write(result.stopped ? 'Stopped ' + id + '.\n' : id + ' is not running (' + result.status + ').\n'); return; }
  if (sub === 'rm') { await bg.removeBackgroundSession(id, process.env); stdout.write('Removed ' + id + '.\n'); return; }
  if (sub === 'attach') {
    const entry = await bg.readEntry(id, process.env);
    if (entry.kind === 'exec') {
      stdout.write('Attaching to ' + id + ' (' + entry.command + '). Ctrl+C detaches; the job keeps running.\n');
      return await backgroundCommand(root, ['logs', id, '--follow']);
    }
    if (entry.status === 'running') {
      if (!(await approve(id + ' is still running. Stop it and continue the conversation here?', true, false))) { stdout.write('Left it running. oasis bg logs ' + id + ' --follow shows progress.\n'); return; }
      await bg.stopBackgroundSession(id, process.env);
    }
    stdout.write('Attaching to ' + id + ' (session ' + entry.sessionId + ').\n' + (bg.renderLog(await readFile(entry.logFile, 'utf8').catch(() => '')).split('\n').slice(-12).join('\n')) + '\n');
    try { process.chdir(entry.root); } catch {}
    return await interactive(entry.root, false, { enabled: true, resumeId: entry.sessionId });
  }
  throw new Error('Unknown bg command ' + sub + '. Usage: oasis bg [list] | logs ID [--follow] | send ID "message" | approve ID [--always] | deny ID [reason] | attach ID | stop ID | rm ID | respawn ID|--all|--interrupted');
}

// oasis auto-mode defaults [--label PREFIX] | config | critique | reset [--yes]  (claude auto-mode ...)
async function autoModeCommand(root, rest, autoApprove = false) {
  const { DEFAULT_AUTO_MODE, AUTO_MODE_SECTIONS, effectiveAutoModeConfig, critiqueAutoMode, ruleLabel } = await import('./auto-mode.mjs');
  const [sub = 'config', ...more] = rest;
  const labelAt = more.indexOf('--label');
  const label = labelAt >= 0 ? String(more[labelAt + 1] || '').toLowerCase() : '';
  const filter = (config) => {
    if (!label) return config;
    const out = {};
    for (const section of AUTO_MODE_SECTIONS) out[section] = (config[section] || []).filter((rule) => ruleLabel(rule).toLowerCase().startsWith(label));
    return out;
  };
  const settings = await loadSettings(root);
  if (sub === 'defaults') { stdout.write(JSON.stringify(filter(DEFAULT_AUTO_MODE), null, 2) + '\n'); return; }
  if (sub === 'config') {
    const config = effectiveAutoModeConfig(settings.autoMode);
    if (settings.autoMode && settings.autoMode.rules && settings.autoMode.rules.length) config.rules = settings.autoMode.rules;
    if (settings.autoMode && settings.autoMode.classifyAllShell) config.classifyAllShell = true;
    stdout.write(JSON.stringify(filter(config), null, 2) + '\n');
    return;
  }
  if (sub === 'critique') { stdout.write(critiqueAutoMode(settings.autoMode).map((note) => '- ' + note).join('\n') + '\n'); return; }
  if (sub === 'reset') {
    const file = userSettingsPath(process.env);
    const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}') || '{}');
    if (!current.autoMode) { stdout.write('No autoMode section in ' + file + '; the defaults already apply.\n'); return; }
    stdout.write('This removes the autoMode section from ' + file + ': ' + Object.keys(current.autoMode).join(', ') + '. Rules from managed settings or --settings still apply.\n');
    if (!autoApprove && !more.includes('--yes') && !more.includes('-y') && !(await approve('Reset auto mode configuration to defaults?', true, false))) { stdout.write('Kept your auto mode rules.\n'); return; }
    const { updateUserSettings } = await import('./settings.mjs');
    await updateUserSettings((data) => { delete data.autoMode; return data; }, process.env);
    stdout.write('Auto mode configuration reset to defaults.\n');
    return;
  }
  throw new Error('Usage: oasis auto-mode defaults [--label PREFIX] | config [--label PREFIX] | critique | reset [--yes]');
}

// --verbose / "verbose": true / /config verbose: show tool output in the transcript.
function verboseEnabled(session) {
  if (typeof SESSION_OPTIONS.verbose === 'boolean') return SESSION_OPTIONS.verbose;
  return Boolean(session && session.settings && session.settings.verbose);
}

async function purgeCommand(root, rest, autoApprove) {
  const { parsePurgeArgs, planPurge, applyPurge, describePurge, knownProjects } = await import('./purge.mjs');
  const options = parsePurgeArgs(rest);
  if (autoApprove) options.yes = true;
  let targets = [];
  if (options.all) targets = (await knownProjects(process.env)).map((item) => item.root);
  else if (options.path) targets = [path.resolve(options.path)];
  else {
    const projects = await knownProjects(process.env);
    if (!projects.length) { stdout.write('No projects have saved Oasis state.\n'); return; }
    if (!(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function')) throw new Error('Usage: oasis purge PATH | --all. Projects with saved state:\n' + projects.map((item) => '  ' + item.root + ' (' + item.sessions + ' sessions)').join('\n'));
    const { selectDialog } = await import('./select-dialog.mjs');
    stdout.write('Select a project to purge:\n');
    const chosen = await selectDialog({ input: stdin, output: stdout, options: projects.map((item) => ({ label: item.root + '  (' + item.sessions + ' session' + (item.sessions === 1 ? '' : 's') + ')', value: item.root })), context: 'Select', color: colorEnabled(stdout) });
    if (!chosen) { stdout.write('Cancelled.\n'); return; }
    targets = [chosen];
  }
  if (!targets.length) { stdout.write('No projects have saved Oasis state.\n'); return; }
  for (const target of targets) {
    const plan = await planPurge(target, { env: process.env, memory: options.memory });
    stdout.write(describePurge(plan) + '\n');
    if (!plan.items.length || options.dryRun) { if (options.dryRun && plan.items.length) stdout.write('(dry run — nothing deleted)\n'); continue; }
    if (!options.yes && !options.interactive && !(await approve('Delete all of this? It cannot be undone.', true, false))) { stdout.write('Kept ' + target + '.\n'); continue; }
    const done = await applyPurge(plan, { env: process.env, confirm: options.interactive && !options.yes ? (item) => approve('Delete ' + item.label + '?', true, false) : null });
    stdout.write('Purged ' + done.length + ' item' + (done.length === 1 ? '' : 's') + ' for ' + target + '.\n');
  }
}

async function importCommand(root, rest, autoApprove) {
  const { planImport, describePlan, applyImport, parseImportArgs } = await import('./importers.mjs');
  const { sources, dryRun, yes } = parseImportArgs(rest);
  const plan = await planImport(root, { sources, env: process.env });
  stdout.write(describePlan(plan) + '\n');
  const pending = plan.items.filter((item) => item.action !== 'skip');
  if (!pending.length || dryRun) { if (dryRun && pending.length) stdout.write('Dry run: nothing was written.\n'); return; }
  if (!yes && !(await approve('Import these ' + pending.length + ' item' + (pending.length === 1 ? '' : 's') + '?', true, autoApprove))) { stdout.write('Import cancelled.\n'); return; }
  const done = await applyImport(plan);
  stdout.write('Imported ' + done.length + ' item' + (done.length === 1 ? '' : 's') + '. New MCP servers, commands and rules apply to new sessions.\n');
}

async function manageTrust(root, rest) {
  const revoke = rest.includes('--revoke');
  const id = await setWorkspaceTrust(root, !revoke);
  stdout.write((revoke ? 'Revoked trust for ' : 'Trusted ') + id + '. ' + (revoke ? 'Project allow rules and hooks are ignored again.' : 'Project allow rules, hooks, and sandbox/mode settings now apply. Review .oasis/ and .claude/ settings files before trusting a repository you did not write.') + '\n');
}

async function selfUpdate(autoApprove = false) {
  if (!commandAvailable('npm')) throw new Error('npm was not found. Install Node.js with npm, then rerun oasis update.');
  const { latestReleaseCommit } = await import('./update.mjs');
  const latest = await latestReleaseCommit();
  const installUrl = INSTALL_URL + latest.sha + '.tar.gz';
  const command = 'npm';
  const args = ['install', '--global', installUrl];
  stdout.write('Oasis self-update plan\n  ' + command + ' ' + args.join(' ') + '\n');
  stdout.write('This installs the latest stable release ' + latest.tag + ' from its immutable source archive.\n');
  if (!(await approve('Install/update Oasis from stable release ' + latest.tag + ' (' + latest.sha.slice(0, 7) + ')?', false, autoApprove))) {
    stdout.write('Update cancelled.\n');
    return;
  }
  const result = await runInteractiveCommand(command, args);
  if (result.code === 0) stdout.write('Oasis CLI update completed.\n');
  else stdout.write('Oasis CLI update failed' + (result.code === null ? ': ' + result.error : ' with exit code ' + result.code) + '.\n');
}

async function diagnosticsCommand(rest, root, autoApprove) {
  const paths = [];
  let checker = 'auto';
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') json = true;
    else if (arg === '--checker') checker = rest[++i] || '';
    else if (arg.startsWith('--checker=')) checker = arg.slice('--checker='.length);
    else if (arg.startsWith('-')) throw new Error('Usage: oasis diagnostics [PATH...] [--checker auto|' + CHECKERS.join('|') + '] [--json]');
    else paths.push(arg);
  }
  const settings = await loadSettings(root).catch(() => ({}));
  const sandbox = resolveSandbox(settings, root);
  const result = await runDiagnostics(root, { checker, paths }, {
    autoApprove, env: process.env, sandbox,
    approval: (message, forceInteractive = false) => approve(message, forceInteractive, autoApprove)
  });
  stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : formatDiagnostics(result) + '\n');
  if (result.summary.errors) process.exitCode = 1;
  return result;
}

async function installRequest(request, root, autoApprove) {
  if (request.action === 'self') return await selfUpdate(autoApprove);
  const plan = planPackageInstall({ packageName: request.packageName, ecosystem: request.ecosystem, workspaceRoot: root });
  stdout.write('Installation plan\n');
  stdout.write('  Package: ' + plan.packageName + '\n');
  stdout.write('  Manager: ' + plan.ecosystem + '\n');
  stdout.write('  Command: ' + plan.command + ' ' + plan.args.map((arg) => JSON.stringify(arg)).join(' ') + '\n');
  stdout.write('  Note: ' + plan.note + '\n');
  const result = await executeTool('install_package', request, {
    root, autoApprove, approval: (message) => approve(message, false, autoApprove)
  });
  if (result && result.exitCode === 0) stdout.write('\nInstallation completed. You can verify it with oasis doctor or the tool’s version command.\n');
  else if (result && result.approved === false) stdout.write('\nInstallation cancelled; no package manager was started.\n');
  else if (result && result.exitCode !== undefined) stdout.write('\nInstallation did not complete successfully. Exit code: ' + result.exitCode + '\n');
  else if (result && result.error) stdout.write('\nInstallation error: ' + result.error + '\n');
  else stdout.write('\nInstallation result: ' + JSON.stringify(result) + '\n');
}

async function initWorkspace(root) {
  const target = path.join(root, 'OASIS.md');
  try { await access(target); stdout.write('OASIS.md already exists; leaving it unchanged.\n'); return; } catch {}
  await writeFile(target, [
    '# Oasis workspace instructions',
    '',
    '## Project purpose',
    'Describe what this repository is for and its main constraints.',
    '',
    '## Development workflow',
    '- Inspect existing code before changing it.',
    '- Prefer small, testable changes.',
    '- Run relevant checks before reporting completion.',
    '- Do not commit credentials or generated user data.',
    '- Ask before destructive commands, remote publishing, or production changes.',
    ''
  ].join('\n'), { encoding: 'utf8', flag: 'wx' });
  stdout.write('Created ' + target + '. Edit it to give Oasis persistent project context.\n');
}

async function listSkills(root) {
  const skills = await listAvailableSkills(root);
  stdout.write('Agent skills visible to Oasis (skill instructions are context, not executable code):\n');
  if (!skills.length) { stdout.write('  No skills found. Try "oasis skills find frontend" or install one with "oasis skills add SOURCE --skill NAME".\n'); return; }
  const sourceLabels = {
    'built-in': 'bundled',
    workspace: '.oasis/skills',
    'portable-workspace': '.agents/skills',
    'global-portable': 'global universal skills',
    'claude-project': '.claude/skills',
    'claude-user': '~/.claude/skills',
    'global-extension': 'global extension',
    'project-extension': 'project extension'
  };
  for (const skill of skills) {
    stdout.write('  ' + skill.name + ' [' + (sourceLabels[skill.source] || skill.source) + '] — ' + skill.description + '\n');
  }
}

// Search GitHub for repositories that publish SKILL.md packages.
async function findSkillRepositories(query) {
  const terms = String(query || '').trim();
  const q = encodeURIComponent((terms ? terms + ' ' : '') + 'SKILL.md in:readme,description,name') + '+topic:agent-skills';
  const tries = [
    'https://api.github.com/search/repositories?per_page=15&sort=stars&q=' + q,
    'https://api.github.com/search/repositories?per_page=15&sort=stars&q=' + encodeURIComponent((terms || 'skills') + ' agent skills SKILL.md')
  ];
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'oasis-cli' };
  if (process.env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  for (const url of tries) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('GitHub search failed (' + response.status + '). Set GITHUB_TOKEN if you hit the anonymous rate limit.');
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length) return items;
  }
  return [];
}

async function skillsFromSource(root, source, options, autoApprove) {
  const { installSkillsFromSource } = await import('./skill-install.mjs');
  if (!options.list) {
    const ok = autoApprove || await approve('Download "' + source + '" and copy ' + (options.all ? 'all of its skills' : 'the skill "' + options.skill + '"') + ' into ' + options.targetDir + '? Nothing from the source is run; the instructions are treated as untrusted context.', true, false);
    if (!ok) { stdout.write('Skill installation cancelled.\n'); return; }
  }
  const result = await installSkillsFromSource(source, { ...options, env: process.env });
  if (options.list) {
    if (!result.available.length) { stdout.write('No SKILL.md packages found in ' + source + '.\n'); return result; }
    stdout.write('Skills in ' + source + ':\n');
    for (const item of result.available) stdout.write('  ' + item.name + (item.description ? ' — ' + item.description : '') + '\n');
    stdout.write('Install one with: oasis skills add ' + source + ' --skill NAME\n');
    return result;
  }
  stdout.write(result.message + '\n');
  for (const item of result.installed) if (item.skipped.length) stdout.write('  skipped in ' + item.name + ': ' + item.skipped.join(', ') + '\n');
  if (!result.installed.length) process.exitCode = 1;
  return { ok: result.installed.length > 0, ...result };
}

async function installSkill(root, name) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name || '')) throw new Error('Skill name must use lowercase letters, numbers, and hyphens. Usage: oasis skills install NAME');
  const source = path.join(APP_ROOT, 'skills', name, 'SKILL.md');
  const destination = path.join(root, '.oasis', 'skills', name, 'SKILL.md');
  try { await access(source); } catch { throw new Error('No bundled skill named "' + name + '". Use oasis skills list.'); }
  try { await access(destination); stdout.write('Skill already exists at ' + destination + '; leaving it unchanged.\n'); return; } catch {}
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, 0);
  stdout.write('Installed skill "' + name + '" into ' + destination + '. It will be loaded as project context in the next agent session.\n');
}

async function manageSkills(root, args, autoApprove) {
  const action = String(args[0] || 'list').toLowerCase();
  const rest = args.slice(1);
  if (action === 'list' || action === 'ls') return await listSkills(root);
  if (action === 'install') return await installSkill(root, rest[0]);
  if (action === 'find' || action === 'search') {
    if (rest.length > 4) throw new Error('Use "oasis skills find [a few keywords]" to search the skills directory.');
    if (rest.some((value) => /^--/.test(value))) throw new Error('Search terms cannot start with command flags.');
    const query = rest.join(' ').trim();
    const items = await findSkillRepositories(query);
    if (!items.length) { stdout.write('No skill repositories found' + (query ? ' for "' + query + '"' : '') + '.\n'); return; }
    for (const item of items) stdout.write('  ' + item.full_name + '  ★' + item.stargazers_count + (item.description ? '  ' + String(item.description).slice(0, 100) : '') + '\n');
    stdout.write('Review one with: oasis skills inspect OWNER/REPO\n');
    return;
  }
  if (action === 'inspect') {
    if (rest.length !== 1) throw new Error('Usage: oasis skills inspect SOURCE');
    return await skillsFromSource(root, rest[0], { list: true }, autoApprove);
  }
  if (action === 'add') {
    if (rest.length < 1) throw new Error('Usage: oasis skills add SOURCE --skill NAME, or oasis skills add SOURCE --all.');
    const source = rest[0];
    let skillName = '';
    let allSkills = false;
    let global = false;
    for (let i = 1; i < rest.length; i++) {
      const value = rest[i];
      if (value === '--skill') {
        if (!rest[i + 1]) throw new Error('--skill requires the exact skill name to install.');
        skillName = rest[++i];
      } else if (value.startsWith('--skill=')) {
        skillName = value.slice('--skill='.length);
      } else if (value === '--all') {
        allSkills = true;
      } else if (value === '--global' || value === '-g') {
        global = true;
      } else {
        throw new Error('Usage: oasis skills add SOURCE --skill NAME [--global], or oasis skills add SOURCE --all [--global].');
      }
    }
    if (Boolean(skillName) === allSkills) throw new Error('Choose exactly one of --skill NAME or --all. Use "oasis skills inspect SOURCE" to review available names first.');
    if (skillName && (skillName.length > 128 || /[\r\n\0"]/.test(skillName) || /^-/.test(skillName))) {
      throw new Error('Skill names must be 1–128 characters and cannot contain quotes, line breaks, NUL, or start with a flag.');
    }
    const { getUniversalGlobalSkillsDirectory } = await import('./tools.mjs');
    const targetDir = global ? getUniversalGlobalSkillsDirectory(process.env) : path.join(root, '.agents', 'skills');
    const result = await skillsFromSource(root, source, { skill: skillName, all: allSkills, targetDir }, autoApprove);
    return result;
  }
  throw new Error('Unknown skills action. Use oasis skills list, find, inspect, add, or install.');
}

async function manageSessions(root, rest) {
  const action = rest[0] || 'list';
  const sessions = await listSessions(root);
  if (action === 'list') {
    stdout.write('Saved sessions for ' + path.resolve(root) + ':\n');
    if (!sessions.length) { stdout.write('  No saved sessions. Use oasis --continue to save/resume a session.\n'); return; }
    for (const item of sessions) stdout.write('  ' + item.id + '  ' + item.updatedAt + '  ' + item.messages + ' messages  ' + (item.model || 'unknown model') + '\n');
    return;
  }
  if (action === 'clear' || action === 'delete' || action === 'remove') {
    const id = rest[1];
    if (!id) throw new Error('Usage: oasis sessions clear SESSION_ID');
    if (!sessions.some((item) => item.id === id)) throw new Error('No saved session with ID ' + id + ' exists for this workspace.');
    if (!(await approve('Delete the locally saved conversation ' + id + '? This removes the saved history file.', true, false))) {
      stdout.write('Session deletion cancelled.\n');
      return;
    }
    await deleteSession(root, id);
    stdout.write('Deleted saved session ' + id + '.\n');
    return;
  }
  if (action === 'prune') {
    const flag = rest.indexOf('--older-than');
    const raw = flag >= 0 ? rest[flag + 1] : rest[1];
    const days = raw === undefined ? 30 : Number.parseInt(String(raw).replace(/d$/i, ''), 10);
    if (!Number.isInteger(days) || days < 1) throw new Error('Usage: oasis sessions prune [--older-than DAYS]   (default 30)');
    const stale = await staleSessions(root, days);
    if (!stale.length) { stdout.write('No saved sessions older than ' + days + ' days.\n'); return; }
    stdout.write(stale.length + ' saved session(s) last used more than ' + days + ' days ago:\n');
    for (const item of stale.slice(0, 20)) stdout.write('  ' + item.id + '  ' + item.updatedAt + '  ' + (item.title || '') + '\n');
    if (stale.length > 20) stdout.write('  ... and ' + (stale.length - 20) + ' more\n');
    if (!(await approve('Delete these ' + stale.length + ' saved conversation(s)? This removes their history files.', true, false))) { stdout.write('Nothing deleted.\n'); return; }
    const removed = await pruneSessions(root, days);
    stdout.write('Deleted ' + removed.length + ' saved session(s).\n');
    return;
  }
  if (action === 'export') {
    const { exportSessions } = await import('./trajectories.mjs');
    const count = await exportSessions(root, rest.slice(1));
    if (rest.includes('--out')) stdout.write('Exported ' + count + ' session(s).\n');
    return;
  }
  if (action === 'search') {
    const json = rest.includes('--json');
    const all = rest.includes('--all');
    const query = rest.slice(1).filter((arg) => arg !== '--json' && arg !== '--all').join(' ').trim();
    if (!query) throw new Error('Usage: oasis sessions search QUERY [--all] [--json]');
    const { searchSessions, formatSessionSearch } = await import('./session-search.mjs');
    const result = await searchSessions(root, query, { scope: all ? 'all' : 'workspace', limit: 20 });
    stdout.write((json ? JSON.stringify(result, null, 2) : formatSessionSearch(result, query)) + '\n');
    return;
  }
  throw new Error('Unknown sessions action. Use oasis sessions list, oasis sessions search QUERY, oasis sessions clear SESSION_ID, or oasis sessions prune [--older-than DAYS].');
}

async function manageMcp(rest, root = process.cwd()) {
  const action = rest[0] || 'list';
  const config = await loadMcpServers();
  if (action === 'list') {
    stdout.write('MCP server configuration: ' + config.configPath + '\n');
    if (!config.servers.length) stdout.write('No servers in this file. Add one with oasis mcp add NAME -- COMMAND, or a remote one with oasis mcp add --transport http|sse NAME URL.\n');
    for (const server of config.servers) {
      stdout.write('  ' + server.name + ' — ' + (server.enabled ? 'enabled' : 'disabled') + '\n');
      stdout.write('    executable: ' + server.command + '\n');
      stdout.write('    args: ' + server.args.length + ' argument(s) (values hidden in this summary)\n');
      stdout.write('    explicit environment passthrough: ' + (server.passEnv.join(', ') || 'none') + '\n');
      if (server.origin) {
        stdout.write('    imported from: ' + server.origin.repository + '\n');
        stdout.write('    source revision: ' + server.origin.commitSha + '\n');
        stdout.write('    source manifest: ' + server.origin.filePath + '\n');
      }
    }
    const project = await loadProjectMcpServers(root, { env: process.env }).catch((error) => ({ servers: [], failures: [{ name: '.mcp.json', error: error.message }] }));
    if (project.servers.length || project.failures.length) {
      const trusted = (await loadSettings(root)).trusted;
      stdout.write('Project servers from .mcp.json' + (trusted ? '' : ' (ignored until you run oasis trust)') + ':\n');
      for (const server of project.servers) stdout.write('  ' + server.name + ' — ' + (server.type === 'http' || server.type === 'sse' ? server.type + ' ' + server.url : 'stdio ' + server.command) + '\n');
      for (const failure of project.failures) stdout.write('  ' + failure.name + ' — not usable: ' + failure.error + '\n');
    }
    const { loadClaudeCodeMcpServers } = await import('./mcp-project.mjs');
    const claude = await loadClaudeCodeMcpServers(root, { env: process.env }).catch((error) => ({ local: [], user: [], failures: [{ name: '~/.claude.json', error: error.message }] }));
    const { loadUserMcpJson } = await import('./mcp-project.mjs');
    const userJson = await loadUserMcpJson({ env: process.env }).catch(() => ({ servers: [], failures: [] }));
    if (userJson.servers.length || userJson.failures.length) {
      stdout.write('User servers from ' + userJson.file + ':\n');
      for (const server of userJson.servers) stdout.write('  ' + server.name + ' — ' + (server.type === 'http' || server.type === 'sse' ? server.type + ' ' + server.url : 'stdio ' + server.command) + '\n');
      for (const failure of userJson.failures) stdout.write('  ' + failure.name + ' — not usable: ' + failure.error + '\n');
    }
    if (claude.local.length || claude.user.length || claude.failures.length) {
      stdout.write('Claude Code servers from ' + (claude.file || '~/.claude.json') + ':\n');
      for (const server of [...claude.local, ...claude.user]) stdout.write('  ' + server.name + ' — ' + (server.source === 'claude-local' ? 'local' : 'user') + ' scope, ' + (server.type === 'http' || server.type === 'sse' ? server.type + ' ' + server.url : 'stdio ' + server.command) + '\n');
      for (const failure of claude.failures) stdout.write('  ' + failure.name + ' — not usable: ' + failure.error + '\n');
    }
    stdout.write('Configured MCP servers start when a new agent session begins; each tool call asks for approval by default.\n');
    return;
  }
  if (action === 'serve') {
    const { serveMcp } = await import('./mcp-serve.mjs');
    await serveMcp({ root, args: rest.slice(1), env: process.env });
    return;
  }
  if (action === 'login' || action === 'logout') {
    if (!rest[1]) throw new Error('Usage: oasis mcp ' + action + ' NAME');
    const commands = await import('./mcp-auth-commands.mjs');
    stdout.write((action === 'login'
      ? await commands.mcpLogin(root, rest[1], { env: process.env, print: (text) => stdout.write(text + '\n') })
      : await commands.mcpLogout(root, rest[1], { env: process.env })) + '\n');
    return;
  }
  if (action === 'search') {
    const registry = await import('./mcp-registry.mjs');
    const query = rest.slice(1).filter((arg) => arg !== '--json').join(' ');
    const rows = await registry.searchRegistry(query, { env: process.env });
    stdout.write((rest.includes('--json') ? JSON.stringify(rows, null, 2) : registry.formatSearchResults(rows, query)) + '\n');
    return;
  }
  if (action === 'install') {
    const { installFromRegistry } = await import('./mcp-registry.mjs');
    stdout.write(await installFromRegistry(rest.slice(1), { root, env: process.env, approve: (text) => approve(text, true, false) }) + '\n');
    return;
  }
  if (action === 'add' && rest.some((arg, i) => arg === '--transport' && /^(?:http|sse|streamable-http)$/i.test(String(rest[i + 1] || '')) || /^--transport=(?:http|sse|streamable-http)$/i.test(arg))) {
    const { addRemoteMcpServer } = await import('./mcp-remote-add.mjs');
    const result = await addRemoteMcpServer(rest.slice(1), { root, env: process.env, approve: (text) => approve(text, true, false) });
    stdout.write(result + '\n');
    return;
  }
  if (action === 'add') {
    const name = rest[1];
    const separator = rest.indexOf('--');
    if (!name || separator < 2 || separator === rest.length - 1) {
      throw new Error('Usage: oasis mcp add NAME [--env VAR1,VAR2] -- EXECUTABLE [ARG ...]\n       oasis mcp add --transport http|sse NAME URL [--header "Name: value"] [--scope user|project]');
    }
    let passEnv = [];
    for (let i = 2; i < separator; i++) {
      if (rest[i] === '--env') {
        if (!rest[i + 1]) throw new Error('--env needs a comma-separated list of environment variable names.');
        passEnv = rest[++i].split(',').map((item) => item.trim()).filter(Boolean);
      } else {
        throw new Error('Unknown MCP option: ' + rest[i] + '. Supported option: --env VAR1,VAR2');
      }
    }
    const command = rest[separator + 1];
    const args = rest.slice(separator + 2);
    const entry = validateMcpServerConfig({ name, command, args, passEnv, enabled: true });
    const summary = 'Configure MCP server "' + name + '"?\nExecutable: ' + command + '\nArguments: ' + JSON.stringify(args) + '\nEnvironment passthrough: ' + (passEnv.join(', ') || 'none') + '\nThis starts third-party code inside your user account when Oasis sessions start. Review the server source and package identity before approving.';
    if (!(await approve(summary, true, false))) {
      stdout.write('MCP configuration cancelled. The previous configuration was kept.\n');
      return;
    }
    const output = await saveMcpServers(config.servers.filter((server) => server.name !== name).concat(entry), { configPath: config.configPath });
    stdout.write('Configured MCP server "' + name + '" in ' + output + '. It will start next time you run Oasis.\n');
    return;
  }
  if (action === 'remove') {
    const name = rest[1];
    if (!name) throw new Error('Usage: oasis mcp remove NAME');
    const existing = config.servers.find((server) => server.name === name);
    if (!existing) {
      const { removeUserMcpJsonServer } = await import('./mcp-remote-add.mjs');
      const removed = await removeUserMcpJsonServer(name, { env: process.env, approve: (text) => approve(text, true, false) });
      if (removed) { stdout.write(removed + '\n'); return; }
      throw new Error('No configured MCP server named "' + name + '". Project servers live in .mcp.json; edit that file to remove one.');
    }
    if (!(await approve('Remove MCP server "' + name + '" from the user-level configuration?', true, false))) {
      stdout.write('MCP removal cancelled.\n');
      return;
    }
    const output = await saveMcpServers(config.servers.filter((server) => server.name !== name), { configPath: config.configPath });
    stdout.write('Removed MCP server "' + name + '" from ' + output + '.\n');
    return;
  }
  if (action === 'enable' || action === 'disable') {
    const name = rest[1];
    const existing = config.servers.find((server) => server.name === name);
    if (!existing) throw new Error('No configured MCP server named "' + name + '".');
    if (!(await approve((action === 'enable' ? 'Enable' : 'Disable') + ' MCP server "' + name + '"?', true, false))) return;
    existing.enabled = action === 'enable';
    const output = await saveMcpServers(config.servers, { configPath: config.configPath });
    stdout.write('MCP server "' + name + '" is now ' + (existing.enabled ? 'enabled' : 'disabled') + '. Saved ' + output + '\n');
    return;
  }
  throw new Error('Unknown MCP action. Use oasis mcp list, search, install, add, remove, enable, or disable.');
}

async function showBackups(root) {
  const backups = await listBackups(root);
  if (!backups.length) { stdout.write('No Oasis snapshots are stored for this workspace yet.\n'); return; }
  stdout.write('Snapshots for ' + path.resolve(root) + ':\n');
  for (const item of backups) stdout.write('  ' + item.id + '  ' + item.relativePath + '  (' + item.reason + ', ' + item.createdAt + ')\n');
}

async function restoreOne(root, backupId) {
  if (!backupId) throw new Error('Usage: oasis restore BACKUP_ID');
  const ok = await approve('Restore snapshot ' + backupId + ' into this workspace? If the target currently exists, Oasis will snapshot it first.', true, false);
  if (!ok) { stdout.write('Restore cancelled.\n'); return; }
  const result = await restoreBackup(root, backupId);
  stdout.write('Restored ' + result.path + ' from snapshot ' + result.restoredFrom + '.\n');
}

function printConfig(config) {
  const summary = getProviderSummary(config);
  stdout.write('Oasis provider configuration\n');
  stdout.write('  Base URL: ' + config.baseURL + '\n');
  stdout.write('  Protocol: ' + (config.protocol || 'openai-compatible') + '\n');
  stdout.write('  Model: ' + config.model + '\n');
  stdout.write('  Authentication: ' + summary.authentication + '\n');
  stdout.write('  API key: ' + (config.apiKey ? 'configured (masked)' : 'not set') + '\n');
  stdout.write('  Config file: ' + config.configPath + '\n');
}

async function waitForBackgroundRegistration() {
  const id = process.env.OASIS_BACKGROUND_ID;
  const runId = process.env.OASIS_BACKGROUND_RUN_ID;
  if (!id || !runId) return;
  const { readEntry } = await import('./background-sessions.mjs');
  for (let i = 0; i < 300; i++) {
    try {
      const entry = await readEntry(id, process.env);
      if (entry.pid === process.pid && entry.runId === runId) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the parent process to register this background run. No task was started.');
}

// Save the conversation while a turn is still running (at most every few
// seconds), so closing the terminal or a crash mid-task keeps the work done
// so far resumable with oasis -c. The end-of-turn save still runs as before.
const MID_TURN_SAVE_MS = 3000;
function saveMidTurn(session) {
  if (!session || session.midTurnSaving) return;
  const due = (session.midTurnSavedAt || 0) + MID_TURN_SAVE_MS;
  if (Date.now() < due) {
    if (!session.midTurnTimer) {
      session.midTurnTimer = setTimeout(() => { session.midTurnTimer = null; saveMidTurn(session); }, due - Date.now());
      session.midTurnTimer.unref?.();
    }
    return;
  }
  session.midTurnSaving = true;
  session.midTurnSavedAt = Date.now();
  session.midTurnSave = saveSession(session).catch(() => {}).finally(() => { session.midTurnSaving = false; });
}
// What a retried model response was, in plain words: a dropped or stalled
// stream, or a tool call the model sent in a form that could not be parsed.
export function streamRestartNotice(info = {}, partialShown = false) {
  const count = ' (' + (info.attempt || 1) + '/' + (info.limit || 2) + ')';
  if (info.kind === 'malformed-call') return "[retry] The model's tool call could not be parsed; asking it to send the call again" + count + '.';
  const reason = String(info.reason || '');
  const what = /stalled/i.test(reason) ? 'The model response stalled' : /malformed/i.test(reason) ? "The model's tool call could not be parsed" : /high demand|overloaded|503|unavailable/i.test(reason) ? 'The provider broke off the response (overloaded)' : 'The model connection dropped mid-response';
  return '[network] ' + what + '; retrying' + count + '.' + (partialShown ? ' The partial reply above is discarded.' : '');
}

// "⎿ Read 3 lines" -> "⎿ add.mjs · Read 3 lines" for a result printed away
// from its header (parallel tool calls).
export function labelToolResult(summary, name, call) {
  let args = {};
  try { args = JSON.parse(call && call.function && call.function.arguments || '{}') || {}; } catch {}
  const raw = args.path || args.file_path || args.filePath || args.pattern || args.query || args.command || args.url || '';
  const label = String(Array.isArray(raw) ? raw.join(' ') : raw).replace(/\s+/g, ' ').trim();
  const short = label.length > 40 ? label.slice(0, 39) + '…' : label;
  if (!short) return summary;
  return String(summary).replace('⎿ ', '⎿ ' + short + ' · ');
}

async function settleMidTurnSave(session) {
  if (!session) return;
  if (session.midTurnTimer) { clearTimeout(session.midTurnTimer); session.midTurnTimer = null; }
  if (session.midTurnSave) await session.midTurnSave;
}

async function runPrompt(prompt, root, autoApprove, session = null, persistence = {}, modeOptions = {}) {
  const requestText = String(prompt || '');
  if (AUTO_HALT && !String(prompt || '').startsWith(WAKE_PREFIX) && !modeOptions.selfPacedLoop) AUTO_HALT = null;
  // The parent starts this process before persisting its PID; wait so a fast
  // background task cannot finish and then be overwritten by the parent's stale
  // initial "running" record.
  await waitForBackgroundRegistration();
  const config = await loadConfig();
  if (SESSION_OPTIONS.model) config.model = SESSION_OPTIONS.model;
  if (SESSION_OPTIONS.effort) Object.assign(config, applyEffort(config, SESSION_OPTIONS.effort));
  if (modeOptions.model) config.model = modeOptions.model;
  if (modeOptions.effort) Object.assign(config, applyEffort(config, modeOptions.effort));
  try {
    const expanded = await expandFileMentions(root, prompt, { images: visionEnabled(config) });
    if (expanded.files.length) {
      stdout.write('[context] Included ' + expanded.files.map((file) => '@' + file).join(', ') + '\n');
      prompt = expanded.text;
    }
    if (expanded.images && expanded.images.length) modeOptions = { ...modeOptions, images: expanded.images };
  } catch {}
  if (!config.configured) {
    stdout.write('Oasis needs a model provider for general coding tasks. Run oasis setup first, or configure OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL, and the matching API-key environment variable. Local Ollama-style endpoints can use a loopback URL without an API key.\n');
    return session;
  }
  if (!session) {
    let restored = null;
    if (persistence.resumeId) {
      restored = await loadSession(root, persistence.resumeId);
      if (SESSION_OPTIONS.forkSession) { stdout.write('[session] Forking ' + restored.id + ' into a new session.\n'); restored = { ...restored, id: null }; }
      stdout.write('[session] Resuming ' + restored.id + ' (' + restored.messages.length + ' saved messages, last updated ' + restored.updatedAt + ').\n');
    }
    session = await createSession({ root, config, restore: restored, ...sessionCreateOptions(), watchFiles: true });
  } else if (path.resolve(session.worktreeSession ? session.worktreeSession.originalRoot : session.root) !== path.resolve(root)) {
    closeSession(session);
    session = await createSession({ root, config, ...sessionCreateOptions(), watchFiles: true });
  }
  if (modeOptions.selfPacedLoop !== undefined) session.selfPacedLoop = modeOptions.selfPacedLoop;
  // MCP servers can ask the user for input mid-call (elicitation); answer in the terminal.
  if (stdin.isTTY && stdout.isTTY && !session.elicit) {
    session.elicit = async (request) => {
      const { askElicitationInTerminal } = await import('./mcp-client-features.mjs');
      const { openInBrowser } = await import('./mcp-oauth.mjs');
      endStream();
      return await askElicitationInTerminal(request, { ask: (question) => askLine(question), write: (text) => stdout.write(text), openUrl: (url) => openInBrowser(url) });
    };
  }
  // watchPaths returned by a CwdChanged hook carry over to the session for the new directory.
  if (persistence.watchPaths) {
    const { startHookWatchers } = await import('./file-watch.mjs');
    const { hookOptions: hookOpts, reloadSessionSettings } = await import('./agent.mjs');
    if (session.fileWatchers) session.fileWatchers.setDynamicPaths(persistence.watchPaths);
    else { session.hookWatchPaths = persistence.watchPaths; try { session.fileWatchers = startHookWatchers(session, { liveReload: true, hookOptions: () => hookOpts(session), reload: reloadSessionSettings }); } catch {} }
    persistence.watchPaths = null;
  }
  session.config = carryLearnedContextWindow(session.config, config);
  // Auto-connect to the IDE when launched from a VS Code (or fork) integrated terminal.
  if (!session.ideChecked) {
    session.ideChecked = true;
    if (process.env.OASIS_IDE_PORT || process.env.TERM_PROGRAM === 'vscode' || process.env.OASIS_IDE === 'auto') {
      try {
        const { discoverIde, attachIde } = await import('./ide.mjs');
        const client = await discoverIde(root, process.env);
        if (client) { attachIde(session, client); stdout.write('[ide] Connected to ' + client.ideName + ' — selections are shared and edits open as diffs there.\n'); }
      } catch {}
    }
  }
  if (session.ide) ideSession = session;
  if (session.ide) {
    try {
      const { ideSelectionContext } = await import('./ide.mjs');
      const selection = await ideSelectionContext(session);
      if (selection) { stdout.write('[ide] ' + selection.label + '\n'); prompt = selection.text + '\n\n' + prompt; }
    } catch {}
  }
  if (!session.onAgentNotice) session.onAgentNotice = (text) => stdout.write('\n[agents] ' + String(text).split('\n')[0] + ' The report will be shared with Oasis on your next message (/tasks to read it now).\n');
  reportSessionNotices(session);
  if (session.mcpFailures && session.mcpFailures.length) {
    // Print each failure once, but keep it so /mcp can show it and /mcp reconnect can retry it.
    for (const failure of session.mcpFailures) {
      if (failure.reported) continue;
      Object.defineProperty(failure, 'reported', { value: true, enumerable: false, configurable: true });
      stdout.write('[MCP] ' + failure.name + ' did not start: ' + failure.error + (failure.config ? ' (retry with /mcp reconnect ' + failure.name + ')' : '') + '\n');
    }
  }
  // Ctrl+C stops the current task and returns to the prompt; a second Ctrl+C exits.
  const controller = new AbortController();
  const onInterrupt = (kind) => {
    if (controller.signal.aborted && kind === 'escape') return;
    if (controller.signal.aborted) { stdout.write('\nExiting Oasis.\n'); closeSession(session); process.exit(130); }
    endStream();
    stdout.write('\n[interrupted] Stopping the current task. Press Ctrl+C again to quit' + '.\n');
    controller.abort();
  };
  if (stdin.isTTY) process.on('SIGINT', onInterrupt);
  const turnStartedAt = Date.now();
  CURRENT_TURN_STARTED_AT = turnStartedAt;
  if (session && session.settings) configureSounds({ enabled: typeof session.settings.sounds === 'boolean' ? session.settings.sounds : undefined, volume: session.settings.soundVolume });
  let lastToolHeader = null;
  let todosDone = completedTodoCount(session && session.todos);
  turnKeys = startTurnKeys(onInterrupt, (text) => !controller.signal.aborted && !modeOptions.fork && steerSession(session, text));
  try {
    const fork = modeOptions.fork;
    const runner = fork ? (s, p, o) => runForkedTurn(s, p, { ...o, agent: fork.agent, label: fork.label, env: process.env }) : modeOptions.planOnly ? runAgentPlan : runAgentTurn;
    // allowed-tools from a command apply only while it runs.
    const granted = session.permissions && Array.isArray(modeOptions.grantTools) ? session.permissions.sessionAllow.length : -1;
    if (granted >= 0) for (const rule of modeOptions.grantTools) session.permissions.rememberForSession(rule);
    if (fork) stdout.write('[fork] Running ' + fork.label + ' in a ' + (fork.agent || 'general-purpose') + ' subagent.\n');
    const result = await runner(session, prompt, {
      signal: controller.signal,
      autoApprove,
      ...(modeOptions.images ? { images: modeOptions.images } : {}),
      ...(modeOptions.expansion ? { expansion: modeOptions.expansion } : {}),
      onThinkingBudget: (budget) => stdout.write('[thinking] Extended thinking on for this task (budget ' + budget + ' tokens).\n'),
      onReasoningEffort: (effort) => stdout.write('[thinking] Reasoning effort ' + effort + ' for this task.\n'),
      onMemoryRecall: (ids) => stdout.write('[memory] Recalled ' + ids.join(', ') + '\n'),
      onSteer: (info) => { endStream(); stdout.write((colorEnabled(stdout) ? '\x1b[2m' : '') + '  ↳ Oasis read your ' + (info.delivered === 1 ? 'message' : info.delivered + ' messages') + ' and is adjusting' + (colorEnabled(stdout) ? '\x1b[22m' : '') + '\n'); },
      ...(stdout.isTTY ? { onModelWait } : {}),
      onProviderRetry: (event) => { stopWaitIndicator(); const dim = colorEnabled(process.stderr); process.stderr.write((dim ? '\x1b[2m' : '') + '  ⎿ Provider ' + (event.status ? 'error ' + event.status : 'connection failed') + (event.reason && event.status ? ' (' + event.reason + ')' : '') + ' · retrying in ' + formatWait(event.waitMs) + ' (' + event.attempt + '/' + event.limit + ')' + (dim ? '\x1b[22m' : '') + '\n'); },
      onRateLimitWait: (event) => { stopWaitIndicator(); process.stderr.write('[rate limit] Waiting ' + formatWait(event.waitMs) + ' for the provider limit to reset (until ' + event.until + ').' + (event.compactTools ? ' Switched to the compact tool set to fit its per-minute token limit; other tools stay available through tool_search.' : '') + '\n'); },
      approval: (message, forceInteractive = false, meta = {}) => approve(message, forceInteractive, autoApprove, meta),
      ...(stdin.isTTY && stdout.isTTY ? { askUser: (question) => { endStream(); return askQuestionInTerminal(question); } } : {}),
      onToolStart: (event) => { endStream(); lastToolHeader = event && event.call ? event.call.id : null; stdout.write('\n' + (richOutput() ? describeTool(event, { color: true }) : describeToolStart(event)) + '\n'); },
      onAutoMode: (event) => { endStream(); stdout.write('[auto] ' + (event.decision === 'allow' ? 'Allowed' : event.decision === 'block' ? 'Blocked' : 'Asking you about') + ' ' + event.tool + (event.reason ? ': ' + event.reason : '') + '\n'); },
      onUsage: (usage) => recordUsage(USAGE, usage),
      onThrash: (info) => { endStream(); stdout.write('[stuck?] `' + info.command + '` has failed the same way after ' + info.count + ' rounds of edits; Oasis asked the model to step back and diagnose before editing again.\n'); },
      onStreamRestart: (info) => { const partial = endStream(); stdout.write(streamRestartNotice(info, partial) + '\n'); },
      onContextOverflow: (info) => { endStream(); stdout.write(info.smallContextTools ? '\n[context] The model server has a ' + info.contextWindow + '-token window; switched to the small-context tool set (others stay reachable through tool_search) and retrying.\n' : '\n[context] The provider said the request was too long for the context window; compacted (' + Math.round(info.beforeChars / 1000) + 'k → ' + Math.round(info.afterChars / 1000) + 'k chars) and retrying.\n'); },
      onCompactionStart: (info) => { endStream(); stdout.write('\n[context] Compacting ' + info.messages + ' older messages (about ' + Number(info.beforeTokens || 0).toLocaleString('en-US') + ' tokens; local fallback after ' + info.timeoutSeconds + 's)…\n'); },
      onCompaction: (info) => stdout.write('\n[context] ' + String(info.note || 'Compacted older conversation history.') + (info.notesSaved ? ' Continuity note saved in .oasis/session-notes.md.' : ' Continuity note was not saved.') + '\n'),
      // MessageDisplay hooks see whole messages, so streaming is off while any are configured.
      ...(stdout.isTTY && process.env.OASIS_NO_STREAM !== '1' && !hasConfiguredHooks(session.hooks || {}, 'MessageDisplay') ? { onDelta: streamDelta } : {}),
      onToolResult: ({ name, result, call }) => {
        if (persistence.enabled) saveMidTurn(session);
        if (name === 'todo_write' && result && !result.error) { const done = completedTodoCount(Array.isArray(result.todos) ? result.todos : session.todos); if (done > todosDone) playSound('task', { stream: stdout }); todosDone = done; }
        if (richOutput() && call && ['edit_file', 'multi_edit', 'write_file'].includes(name)) {
          let args = {};
          try { args = JSON.parse(call.function && call.function.arguments || '{}'); } catch {}
          const shown = describeEdit({ name, args, result }, { color: true });
          if (shown) stdout.write(shown + '\n');
        }
        let summary = richOutput() && !verboseEnabled(session) ? describeToolResult(name, result, { color: true }) : '';
        // Parallel calls print every header first; name the call on each result
        // that does not sit right under its own header.
        if (summary && call && lastToolHeader && call.id !== lastToolHeader) summary = labelToolResult(summary, name, call);
        if (summary) stdout.write(summary + '\n');
        else if (result && (result.error || result.exitCode !== undefined && result.exitCode !== 0)) {
          stdout.write('[tool result] ' + name + ': ' + String(result.error || ('exit code ' + result.exitCode)).slice(0, 700) + '\n');
        }
        if (summary) lastToolHeader = '#result'; // a later result in the batch is away from its header too
        if (name === 'auto_test' && result && result.passed) stdout.write('[auto-test] passed in ' + (Math.round(result.durationMs / 100) / 10) + 's\n');
        if (name === 'report_findings' && result && !result.error) { endStream(); stdout.write('\n[findings]\n' + formatFindings(session.reportedFindings, { color: colorEnabled(stdout) }) + '\n'); }
        if (verboseEnabled(session)) { const shown = verboseToolOutput(name, result, { color: colorEnabled(stdout) }); if (shown) stdout.write(shown + '\n'); }
      },
      onText: (text) => {
        if (endStream()) return;
        if (richOutput()) { const md = new MarkdownStream({ write: (chunk) => stdout.write(chunk), color: true, columns: () => stdout.columns || 80, prefix: '\x1b[38;2;251;191;36m●\x1b[39m ' }); md.push(String(text)); md.end(); }
        else stdout.write('\nOasis> ' + text + '\n');
      }
    }).finally(() => { if (granted >= 0) session.permissions.sessionAllow.length = granted; });
    USAGE.turns += 1;
    if (result.modelRouting && result.modelRouting.enabled) {
      const taskUsage = result.taskUsage || {};
      if (result.modelRouting.tier === 'easy') {
        USAGE.routingTasks = Number(USAGE.routingTasks || 0) + 1;
        if (typeof taskUsage.savingsUSD === 'number') USAGE.routingSavingsUSD = Number(USAGE.routingSavingsUSD || 0) + taskUsage.savingsUSD;
      }
      const costText = typeof taskUsage.costUSD === 'number' ? formatUsd(taskUsage.costUSD) : 'unknown';
      const baselineText = typeof taskUsage.strongModelCostUSD === 'number' ? formatUsd(taskUsage.strongModelCostUSD) : 'unknown';
      const savingsText = typeof taskUsage.savingsUSD === 'number'
        ? (taskUsage.savingsUSD >= 0 ? 'saved ' : 'cost ' + formatUsd(Math.abs(taskUsage.savingsUSD)) + ' more than ') + (taskUsage.savingsUSD >= 0 ? formatUsd(taskUsage.savingsUSD) : 'the strong-model estimate')
        : 'savings unavailable (pricing not configured for both models)';
      stdout.write('[routing] ' + result.modelRouting.tier + ' · ' + result.modelRouting.selectedModel +
        ' · ' + taskUsage.totalTokens + ' tokens · ' + costText + ' vs strong-model estimate ' + baselineText +
        ' · ' + savingsText + '\n');
    }
    if (result.verification && result.verification.required) {
      const evidence = result.verification;
      const check = evidence.checkRequired
        ? (evidence.lastCheck
          ? evidence.lastCheck.kind + (evidence.lastCheck.passed ? ' passed' : ' failed') +
            (Number.isInteger(evidence.lastCheck.exitCode) ? ' (exit ' + evidence.lastCheck.exitCode + ')' : '')
          : 'not recorded')
        : 'not required';
      const lsp = Array.isArray(evidence.lsp) ? evidence.lsp : [];
      const lspIssues = lsp.filter((item) => item.status === 'issues' || item.status === 'errors' || (item.status === 'unavailable' && item.blocking !== false)).length;
      const lspSkipped = lsp.filter((item) => item.status === 'unavailable' && item.blocking === false).length;
      const lspStatus = lsp.length && lspSkipped === lsp.length
        ? 'LSP skipped (no language server installed for ' + (lsp.length === 1 ? 'this file' : 'these ' + lsp.length + ' files') + ')'
        : lsp.length
        ? 'LSP ' + lspIssues + ' issue(s) across ' + lsp.length + ' changed file(s)' + (lspSkipped ? ' (' + lspSkipped + ' skipped: no language server installed)' : '')
        : 'LSP not reported';
      const verificationLine = (evidence.complete ? 'Complete' : 'Incomplete') +
        ' · diff ' + (evidence.diffReviewed ? 'reviewed' : 'not reviewed') +
        ' · check ' + check + ' · ' + lspStatus +
        (evidence.autoTest ? ' · auto-test ' + (evidence.autoTest.passed ? 'passed' : 'failed') + ' (' + evidence.autoTest.attempts + ' run' + (evidence.autoTest.attempts === 1 ? '' : 's') + ')' : '');
      if (richOutput()) {
        // One plain line: what was checked, or what still is not. The full
        // evidence stays in the plain output, -p JSON and /status.
        const issues = Array.isArray(evidence.issues) ? evidence.issues : [];
        const facts = [
          evidence.lastCheck ? evidence.lastCheck.kind + (evidence.lastCheck.passed ? ' passed' : ' failed') : '',
          evidence.autoTest ? 'auto-test ' + (evidence.autoTest.passed ? 'passed' : 'failed') : '',
          lspIssues ? lspIssues + ' editor diagnostic' + (lspIssues === 1 ? '' : 's') : ''
        ].filter(Boolean);
        const text = evidence.complete
          ? '\x1b[32m✓ Checked\x1b[39m' + (facts.length ? '\x1b[2m · ' + facts.join(' · ') + '\x1b[22m' : '')
          : '\x1b[33m! Not fully checked\x1b[39m\x1b[2m' + (issues.length ? ': ' + issues.join('; ') : facts.length ? ' · ' + facts.join(' · ') : '') + '\x1b[22m';
        stdout.write('\n' + wrapRendered('  ' + text, stdout.columns || 80, { indent: 4 }) + '\n');
      } else stdout.write('[verification] ' + verificationLine + '\n');
      if (!richOutput() && !evidence.complete && Array.isArray(evidence.issues) && evidence.issues.length) {
        stdout.write('[verification] Blockers: ' + evidence.issues.join('; ') + '. Do not treat the task as fully verified yet.\n');
      }
    } else if (result.verificationIncomplete && Array.isArray(result.verificationIssues) && result.verificationIssues.length) {
      stdout.write('[verification] Incomplete: ' + result.verificationIssues.join('; ') + '. Do not treat the task as fully verified yet.\n');
    } else if (!result.finished) {
      stdout.write('Oasis reached a safety limit before the task was fully completed. Review the summary and continue in a new turn if appropriate.\n');
    }
    const changedThisTurn = result.verification && Array.isArray(result.verification.changedPaths) ? result.verification.changedPaths : [];
    if (changedThisTurn.length) {
      const { autoCommitEnabled, autoCommitTurn, describeAutoCommit } = await import('./auto-commit.mjs');
      if (autoCommitEnabled(session, process.env)) {
        const line = describeAutoCommit(await autoCommitTurn({ root: session.root || root, paths: changedThisTurn, prompt: requestText }).catch((error) => ({ error: error.message })));
        if (line) stdout.write((richOutput() ? '\x1b[2m  ' + line + '\x1b[22m' : '[auto-commit] ' + line) + '\n');
      }
    }
    if (richOutput()) stdout.write('\x1b[2m  ' + formatTurnSummary({ ms: Date.now() - turnStartedAt, toolCalls: result.toolCalls, tokens: result.tokensUsed, finished: result.finished !== false }) + '\x1b[22m\n');
    const doneSound = Date.now() - turnStartedAt >= DONE_SOUND_AFTER_MS && playSound('done', { stream: stdout });
    notifyAttention('OASIS · ' + formatTurnSummary({ ms: Date.now() - turnStartedAt, toolCalls: result.toolCalls, tokens: result.tokensUsed, finished: result.finished !== false }), { elapsedMs: Date.now() - turnStartedAt, soundPlayed: doneSound, stream: stdout });
  } catch (error) {
    endStream();
    if (controller.signal.aborted || error.name === 'AbortError') {
      repairInterruptedHistory(session);
      stdout.write('[interrupted] Task stopped. Changes made before the interruption remain; use /rewind 1 to undo them.\n');
    } else {
      stdout.write('\nOASIS error: ' + (error.message || String(error)) + '\n');
      playSound('error', { stream: stdout });
      haltAutoContinue(error);
    }
  } finally {
    stopWaitIndicator();
    process.removeListener('SIGINT', onInterrupt);
    if (turnKeys) { turnKeys.stop(); turnKeys = null; }
    // Steering that arrived too late for this turn (or after Esc) is never lost:
    // it becomes the next message.
    const undelivered = takeSteering(session);
    if (undelivered.length) {
      QUEUED_INPUT.unshift(...undelivered);
      stdout.write('[queued] ' + undelivered.length + ' message' + (undelivered.length === 1 ? '' : 's') + ' sent during the turn will run next.\n');
    }
  }
  reportSessionNotices(session);
  if (persistence.enabled) {
    try {
      await settleMidTurnSave(session);
      const saved = await saveSession(session);
      if (!session.announcedSave || session.announcedSave !== saved.id) {
        session.announcedSave = saved.id;
        if (process.env.OASIS_QUIET_SESSIONS === '1') {}
        else if (richOutput()) stdout.write('\x1b[2m  Chat saved · continue later with oasis -c\x1b[22m\n');
        else stdout.write((colorEnabled(stdout) ? '\x1b[2m' : '') + '[session] Saved as ' + saved.id.slice(0, 8) + ' · resume with oasis -c or oasis -r ' + saved.id + (colorEnabled(stdout) ? '\x1b[22m' : '') + '\n');
      }
    } catch (error) {
      stdout.write('[session] Could not save history: ' + error.message + '\n');
    }
  }
  return session;
}

async function streamInputChannel() {
  const { createStreamJsonChannel } = await import('./headless.mjs');
  const lines = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
  return createStreamJsonChannel(lines, (event) => stdout.write(JSON.stringify(event) + '\n'));
}

async function readPipedStdin(options = {}) {
  // Only read stdin when it is a pipe, socket, or redirected file (not a terminal or
  // /dev/null). Use `< /dev/null` if a job inherits an open stdin it never closes.
  let info;
  try { info = fstatSync(0); } catch { return ''; }
  if (stdin.isTTY || !(info.isFIFO() || info.isFile() || info.isSocket())) return '';
  // With a prompt already on the command line, an inherited pipe that never sends
  // anything (CI runners, IDE tasks, `nohup`) used to hang `oasis -p` silently forever.
  // Wait a few seconds for the first byte, then go on without stdin.
  const firstByteMs = info.isFile() ? 0 : Number(options.firstByteMs || 0);
  let data = '';
  const iterator = stdin[Symbol.asyncIterator]();
  try {
    let first = true;
    while (true) {
      let timer = null;
      const next = iterator.next();
      const step = first && firstByteMs > 0
        ? await Promise.race([next, new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), firstByteMs); })])
        : await next;
      if (timer) clearTimeout(timer);
      if (step.timeout) {
        process.stderr.write('[oasis] stdin is open but sent nothing for ' + Math.round(firstByteMs / 1000) + 's; continuing with the prompt only (redirect `< /dev/null` to skip the wait).\n');
        try { stdin.pause(); stdin.unref?.(); } catch {}
        return '';
      }
      first = false;
      if (step.done) break;
      data += step.value;
      if (data.length > 1024 * 1024) break;
    }
  } finally {
    if (data.length > 1024 * 1024) { try { await iterator.return?.(); } catch {} }
  }
  return data.slice(0, 1024 * 1024);
}

async function printMode(root, headless, args, autoApprove, persistence) {
  let prompt = [headless.prompt, ...args].filter(Boolean).join(' ').trim();
  const streamInput = headless.inputFormat === 'stream-json';
  const stdinWait = Number(process.env.OASIS_STDIN_WAIT_SECONDS);
  const piped = streamInput ? '' : await readPipedStdin({ firstByteMs: prompt ? (Number.isFinite(stdinWait) && stdinWait >= 0 ? stdinWait : 3) * 1000 : 0 });
  if (piped.trim()) prompt = prompt ? prompt + '\n\n<stdin>\n' + piped + '\n</stdin>' : piped;
  if (prompt.trim().startsWith('/')) {
    // oasis -p "/review src" runs a custom command or skill, like the interactive prompt.
    const custom = await resolveCustomCommand(root, prompt.trim(), await customCommandContext(root)).catch(() => null);
    if (custom) {
      for (const item of custom.shell || []) if (item.skipped) stderr.write('[command] Skipped !`' + item.command + '`: ' + item.skipped + '\n');
      prompt = custom.prompt;
      if (custom.command.model && !SESSION_OPTIONS.model) SESSION_OPTIONS.model = custom.command.model;
      if (custom.command.effort && !SESSION_OPTIONS.effort) SESSION_OPTIONS.effort = custom.command.effort;
    } else {
      const skillCommand = await resolveSkillCommand(root, prompt.trim()).catch(() => null);
      if (skillCommand) prompt = skillCommand.options.fork ? 'Use the task tool with subagent_type "' + (skillCommand.options.fork.agent || 'general-purpose') + '" to run this, then report its result:\n\n' + skillCommand.prompt : skillCommand.prompt;
    }
  }
  if (!prompt.trim() && !streamInput) throw new Error('Usage: oasis -p "your task" [--output-format text|json|stream-json] [--max-turns N] [--model ID]');
  const config = await loadConfig();
  if (SESSION_OPTIONS.model) config.model = SESSION_OPTIONS.model;
  if (SESSION_OPTIONS.effort) Object.assign(config, applyEffort(config, SESSION_OPTIONS.effort));
  if (!config.configured) {
    const envKeys = providerKeysInEnv();
    if (envKeys.length) throw new Error('No model provider is configured, but ' + envKeys.map((item) => item.name).join(', ') + (envKeys.length > 1 ? ' are' : ' is') + ' set.\n  Run: oasis connect --from-env' + (envKeys.length > 1 ? ' [' + envKeys.map((item) => item.provider).join('|') + ']' : '') + '\n  It finds a model that works with that key and saves it.');
  }
  if (!config.configured) throw new Error('No model provider is configured.\n  Pick one:\n    oasis connect        paste an API key, model link or local server address\n    oasis setup          guided setup in this terminal (API key, free gateway, or Ollama)\n    oasis setup --auto   detect this computer and any local model server, then configure the best fit\n    oasis web --open     set it up in the browser workspace instead\n    OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL + API key variable   for CI and scripts\n  Guide: https://github.com/FAHTHIZ/oasis/blob/main/docs/INSTALL.md');
  if (SESSION_OPTIONS.channels.length || SESSION_OPTIONS.devChannels.length) stderr.write('[channels] Channels need an interactive session; ignored with -p.\n');
  // CI runners and supervisors stop jobs with SIGTERM. Commands run in their own
  // process group, so without this they would outlive Oasis and the job would
  // exit 0. Abort the turn (which stops running commands), then exit 128+signal.
  const stopController = new AbortController();
  let stopSignal = null;
  const SIGNAL_CODES = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
  const onStopSignal = (name) => {
    if (stopSignal) process.exit(128 + SIGNAL_CODES[name]);
    stopSignal = name;
    stderr.write('[oasis] Received ' + name + '; stopping the task and any running commands.\n');
    stopController.abort();
    setTimeout(() => process.exit(128 + SIGNAL_CODES[name]), 5000).unref();
  };
  const stopHandlers = Object.keys(SIGNAL_CODES).map((name) => [name, () => onStopSignal(name)]);
  for (const [name, handler] of stopHandlers) process.on(name, handler);
  let exitCode;
  try {
  let summary;
  ({ exitCode, summary } = await runHeadless({
    signal: stopController.signal,
    prompt, root, config, autoApprove,
    outputFormat: headless.outputFormat,
    maxTurns: headless.maxTurns,
    planOnly: headless.planOnly,
    jsonSchema: headless.jsonSchema || null,
    sessionOptions: { ...sessionCreateOptions(), channels: [] },
    persistence: { ...persistence, fork: Boolean(SESSION_OPTIONS.forkSession) },
    env: process.env,
    ...(streamInput ? { inputStream: await streamInputChannel() } : {}),
    includePartial: Boolean(headless.includePartial),
    replayUser: Boolean(headless.replayUser),
    permissionPromptTool: headless.permissionPromptTool || null,
    permissionPrompts: headless.permissionPrompts || null,
    includeHookEvents: Boolean(headless.includeHookEvents),
    forwardSubagentText: Boolean(headless.forwardSubagentText),
    promptSuggestions: Boolean(headless.promptSuggestions)
  }));
  // Codex's -o/--output-last-message: also write the final reply to a file.
  if (headless.outputLastMessage && summary) {
    const text = summary.structured_output !== undefined ? JSON.stringify(summary.structured_output) : String(summary.result || '');
    await writeFile(path.resolve(headless.outputLastMessage), text + (text.endsWith('\n') ? '' : '\n')).catch((error) => stderr.write('[oasis] Could not write ' + headless.outputLastMessage + ': ' + error.message + '\n'));
  }
  } finally { for (const [name, handler] of stopHandlers) process.removeListener(name, handler); }
  if (stopSignal) exitCode = 128 + SIGNAL_CODES[stopSignal];
  process.exitCode = exitCode;
  if (process.env.OASIS_BACKGROUND_ID) {
    const { finishBackgroundSession } = await import('./background-sessions.mjs');
    await finishBackgroundSession(process.env.OASIS_BACKGROUND_ID, { exitCode }, process.env).catch(() => {});
  }
}

// Setup hooks (--init, --init-only, --maintenance): command hooks only, output discarded.
async function runSetupHooks(root, trigger) {
  const { runHooks, hasHooks } = await import('./hooks.mjs');
  const settings = await loadSettings(root).catch(() => null);
  if (!settings || !hasHooks(settings.hooks, 'Setup')) return;
  const result = await runHooks('Setup', { session_id: 'setup', trigger }, { hooks: settings.hooks, root, env: process.env }).catch(() => null);
  if (result) for (const message of result.messages) stderr.write('[hook] ' + message + '\n');
}

// CwdChanged hooks run when /cd switches the workspace.
async function fireCwdChanged(session, oldRoot, newRoot) {
  const { runHooks, hasHooks } = await import('./hooks.mjs');
  const { hookOptions } = await import('./agent.mjs');
  const hooks = session ? session.hooks : (await loadSettings(oldRoot).catch(() => ({}))).hooks;
  if (!hasHooks(hooks, 'CwdChanged')) return;
  const options = session ? hookOptions(session) : { hooks, root: oldRoot, env: process.env };
  const result = await runHooks('CwdChanged', { session_id: session && session.sessionId || 'unsaved', old_cwd: oldRoot, new_cwd: newRoot }, options).catch(() => null);
  if (result) for (const message of result.messages) stdout.write('[hook] ' + message + '\n');
  return result && Array.isArray(result.watchPaths) ? result.watchPaths.filter((item) => path.isAbsolute(item)) : null;
}

// oasis -w NAME: run the whole session in a fresh git worktree on its own branch.
async function startSessionWorktree(root, name, out) {
  const { createWorktree } = await import('./worktrees.mjs');
  let worktree;
  const settings = await loadSettings(root).catch(() => ({ hooks: {} }));
  const hookOptions = { hooks: settings.hooks || {}, root, env: process.env };
  try { worktree = await createWorktree(root, name, { hookOptions }); }
  catch (error) { throw new Error('--worktree: ' + error.message.replace(/isolation "worktree"/g, '--worktree').replace(/, or launch the subagent without isolation/, '')); }
  worktree.hookOptions = hookOptions;
  out.write('[worktree] Working in ' + worktree.relative + (worktree.hook ? ' (created by a WorktreeCreate hook)' : ' on branch ' + worktree.branch) + '. Your main checkout is untouched.\n');
  return worktree;
}

// oasis -w NAME --tmux: run the worktree session in its own tmux session (a new window when
// already inside tmux, which keeps the worktree for you to clean up).
async function tmuxWorktreeSession(root, name, rawArgs) {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) throw new Error('--tmux needs tmux on PATH.');
  const worktree = await startSessionWorktree(root, name, stdout);
  const inner = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--tmux' || arg === '--tmux=classic') continue;
    if (arg === '-w' || arg === '--worktree') { if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) i++; continue; }
    if (arg === '-C' || arg === '--cwd' || arg === '--cd') { i++; continue; }
    inner.push(arg);
  }
  const command = [process.execPath, fileURLToPath(import.meta.url), '-C', worktree.path, ...inner];
  const label = 'oasis-' + String(name).replace(/[^\w-]/g, '-').slice(0, 40);
  if (process.env.TMUX) {
    spawnSync('tmux', ['new-window', '-n', label, '-c', worktree.path, ...command], { stdio: 'inherit' });
    stdout.write('[tmux] Opened window ' + label + ' in ' + worktree.relative + '. The worktree is kept; remove it with git worktree remove ' + worktree.relative + ' when done.\n');
    return;
  }
  spawnSync('tmux', ['new-session', '-s', label, '-c', worktree.path, ...command], { stdio: 'inherit' });
  await endSessionWorktree(root, worktree, stdout);
}

async function endSessionWorktree(root, worktree, out) {
  const { removeWorktree } = await import('./worktrees.mjs');
  if (worktree.hook) {
    // Hook-created worktrees have no git status to check, so they are always kept.
    out.write('[worktree] Kept ' + worktree.path + ' (created by a WorktreeCreate hook). Delete it yourself when you are done.\n');
    return;
  }
  const { execFile } = await import('node:child_process');
  const git = (args, cwd) => new Promise((resolve) => execFile('git', args, { cwd }, (error, stdout) => resolve(error ? null : stdout.trim())));
  const status = await git(['status', '--porcelain', '--untracked-files=all'], worktree.path);
  const head = await git(['rev-parse', 'HEAD'], worktree.path);
  if (status === '' && head === worktree.base) {
    await removeWorktree(root, worktree, { deleteBranch: true });
    out.write('[worktree] No changes, so the worktree and branch ' + worktree.branch + ' were removed.\n');
    return;
  }
  out.write('[worktree] Kept ' + worktree.relative + ' (branch ' + worktree.branch + ')' + (status ? ' with uncommitted changes' : '') + '. Review with: git -C ' + worktree.relative + ' diff, merge with: git merge ' + worktree.branch + ', remove with: git worktree remove ' + worktree.relative + '\n');
}

// /loop: run the prompt, wait, repeat. Ctrl+C stops the current run and the loop.
// Trust and deny rules decide whether a command's !`cmd` lines may run.
async function customCommandContext(root) {
  const { PermissionPolicy } = await import('./permissions.mjs');
  const settings = await loadSettings(root).catch(() => null);
  return { env: process.env, trusted: Boolean(settings && settings.trusted), policy: settings ? new PermissionPolicy(settings) : null };
}

function customRunOptions(custom) {
  const command = custom.command;
  return {
    ...(command.model ? { model: command.model } : {}),
    ...(command.effort ? { effort: command.effort } : {}),
    ...(custom.grantTools ? { grantTools: custom.grantTools } : {}),
    expansion: { command_name: custom.name, command_source: command.scope || command.source || 'project', command_args: String(custom.args || ''), prompt: String(custom.prompt || '').slice(0, 20000) },
    ...(command.context === 'fork' ? { fork: { agent: command.agent, label: '/' + custom.name } } : {})
  };
}

function reportInlineShell(ran = []) {
  for (const item of ran) stdout.write(item.skipped ? '[command] Skipped !`' + item.command + '`: ' + item.skipped + '\n' : '[command] Ran !`' + item.command + '`' + (item.code ? ' (exit ' + item.code + ')' : '') + '\n');
}

async function runLoop(loop, root, autoApprove, session, persistence) {
  let stopped = false;
  let wake = null;
  const onStop = () => { stopped = true; if (wake) wake(); };
  process.on('SIGINT', onStop);
  try {
    for (let run = 1; !stopped && run <= (loop.times || 1000); run += 1) {
      stdout.write('[loop] Run ' + run + (loop.times ? ' of ' + loop.times : '') + '\n');
      let prompt = loop.prompt;
      let loopOptions = {};
      if (prompt.startsWith('/')) {
        const custom = await resolveCustomCommand(root, prompt, await customCommandContext(root)).catch(() => null);
        if (custom) { reportInlineShell(custom.shell); prompt = custom.prompt; loopOptions = customRunOptions(custom); }
      }
      if (loop.selfPaced) {
        loopOptions = { ...loopOptions, selfPacedLoop: true };
        if (session) session.loopWakeup = null;
        if (run === 1) prompt += '\n\n(This is a self-paced loop. After this run, call schedule_wakeup with delay_seconds for when to check again and a short reason, or with stop: true once the task is done or no longer needs checking.)';
      }
      session = await runPrompt(prompt, root, autoApprove, session, persistence, loopOptions);
      persistence.resumeId = null;
      if (AUTO_HALT) { stdout.write('[loop] Stopping: the last run hit a ' + (AUTO_HALT.kind === 'billing_error' ? 'billing/quota' : 'authentication') + ' error, so further runs would fail too.\n'); break; }
      const wakeup = loop.selfPaced && session ? session.loopWakeup : null;
      if (session && loop.selfPaced) session.loopWakeup = null;
      if (wakeup && wakeup.stop) { stdout.write('[loop] The model ended the loop' + (wakeup.reason ? ': ' + wakeup.reason : '.') + '\n'); break; }
      if (stopped || (loop.times && run >= loop.times)) break;
      const delayMs = wakeup && wakeup.delayMs ? wakeup.delayMs : loop.intervalMs;
      stdout.write('[loop] Next run in ' + formatInterval(delayMs) + (wakeup && wakeup.reason ? ' (' + wakeup.reason + ')' : loop.selfPaced ? ' (no schedule_wakeup call; default)' : '') + '. Press Ctrl+C to stop.\n');
      await new Promise((resolve) => { const timer = setTimeout(resolve, Number(process.env.OASIS_LOOP_DELAY_SCALE ? delayMs * Number(process.env.OASIS_LOOP_DELAY_SCALE) : delayMs)); wake = () => { clearTimeout(timer); resolve(); }; });
      wake = null;
    }
  } finally { process.removeListener('SIGINT', onStop); }
  if (session) session.selfPacedLoop = false;
  stdout.write('[loop] Stopped.\n');
  return session;
}

async function runGoal(goal, root, autoApprove, session, persistence) {
  let stopped = false;
  const onStop = () => { stopped = true; };
  process.on('SIGINT', onStop);
  const { evaluateGoal } = await import('./agent.mjs');
  let state = { condition: goal.condition, active: true, achieved: false, turns: 0, reason: '' };
  try {
    let prompt = 'Goal: ' + goal.condition + '\nWork toward this goal now. Verify results by running checks, not by assumption. Keep going until it is fully met.';
    while (!stopped && state.active && state.turns < goal.maxTurns) {
      state.turns += 1;
      stdout.write('[goal] Turn ' + state.turns + ' of up to ' + goal.maxTurns + '\n');
      session = await runPrompt(prompt, root, autoApprove, session, persistence);
      persistence.resumeId = null;
      if (!session) break;
      if (session.goal && session.goal !== state && !session.goal.active) break;
      session.goal = state;
      if (stopped) break;
      const verdict = await evaluateGoal(session, goal.condition).catch((error) => ({ met: false, reason: 'Check failed: ' + error.message }));
      state.reason = verdict.reason;
      if (verdict.met) { state.achieved = true; state.active = false; stdout.write('[goal] Met: ' + verdict.reason + '\n'); break; }
      stdout.write('[goal] Not met yet: ' + verdict.reason + '\n');
      prompt = 'The goal is not met yet. A reviewer said: ' + verdict.reason + '\nContinue working toward the goal: ' + goal.condition;
    }
  } finally { process.removeListener('SIGINT', onStop); }
  if (state.active) { state.active = false; stdout.write('[goal] Stopped after ' + state.turns + ' turn(s). /goal shows the last check.\n'); }
  if (session) session.goal = state;
  return session;
}

async function memoryCommand(args, root) {
  const { runBuiltinCommand } = await import('./slash.mjs');
  const handled = await runBuiltinCommand('memory', args.join(' '), { root, env: process.env });
  stdout.write(handled.output + '\n');
}

async function interactiveCommandList(root) {
  const list = Object.entries(BUILTIN_COMMANDS).map(([name, description]) => ({ name, description }));
  list.push({ name: 'init', description: 'Create project instructions for this workspace' }, { name: 'quit', description: 'Exit Oasis' });
  try { for (const [name, command] of (await loadCustomCommands(root, { env: process.env })).entries()) list.push({ name, description: (command && command.description) || 'Custom command' }); } catch {}
  try { for (const skill of await listAvailableSkills(root, { env: process.env })) list.push({ name: skill.name, description: skill.description ? 'Skill: ' + String(skill.description).slice(0, 70) : 'Skill' }); } catch {}
  return list;
}

async function pasteClipboardImage(root) {
  const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
  const attempts = process.platform === 'darwin'
    ? [['pngpaste', ['-']], ['osascript', ['-e', 'set png to (the clipboard as «class PNGf»)', '-e', 'set f to (open for access POSIX file "/dev/stdout" with write permission)', '-e', 'write png to f', '-e', 'close access f']]]
    : process.platform === 'win32' ? []
      : [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 5000 });
    const data = result.stdout;
    if (result.status === 0 && data && data.length > 8 && data[0] === 0x89 && data[1] === 0x50) {
      const dir = path.join(root, '.oasis', 'pastes');
      await mk(dir, { recursive: true });
      const name = 'paste-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      await wf(path.join(dir, name), data);
      return '@.oasis/pastes/' + name;
    }
  }
  return null;
}

// /vim and the "editorMode" setting; Claude Code's ~/.claude.json editorMode is honored too.
let claudeEditorMode;
function editorModeFor(session) {
  if (SESSION_OPTIONS.editorMode) return SESSION_OPTIONS.editorMode;
  if (session && session.settings && session.settings.editorMode) return session.settings.editorMode;
  if (claudeEditorMode === undefined) {
    claudeEditorMode = null;
    try {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const raw = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'));
      if (raw && (raw.editorMode === 'vim' || raw.editorMode === 'normal')) claudeEditorMode = raw.editorMode;
    } catch {}
  }
  return claudeEditorMode || 'normal';
}

async function readMainInput(root, session, state) {
  if (!stdin.isTTY || !stdout.isTTY || process.env.OASIS_SIMPLE_INPUT === '1') return askLine('\nYou> ');
  const color = colorEnabled(stdout);
  const currentMode = () => (session && session.permissions ? session.permissions.mode : SESSION_OPTIONS.permissionMode || 'default');
  stdout.write('\n');
  const initialText = queuedDraft;
  queuedDraft = '';
  const result = await readInput({
    initialText,
    history: state.history,
    color,
    vim: editorModeFor(session) === 'vim',
    prompt: (editor) => promptFor(editor.text, color),
    footer: (editor) => {
      const model = session && session.config && session.config.model || '';
      const contextPercent = session && Array.isArray(session.messages)
        ? estimateTokens(session.messages) / Math.max(1, contextWindowSize(session.config, process.env)) * 100
        : null;
      const spentUsd = session && session.budgetLedger ? session.budgetLedger.spentUsd : (session && typeof session.costUsd === 'number' ? session.costUsd : null);
      const budgetUsd = session && Number(session.maxBudgetUsd) > 0 ? Number(session.maxBudgetUsd) : Number(SESSION_OPTIONS.maxBudgetUsd) || 0;
      const priced = session && session.config ? priceFor(model, { config: session.config, overrides: session.pricing || {}, env: process.env }) : null;
      const costLabel = session ? (priced ? formatUsd(spentUsd == null ? 0 : spentUsd) : 'unknown') : '';
      return footerFor({ text: editor.text, mode: currentMode(), color, model, contextPercent, costLabel, budgetUsd, spentUsd });
    },
    complete: state.completer,
    onShiftTab: async () => {
      const mode = nextMode(currentMode(), { allowBypass: Boolean(SESSION_OPTIONS.allowBypass) });
      await runBuiltinCommand('mode', mode, { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS });
    },
    onReady: (submit) => { IDLE_SUBMIT = submit; setTimeout(() => wakeIfPending(session), 0); },
    onDoubleEscape: () => '/rewind',
    onPasteImage: () => pasteClipboardImage(root),
    voice: {
      enabled: () => {
        if (session && session.settings && session.settings.voiceDisabledByPolicy) return false;
        if (/^(0|false|off|1|true|on)$/i.test(String(process.env.OASIS_VOICE || ''))) return /^(1|true|on)$/i.test(process.env.OASIS_VOICE);
        if (typeof SESSION_OPTIONS.voiceEnabled === 'boolean') return SESSION_OPTIONS.voiceEnabled;
        const settings = session && session.settings || {};
        return settings.voiceEnabled === true || Boolean(settings.voice && settings.voice.enabled === true);
      },
      settings: () => (session && session.settings) || {},
      // The project's name helps the transcriber spell it.
      hints: () => [path.basename(root)]
    },
    onCommandPalette: async () => {
      const commands = await interactiveCommandList(root);
      const commandItems = commands.map((item) => ({
        label: '/' + String(item.name || '').slice(0, 100),
        description: redactApprovalSecrets(String(item.description || '')).slice(0, 180),
        value: '/' + String(item.name || '').slice(0, 100),
        category: Object.hasOwn(BUILTIN_COMMANDS, item.name) ? 'Commands' : 'Custom / skill'
      })).filter((item) => item.label.length > 1);
      const settingsItems = [
        { label: 'Provider setup', description: 'Connect or change your model provider', value: '/setup', category: 'Settings' },
        { label: 'Model for this session', description: 'View or switch the current model', value: '/model', category: 'Settings' },
        { label: 'Permission mode', description: 'Choose Ask, Plan, Auto, or edit mode', value: '/mode', category: 'Settings' },
        { label: 'Permission rules', description: 'Review allow, ask, and deny rules', value: '/permissions', category: 'Settings' },
        { label: 'General settings', description: 'Open the configuration panel', value: '/config', category: 'Settings' },
        { label: 'Keyboard shortcuts', description: 'Show the shortcut cheat sheet', value: '/keys', category: 'Settings' },
        { label: 'Appearance', description: 'Change the prompt colour', value: '/color', category: 'Settings' }
      ];
      const recentItems = (await listSessions(root, { env: process.env }).catch(() => []))
        .slice(0, 12)
        .map((item) => {
          const date = Number.isFinite(Date.parse(item.updatedAt || '')) ? new Date(item.updatedAt).toLocaleString() : 'saved session';
          return {
            label: 'Resume session ' + String(item.id || '').slice(0, 8),
            description: [item.model || 'model not recorded', date].join(' · '),
            value: '/resume ' + String(item.id || ''),
            category: 'Recent sessions'
          };
        });
      return [...settingsItems, ...recentItems, ...commandItems];
    },
    onTranscript: async () => {
      const { transcriptLines } = await import('./terminal-ui.mjs');
      return { pager: transcriptLines(session ? session.messages : [], { color: colorEnabled(stdout), width: stdout.columns || 100 }) };
    },
    onTodos: async () => {
      const handled = await runBuiltinCommand('todos', '', { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS }).catch(() => null);
      return handled ? String(handled.output).split('\n') : [];
    }
  });
  IDLE_SUBMIT = null;
  if (result.type === 'eof') throw new Error('eof');
  if (result.text.startsWith(WAKE_PREFIX)) return result.text;
  state.history.push(result.text);
  appendHistory(root, result.text).catch(() => {});
  return result.text;
}

// Settings "env" (Claude Code key) is applied to process.env before the provider loads;
// "disableBypassPermissionsMode": "disable" (often from managed settings) blocks bypass mode.
async function applySettingsPolicy(root, autoApprove, keepSessionIds = []) {
  const settings = await loadSettings(root).catch(() => null);
  if (!settings) return;
  // "cleanupPeriodDays" (Claude Code key, opt-in): quietly delete saved chats unused for that long.
  const cleanupDays = Number.parseInt(process.env.OASIS_CLEANUP_PERIOD_DAYS || '', 10) || settings.cleanupPeriodDays;
  if (Number.isInteger(cleanupDays) && cleanupDays >= 1) pruneSessions(root, cleanupDays, { keep: keepSessionIds.filter(Boolean) }).catch(() => {});
  for (const [key, value] of Object.entries(settings.env || {})) process.env[key] = value;
  if (settings.apiKeyHelper && !process.env.OASIS_API_KEY_HELPER) process.env.OASIS_API_KEY_HELPER = settings.apiKeyHelper;
  if (settings.customHeadersHelper && !process.env.OASIS_CUSTOM_HEADERS_HELPER) process.env.OASIS_CUSTOM_HEADERS_HELPER = settings.customHeadersHelper;
  if (settings.permissions && settings.permissions.disableBypassPermissionsMode) {
    if (SESSION_OPTIONS.permissionMode === 'bypassPermissions') throw new Error('bypassPermissions mode is disabled by settings (permissions.disableBypassPermissionsMode).');
    SESSION_OPTIONS.disableBypass = true;
  }
}

// /reload-plugins and /reload-skills: rebuild the session (settings, plugins, skills,
// agents, hooks, MCP servers, system prompt) while keeping the conversation.
async function reloadSessionComponents(session, root, what) {
  const { rebuildSession } = await import('./agent.mjs');
  const { session: next, summary } = await rebuildSession(session, { root, ...sessionCreateOptions(), watchFiles: true }, what);
  attachMonitors(next);
  stdout.write(summary + '\n');
  return next;
}

// /theme and the "theme" setting (Claude Code's ~/.claude.json theme is honored too).
async function applyThemeFromSettings(settings) {
  if (process.env.OASIS_SAFE_MODE === '1') return;
  try {
    const { applyTheme, resolveTheme, themePreference } = await import('./themes.mjs');
    applyTheme(resolveTheme(themePreference({ env: process.env, settings }), { env: process.env, plugins: (settings && settings.pluginThemeSources) || [] }));
  } catch {}
}

async function interactive(root, autoApprove, persistence = {}) {
  let session = null;
  await ensureModelProviderSetup(root);
  const bannerConfig = await loadConfig().catch(() => ({}));
  const startupSettings = await loadSettings(root).catch(() => null);
  await applyThemeFromSettings(startupSettings);
  if (stdout.isTTY && process.env.OASIS_DISABLE_THEME_RELOAD !== '1') {
    import('./themes.mjs').then(({ watchThemes }) => watchThemes({ env: process.env, plugins: (startupSettings && startupSettings.pluginThemeSources) || [], onReload: (theme) => stdout.write('\n[theme] reloaded ' + theme.name + '\n') })).catch(() => {});
  }
  if (stdout.isTTY) await showStartupBanner({ root, model: SESSION_OPTIONS.model || (bannerConfig.configured === false ? 'not set up yet · exit and run oasis setup' : bannerConfig.model) || '', provider: bannerConfig.configured === false ? '' : (bannerConfig.protocol || ''), mode: SESSION_OPTIONS.permissionMode || 'default' }).catch(() => {});
  else stdout.write('\nOASIS — coding agent\nWorkspace: ' + root + '\nType your task in plain English. Use /help or /exit. Commands run locally; review permissions carefully.\n');
  if (stdout.isTTY) {
    try {
      const { cliUpdateNotice } = await import('./app-update.mjs');
      const { getBaseConfigDirectory } = await import('./config.mjs');
      const { oasisVersion } = await import('./version.mjs');
      const notice = await cliUpdateNotice({ statePath: path.join(getBaseConfigDirectory(process.env), 'update-state.json'), currentVersion: oasisVersion() });
      if (notice) stdout.write((colorEnabled(stdout) ? '\x1b[33m' : '') + notice + (colorEnabled(stdout) ? '\x1b[39m' : '') + '\n');
    } catch {}
  }
  if (process.env.OASIS_BACKGROUND_NOTICE !== '0') {
    try {
      const bg = await import('./background-sessions.mjs');
      const notice = bg.backgroundStartupNotice(await bg.listBackgroundSessions(process.env), root);
      if (notice) stdout.write(notice + '\n');
    } catch {}
  }
  if (stdout.isTTY && !SESSION_OPTIONS.safeMode) {
    try {
      const { importStartupNotice } = await import('./importers.mjs');
      const notice = await Promise.race([importStartupNotice(root, { env: process.env }), new Promise((resolve) => setTimeout(() => resolve(''), 1500).unref())]);
      if (notice) stdout.write(notice + '\n');
    } catch {}
  }
  if (SESSION_OPTIONS.devChannels.length) {
    stdout.write('\n\x1b[1mWARNING: loading development channels\x1b[22m\n  ' + SESSION_OPTIONS.devChannels.join('\n  ') + '\nAnything that can reach these servers can put text in front of the agent' + '. Only use channels you trust.\n');
    const answer = await askLine('Type "yes" if you are using this for local development (anything else exits): ').catch(() => '');
    if (String(answer).trim().toLowerCase() !== 'yes') { stdout.write('Exiting.\n'); return; }
    SESSION_OPTIONS.devChannelsConfirmed = true;
  }
  // Channels push messages before you type anything, so start the session (and its MCP servers) now.
  if (SESSION_OPTIONS.channels.length || SESSION_OPTIONS.devChannelsConfirmed) {
    const config = await loadConfig().catch(() => null);
    if (config && config.configured) {
      if (SESSION_OPTIONS.model) config.model = SESSION_OPTIONS.model;
      let restored = null;
      if (persistence.resumeId) { restored = await loadSession(root, persistence.resumeId).catch(() => null); persistence.resumeId = null; }
      session = await createSession({ root, config, restore: restored, ...sessionCreateOptions(), watchFiles: true });
      const { channelClients } = await import('./channels.mjs');
      const live = channelClients(session).map((client) => client.config.name);
      const requested = session.channels.map((entry) => entry.raw);
      stdout.write('[channels] ' + (live.length ? 'Listening on ' + live.join(', ') : 'No connected MCP server declared the claude/channel capability for ' + requested.join(', ')) + '.\n');
      if (session.settings && session.settings.channelsEnabled === false) stdout.write('[channels] channelsEnabled is false in settings, so channel messages are dropped.\n');
    }
  }
  const inputState = { history: await loadHistory(root).catch(() => []), completer: createCompleter({ root, commands: () => interactiveCommandList(root) }) };
  const pendingShell = [];
  while (true) {
    let input;
    const statusLine = (session && session.settings || startupSettings || {}).statusLine;
    if (statusLine) {
      const line = await renderStatusLine(statusLine, statusLinePayload({ root, session, config: await loadConfig().catch(() => ({})), usage: USAGE, outputStyle: SESSION_OPTIONS.outputStyle }), { root, env: process.env, keepColor: Boolean(stdout.isTTY) }).catch(() => null);
      if (line) stdout.write('\n' + line);
    }
    attachCron(session);
    attachMonitors(session);
    if (QUEUED_INPUT.length) {
      input = QUEUED_INPUT.shift();
      stdout.write('\n' + (colorEnabled(stdout) ? '\x1b[2m❯ ' + input + '\x1b[22m' : '> ' + input) + '\n');
      inputState.history.push(input);
      appendHistory(root, input).catch(() => {});
    } else {
      const idle = startIdleCompaction(session, {
        minutes: idleCompactMinutes(session && session.settings, process.env),
        compact: async (target, options) => {
          const before = estimateTokens(target.messages);
          const result = await compactHistoryIfNeeded(target, { ...options, mustPreserve: target.mustPreserve });
          if (result && result.tokensUsed) recordUsage(USAGE, { totalTokens: result.tokensUsed, phase: 'compaction' });
          return result && result.compacted ? { ...result, beforeTokens: before, afterTokens: estimateTokens(target.messages) } : result;
        }
      });
      try { input = await readMainInput(root, session, inputState); } catch { await idle.settle(); break; }
      const idleResult = await idle.settle();
      if (idleResult) { stdout.write(idleCompactionNote(idleResult) + '\n'); saveSession(session).catch(() => {}); }
    }
    let text = input.trim();
    if (!text) continue;
    if (text.startsWith('!') && text.length > 1) {
      const command = text.slice(1).trim();
      if (SESSION_OPTIONS.restricted) { stdout.write('[restricted] ! shell commands are disabled in --restricted mode.\n'); continue; }
      let powershell = null;
      if (((await loadSettings(root).catch(() => ({}))).defaultShell) === 'powershell') {
        const { findPowerShell } = await import('./power-tools.mjs');
        powershell = findPowerShell(process.env);
        if (!powershell) stdout.write('[shell] defaultShell is powershell, but the PowerShell tool is not enabled or pwsh was not found; using the normal shell.\n');
      }
      const ran = await runShellPassthrough(command, { root, powershell });
      if (ran.code) stdout.write((colorEnabled(stdout) ? '\x1b[2m' : '') + '[exit ' + ran.code + ']' + (colorEnabled(stdout) ? '\x1b[22m' : '') + '\n');
      pendingShell.push({ command, code: ran.code, output: ran.output });
      if (pendingShell.length > 10) pendingShell.shift();
      continue;
    }
    if (pendingShell.length && !text.startsWith('/') && !text.startsWith('#')) {
      text = 'Commands I ran in my terminal (for context):\n' + shellContextBlock(pendingShell) + '\n\n' + text;
      pendingShell.length = 0;
    }
    if (['/exit', '/quit', 'exit', 'quit'].includes(text.toLowerCase())) break;
    if (text.startsWith('#') && !text.startsWith('#!')) {
      try {
        const scope = /^#\s*user:/i.test(text) ? 'user' : /^#\s*local:/i.test(text) ? 'local' : 'project';
        const note = text.replace(/^#+\s*(?:(?:user|local|project):)?\s*/i, '');
        const file = await appendMemoryNote(root, note, { scope });
        if (session && session.messages && session.messages[0]) {
          const line = '\n- ' + note;
          session.baseSystemPrompt = (session.baseSystemPrompt || session.messages[0].content) + line;
          session.messages[0].content += line;
        }
        stdout.write('[memory] Saved to ' + file + '\n');
      } catch (error) { stdout.write('[memory] ' + error.message + '\n'); }
      continue;
    }
    if (text === '/clear' || text === '/new' || text === '/reset') { closeSession(session); session = null; persistence.resumeId = null; stdout.write('Conversation context cleared. Project instructions will be loaded again on the next task.\n'); continue; }
    if (text === '/status') { try { printConfig(await loadConfig()); } catch (e) { stdout.write(e.message + '\n'); } continue; }
    if (text === '/setup') { try { await configureProvider(root); closeSession(session); session = null; persistence.resumeId = null; } catch (e) { stdout.write(e.message + '\n'); } continue; }
    const slash = text.match(/^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i);
    // Aliases yield to a custom command of the same name (a personal /ask.md stays yours).
    if (slash && !Object.hasOwn(BUILTIN_COMMANDS, slash[1].toLowerCase()) && Object.hasOwn(COMMAND_ALIASES, slash[1].toLowerCase()) && !(await loadCustomCommands(root, { env: process.env }).catch(() => new Map())).has(slash[1].toLowerCase())) slash[1] = COMMAND_ALIASES[slash[1].toLowerCase()];
    if (slash && Object.hasOwn(BUILTIN_COMMANDS, slash[1].toLowerCase())) {
      // /config without an argument opens the settings pane in a terminal.
      if (slash[1].toLowerCase() === 'config' && !String(slash[2] || '').trim() && stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function' && process.env.OASIS_LINE_APPROVALS !== '1') {
        try {
          const pane = await import('./config-pane.mjs');
          const { selectDialog } = await import('./select-dialog.mjs');
          const state = { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS, autoApprove, color: Boolean(stdout.isTTY && colorEnabled(stdout)), width: stdout.columns || 100 };
          const run = (command, value) => runBuiltinCommand(command, value, state);
          let last = 0;
          for (;;) {
            const rows = await pane.configRows(state);
            const width = Math.max(...rows.map((row) => row.item.label.length));
            stdout.write('\nSettings — Enter to change, Esc when done:\n');
            const picked = await selectDialog({ input: stdin, output: stdout, options: [...rows.map((row, index) => ({ label: row.item.label.padEnd(width) + '  ' + row.value, value: String(index) })), { label: 'Done', value: null, hotkey: 'no' }], initial: last, context: 'Select', color: colorEnabled(stdout) });
            if (!picked) break;
            last = Number(picked);
            const row = rows[last];
            const choices = await row.item.choices(state);
            stdout.write(row.item.label + ' — ' + row.item.description + ':\n');
            const value = await selectDialog({ input: stdin, output: stdout, options: [...choices.map((choice) => ({ label: choice + (choice === row.value ? ' (current)' : ''), value: choice })), { label: 'Cancel', value: null, hotkey: 'no' }], initial: Math.max(0, choices.indexOf(row.value)), context: 'Select', color: colorEnabled(stdout) });
            if (!value || value === row.value) continue;
            try { stdout.write(String(await pane.setConfigValue(row.item.key, value, state, run)) + '\n'); } catch (error) { stdout.write('[config] ' + error.message + '\n'); }
          }
          session = state.session || session;
        } catch (error) { stdout.write('[config] ' + error.message + '\n'); }
        continue;
      }
      // /model, /theme and /color without an argument open a picker in a terminal.
      if (!String(slash[2] || '').trim() && stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function' && ['model', 'theme', 'color'].includes(slash[1].toLowerCase())) {
        try {
          const { pickerFor, selectDialog } = await import('./select-dialog.mjs');
          const picker = await pickerFor(slash[1].toLowerCase(), { session, env: process.env, settings: (session && session.settings) || await loadSettings(root).catch(() => null) });
          stdout.write('Select ' + slash[1].toLowerCase() + ':\n');
          const chosen = await selectDialog({ input: stdin, output: stdout, options: picker.options, initial: picker.initial, context: picker.context, color: colorEnabled(stdout) });
          if (!chosen) { stdout.write('Cancelled.\n'); continue; }
          slash[2] = chosen;
        } catch (error) { stdout.write('[picker] ' + error.message + '\n'); continue; }
      }
      try {
        // /context before the first message: start the session now (the first
        // prompt would anyway) so it shows the real system prompt and tool cost,
        // as Claude Code does, instead of "no conversation yet".
        if (slash[1].toLowerCase() === 'context' && !session && !persistence.resumeId) {
          try {
            const config = await loadConfig();
            if (SESSION_OPTIONS.model) config.model = SESSION_OPTIONS.model;
            if (config.configured) session = await createSession({ root, config, ...sessionCreateOptions(), watchFiles: true });
          } catch { /* fall back to the plain message */ }
        }
        const handled = await runBuiltinCommand(slash[1].toLowerCase(), String(slash[2] || '').trim(), { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS, autoApprove, print: (line) => stdout.write(line + '\n'), color: Boolean(stdout.isTTY && colorEnabled(stdout)), width: stdout.columns || 100, confirm: (question) => askApproval(question, true, {}) });
        if (handled) {
          if (handled.output) stdout.write(handled.output + '\n');
          if (handled.reload && session) {
            session = await reloadSessionComponents(session, root, handled.reload);
            continue;
          }
          if (handled.osc52 && stdout.isTTY) stdout.write('\x1b]52;c;' + handled.osc52 + '\x07');
          if (handled.forked) persistence.enabled = true;
          if (handled.mcpLogin) {
            try { stdout.write((await (await import('./mcp-auth-commands.mjs')).mcpLogin(root, handled.mcpLogin, { env: process.env, session, print: (text) => stdout.write(text + '\n') })) + '\n'); }
            catch (error) { stdout.write('[mcp] ' + error.message + '\n'); }
          }
          if (handled.resume) { closeSession(session); session = null; persistence.enabled = true; persistence.resumeId = handled.resume; }
          if (handled.focus) {
            if (stdout.isTTY) {
              stdout.write('\x1b[?1049h\x1b[H\x1b[2J' + handled.focus + '\n\n');
              try { await askLine('Press Enter to return '); } catch {}
              stdout.write('\x1b[?1049l');
            } else stdout.write(handled.focus + '\n');
            continue;
          }
          if (handled.background) {
            try {
              if (!session) throw new Error('Start a conversation first; /background hands the current session to a background agent.');
              const saved = await saveSession(session);
              const { startBackgroundSession } = await import('./background-sessions.mjs');
              const entry = await startBackgroundSession({ root, prompt: handled.background.prompt, resumeId: saved.id, env: process.env, permissionMode: (session.permissions && session.permissions.mode !== 'bypassPermissions' ? session.permissions.mode : SESSION_OPTIONS.permissionMode) || null, model: session.config && session.config.model || null });
              stdout.write('Moved this conversation to background session ' + entry.id + '.\n  oasis bg logs ' + entry.id + ' --follow   watch progress\n  oasis bg attach ' + entry.id + '          continue it here later\n');
              closeSession(session); session = null;
              break;
            } catch (error) { stdout.write('[background] ' + error.message + '\n'); continue; }
          }
          if (handled.prompt) { session = await runPrompt(handled.prompt, root, autoApprove, session, persistence, handled.planOnly ? { planOnly: true } : {}); persistence.resumeId = null; }
          if (handled.cd) { persistence.watchPaths = await fireCwdChanged(session, root, handled.cd); closeSession(session); session = null; persistence.resumeId = null; root = handled.cd; try { process.chdir(root); } catch {} }
          if (handled.loop) session = await runLoop(handled.loop, root, autoApprove, session, persistence);
          if (handled.goal) session = await runGoal(handled.goal, root, autoApprove, session, persistence);
          continue;
        }
      } catch (error) { stdout.write('Command failed: ' + error.message + '\n'); continue; }
    }
    if (text.startsWith('/') && !SESSION_OPTIONS.disableSlashCommands) {
      try {
        const custom = await resolveCustomCommand(root, text, await customCommandContext(root));
        if (custom) {
          stdout.write('Running /' + custom.name + ' from ' + custom.command.file + '.\n');
          reportInlineShell(custom.shell);
          session = await runPrompt(custom.prompt, root, autoApprove, session, persistence, customRunOptions(custom));
          persistence.resumeId = null;
          continue;
        }
      } catch (error) {
        stdout.write('Could not run custom command: ' + error.message + '\n');
        continue;
      }
      try {
        const imported = await resolveImportedSlashCommand(root, text, { env: process.env });
        if (imported) {
          stdout.write('Running imported command /' + imported.alias + ' from ' + imported.sourcePath + '.\n');
          session = await runPrompt(imported.prompt, root, autoApprove, session, persistence);
          persistence.resumeId = null;
          continue;
        }
      } catch (error) {
        stdout.write('Could not resolve imported command: ' + error.message + '\n');
        continue;
      }
      if (/^\/mcp__[a-z0-9_-]+__/.test(text)) { session = await runPrompt(text, root, autoApprove, session, persistence); persistence.resumeId = null; continue; }
      const skillCommand = await resolveSkillCommand(root, text).catch(() => null);
      if (skillCommand) {
        stdout.write('Running the ' + skillCommand.name + ' skill.\n');
        session = await runPrompt(skillCommand.prompt, root, autoApprove, session, persistence, skillCommand.options);
        persistence.resumeId = null;
        continue;
      }
      stdout.write('Unknown command. Type /help to list built-in and custom commands.\n');
      continue;
    }
    const direct = parseInstallIntent(text);
    if (direct) {
      try { await installRequest(direct, root, autoApprove); } catch (error) { stdout.write('Install request failed: ' + error.message + '\n'); }
      continue;
    }
    session = await runPrompt(text, root, autoApprove, session, persistence);
    persistence.resumeId = null;
  }
  closeSession(session);
  stdout.write('\nOasis session closed.\n');
}


async function watchCommentsCommand(root, autoApprove, persistence = {}) {
  await ensureModelProviderSetup(root);
  const { watchAiComments } = await import('./ai-comments.mjs');
  let session = null;
  stdout.write('Watching ' + root + ' for AI comments. End a comment with AI! to request a change or AI? to ask a question; plain AI adds context. Press Ctrl+C to stop.\n');
  const watcher = watchAiComments(root, {
    onTrigger: async ({ byFile, prompt }) => {
      const where = [...byFile.entries()].map(([file, items]) => file + ':' + items.map((item) => item.line).join(',')).join('  ');
      stdout.write('\n[watch] ' + where + '\n');
      try { session = await runPrompt(prompt, root, autoApprove, session, persistence); }
      catch (error) { stderr.write('[watch] ' + (error && error.message || error) + '\n'); }
      stdout.write('\n[watch] Waiting for the next AI! or AI? comment.\n');
    },
    onError: (error) => stderr.write('[watch] ' + (error && error.message || error) + '\n')
  });
  await new Promise((resolve) => {
    const finish = () => { watcher.stop(); resolve(); };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  if (session) closeSession(session);
}

async function startUniversalApp(args) {
  let host = '127.0.0.1';
  let port = 3920;
  let openBrowser = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--lan') host = '0.0.0.0';
    else if (arg === '--host') host = args[++i];
    else if (arg.startsWith('--host=')) host = arg.slice(7);
    else if (arg === '--port') port = Number(args[++i]);
    else if (arg.startsWith('--port=')) port = Number(arg.slice(7));
    else if (arg === '--open') openBrowser = true;
    else throw new Error('Unknown app option: ' + arg + '. Supported options: --lan, --host HOST, --port PORT, --open.');
  }
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535.');
  const { startAppServer } = await import('./app-server.mjs');
  const server = await startAppServer({ root: APP_ROOT, host, port });
  const actualPort = server.address().port;
  const localUrl = 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + actualPort + '/app/';
  stdout.write('\nOASIS universal app: ' + localUrl + '\n');
  stdout.write('  Everything runs inside the browser that opens it: projects, keys and the agent stay on that device.\n');
  stdout.write('  This server only hands out the app files. It is also published at https://fahthiz.github.io/oasis/app/\n');
  if (host === '0.0.0.0') {
    try {
      const { lanAddresses } = await import('./lan-addresses.mjs');
      const addresses = lanAddresses();
      if (addresses.length) {
        const url = (address) => 'http://' + address + ':' + actualPort + '/app/';
        stdout.write('\n  On a phone or tablet on the same network, open:\n');
        for (const entry of addresses.slice(0, 4)) stdout.write('    ' + url(entry.address) + '\n');
        if (stdout.isTTY && process.env.OASIS_NO_QR !== '1') {
          const { renderQrTerminal } = await import('./qr.mjs');
          stdout.write('\n' + renderQrTerminal(url(addresses[0].address), { color: colorEnabled(stdout) }).split('\n').map((line) => '    ' + line).join('\n') + '\n');
        }
        stdout.write('  Plain http on a LAN cannot install or work offline; for that, open the published https link once.\n');
      }
    } catch {}
  }
  stdout.write('\nPress Ctrl+C to stop.\n');
  if (openBrowser) {
    const { openInBrowser } = await import('./mcp-oauth.mjs');
    if (!openInBrowser(localUrl)) stdout.write('Could not open a browser automatically. Open the link above instead.\n');
  }
  await new Promise((resolve) => {
    const stop = () => { server.close(); resolve(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function startWebWorkspace(root, args) {
  await ensureModelProviderSetup(root);
  let host = '127.0.0.1';
  let port = 3917;
  let tlsCertFile = null;
  let tlsKeyFile = null;
  let allowInsecureLan = false;
  let openBrowser = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host') {
      if (!args[i + 1]) throw new Error('--host requires a host address.');
      host = args[++i];
    } else if (arg.startsWith('--host=')) host = arg.slice(7);
    else if (arg === '--port') {
      if (!args[i + 1]) throw new Error('--port requires a number.');
      port = Number(args[++i]);
    } else if (arg.startsWith('--port=')) port = Number(arg.slice(7));
    else if (arg === '--tls-cert') {
      if (!args[i + 1]) throw new Error('--tls-cert requires a certificate file path.');
      tlsCertFile = args[++i];
    } else if (arg.startsWith('--tls-cert=')) tlsCertFile = arg.slice(11);
    else if (arg === '--tls-key') {
      if (!args[i + 1]) throw new Error('--tls-key requires a private-key file path.');
      tlsKeyFile = args[++i];
    } else if (arg.startsWith('--tls-key=')) tlsKeyFile = arg.slice(10);
    else if (arg === '--allow-insecure-lan') allowInsecureLan = true;
    else if (arg === '--open') openBrowser = true;
    else throw new Error('Unknown web option: ' + arg + '. Supported options: --host HOST, --port PORT, --open, --tls-cert FILE, --tls-key FILE, --allow-insecure-lan.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535 (0 chooses an available port).');
  const normalizedHost = host.toLowerCase();
  if (normalizedHost !== 'localhost' && isIP(host) === 0) throw new Error('--host must be localhost or a literal IP address. Use --host 0.0.0.0 only when you intentionally want other devices on your private network to connect.');
  const app = await startOasisWebServer({ root, host, port, tlsCertFile, tlsKeyFile, allowInsecureLan });
  const scheme = app.secure ? 'https' : 'http';
  const urlHost = host.includes(':') ? '[' + host + ']' : host;
  const localUrl = scheme + '://' + (host === '0.0.0.0' ? '127.0.0.1' : urlHost) + ':' + app.port + '/';
  const connectUrl = localUrl + 'app/#token=' + app.token;
  stdout.write('\nOASIS is running for ' + root + '\n\n');
  stdout.write('  Open this link to start: ' + connectUrl + '\n');
  stdout.write('  Keep it private: anyone with the link can use this folder.\n\n');
  stdout.write('  Another browser? Open ' + localUrl + ' and paste the link above into the message box.\n\n');
  stdout.write('Commands, package installs, file deletions and bundle installs always ask for your approval in the browser first.\n');
  if (host === '0.0.0.0' || (isIP(host) > 0 && !['127.0.0.1', '::1'].includes(host))) {
    // Print real phone links (and a QR code to scan) instead of a placeholder.
    let printedPhoneLinks = false;
    try {
      const { lanAddresses } = await import('./lan-addresses.mjs');
      const addresses = host === '0.0.0.0' ? lanAddresses() : [{ address: host, name: '', virtual: false, tailscale: false }];
      if (addresses.length) {
        const phoneUrl = (address) => scheme + '://' + address + ':' + app.port + '/app/#token=' + app.token;
        stdout.write('\n  Phone or tablet on the same private network, open:\n');
        for (const entry of addresses.slice(0, 4)) stdout.write('    ' + phoneUrl(entry.address) + (entry.tailscale ? '   (Tailscale)' : entry.virtual ? '   (virtual adapter)' : '') + '\n');
        if (stdout.isTTY && process.env.OASIS_NO_QR !== '1') {
          const { renderQrTerminal } = await import('./qr.mjs');
          stdout.write('\n  Or scan this with the phone camera:\n\n' + renderQrTerminal(phoneUrl(addresses[0].address), { color: colorEnabled(stdout) }).split('\n').map((line) => '    ' + line).join('\n') + '\n\n');
        }
        stdout.write('  Then add it to the home screen (Share → Add to Home Screen on iPhone, menu → Install app on Android).\n');
        printedPhoneLinks = true;
      }
    } catch {}
    if (app.secure) {
      stdout.write('HTTPS is active. The certificate must be trusted by each client device and include the exact LAN IP in its subject alternative names.\n');
      if (!printedPhoneLinks) stdout.write('On your phone, open https://<this-computer-LAN-IP>:' + app.port + '/ while connected to the same private Wi-Fi, then paste the token.\n');
    } else {
      stdout.write('UNENCRYPTED LAN WARNING: explicit --allow-insecure-lan is active. The token and workspace traffic can be observed on the network. Never use public Wi-Fi or expose this port to the Internet.\n');
      if (!printedPhoneLinks) stdout.write('On your phone, open http://<this-computer-LAN-IP>:' + app.port + '/ while connected to the same private Wi-Fi, then paste the token.\n');
    }
  } else {
    stdout.write('Local only: other devices cannot connect. Network access requires a trusted TLS certificate, or the explicit and unsafe --allow-insecure-lan flag.\n');
  }
  stdout.write('Press Ctrl+C to stop.\n');
  if (openBrowser) {
    const { openInBrowser } = await import('./mcp-oauth.mjs');
    if (!openInBrowser(connectUrl)) stdout.write('Could not open a browser automatically. Open the link above instead.\n');
  }
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().catch((error) => stderr.write('Oasis web shutdown error: ' + error.message + '\n'));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}


async function manageExternalExtensions(root, args, autoApprove) {
  const values = [...args];
  const action = String(values.shift() || 'list').toLowerCase();
  let scope = 'project';
  let selectedServerNames = null;
  let rollbackCommitSha = null;
  const positional = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '--commit') {
      if (!values[i + 1]) throw new Error('--commit requires a full 40-character backup commit SHA.');
      rollbackCommitSha = values[++i];
    } else if (values[i].startsWith('--commit=')) {
      rollbackCommitSha = values[i].slice('--commit='.length);
    } else if (values[i] === '--servers') {
      if (!values[i + 1]) throw new Error('--servers requires a comma-separated list of MCP server names.');
      selectedServerNames = values[++i].split(',').map((name) => name.trim()).filter(Boolean);
    } else if (values[i].startsWith('--servers=')) {
      selectedServerNames = values[i].slice('--servers='.length).split(',').map((name) => name.trim()).filter(Boolean);
    } else if (values[i] === '--scope') {
      if (!values[i + 1]) throw new Error('--scope requires self, project, or both.');
      scope = values[++i];
    } else if (values[i].startsWith('--scope=')) {
      scope = values[i].slice('--scope='.length);
    } else positional.push(values[i]);
  }
  if (!['self', 'project', 'both'].includes(scope)) throw new Error('Scope must be self, project, or both.');
  if (action === 'list') {
    const data = await listInstalledExtensions({ root });
    stdout.write('Oasis external agent/skill extensions\n\n');
    if (!data.extensions.length) { stdout.write('No external extensions are installed yet.\n'); return; }
    for (const item of data.extensions) {
      stdout.write(item.name + ' [' + item.scope + '] — ' + item.importedFiles + ' Markdown prompt(s)\n');
      stdout.write('  Source: ' + item.source + '\n  Commit: ' + item.commitSha + '\n  License: ' + item.license + '\n');
      for (const command of item.commands || []) stdout.write('  Command: /' + command.alias + ' — ' + command.description + '\n');
      for (const backup of item.backups || []) stdout.write('  Rollback: ' + backup.commitSha + ' (verified backup)\n');
    }
    return;
  }
  if (action === 'inspect') {
    const url = positional[0];
    if (!url) throw new Error('Usage: oasis extensions inspect https://github.com/owner/repository');
    const report = await inspectGitHubExtension(url);
    stdout.write('Repository: ' + report.repository.fullName + '\n');
    stdout.write('Default branch: ' + report.repository.defaultBranch + '\n');
    stdout.write('Pinned commit: ' + report.repository.commitSha + '\n');
    stdout.write('License: ' + report.repository.license + '\n');
    stdout.write('Importable Markdown prompts: ' + report.importCount + (report.limited ? ' (bounded selection)' : '') + '\n');
    stdout.write('Executable/source files detected (not imported): ' + report.executableFilesDetected + '\n');
    stdout.write('Policy: ' + report.executionPolicy + '\n');
    stdout.write('\nImportable Markdown commands (registered as Oasis aliases after installation):\n');
    for (const command of report.commands || []) stdout.write('  /' + command.alias + ' [' + command.sourceFormat + '] — ' + command.sourcePath + '\n');
    if (!(report.commands || []).length) stdout.write('  None detected in supported Markdown command layouts.\n');
    stdout.write('\nNormalized adapter plan (detection does not activate features):\n');
    for (const adapter of report.compatibility.installPlan.adapters) {
      stdout.write('  ' + adapter.label + '\n');
      for (const item of adapter.capabilities) {
        stdout.write('    ' + item.id + ': ' + item.status + ' (' + item.count + ') — ' + item.detail + '\n');
      }
    }
    const mcpPlan = report.mcpImportPlan || { servers: [], skipped: [], sourceFiles: [] };
    stdout.write('\nMCP server proposals (not imported or started): ' + mcpPlan.servers.length + '\n');
    for (const server of mcpPlan.servers) {
      stdout.write('  ' + server.name + ' — ' + server.command + ' ' + JSON.stringify(server.args) + ' [disabled if imported]\n');
      if (server.sourceEnvKeys.length) stdout.write('    Environment variable names declared (values omitted): ' + server.sourceEnvKeys.join(', ') + '\n');
    }
    for (const item of mcpPlan.skipped) stdout.write('  Skipped ' + (item.name || item.sourcePath) + ': ' + item.reason + '\n');
    stdout.write('\nSample of prompt paths:\n');
    for (const file of report.files.slice(0, 30)) stdout.write('  ' + file.path + '\n');
    return;
  }
  if (action === 'update') {
    const url = positional[0];
    if (!url) throw new Error('Usage: oasis extensions update https://github.com/owner/repository --scope self|project|both');
    const report = await inspectGitHubExtension(url);
    const inventory = await listInstalledExtensions({ root });
    const selectedScopes = scope === 'both' ? ['self', 'project'] : [scope];
    const matches = inventory.extensions.filter((item) => item.source === report.repository.url && selectedScopes.includes(item.scope));
    const missing = selectedScopes.filter((itemScope) => !matches.some((item) => item.scope === itemScope));
    if (missing.length) throw new Error('This repository is not installed in scope(s): ' + missing.join(', ') + '. Install it in those scopes before updating.');
    stdout.write('Update review\n  Repository: ' + report.repository.fullName + '\n');
    for (const item of matches) stdout.write('  ' + item.scope + ': ' + item.commitSha + '\n');
    stdout.write('  New commit: ' + report.repository.commitSha + '\n');
    stdout.write('  Importable prompts: ' + report.importCount + '\n  Callable Markdown commands: ' + (report.commands || []).length + '\n');
    if (matches.every((item) => item.commitSha.toLowerCase() === report.repository.commitSha.toLowerCase())) {
      stdout.write('Already current; no files changed.\n'); return;
    }
    const approved = await approve(
      'Update ' + report.repository.fullName + ' in ' + scope + ' to reviewed commit ' + report.repository.commitSha +
      '? Oasis verifies existing file hashes, keeps the previous revision for rollback, and does not execute scripts or enable MCP servers.',
      false, autoApprove
    );
    if (!approved) { stdout.write('Update cancelled; the installed revision was not changed.\n'); return; }
    const result = await updateGitHubExtension(url, { root, scope, expectedCommit: report.repository.commitSha });
    if (result.alreadyCurrent) { stdout.write('Already current; no files changed.\n'); return; }
    stdout.write('Updated ' + result.extensionName + ' to ' + result.commitSha + '.\n');
    for (const backup of result.backups) stdout.write('  Rollback available: ' + backup.scope + ' revision ' + backup.commitSha + '\n');
    for (const command of result.commands || []) stdout.write('  Command alias: /' + command.alias + '\n');
    stdout.write('No repository scripts were executed; previous verified revision kept for rollback.\n');
    return;
  }
  if (action === 'rollback') {
    const name = String(positional[0] || '').toLowerCase();
    if (!name || !rollbackCommitSha) throw new Error('Usage: oasis extensions rollback NAME --commit FULL_SHA --scope self|project|both');
    if (!/^[a-f0-9]{40}$/i.test(rollbackCommitSha)) throw new Error('--commit must be a full 40-character backup commit SHA.');
    const scopes = scope === 'both' ? ['self', 'project'] : [scope];
    const inventory = await listInstalledExtensions({ root });
    const matching = inventory.extensions.filter((item) => item.name === name && scopes.includes(item.scope));
    const missing = scopes.filter((itemScope) => {
      const item = matching.find((entry) => entry.scope === itemScope);
      return !item || !(item.backups || []).some((backup) => backup.commitSha.toLowerCase() === rollbackCommitSha.toLowerCase());
    });
    if (missing.length) throw new Error('No intact backup of ' + rollbackCommitSha + ' is available in scope(s): ' + missing.join(', ') + '. Use oasis extensions list to view rollback revisions.');
    const approved = await approve(
      'Restore extension "' + name + '" to verified commit ' + rollbackCommitSha + ' in ' + scope +
      '? The currently active revision will be preserved as another rollback backup.',
      false, autoApprove
    );
    if (!approved) { stdout.write('Rollback cancelled; no extension was changed.\n'); return; }
    const result = await rollbackGitHubExtension({ root, scope, name, commitSha: rollbackCommitSha });
    if (result.alreadyCurrent) { stdout.write(name + ' is already at commit ' + result.commitSha + '.\n'); return; }
    stdout.write('Rolled back ' + name + ' to ' + result.commitSha + '.\n');
    for (const backup of result.backups || []) stdout.write('  Previous revision retained: ' + backup.scope + ' ' + backup.commitSha + '\n');
    return;
  }
  if (action === 'mcp-import') {
    const url = positional[0];
    if (!url) throw new Error('Usage: oasis extensions mcp-import https://github.com/owner/repository [--servers name1,name2]');
    const plan = await inspectGitHubMcpServers(url);
    stdout.write('MCP import review for ' + plan.repository + '\nCommit: ' + plan.commitSha + '\nSource files: ' + (plan.sourceFiles.join(', ') || 'none') + '\n\n');
    for (const server of plan.servers) {
      stdout.write('  ' + server.name + ' — ' + server.command + ' ' + JSON.stringify(server.args) + '\n');
      stdout.write('    State: disabled on import; environment values are not copied.' + (server.sourceEnvKeys.length ? ' Declared environment keys: ' + server.sourceEnvKeys.join(', ') : '') + '\n');
    }
    for (const skipped of plan.skipped) stdout.write('  Skipped ' + (skipped.name || skipped.sourcePath) + ': ' + skipped.reason + '\n');
    if (!plan.servers.length) { stdout.write('No supported local stdio MCP server declarations were found. Nothing was changed.\n'); return; }
    const selected = selectReviewedMcpServers(plan.servers, selectedServerNames);
    if (!selected.length) { stdout.write('No supported MCP servers were selected. Nothing was changed.\n'); return; }
    const existing = await loadMcpServers();
    const existingNames = new Set(existing.servers.map((server) => server.name));
    const collisions = selected.filter((server) => existingNames.has(server.name)).map((server) => server.name);
    if (collisions.length) throw new Error('MCP server names already configured: ' + collisions.join(', ') + '. Rename or remove them before importing.');
    if (existing.servers.length + selected.length > 40) throw new Error('The configured MCP server limit would be exceeded.');
    const approved = await approve(
      'Save ' + selected.length + ' MCP server configuration(s) from ' + plan.repository + ' at commit ' + plan.commitSha +
      '? They will be saved disabled; no process will start, and no environment values will be copied.',
      false,
      autoApprove
    );
    if (!approved) { stdout.write('MCP import cancelled; no configuration was changed.\n'); return; }
    // Re-fetch after approval. If the repository default branch changed while the
    // prompt was open, stop instead of importing commands that were not reviewed.
    const latestPlan = await inspectGitHubMcpServers(url, { expectedCommit: plan.commitSha });
    const latestSelected = selectReviewedMcpServers(latestPlan.servers, selected.map((server) => server.name));
    const latestConfig = await loadMcpServers();
    const latestNames = new Set(latestConfig.servers.map((server) => server.name));
    const lateCollisions = latestSelected.filter((server) => latestNames.has(server.name)).map((server) => server.name);
    if (lateCollisions.length) throw new Error('MCP server names were configured while approval was pending: ' + lateCollisions.join(', ') + '. Nothing was imported.');
    if (latestConfig.servers.length + latestSelected.length > 40) throw new Error('The configured MCP server limit would be exceeded. Nothing was imported.');
    const proposed = latestSelected.map((server) => ({ name: server.name, command: server.command, args: server.args, passEnv: [], enabled: false, origin: server.origin }));
    await saveMcpServers([...latestConfig.servers, ...proposed]);
    stdout.write('Imported ' + proposed.length + ' MCP configuration(s). All remain disabled; review environment variables, then enable trusted servers separately.\n');
    return;
  }
  if (action === 'install') {
    const url = positional[0];
    if (!url) throw new Error('Usage: oasis extensions install https://github.com/owner/repository --scope self|project|both');
    const report = await inspectGitHubExtension(url);
    stdout.write('Import plan\n  Repository: ' + report.repository.fullName + '\n  Commit: ' + report.repository.commitSha + '\n  Scope: ' + scope + '\n  Markdown prompts: ' + report.importCount + '\n  Detected executable/source files (ignored): ' + report.executableFilesDetected + '\n  License: ' + report.repository.license + '\n');
    const approved = await approve(
      'Import ' + report.importCount + ' Markdown prompt file(s) from ' + report.repository.fullName +
      ' at commit ' + report.repository.commitSha + ' into ' + scope +
      '? Oasis will not execute repository scripts, install packages, or enable MCP servers.',
      false,
      autoApprove
    );
    if (!approved) { stdout.write('Import cancelled; no extension files were installed.\n'); return; }
    const result = await installGitHubExtension(url, { root, scope, expectedCommit: report.repository.commitSha });
    stdout.write('\nImported ' + result.importedFiles + ' prompt file(s) from ' + result.repository.fullName + '.\n');
    for (const destination of result.destinations) stdout.write('  ' + destination.scope + ': ' + destination.path + '\n');
    stdout.write('Verification: pinned commit ' + result.commitSha + '; scripts executed: no; dependencies installed: no.\n');
    return;
  }
  if (action === 'remove' || action === 'uninstall') {
    const name = positional[0];
    if (!name) throw new Error('Usage: oasis extensions remove NAME --scope self|project');
    if (!['self', 'project'].includes(scope)) throw new Error('Remove accepts scope self or project, not both.');
    if (!(await approve('Remove the Oasis-managed "' + name + '" extension from scope "' + scope + '"? Any edited or unexpected files cause removal to be refused.', false, autoApprove))) {
      stdout.write('Removal cancelled.\n'); return;
    }
    const result = await removeGitHubExtension({ root, scope, name });
    stdout.write('Removed ' + result.name + ' from ' + result.scope + '.\n');
    return;
  }
  throw new Error('Unknown extensions action "' + action + '". Use list, inspect, install, or remove.');
}

async function main() {
  // HTTPS_PROXY / HTTP_PROXY / NO_PROXY for every outbound request (Node's fetch ignores them).
  installProxyFromEnv();
  const rawArgs = process.argv.slice(2);
  // --profile NAME (or -P NAME) picks an isolated agent profile before anything reads config.
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--') break;
    if (arg === '--profile' || arg === '-P' || arg.startsWith('--profile=')) {
      const name = arg.startsWith('--profile=') ? arg.slice(10) : rawArgs[i + 1];
      if (!name) throw new Error('--profile needs a name.');
      process.env.OASIS_PROFILE = name;
      rawArgs.splice(i, arg.startsWith('--profile=') ? 1 : 2);
      i--;
    }
  }
  if (process.env.OASIS_PROFILE) { const { activeProfile } = await import('./config.mjs'); activeProfile(process.env); }
  if (rawArgs[0] === 'completion' || rawArgs[0] === 'completions') {
    const { completionScript, completionUsage } = await import('./shell-completion.mjs');
    const script = rawArgs[1] ? completionScript(rawArgs[1]) : null;
    if (!script) { (rawArgs[1] ? process.stderr : stdout).write((rawArgs[1] ? 'Unknown shell: ' + rawArgs[1] + '\n\n' : '') + completionUsage()); if (rawArgs[1]) process.exitCode = 1; return; }
    stdout.write(script);
    return;
  }
  if (rawArgs[0] === 'profile' || rawArgs[0] === 'profiles') {
    const { profileCommand } = await import('./profiles.mjs');
    await profileCommand(rawArgs.slice(1));
    return;
  }
  // `oasis exec PROMPT` is an alias for `oasis -p PROMPT` (Codex CLI muscle memory).
  if (rawArgs[0] === 'exec') rawArgs[0] = '-p';
  // `oasis resume [--last | ID]` (Codex CLI) maps to -c / -r.
  if (rawArgs[0] === 'resume' && (rawArgs.length === 1 || rawArgs[1] === '--last' || /^[0-9a-f][0-9a-f-]{6,}$/i.test(rawArgs[1] || '') || String(rawArgs[1] || '').startsWith('-'))) {
    if (rawArgs[1] === '--last') rawArgs.splice(0, 2, '-c'); else rawArgs[0] = '-r';
  }
  let autoApprove = process.env.OASIS_AUTO_APPROVE === '1';
  if (process.env.CLAUDE_CODE_SAFE_MODE === '1' || process.env.OASIS_SAFE_MODE === '1') { SESSION_OPTIONS.safeMode = true; process.env.OASIS_SAFE_MODE = '1'; }
  // Sessions are saved by default (resume with -c / -r / /resume), like Claude Code.
  let persistSession = process.env.OASIS_PERSIST_SESSIONS !== '0';
  let noPersist = process.env.OASIS_PERSIST_SESSIONS === '0';
  let continueSession = false;
  let resumeId = null;
  let workspace = process.cwd();
  let worktreeName = null;
  const args = [];
  let explicitYes = false;
  const headless = { enabled: false, prompt: '', outputFormat: 'text', maxTurns: null, planOnly: false };
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--yes' || arg === '-y' || arg === '--auto') { autoApprove = true; if (arg !== '--auto') explicitYes = true; continue; }
    if (arg === '--permission-mode') {
      const requestedMode = rawArgs[++i];
      const mode = normalizePermissionMode(requestedMode);
      if (!mode) throw new Error('--permission-mode must be one of ' + PERMISSION_MODES.join(', ') + ' (aliases: manual, accept-edits).');
      SESSION_OPTIONS.permissionMode = mode;
      if (mode === 'bypassPermissions') autoApprove = true;
      continue;
    }
    if (arg === '--allowedTools' || arg === '--allowed-tools' || arg === '--disallowedTools' || arg === '--disallowed-tools') {
      if (!rawArgs[i + 1]) throw new Error(arg + ' requires a comma- or space-separated rule list.');
      const rules = rawArgs[++i].split(/,(?![^(]*\))/).map((rule) => rule.trim()).filter(Boolean);
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
      const value = String(rawArgs[++i] || '').toLowerCase();
      if (!['none', 'host', 'default'].includes(value)) throw new Error('--permission-prompts must be none or host.');
      headless.permissionPrompts = value; if (value === 'none') process.env.OASIS_PERMISSION_PROMPTS = 'none'; continue;
    }
    if (arg === '--autocompact') {
      // auto | off | PERCENT% (1-100) | a token window such as 500k or 1m (this session only).
      const value = String(rawArgs[++i] || '').trim().toLowerCase();
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
    if (arg === '--append-system-prompt') { SESSION_OPTIONS.appendSystemPrompt = [SESSION_OPTIONS.appendSystemPrompt, rawArgs[++i] || ''].filter(Boolean).join('\n\n'); continue; }
    const needValue = (flag) => { const value = rawArgs[i + 1]; if (value === undefined) throw new Error(flag + ' requires a value.'); i += 1; return value; };
    if (arg === '--system-prompt') { SESSION_OPTIONS.systemPromptOverride = needValue(arg); continue; }
    if (arg === '--output-style' || arg.startsWith('--output-style=')) { const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : needValue(arg); if (!String(value).trim()) throw new Error('--output-style requires a style name.'); SESSION_OPTIONS.outputStyle = String(value).trim(); continue; }
    if (arg === '--system-prompt-file') { SESSION_OPTIONS.pendingFiles.push({ kind: 'system', file: needValue(arg) }); continue; }
    if (arg === '--append-system-prompt-file') { SESSION_OPTIONS.pendingFiles.push({ kind: 'append', file: needValue(arg) }); continue; }
    if (arg === '--fallback-model') { SESSION_OPTIONS.fallbackModel = needValue(arg); continue; }
    if (arg === '--advisor') { SESSION_OPTIONS.advisor = needValue(arg); continue; }
    if (arg === '--chrome') { SESSION_OPTIONS.chrome = true; continue; }
    if (arg === '--no-chrome') { SESSION_OPTIONS.chrome = false; continue; }
    if (arg === '--bg' || arg === '--background') { SESSION_OPTIONS.background = true; continue; }
    if (arg === '--exec') { const value = rawArgs[i + 1]; if (value === undefined) throw new Error('--exec requires a shell command.'); i += 1; SESSION_OPTIONS.exec = value; continue; }
    if (arg === '--max-budget-usd') {
      const value = Number(needValue(arg));
      if (!Number.isFinite(value) || value <= 0) throw new Error('--max-budget-usd must be a positive dollar amount, for example 2.50.');
      SESSION_OPTIONS.maxBudgetUsd = value;
      continue;
    }
    if (arg === '--agent') { SESSION_OPTIONS.agent = needValue(arg).trim().toLowerCase(); continue; }
    if (arg === '--tools') { SESSION_OPTIONS.tools = needValue(arg).split(/[\s,]+/).filter(Boolean); continue; }
    if (arg === '--mcp-config') { SESSION_OPTIONS.pendingFiles.push({ kind: 'mcp', file: needValue(arg) }); continue; }
    if (arg === '--strict-mcp-config') { SESSION_OPTIONS.strictMcpConfig = true; continue; }
    if (arg === '--channels' || arg.startsWith('--channels=') || arg === '--dangerously-load-development-channels' || arg.startsWith('--dangerously-load-development-channels=')) {
      const dev = arg.startsWith('--dangerously');
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
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
      SESSION_OPTIONS.sessionId = value.toLowerCase(); persistSession = true; continue;
    }
    if (arg === '--fork-session') { SESSION_OPTIONS.forkSession = true; continue; }
    if (arg === '--name' || arg === '-n') { SESSION_OPTIONS.sessionName = needValue(arg); persistSession = true; continue; }
    if (arg === '--verbose') { SESSION_OPTIONS.verbose = true; continue; }
    if (arg === '--debug-file') { SESSION_OPTIONS.debugFile = needValue(arg); process.env.OASIS_DEBUG_FILE = SESSION_OPTIONS.debugFile; if (!SESSION_OPTIONS.debug) { SESSION_OPTIONS.debug = 'all'; process.env.OASIS_DEBUG = 'all'; } continue; }
    if (arg === '--debug') { SESSION_OPTIONS.debug = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') && !/\s/.test(rawArgs[i + 1]) && /^[a-z,!]+$/i.test(rawArgs[i + 1]) ? rawArgs[++i] : 'all'; process.env.OASIS_DEBUG = SESSION_OPTIONS.debug; continue; }
    if (arg === '--disable-slash-commands') { SESSION_OPTIONS.disableSlashCommands = true; continue; }
    if (arg === '--input-format') {
      headless.inputFormat = needValue(arg);
      if (!['text', 'stream-json'].includes(headless.inputFormat)) throw new Error('--input-format must be text or stream-json.');
      continue;
    }
    if (arg === '--include-partial-messages') { headless.includePartial = true; continue; }
    if (arg === '--replay-user-messages') { headless.replayUser = true; continue; }
    if (arg === '--include-hook-events') { headless.includeHookEvents = true; continue; }
    if (arg === '--forward-subagent-text') { headless.forwardSubagentText = true; continue; }
    if (arg === '--prompt-suggestions') { headless.promptSuggestions = true; continue; }
    if (arg === '--exclude-dynamic-system-prompt-sections') { SESSION_OPTIONS.excludeDynamicSections = true; continue; }
    if (arg === '--permission-prompt-tool') { headless.permissionPromptTool = needValue(arg); continue; }
    if (arg === '--init' || arg === '--init-only') { SESSION_OPTIONS.runInit = arg === '--init-only' ? 'only' : 'continue'; continue; }
    if (arg === '--maintenance') { SESSION_OPTIONS.runMaintenance = true; continue; }
    if (arg === '--from-pr') { SESSION_OPTIONS.fromPr = needValue(arg); continue; }
    if (arg === '-p' || arg === '--print') {
      headless.enabled = true;
      if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) headless.prompt = rawArgs[++i];
      continue;
    }
    if (arg === '--output-format') {
      headless.outputFormat = rawArgs[++i];
      if (!OUTPUT_FORMATS.includes(headless.outputFormat)) throw new Error('--output-format must be one of ' + OUTPUT_FORMATS.join(', ') + '.');
      continue;
    }
    if (arg.startsWith('--output-format=')) { headless.outputFormat = arg.slice(16); continue; }
    if (arg === '--max-turns') {
      const value = Number.parseInt(rawArgs[++i], 10);
      if (!Number.isInteger(value) || value < 1 || value > 400) throw new Error('--max-turns must be a whole number from 1 to 400.');
      headless.maxTurns = value;
      continue;
    }
    if (arg === '--model') {
      if (!rawArgs[i + 1]) throw new Error('--model requires a model id.');
      SESSION_OPTIONS.model = rawArgs[++i];
      continue;
    }
    if (arg === '--effort') {
      const level = String(rawArgs[++i] || '').toLowerCase();
      if (!['low', 'medium', 'high', 'max', 'auto'].includes(level)) throw new Error('--effort must be low, medium, high, max or auto.');
      SESSION_OPTIONS.effort = level === 'auto' ? null : level;
      continue;
    }
    if (arg === '--json-schema' || arg === '--output-schema') {
      const value = rawArgs[++i];
      if (!value) throw new Error(arg + ' needs a JSON Schema (inline JSON or @path/to/schema.json).');
      // Codex's --output-schema takes a plain file path.
      headless.jsonSchemaSource = arg === '--output-schema' && !/^\s*[{@]/.test(value) ? '@' + value : value;
      continue;
    }
    if (arg === '-o' || arg === '--output-last-message') {
      const value = rawArgs[++i];
      if (!value || value.startsWith('-')) throw new Error(arg + ' needs a file path for the final message.');
      headless.outputLastMessage = value;
      continue;
    }
    if (arg === '-w' || arg === '--worktree') {
      worktreeName = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[++i] : 'session';
      continue;
    }
    if (arg === '--plan') { headless.planOnly = true; continue; }
    if (arg === '--tmux' || arg === '--tmux=classic') { SESSION_OPTIONS.tmux = true; continue; }
    if (arg === '--ide') { process.env.OASIS_IDE = 'auto'; continue; }
    if (arg === '--teammate-mode' || arg.startsWith('--teammate-mode=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
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
      const value = (arg.includes('=') ? arg.split('=')[1] : rawArgs[++i] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) throw new Error('--system-prompt-snapshot must be on or off.');
      SESSION_OPTIONS.systemPromptSnapshot = value;
      continue;
    }
    if (arg === '--plugin-url') { const url = rawArgs[++i]; if (!url) throw new Error('--plugin-url needs a URL.'); (SESSION_OPTIONS.pluginUrls ||= []).push(url); continue; }
    if (arg === '--plugin-dir') { const dir = rawArgs[++i]; if (!dir) throw new Error('--plugin-dir needs a directory.'); process.env.OASIS_PLUGIN_DIRS = [process.env.OASIS_PLUGIN_DIRS, path.resolve(dir)].filter(Boolean).join(path.delimiter); continue; }
    if (arg === '--add-dir') { const dir = rawArgs[++i]; if (!dir) throw new Error('--add-dir needs a directory.'); SESSION_OPTIONS.addDirs.push(path.resolve(dir)); continue; }
    if (arg === '--dangerously-skip-permissions') { SESSION_OPTIONS.permissionMode = 'bypassPermissions'; SESSION_OPTIONS.allowBypass = true; autoApprove = true; continue; }
    // Codex and Gemini CLI flags, mapped to the nearest OASIS policy. The runtime's
    // hard refusals (home deletion, force pushes, reset --hard, ...) still apply.
    if (arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') { SESSION_OPTIONS.permissionMode = 'bypassPermissions'; SESSION_OPTIONS.allowBypass = true; autoApprove = true; process.env.OASIS_SANDBOX = '0'; continue; }
    if (arg === '--full-auto') { SESSION_OPTIONS.permissionMode = 'acceptEdits'; process.env.OASIS_SANDBOX = '1'; continue; }
    if (arg === '--sandbox' || arg === '-s' || arg.startsWith('--sandbox=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (value === 'read-only') SESSION_OPTIONS.permissionMode = 'plan';
      else if (value === 'workspace-write') process.env.OASIS_SANDBOX = '1';
      else if (value === 'danger-full-access') process.env.OASIS_SANDBOX = '0';
      else throw new Error('--sandbox must be read-only, workspace-write or danger-full-access.');
      continue;
    }
    if (arg === '--ask-for-approval' || arg === '-a' || arg.startsWith('--ask-for-approval=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      // never: no prompts, like Codex; OASIS uses auto mode, whose risk check still blocks dangerous commands.
      if (value === 'never') SESSION_OPTIONS.permissionMode = 'auto';
      else if (value === 'on-request' || value === 'on-failure' || value === 'untrusted') SESSION_OPTIONS.permissionMode = SESSION_OPTIONS.permissionMode || 'default';
      else throw new Error('--ask-for-approval must be untrusted, on-failure, on-request or never.');
      continue;
    }
    if (arg === '--approval-mode' || arg.startsWith('--approval-mode=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      const mode = { default: 'default', auto_edit: 'acceptEdits', 'auto-edit': 'acceptEdits', yolo: 'bypassPermissions', plan: 'plan' }[value];
      if (!mode) throw new Error('--approval-mode must be default, auto_edit, yolo or plan.');
      SESSION_OPTIONS.permissionMode = mode;
      if (mode === 'bypassPermissions') { SESSION_OPTIONS.allowBypass = true; autoApprove = true; }
      continue;
    }
    if (arg === '--include-directories' || arg.startsWith('--include-directories=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error('--include-directories needs a comma-separated list of directories.');
      for (const dir of value.split(',').map((item) => item.trim()).filter(Boolean)) SESSION_OPTIONS.addDirs.push(path.resolve(dir));
      continue;
    }
    if (arg === '--skip-git-repo-check') continue;
    // Gemini CLI: start the interactive session with this first message.
    if (arg === '-i' || arg === '--prompt-interactive' || arg.startsWith('--prompt-interactive=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error('--prompt-interactive needs a message.');
      SESSION_OPTIONS.initialPrompt = value; continue;
    }
    // Aider flags. --test-cmd plus --auto-test uses Oasis auto-test; commits use auto-commit.
    if (arg === '--yes-always') { autoApprove = true; continue; }
    if (arg === '--message' || arg === '--msg' || arg.startsWith('--message=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error(arg.split('=')[0] + ' needs a message.');
      headless.enabled = true; headless.prompt = value; continue;
    }
    if (arg === '--message-file' || arg.startsWith('--message-file=')) {
      const file = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!file) throw new Error('--message-file needs a file.');
      headless.enabled = true; headless.prompt = readFileSync(path.resolve(file), 'utf8'); continue;
    }
    if (arg === '--test-cmd' || arg.startsWith('--test-cmd=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      if (!value) throw new Error('--test-cmd needs a command.');
      SESSION_OPTIONS.aiderTestCmd = value; continue;
    }
    if (arg === '--auto-test') { SESSION_OPTIONS.aiderAutoTest = true; continue; }
    if (arg === '--no-auto-test') { process.env.OASIS_AUTO_TEST = 'off'; continue; }
    if (arg === '--auto-commits') { process.env.OASIS_AUTO_COMMIT = '1'; continue; }
    if (arg === '--no-auto-commits') { process.env.OASIS_AUTO_COMMIT = '0'; continue; }
    if (arg === '--no-session-persistence') { noPersist = true; continue; }
    if (arg === '--continue' || arg === '-c') { persistSession = true; continueSession = true; continue; }
    if (arg === '--resume' || arg === '-r') {
      // Without an ID (like `claude -r`), open the session picker.
      if (!rawArgs[i + 1] || rawArgs[i + 1].startsWith('-')) { SESSION_OPTIONS.resumePicker = true; persistSession = true; continue; }
      resumeId = rawArgs[++i]; persistSession = true; continue;
    }
    if (arg === '--workspace' || arg === '-C' || arg === '--cd') {
      if (!rawArgs[i + 1]) throw new Error('--workspace requires a path.');
      workspace = path.resolve(rawArgs[++i]);
      continue;
    }
    if (arg.startsWith('--workspace=')) { workspace = path.resolve(arg.slice('--workspace='.length)); continue; }
    args.push(arg);
  }
  if (SESSION_OPTIONS.aiderAutoTest) {
    // Aider runs --test-cmd only with --auto-test; without --test-cmd, keep the configured command.
    if (SESSION_OPTIONS.aiderTestCmd && process.env.OASIS_AUTO_TEST !== 'off') process.env.OASIS_AUTO_TEST = SESSION_OPTIONS.aiderTestCmd;
  }
  await access(workspace);
  await resolveFlagFiles(workspace);
  if (SESSION_OPTIONS.pluginUrls && SESSION_OPTIONS.pluginUrls.length) {
    const { fetchPluginArchive } = await import('./zip.mjs');
    for (const url of SESSION_OPTIONS.pluginUrls) {
      const dir = await fetchPluginArchive(url);
      // fetchPluginArchive may return the plugin's single top-level subfolder;
      // register its actual temporary extraction root so cleanup removes the parent too.
      const parent = path.dirname(dir);
      TEMPORARY_PLUGIN_DIRS.add(path.basename(parent).startsWith('oasis-plugin-url-') ? parent : dir);
      process.env.OASIS_PLUGIN_DIRS = [process.env.OASIS_PLUGIN_DIRS, dir].filter(Boolean).join(path.delimiter);
    }
  }
  if (SESSION_OPTIONS.restricted && (SESSION_OPTIONS.permissionMode === 'bypassPermissions' || SESSION_OPTIONS.allowBypass)) throw new Error('--restricted cannot be combined with --dangerously-skip-permissions, --allow-dangerously-skip-permissions, or --permission-mode bypassPermissions.');
  if (SESSION_OPTIONS.restricted) { autoApprove = false; SESSION_OPTIONS.allowBypass = false; }
  if (SESSION_OPTIONS.runInit) {
    await initWorkspace(workspace);
    await runSetupHooks(workspace, 'init');
    if (SESSION_OPTIONS.runInit === 'only') return;
  }
  if (SESSION_OPTIONS.runMaintenance) await runSetupHooks(workspace, 'maintenance');
  const command = args[0];
  const rest = args.slice(1);
  const persistence = { enabled: !noPersist && (persistSession || Boolean(resumeId)), resumeId };
  if (continueSession && !resumeId) {
    const saved = await listSessions(workspace);
    persistence.resumeId = saved[0] && saved[0].id || null;
    if (!persistence.resumeId) (headless.enabled ? stderr : stdout).write('No previous session exists for this workspace; a new session will be saved after your next task.\n');
  }

  if (headless.jsonSchemaSource) {
    const source = headless.jsonSchemaSource.startsWith('@') ? await readFile(path.resolve(headless.jsonSchemaSource.slice(1)), 'utf8') : headless.jsonSchemaSource;
    try { headless.jsonSchema = JSON.parse(source); } catch (error) { throw new Error('--json-schema is not valid JSON: ' + error.message); }
    if (!headless.jsonSchema || typeof headless.jsonSchema !== 'object') throw new Error('--json-schema must be a JSON object.');
    if (!headless.enabled) throw new Error('--json-schema works with -p (headless mode).');
  }
  await applySettingsPolicy(workspace, autoApprove, [persistence && persistence.resumeId, SESSION_OPTIONS.sessionId]);
  if (SESSION_OPTIONS.exec !== undefined) {
    if (SESSION_OPTIONS.restricted) throw new Error('--exec is not available in --restricted mode.');
    const { startExecJob } = await import('./background-sessions.mjs');
    const entry = await startExecJob({ root: workspace, command: [SESSION_OPTIONS.exec, ...args].join(' '), env: process.env, name: SESSION_OPTIONS.sessionName || null });
    stdout.write('Started background job ' + entry.id + ': ' + entry.command + '\n  oasis logs ' + entry.id + ' --follow   watch output\n  oasis stop ' + entry.id + '             stop it\n');
    if (!SESSION_OPTIONS.background && stdout.isTTY) return await backgroundCommand(workspace, ['logs', entry.id, '--follow']);
    return;
  }
  if (SESSION_OPTIONS.background) {
    const task = args.join(' ').trim();
    if (!task) throw new Error('Usage: oasis --bg "describe the task"');
    const { startBackgroundSession } = await import('./background-sessions.mjs');
    const entry = await startBackgroundSession({ root: workspace, prompt: task, env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null, model: SESSION_OPTIONS.model || null, name: SESSION_OPTIONS.sessionName || null });
    stdout.write('Started background session ' + entry.id + '. It runs without approval prompts, so only tools your permission rules allow will run.\n  oasis bg logs ' + entry.id + ' --follow   watch progress\n  oasis bg attach ' + entry.id + '          continue the conversation here\n');
    return;
  }
  if (SESSION_OPTIONS.tmux && !worktreeName) throw new Error('--tmux requires --worktree.');
  if (SESSION_OPTIONS.resumePicker) {
    if (headless.enabled) throw new Error('--resume requires a saved session ID with -p.');
    QUEUED_INPUT.unshift('/resume');
  }
  if (SESSION_OPTIONS.initialPrompt && !headless.enabled) {
    if (command && command !== '--interactive') throw new Error('--prompt-interactive takes the whole first message; quote it, for example oasis -i "fix the tests".');
    QUEUED_INPUT.push(SESSION_OPTIONS.initialPrompt);
  }
  if (worktreeName && SESSION_OPTIONS.tmux && !headless.enabled && (!command || command === '--interactive')) return await tmuxWorktreeSession(workspace, worktreeName, rawArgs);
  if (worktreeName && (headless.enabled || !command || command === '--interactive')) {
    const session = await startSessionWorktree(workspace, worktreeName, headless.enabled ? stderr : stdout);
    try {
      if (headless.enabled) return await printMode(session.path, headless, args, autoApprove, persistence);
      return await interactive(session.path, autoApprove, persistence);
    } finally { await endSessionWorktree(workspace, session, headless.enabled ? stderr : stdout); }
  }
  if (headless.enabled) return await printMode(workspace, headless, args, autoApprove, persistence);
  if (!command || command === '--interactive') return await interactive(workspace, autoApprove, persistence);
  if (command === '--help' || command === '-h' || command === 'help') return (args.includes('all') || args.includes('--all')) ? printHelp() : printQuickHelp();
  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(await readFile(path.join(APP_ROOT, 'package.json'), 'utf8'));
    stdout.write('OASIS ' + pkg.version + '\n');
    return;
  }
  if (command === 'setup') {
    // `oasis setup --auto` (or `setup auto` / `--detect`): configure from this computer's hardware and running model servers.
    if (rest[0] === 'auto' || rest.includes('--detect') || process.argv.slice(2).includes('--auto')) return await autoSetup(workspace, { dryRun: rest.includes('--dry-run') });
    if (stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function' && !rest.length) {
      const outcome = await pasteFirstSetup(workspace);
      if (outcome !== 'menu') return;
    }
    return await configureProvider(workspace);
  }
  if (command === 'connect') return await connectCommand(rest, workspace);
  if (command === 'doctor') return await doctor(rest, workspace);
  if (command === 'memory') return await memoryCommand(rest, workspace);
  if (command === 'diagnostics') return await diagnosticsCommand(rest, workspace, autoApprove);
  // The global flag parser takes --yes/-y for autoApprove; hand it back.
  if (command === 'update') return await updateOasis(explicitYes && !rest.includes('--yes') ? [...rest, '--yes'] : rest);
  if (command === 'uninstall') return await uninstallOasis(explicitYes && !rest.includes('--yes') ? [...rest, '--yes'] : rest);
  if (command === 'web') return await startWebWorkspace(workspace, rest);
  if (command === 'app') return await startUniversalApp(rest);
  if (command === 'watch') return await watchCommentsCommand(workspace, autoApprove || rest.includes('--yes'), persistence);
  if (command === 'plan') {
    const planPrompt = rest.join(' ').trim();
    if (!planPrompt) throw new Error('Usage: oasis plan "Describe the task to plan"');
    await ensureModelProviderSetup(workspace);
    const session = await runPrompt(planPrompt, workspace, autoApprove, null, persistence, { planOnly: true });
    closeSession(session);
    return;
  }
  if (command === 'eval') {
    // The global option parser above consumes --model before `eval` sees it.
    // Hand it back: external agents take it as their own --model; OASIS's own
    // eval reads the model from its provider config (OASIS_MODEL).
    const { args: evalArgs, env: evalEnv } = evalModelPassthrough(rest, SESSION_OPTIONS.model, process.env);
    const result = await runEvalCommand(evalArgs, { autoApprove, env: evalEnv });
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (command === 'init') return await initWorkspace(workspace);
  if (command === 'update' || command === 'self-update') return await selfUpdate(autoApprove);
  if (command === 'config' || command === 'status') return printConfig(await loadConfig());
  if (command === 'mcp') return await manageMcp(rest, workspace);
  // A pasted install command (npx …, uvx …, claude mcp add …, /plugin install …,
  // npx skills add …) is one source too, quoted or not.
  const pastedInstall = command === 'add' && /^(npx|uvx|bunx|pnpx|docker|pipx|claude|codex|gemini|qwen|opencode|skills|\/plugin)$/i.test(String(rest[0] || '')) && rest.length > 1;
  if (pastedInstall) {
    const { addAnything } = await import('./add-anything.mjs');
    // Read the command from the raw arguments: its own flags (npx -y, -e KEY=V,
    // --transport) belong to it, and its -y must not count as OASIS's --yes.
    const argv = process.argv.slice(2);
    const at = argv.indexOf('add');
    const tail = argv.slice(at + 1);
    const yes = argv.slice(0, at).some((arg) => arg === '--yes' || arg === '-y') || tail[tail.length - 1] === '--yes';
    const source = (tail[tail.length - 1] === '--yes' ? tail.slice(0, -1) : tail).map((word) => /[\s"'\\]/.test(word) ? "'" + word.replace(/'/g, "'\\''") + "'" : word).join(' ');
    stdout.write('Looking at ' + source + '…\n');
    const result = await addAnything(source, { root: workspace, env: process.env, scope: 'user', approve: async (summary) => {
      stdout.write(summary + '\n');
      if (yes) return true;
      if (!stdin.isTTY) { stdout.write('Run again with --yes to install without a prompt.\n'); return false; }
      return /^y(es)?$/i.test(String(await askLine('Install it? [y/N] ')).trim());
    } });
    stdout.write(result.message + '\n');
    if (result.approved === false) process.exitCode = 1;
    return result;
  }
  if (command === 'add' && rest.filter((word) => !/^--/.test(word)).length - (rest.includes('--name') ? 1 : 0) === 1) {
    // oasis add <anything>: GitHub link, owner/repo, plugin@marketplace, MCP URL,
    // npm MCP package or MCP Registry name. One summary, one yes, done.
    const { addAnything } = await import('./add-anything.mjs');
    const words = rest.filter((word) => !/^--/.test(word));
    const scope = rest.includes('--project') ? 'project' : 'user';
    const nameAt = rest.indexOf('--name');
    const name = nameAt >= 0 ? rest[nameAt + 1] : undefined;
    const source = words.filter((word) => word !== name).join(' ');
    if (!source) { stdout.write('Usage: oasis add <GitHub link | owner/repo[#name] | plugin@marketplace | MCP URL | npm package | registry name> [--project] [--name NAME]\n'); process.exitCode = 1; return; }
    stdout.write('Looking at ' + source + '…\n');
    const result = await addAnything(source, { root: workspace, env: process.env, scope, name, approve: async (summary) => {
      stdout.write(summary + '\n');
      if (autoApprove) return true;
      if (!stdin.isTTY) { stdout.write('Run again with --yes to install without a prompt.\n'); return false; }
      return /^y(es)?$/i.test(String(await askLine('Install it? [y/N] ')).trim());
    } });
    stdout.write(result.message + '\n');
    if (result.approved === false) process.exitCode = 1;
    return result;
  }
  if (command === 'ide') { const { ideCli } = await import('./ide.mjs'); return await ideCli(workspace, rest, { env: process.env }); }
  if (command === 'extensions' || command === 'extension') return await manageExternalExtensions(workspace, rest, autoApprove);
  if (command === 'plugins' || command === 'plugin') {
    // Claude Code plugins and marketplaces; the bundled capability catalog stays under
    // `oasis plugins list|install|remove NAME` for its built-in names.
    const sub = String(rest[0] || 'list').toLowerCase();
    if (sub === 'eval') {
      const { pluginEvalCli } = await import('./plugin-eval.mjs');
      const result = await pluginEvalCli(rest.slice(1), { env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null });
      if (!result.ok || (result.report && result.report.summary.passRate < 1)) process.exitCode = 1;
      return;
    }
    const builtIn = ['install', 'remove'].includes(sub) && rest[1] && !String(rest[1]).includes('@') && await (await import('./plugins.mjs')).isBuiltInPlugin(rest[1]);
    if (sub === 'catalog' || sub === 'browse' || builtIn) return await managePlugins(workspace, sub === 'catalog' ? ['list', ...rest.slice(1)] : rest);
    const { pluginCli } = await import('./claude-plugins.mjs');
    if (sub === 'list' || sub === 'ls') {
      await managePlugins(workspace, ['list']);
      stdout.write('\nClaude Code plugins (oasis plugin marketplace add OWNER/REPO, then oasis plugin install NAME@MARKETPLACE)\n\n');
    }
    await pluginCli(workspace, rest, { env: process.env });
    return;
  }
  if (command === 'sessions') return await manageSessions(workspace, rest);
  if (command === 'batch') {
    const { runBatch } = await import('./trajectories.mjs');
    const result = await runBatch(workspace, rest, { env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null });
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (command === 'gateway') {
    const { runGateway } = await import('./gateway-telegram.mjs');
    await runGateway(rest, { root: workspace, env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null });
    return;
  }
  if (command === 'acp') {
    const { serveAcp } = await import('./acp.mjs');
    const { oasisVersion } = await import('./version.mjs');
    const modeAt = rest.indexOf('--permission-mode');
    const permissionMode = (modeAt >= 0 ? rest[modeAt + 1] : null) || SESSION_OPTIONS.permissionMode || null;
    if (permissionMode && !['default', 'acceptEdits', 'plan', 'auto'].includes(permissionMode)) throw new Error('oasis acp --permission-mode must be default, acceptEdits, plan or auto.');
    await serveAcp({ env: process.env, version: oasisVersion(), permissionMode, editorTerminal: rest.includes('--editor-terminal') });
    return;
  }
  if (command === 'skills' && rest[0] === 'eval') {
    const { pluginEvalCli } = await import('./plugin-eval.mjs');
    const result = await pluginEvalCli(rest.slice(1), { env: process.env, permissionMode: SESSION_OPTIONS.permissionMode || null });
    if (!result.ok || (result.report && result.report.summary.passRate < 1)) process.exitCode = 1;
    return;
  }
  if (command === 'skills') return await manageSkills(workspace, rest, autoApprove);
  if (command === 'permissions') return await managePermissions(workspace, rest);
  if (command === 'trust') return await manageTrust(workspace, rest);
  if (command === 'import') return await importCommand(workspace, rest, autoApprove);
  if (command === 'bg' || command === 'background') return await backgroundCommand(workspace, rest);
  // Claude Code's top-level background commands: claude attach|logs|stop|kill|rm|respawn ID.
  if (['attach', 'logs', 'stop', 'kill', 'rm', 'respawn'].includes(command)) return await backgroundCommand(workspace, [command, ...rest]);
  if (command === 'purge') return await purgeCommand(workspace, rest, autoApprove);
  if (command === 'auto-mode') return await autoModeCommand(workspace, rest, autoApprove);
  if (command === 'auth') return await authCommand(workspace, rest);
  if (command === 'setup-token') return await setupTokenCommand(rest);
  if (command === 'agents' && (rest.includes('--json') || !stdin.isTTY)) return await agentsCommand(rest);
  if (command === 'ultrareview') return await ultrareviewCommand(workspace, rest, autoApprove, persistence);
  if (command === 'insights') {
    const { writeInsightsReport, insightsSummaryText } = await import('./insights.mjs');
    const { file, stats } = await writeInsightsReport({ env: process.env, days: Math.min(365, Math.max(1, parseInt(rest[0], 10) || 30)) });
    stdout.write(insightsSummaryText(stats) + '\nReport: ' + file + '\n');
    return;
  }
  if (command === 'backups') return await showBackups(workspace);
  if (command === 'restore') return await restoreOne(workspace, rest[0]);
  if (command === 'install') {
    if (!rest.length) { stdout.write('Usage: oasis install PACKAGE_NAME  (or specify an ecosystem such as "npm package prettier")\n'); return; }
    const request = parseInstallIntent(args.join(' '));
    if (!request) throw new Error('Use one package name at a time. For compound setup requests, configure a provider and ask Oasis in plain English.');
    return await installRequest(request, workspace, autoApprove);
  }
  const fullPrompt = args.join(' ');
  {
    const direct = parseInstallIntent(fullPrompt);
    if (direct) return await installRequest(direct, workspace, autoApprove);
  }
  // On a terminal, a task given on the command line opens an interactive session so you
  // can follow up. Scripts (no TTY) and OASIS_ONE_SHOT=1 keep the one-shot run; -p is headless.
  if (stdin.isTTY && stdout.isTTY && !/^(?:1|true|yes|on)$/i.test(String(process.env.OASIS_ONE_SHOT || ''))) {
    QUEUED_INPUT.push(fullPrompt);
    return await interactive(workspace, autoApprove, persistence);
  }
  await ensureModelProviderSetup(workspace);
  const session = await runPrompt(fullPrompt, workspace, autoApprove, null, persistence);
  closeSession(session);
}

main().catch((error) => {
  stdout.write('OASIS error: ' + (error.message || String(error)) + '\n');
  process.exitCode = 1;
});
