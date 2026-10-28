#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { defaultCloudBaseURL } from './cloud-providers.mjs';
import { loadConfig, saveConfig, getProviderSummary, DEFAULT_BASE_URL, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_MODEL, validateBaseUrl, validateProtocol, isLoopbackUrl, isNodeVersionSupported, resolveSetupProviderPreset } from './config.mjs';
import { applyEffort, createSession, runAgentTurn, runAgentPlan, runForkedTurn, closeSession, testProviderConnection, repairInterruptedHistory, resolveQuestionAnswer } from './agent.mjs';
import { loadMcpServers, saveMcpServers, getMcpConfigPath, validateMcpServerConfig } from './mcp.mjs';
import { loadProjectMcpServers } from './mcp-project.mjs';
import { loadSession, saveSession, listSessions, deleteSession } from './sessions.mjs';
import { executeTool, listAvailableSkills } from './tools.mjs';
import { parseInstallIntent, planPackageInstall } from './installer.mjs';
import { listBackups, restoreBackup } from './backups.mjs';
import { runEvalCommand } from './eval.mjs';
import { managePlugins } from './plugins.mjs';
import { inspectGitHubExtension, inspectGitHubMcpServers, selectReviewedMcpServers, resolveImportedSlashCommand, installGitHubExtension, updateGitHubExtension, rollbackGitHubExtension, listInstalledExtensions, removeGitHubExtension } from './extensions.mjs';
import { startOasisWebServer } from './web.mjs';
import { loadSettings, setWorkspaceTrust, addPermissionRule, PERMISSION_MODES, userSettingsPath } from './settings.mjs';
import { detectSandbox, resolveSandbox } from './sandbox.mjs';
import { resolveCustomCommand, expandFileMentions, loadCustomCommands } from './commands.mjs';
import { visionEnabled } from './images.mjs';
import { searchBackend } from './web-search.mjs';
import { loadAgentDefinitions } from './subagents.mjs';
import { loadOutputStyles } from './output-styles.mjs';
import { renderStatusLine, statusLinePayload } from './status-line.mjs';
import { BUILTIN_COMMANDS, runBuiltinCommand, createUsageTracker, recordUsage, formatInterval } from './slash.mjs';
import { appendMemoryNote, memoryFiles } from './memory.mjs';
import { runHeadless, OUTPUT_FORMATS } from './headless.mjs';
import { fstatSync } from 'node:fs';
import { runDiagnostics, formatDiagnostics, CHECKERS } from './diagnostics.mjs';
import { readInput, KeyDecoder } from './line-editor.mjs';
import { loadHistory, appendHistory } from './input-history.mjs';
import { createCompleter } from './completion.mjs';
import { MarkdownStream, colorEnabled } from './markdown.mjs';
import { showStartupBanner, promptFor, footerFor, nextMode, runShellPassthrough, shellContextBlock, describeTool, describeEdit } from './terminal-ui.mjs';

// Options that shape every agent session created by this process.
const SESSION_OPTIONS = { permissionMode: null, allowedTools: [], disallowedTools: [], appendSystemPrompt: '', model: null, effort: null, outputStyle: null, addDirs: [], pendingFiles: [], mcpServers: [], settingsOverrides: [], tools: null };
const USAGE = createUsageTracker();
let settingsWarningShown = false;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_URL = 'git+https://github.com/FAHTHIZ/oasis.git#main';

function printHelp() {
  stdout.write([
    'Oasis OSS — a plain-English coding agent',
    '',
    'Usage:',
    '  oasis                         Start an interactive agent session',
    '  oasis "fix the failing tests"  Give a task in plain English',
    '  oasis -p "task" [--output-format text|json|stream-json] [--max-turns N]  Run once without prompts (scripts/CI)',
    '  cat log.txt | oasis -p "explain this error"  Piped input is added to the prompt',
    '  oasis setup                   Configure a model provider',
    '  oasis doctor [--test-provider] Check the environment; optionally verify live tool calling',
    '  oasis update [--check] [--yes] Check GitHub main for a newer Oasis and install it',
    '  oasis web [--host HOST] [--port PORT] [--tls-cert FILE --tls-key FILE]  Start browser workspace',
    '  oasis init                    Create OASIS.md project instructions',
    '  oasis memory [list|search Q|show ID|forget ID|path]  View and manage auto memory',
    '  oasis -p PROMPT --json-schema SCHEMA  Return JSON that matches a schema (inline or @file.json)',
    '  oasis -p PROMPT --bare        Skip project instructions, skills, hooks, MCP, and memory',
    '  oasis -w [NAME]               Work in a new git worktree on its own branch',
    '  oasis diagnostics [PATH...] [--checker NAME] [--json]  Run type checkers/linters and list problems',
    '  oasis plan "task"             Inspect the workspace and produce a read-only implementation plan',
    '  oasis install pnpm            Install a tool using a detected manager',
    '  oasis sessions list           List locally saved sessions for this workspace',
    '  oasis --continue              Resume the most recent saved session and keep saving it',
    '  oasis --resume SESSION_ID     Resume one saved session',
    '  oasis mcp list                List configured Model Context Protocol servers',
    '  oasis mcp add NAME -- COMMAND Configure a stdio MCP server',
    '  oasis mcp remove NAME         Remove a configured server',
    '  oasis mcp serve [--allow-edits] [--allow-commands]  Serve Oasis tools to other MCP clients over stdio',
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
    '  --permission-mode MODE        default | acceptEdits | plan | auto | bypassPermissions',
    '  --add-dir PATH                Let tools read and edit another directory (repeatable)',
    '  --dangerously-skip-permissions  Same as --permission-mode bypassPermissions --yes',
    '  --continue, -c                Continue the most recent saved session',
    '  --resume ID, -r ID            Resume a saved session (see oasis sessions list)',
    '  --model ID                    Use a different model for this run',
    '  --max-turns N                 Limit model steps for one task (1-400)',
    '  --allowedTools RULES          Extra allow rules, e.g. "run_command(npm test:*),Edit(src/**)"',
    '  --disallowedTools RULES       Extra deny rules for this run',
    '  --append-system-prompt TEXT   Add instructions to the system prompt',
    '  --append-system-prompt-file F Add instructions from a file',
    '  --system-prompt TEXT | --system-prompt-file F  Replace the default system prompt',
    '  --fallback-model ID           Switch to this model when the main one is overloaded or failing',
    '  --max-budget-usd N            Stop once the estimated model cost reaches N dollars',
    '  --tools "Read,Edit,Bash"      Only offer these tools (Claude or Oasis names; "" for none)',
    '  --mcp-config FILE|JSON        Load MCP servers ({"mcpServers": {...}}); --strict-mcp-config uses only these',
    '  --settings FILE|JSON          Extra settings on top of the usual files; --setting-sources user,project,local',
    '  --agents JSON                 Define subagents inline: {"name": {"description", "prompt", "tools"}}',
    '  --session-id UUID | --name NAME | --fork-session  Control how the session is saved or resumed',
    '  --input-format stream-json    Read user messages as JSON lines on stdin (with -p)',
    '  --include-partial-messages    Stream text deltas as stream_event lines (with stream-json)',
    '  --replay-user-messages        Echo user messages back in stream-json output',
    '  --permission-prompt-tool NAME Ask this MCP tool to approve actions in -p mode',
    '  --from-pr N                   Start with a GitHub pull request\'s description and diff as context',
    '  --init | --init-only          Create project instructions first (and exit with --init-only)',
    '  --disable-slash-commands      Treat /text as a normal message (built-ins still work)',
    '  --verbose | --debug [cats]    More detail about what Oasis is doing',
    '  --help, -h                    Show this help',
    '  --version                     Show the installed version',
    '',
    'Setup: npm install -g ' + INSTALL_URL,
    'Then:  oasis setup',
    'MCP:   oasis mcp add docs -- npx -y @modelcontextprotocol/server-filesystem /path/to/share',
    'Safety: enable { "sandbox": { "enabled": true } } in settings for OS isolation. Review approvals; --yes increases risk.',
    ''
  ].join('\n'));
}

// While a turn runs, keystrokes are captured: Esc or Ctrl+C interrupts, and
// typed lines are queued as the next messages (type-ahead, like Claude Code).
const QUEUED_INPUT = [];
let queuedDraft = '';
let turnKeys = null;
function startTurnKeys(onInterrupt) {
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
      else if (key.name === 'enter' && buffer.trim()) {
        QUEUED_INPUT.push(buffer);
        stdout.write('\n' + dim('  ↳ queued: ' + buffer.replace(/\s+/g, ' ').slice(0, 90)) + '\n');
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

async function askLine(question) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('This action needs an interactive terminal. Re-run it from a terminal session.');
  const paused = turnKeys;
  if (paused) paused.suspend();
  try { return await askLineRaw(question); } finally { if (paused && turnKeys === paused) paused.resume(); }
}

async function askLineRaw(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  // Readline swallows Ctrl+C; forward it so a running task can be interrupted.
  const controller = new AbortController();
  rl.on('SIGINT', () => { controller.abort(); if (process.listenerCount('SIGINT')) process.emit('SIGINT'); });
  try { return await rl.question(question, { signal: controller.signal }); } finally { rl.close(); }
}

async function askQuestionInTerminal(question) {
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

async function configureOmniRoute(root = process.cwd()) {
  const runSetup = (localApiKey = '') => executeTool('setup_omniroute', localApiKey ? { localApiKey } : {}, {
    root, env: process.env, autoApprove: false,
    approval: (message) => approve(message, true, false)
  });
  let result = await runSetup();
  if (!result.connected && result.needsLocalApiKey) {
    const localApiKey = await askSecret('OmniRoute local endpoint key (input hidden; leave blank if your gateway does not require one): ');
    if (localApiKey) result = await runSetup(localApiKey);
  }
  stdout.write((result.message || 'OmniRoute setup did not complete.') + '\n');
  if (result.connected) stdout.write('OmniRoute tool calling was verified; Oasis is now connected to model "auto".\n');
  else stdout.write('The previous provider configuration was left unchanged. Resolve the message above and retry oasis setup.\n');
  return result;
}

async function configureProvider(root = process.cwd(), options = {}) {
  stdout.write('\nOasis setup — choose and verify your model provider\n');
  stdout.write('A successful model response is required before settings are saved or coding tools are used. Presets include OmniRoute, OpenAI, Anthropic, OpenRouter, Gemini, local Ollama, AWS Bedrock, and Google Vertex AI.\n');
  const rl = createInterface({ input: stdin, output: stdout });
  let protocol, baseURL, model, presetName;
  const presets = {
    openai: { protocol: 'openai-responses', baseURL: DEFAULT_BASE_URL, model: DEFAULT_MODEL },
    anthropic: { protocol: 'anthropic', baseURL: DEFAULT_ANTHROPIC_BASE_URL, model: 'claude-sonnet-5' },
    openrouter: { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: '' },
    gemini: { protocol: 'openai-compatible', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash' },
    ollama: { protocol: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: '' },
    omniroute: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:20128/v1', model: 'auto' },
    bedrock: { protocol: 'bedrock', baseURL: defaultCloudBaseURL('bedrock', process.env), model: process.env.ANTHROPIC_MODEL || '' },
    vertex: { protocol: 'vertex', baseURL: defaultCloudBaseURL('vertex', process.env), model: process.env.ANTHROPIC_MODEL || '' }
  };
  try {
    const defaultPreset = resolveSetupProviderPreset(options.defaultPreset);
    presetName = (await rl.question('Provider preset [omniroute / openai / anthropic / openrouter / gemini / ollama / bedrock / vertex / custom] (default ' + defaultPreset + '): ')).trim().toLowerCase() || defaultPreset;
    if (presetName === 'custom') {
      protocol = validateProtocol((await rl.question('Protocol [openai-responses / anthropic / openai-compatible / bedrock / vertex] (default openai-responses): ')).trim().toLowerCase() || 'openai-responses');
      const defaultBase = protocol === 'bedrock' || protocol === 'vertex' ? defaultCloudBaseURL(protocol, process.env) : protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
      baseURL = (await rl.question('Base URL [' + defaultBase + ']: ')).trim() || defaultBase;
      const defaultModel = protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : '');
      const modelPrompt = defaultModel ? 'Model name [' + defaultModel + ']: ' : 'Model name (exact model ID required): ';
      model = (await rl.question(modelPrompt)).trim() || defaultModel;
    } else {
      const selected = presets[presetName];
      if (!selected) throw new Error('Unknown provider preset. Choose omniroute, openai, anthropic, openrouter, gemini, ollama, bedrock, vertex, or custom.');
      protocol = selected.protocol;
      baseURL = selected.baseURL;
      model = selected.model;
      if (presetName !== 'omniroute') {
        baseURL = (await rl.question('Base URL [' + selected.baseURL + ']: ')).trim() || selected.baseURL;
        const modelPrompt = selected.model ? 'Model name [' + selected.model + ']: ' : 'Model name (exact model ID required): ';
        model = (await rl.question(modelPrompt)).trim() || selected.model;
      }
    }
    if (!model) throw new Error('Enter the exact model name supported by this provider before continuing.');
  } finally { rl.close(); }
  if (presetName === 'omniroute') return await configureOmniRoute(root);
  protocol = validateProtocol(protocol);
  baseURL = validateBaseUrl(baseURL);
  const existing = await loadConfig().catch(() => ({ apiKey: '', baseURL: '', protocol: '' }));
  let apiKey = '';
  const localEndpoint = isLoopbackUrl(baseURL);
  if (protocol === 'bedrock' || protocol === 'vertex') {
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
async function ensureModelProviderSetup(root, options = {}) {
  let configured = false;
  try { configured = Boolean((await loadConfig()).configured); } catch {}
  if (configured) return true;
  if (!stdin.isTTY || !stdout.isTTY) return false;

  if (options.announce !== false) {
    stdout.write('\nNo model connection is configured yet.\n');
    stdout.write('Oasis can set one up now. OmniRoute is the recommended starting point if you do not already have a provider key; free routes depend on upstream availability and limits.\n');
  }
  let answer;
  try { answer = (await askLine('Start guided setup now? [Y/n] ')).trim().toLowerCase(); }
  catch { return false; }
  if (['n', 'no', 'skip', 'later'].includes(answer)) {
    stdout.write('Setup skipped. Run oasis setup later; install/startup is also available through the interactive terminal prompt.\n');
    return false;
  }
  try {
    await configureProvider(root, { defaultPreset: 'omniroute' });
  } catch (error) {
    stdout.write('Guided setup did not complete: ' + String(error && error.message || error) + '. Retry with oasis setup.\n');
  }
  try { return Boolean((await loadConfig()).configured); } catch { return false; }
}

function isOmniRouteSetupIntent(text) {
  return /\b(?:add|install|setup|set\s*up|configure|connect|use|switch|route)\b[\s\S]{0,120}\bomniroute\b/i.test(String(text || ''));
}

function commandAvailable(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [name], { stdio: 'ignore', timeout: 1500, windowsHide: true }).status === 0;
}

async function doctor(args = [], root = process.cwd()) {
  stdout.write('Oasis environment report\n');
  stdout.write('  OS / architecture: ' + process.platform + ' / ' + process.arch + '\n');
  stdout.write('  Node.js: ' + process.version + (isNodeVersionSupported() ? ' (supported)' : ' (requires Node.js 22+)') + '\n');
  const probes = ['git', 'npm', 'python3', 'python', 'pipx', 'pkg', 'apt-get', 'dnf', 'pacman', 'brew', 'winget', 'ollama'];
  for (const item of probes) stdout.write('  ' + item + ': ' + (commandAvailable(item) ? 'available' : 'not found') + '\n');
  try {
    const config = await loadConfig();
    const summary = getProviderSummary(config);
    stdout.write('  Model provider: ' + summary.provider + ' (' + summary.protocol + ')\n');
    stdout.write('  Model: ' + summary.model + '\n');
    stdout.write('  Authentication: ' + summary.authentication + '\n');
    stdout.write('  Config: ' + summary.configPath + '\n');
    if (args.includes('--test-provider')) {
      stdout.write('  Live model/tool-call verification: testing (the inert probe will not be executed)…\n');
      try {
        const result = await testProviderConnection(config, { timeoutMs: 30000 });
        stdout.write('  Live model/tool-call verification: passed (' + result.provider + ' / ' + result.model + ')\n');
      } catch (error) {
        stdout.write('  Live model/tool-call verification: FAILED — ' + String(error && error.message || error) + '\n');
        process.exitCode = 1;
      }
    } else {
      stdout.write('  Live model/tool-call verification: not run (use oasis doctor --test-provider)\n');
    }
  } catch (error) {
    stdout.write('  Provider config: invalid (' + error.message + ')\n');
    if (args.includes('--test-provider')) process.exitCode = 1;
  }
  await doctorWorkspaceReport(root);
}

// Workspace-level checks: tools Oasis relies on, settings/trust, sandbox, MCP,
// memory and extension files. Problems are listed with a suggested fix.
async function updateOasis(args = []) {
  const { latestMainCommit, installedVersion, updatePlan, describeUpdate } = await import('./update.mjs');
  const checkOnly = args.includes('--check');
  const yes = args.includes('--yes') || args.includes('-y');
  const [installed, latest] = await Promise.all([installedVersion(APP_ROOT), latestMainCommit()]);
  const plan = updatePlan(installed, latest);
  stdout.write(describeUpdate(installed, latest, plan) + '\n');
  if (plan.upToDate || plan.blocked || checkOnly) { if (plan.blocked) process.exitCode = 1; return; }
  if (!yes) {
    const answer = (await askLine('Install the update now? [y/N] ')).trim().toLowerCase();
    if (!['y', 'yes'].includes(answer)) { stdout.write('Update skipped.\n'); return; }
  }
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(plan.command, plan.args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) { stderr.write('The update command failed (exit ' + result.status + ').\n'); process.exitCode = 1; return; }
  stdout.write('Oasis updated to ' + latest.sha.slice(0, 7) + '. Restart any running oasis sessions.\n');
}

async function doctorWorkspaceReport(root) {
  const problems = [];
  stdout.write('\nTools\n');
  const rg = commandAvailable('rg');
  stdout.write('  ripgrep (rg): ' + (rg ? 'available (fast grep)' : 'not found (grep uses a slower built-in search)') + '\n');
  stdout.write('  gh: ' + (commandAvailable('gh') ? 'available (/review can read pull requests)' : 'not found (/review PR-number needs the GitHub CLI)') + '\n');
  const search = process.env.OASIS_WEB_SEARCH === 'off' ? 'off' : searchBackend(process.env);
  stdout.write('  Web search: ' + search + (search === 'duckduckgo' ? ' (no key; set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for more reliable results)' : '') + '\n');
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
  stdout.write('\n' + (problems.length ? 'Problems found:\n' + problems.map((item) => '  - ' + item).join('\n') : 'No problems found.') + '\n');
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
function approve(prompt, forceInteractive = false, autoApprove = false, meta = {}) {
  if (autoApprove && !forceInteractive) return Promise.resolve(true);
  const next = approvalQueue.then(() => askApproval(prompt, forceInteractive, meta));
  approvalQueue = next.catch(() => {});
  return next;
}

async function askApproval(prompt, forceInteractive, meta) {
  try {
    stdout.write('\nPermission request\n' + prompt + '\n');
    const offerAlways = meta && meta.suggestion && !forceInteractive;
    const answer = (await askLine(offerAlways ? 'Proceed? [y]es / [N]o / [a]lways allow ' + meta.suggestion + ' this session: ' : 'Proceed? [y/N] ')).trim().toLowerCase();
    if (offerAlways && ['a', 'always'].includes(answer)) return 'always';
    return ['y', 'yes'].includes(answer);
  } catch {
    stdout.write('No interactive approval was available; action denied.\n');
    return false;
  }
}

// Streaming: print assistant text as it arrives; onText then only ends the line.
let streamedSoFar = '';
let markdownStream = null;
const richOutput = () => colorEnabled(stdout) && process.env.OASIS_PLAIN_OUTPUT !== '1';
function streamDelta(accumulated) {
  const text = String(accumulated || '');
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
  if (!streamedSoFar) return false;
  if (markdownStream) { markdownStream.end(); markdownStream = null; }
  else stdout.write('\n');
  streamedSoFar = '';
  return true;
}

function describeToolStart({ name, args = {}, subagent }) {
  let detail = '';
  if (name === 'run_command') detail = [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ');
  else if (name === 'run_shell') detail = String(args.command || '');
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
  return {
    permissionMode: SESSION_OPTIONS.permissionMode,
    allowedTools: SESSION_OPTIONS.allowedTools,
    disallowedTools: SESSION_OPTIONS.disallowedTools,
    appendSystemPrompt: SESSION_OPTIONS.appendSystemPrompt,
    outputStyle: SESSION_OPTIONS.outputStyle || null,
    addDirs: SESSION_OPTIONS.addDirs,
    bare: Boolean(SESSION_OPTIONS.bare),
    systemPromptOverride: SESSION_OPTIONS.systemPromptOverride || '',
    tools: SESSION_OPTIONS.tools,
    mcpServers: SESSION_OPTIONS.mcpServers,
    strictMcpConfig: Boolean(SESSION_OPTIONS.strictMcpConfig),
    agentsInline: SESSION_OPTIONS.agentsInline || null,
    sessionName: SESSION_OPTIONS.sessionName || '',
    fallbackModel: SESSION_OPTIONS.fallbackModel || '',
    maxBudgetUsd: SESSION_OPTIONS.maxBudgetUsd || 0,
    settingsOverrides: SESSION_OPTIONS.settingsOverrides,
    settingSources: SESSION_OPTIONS.settingSources || null
  };
}

function reportSessionNotices(session) {
  if (!session) return;
  if (!settingsWarningShown) {
    settingsWarningShown = true;
    if (session.settingsError) stdout.write('[settings] ' + session.settingsError + '\n');
    if (session.styleWarning) stdout.write('[settings] ' + session.styleWarning + '\n');
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

async function manageTrust(root, rest) {
  const revoke = rest.includes('--revoke');
  const id = await setWorkspaceTrust(root, !revoke);
  stdout.write((revoke ? 'Revoked trust for ' : 'Trusted ') + id + '. ' + (revoke ? 'Project allow rules and hooks are ignored again.' : 'Project allow rules, hooks, and sandbox/mode settings now apply. Review .oasis/ and .claude/ settings files before trusting a repository you did not write.') + '\n');
}

async function selfUpdate(autoApprove = false) {
  if (!commandAvailable('npm')) throw new Error('npm was not found. Install Node.js with npm, then rerun oasis update.');
  const command = 'npm';
  const args = ['install', '--global', INSTALL_URL];
  stdout.write('Oasis self-update plan\n  ' + command + ' ' + args.join(' ') + '\n');
  stdout.write('This downloads the public Oasis source from GitHub and replaces the installed CLI package.\n');
  if (!(await approve('Install/update Oasis from ' + INSTALL_URL + '?', false, autoApprove))) {
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
    'global-extension': 'global extension',
    'project-extension': 'project extension'
  };
  for (const skill of skills) {
    stdout.write('  ' + skill.name + ' [' + (sourceLabels[skill.source] || skill.source) + '] — ' + skill.description + '\n');
  }
}

const SKILLS_CLI_PACKAGE = 'skills@1.7.4';

function supportsSkillsCliNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 20);
}

function validateSkillsSource(raw) {
  const source = String(raw || '').trim();
  if (!source || source.length > 600 || /[\r\n\0]/.test(source) || source.startsWith('-')) {
    throw new Error('Provide a valid skill source (GitHub owner/repo, HTTPS source URL, or local path).');
  }
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(source)) return source;
  if (/^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/i.test(source)) return source;
  if (/^(?:git@|ssh:\/\/|git:\/\/)/i.test(source)) return source;
  if (/^https:\/\//i.test(source)) {
    let url;
    try { url = new URL(source); } catch { throw new Error('The skill source URL is invalid.'); }
    if (url.username || url.password || url.hash) throw new Error('Skill source URLs must not contain credentials or fragments.');
    if (/[\r\n\0]/.test(url.href)) throw new Error('The skill source URL contains invalid characters.');
    return source;
  }
  throw new Error('Unsupported skill source. Use owner/repo, an HTTPS URL, an SSH/Git URL, or a local path.');
}

function quoteWindowsCommandArgument(raw) {
  const value = String(raw);
  if (/[\r\n%!"&|<>^]/.test(value)) throw new Error('This value contains shell metacharacters that cannot safely be passed through the Windows command launcher.');
  return '"' + value.replace(/"/g, '""') + '"';
}

async function runVercelSkillsCli(root, cliArgs, description, autoApprove) {
  if (!supportsSkillsCliNodeVersion()) {
    throw new Error('The Vercel Skills CLI requires Node.js 22.20 or later. Oasis itself can run on Node 22, but upgrade Node to use the skills ecosystem integration.');
  }
  const approved = await approve(
    'Run the pinned Vercel Skills CLI (' + SKILLS_CLI_PACKAGE + ') to ' + description + '?\n' +
    'The command may download the CLI and skill source. Oasis disables telemetry, uses shell-free argv where supported, copies skills instead of creating symlinks, and does not execute imported skill scripts. Review the skill instructions as untrusted content.',
    false,
    autoApprove
  );
  if (!approved) { stdout.write('Skills operation cancelled; no source was installed.\n'); return; }

  const args = ['--yes', SKILLS_CLI_PACKAGE, ...cliArgs];
  const env = {
    ...scrubChildEnvironment(),
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1'
  };
  const childCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npx';
  const windowsCommandLine = ['npx.cmd', ...args].map(quoteWindowsCommandArgument).join(' ');
  const childArgs = process.platform === 'win32'
    ? ['/d', '/v:off', '/s', '/c', '"' + windowsCommandLine + '"']
    : args;
  const result = await new Promise((resolve) => {
    const child = spawn(childCommand, childArgs, {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      stdio: 'inherit'
    });
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; resolve(value); };
    child.on('error', (error) => finish({ exitCode: null, error: error.message }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
  });
  if (result.error) throw new Error('Could not start the Vercel Skills CLI: ' + result.error);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode || 1;
    stdout.write('The Vercel Skills CLI exited with code ' + result.exitCode + '. No success is assumed; inspect the output above.\n');
    return;
  }
  return { ok: true };
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
    return await runVercelSkillsCli(root, ['find', ...(query ? [query] : [])], 'search the public skills directory' + (query ? ' for "' + query + '"' : ''), autoApprove);
  }
  if (action === 'inspect') {
    if (rest.length !== 1) throw new Error('Usage: oasis skills inspect SOURCE');
    const source = validateSkillsSource(rest[0]);
    return await runVercelSkillsCli(root, ['add', source, '--list'], 'list available skills from ' + source, autoApprove);
  }
  if (action === 'add') {
    if (rest.length < 1) throw new Error('Usage: oasis skills add SOURCE --skill NAME, or oasis skills add SOURCE --all.');
    const source = validateSkillsSource(rest[0]);
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
    const scopeArgs = global ? ['--global'] : [];
    const selectionArgs = allSkills ? ['--skill', '*'] : ['--skill', skillName];
    const cliArgs = ['add', source, ...selectionArgs, '--agent', 'universal', '--copy', ...scopeArgs, '--yes'];
    const result = await runVercelSkillsCli(root, cliArgs, 'install ' + (allSkills ? 'all skills' : 'skill "' + skillName + '"') + ' from ' + source + (global ? ' globally' : ' into this project'), autoApprove);
    if (result && result.ok) stdout.write('Skills installed to the Vercel universal skill path. Oasis now scans .agents/skills and the global universal skill directory on new sessions.\n');
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
  throw new Error('Unknown sessions action. Use oasis sessions list or oasis sessions clear SESSION_ID.');
}

async function manageMcp(rest, root = process.cwd()) {
  const action = rest[0] || 'list';
  const config = await loadMcpServers();
  if (action === 'list') {
    stdout.write('MCP server configuration: ' + config.configPath + '\n');
    if (!config.servers.length) stdout.write('No user-level MCP servers configured. See README.md for setup syntax.\n');
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
      for (const server of project.servers) stdout.write('  ' + server.name + ' — ' + (server.type === 'http' ? 'http ' + server.url : 'stdio ' + server.command) + '\n');
      for (const failure of project.failures) stdout.write('  ' + failure.name + ' — not usable: ' + failure.error + '\n');
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
  if (action === 'add') {
    const name = rest[1];
    const separator = rest.indexOf('--');
    if (!name || separator < 2 || separator === rest.length - 1) {
      throw new Error('Usage: oasis mcp add NAME [--env VAR1,VAR2] -- EXECUTABLE [ARG ...]');
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
    if (!existing) throw new Error('No configured MCP server named "' + name + '".');
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
  throw new Error('Unknown MCP action. Use oasis mcp list, add, remove, enable, or disable.');
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

async function runPrompt(prompt, root, autoApprove, session = null, persistence = {}, modeOptions = {}) {
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
    session = await createSession({ root, config, restore: restored, ...sessionCreateOptions() });
  } else if (path.resolve(session.root) !== path.resolve(root)) {
    closeSession(session);
    session = await createSession({ root, config, ...sessionCreateOptions() });
  }
  session.config = config;
  if (!session.onAgentNotice) session.onAgentNotice = (text) => stdout.write('\n[agents] ' + String(text).split('\n')[0] + ' The report will be shared with Oasis on your next message (/tasks to read it now).\n');
  reportSessionNotices(session);
  if (session.mcpFailures && session.mcpFailures.length) {
    for (const failure of session.mcpFailures) stdout.write('[MCP] ' + failure.name + ' did not start: ' + failure.error + '\n');
    session.mcpFailures = [];
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
  turnKeys = startTurnKeys(onInterrupt);
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
      onThinkingBudget: (budget) => stdout.write('[thinking] Extended thinking on for this task (budget ' + budget + ' tokens).\n'),
      onReasoningEffort: (effort) => stdout.write('[thinking] Reasoning effort ' + effort + ' for this task.\n'),
      onMemoryRecall: (ids) => stdout.write('[memory] Recalled ' + ids.join(', ') + '\n'),
      approval: (message, forceInteractive = false, meta = {}) => approve(message, forceInteractive, autoApprove, meta),
      ...(stdin.isTTY && stdout.isTTY ? { askUser: (question) => { endStream(); return askQuestionInTerminal(question); } } : {}),
      onToolStart: (event) => { endStream(); stdout.write('\n' + (richOutput() ? describeTool(event, { color: true }) : describeToolStart(event)) + '\n'); },
      onAutoMode: (event) => { endStream(); stdout.write('[auto] ' + (event.decision === 'allow' ? 'Allowed' : event.decision === 'block' ? 'Blocked' : 'Asking you about') + ' ' + event.tool + (event.reason ? ': ' + event.reason : '') + '\n'); },
      onUsage: (usage) => recordUsage(USAGE, usage),
      ...(stdout.isTTY && process.env.OASIS_NO_STREAM !== '1' ? { onDelta: streamDelta } : {}),
      onToolResult: ({ name, result, call }) => {
        if (richOutput() && call && ['edit_file', 'multi_edit', 'write_file'].includes(name)) {
          let args = {};
          try { args = JSON.parse(call.function && call.function.arguments || '{}'); } catch {}
          const shown = describeEdit({ name, args, result }, { color: true });
          if (shown) stdout.write(shown + '\n');
        }
        if (result && (result.error || result.exitCode !== undefined && result.exitCode !== 0)) {
          stdout.write('[tool result] ' + name + ': ' + String(result.error || ('exit code ' + result.exitCode)).slice(0, 700) + '\n');
        }
      },
      onText: (text) => {
        if (endStream()) return;
        if (richOutput()) { const md = new MarkdownStream({ write: (chunk) => stdout.write(chunk), color: true, columns: () => stdout.columns || 80, prefix: '\x1b[38;2;251;191;36m●\x1b[39m ' }); md.push(String(text)); md.end(); }
        else stdout.write('\nOasis> ' + text + '\n');
      }
    }).finally(() => { if (granted >= 0) session.permissions.sessionAllow.length = granted; });
    USAGE.turns += 1;
    if (result.verificationIncomplete && Array.isArray(result.verificationIssues) && result.verificationIssues.length) {
      stdout.write('[verification] Incomplete: ' + result.verificationIssues.join('; ') + '. Do not treat the task as fully verified yet.\n');
    } else if (!result.finished) {
      stdout.write('Oasis reached a safety limit before the task was fully completed. Review the summary and continue in a new turn if appropriate.\n');
    }
  } catch (error) {
    endStream();
    if (controller.signal.aborted || error.name === 'AbortError') {
      repairInterruptedHistory(session);
      stdout.write('[interrupted] Task stopped. Changes made before the interruption remain; use /rewind 1 to undo them.\n');
    } else stdout.write('\nOasis error: ' + (error.message || String(error)) + '\n');
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    if (turnKeys) { turnKeys.stop(); turnKeys = null; }
  }
  reportSessionNotices(session);
  if (persistence.enabled) {
    try {
      const saved = await saveSession(session);
      stdout.write('[session] Saved locally as ' + saved.id + '. Use oasis --resume ' + saved.id + ' to resume it later.\n');
    } catch (error) {
      stdout.write('[session] Could not save history: ' + error.message + '\n');
    }
  }
  return session;
}

async function* streamInputLines() {
  const { parseStreamInputLine } = await import('./headless.mjs');
  const lines = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    const prompt = parseStreamInputLine(line);
    if (prompt !== null && prompt.trim()) yield prompt;
  }
}

async function readPipedStdin() {
  // Only read stdin when it is a pipe, socket, or redirected file (not a terminal or
  // /dev/null). Use `< /dev/null` if a job inherits an open stdin it never closes.
  let info;
  try { info = fstatSync(0); } catch { return ''; }
  if (stdin.isTTY || !(info.isFIFO() || info.isFile() || info.isSocket())) return '';
  let data = '';
  for await (const chunk of stdin) {
    data += chunk;
    if (data.length > 1024 * 1024) break;
  }
  return data.slice(0, 1024 * 1024);
}

async function printMode(root, headless, args, autoApprove, persistence) {
  let prompt = [headless.prompt, ...args].filter(Boolean).join(' ').trim();
  const streamInput = headless.inputFormat === 'stream-json';
  const piped = streamInput ? '' : await readPipedStdin();
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
  if (!config.configured) throw new Error('No model provider is configured. Run oasis setup, or set OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL, and the API key variable.');
  const { exitCode } = await runHeadless({
    prompt, root, config, autoApprove,
    outputFormat: headless.outputFormat,
    maxTurns: headless.maxTurns,
    planOnly: headless.planOnly,
    jsonSchema: headless.jsonSchema || null,
    sessionOptions: sessionCreateOptions(),
    persistence: { ...persistence, fork: Boolean(SESSION_OPTIONS.forkSession) },
    env: process.env,
    ...(streamInput ? { inputStream: streamInputLines() } : {}),
    includePartial: Boolean(headless.includePartial),
    replayUser: Boolean(headless.replayUser),
    permissionPromptTool: headless.permissionPromptTool || null
  });
  process.exitCode = exitCode;
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
}

// oasis -w NAME: run the whole session in a fresh git worktree on its own branch.
async function startSessionWorktree(root, name, out) {
  const { createWorktree } = await import('./worktrees.mjs');
  let worktree;
  try { worktree = await createWorktree(root, name); }
  catch (error) { throw new Error('--worktree: ' + error.message.replace(/isolation "worktree"/g, '--worktree').replace(/, or launch the subagent without isolation/, '')); }
  out.write('[worktree] Working in ' + worktree.relative + ' on branch ' + worktree.branch + '. Your main checkout is untouched.\n');
  return worktree;
}

async function endSessionWorktree(root, worktree, out) {
  const { removeWorktree } = await import('./worktrees.mjs');
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
    ...(command.context === 'fork' ? { fork: { agent: command.agent, label: '/' + custom.name } } : {})
  };
}

function reportInlineShell(ran = []) {
  for (const item of ran) stdout.write(item.skipped ? '[command] Skipped !`' + item.command + '`: ' + item.skipped + '\n' : '[command] Ran !`' + item.command + '`' + (item.code ? ' (exit ' + item.code + ')' : '') + '\n');
}

// "/skill-name args" runs a skill directly, like Claude Code.
async function resolveSkillCommand(root, text) {
  const match = String(text).trim().match(/^\/([a-zA-Z][a-zA-Z0-9-]{0,63})(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const { loadSkillText } = await import('./tools.mjs');
  const { parseFrontMatter } = await import('./subagents.mjs');
  const { commandOptions } = await import('./commands.mjs');
  let skill;
  try { skill = await loadSkillText(root, match[1], { env: process.env }); } catch { return null; }
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
      session = await runPrompt(prompt, root, autoApprove, session, persistence, loopOptions);
      persistence.resumeId = null;
      if (stopped || (loop.times && run >= loop.times)) break;
      stdout.write('[loop] Next run in ' + formatInterval(loop.intervalMs) + '. Press Ctrl+C to stop.\n');
      await new Promise((resolve) => { const timer = setTimeout(resolve, loop.intervalMs); wake = () => { clearTimeout(timer); resolve(); }; });
      wake = null;
    }
  } finally { process.removeListener('SIGINT', onStop); }
  stdout.write('[loop] Stopped.\n');
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
    prompt: (editor) => promptFor(editor.text, color),
    footer: (editor) => footerFor({ text: editor.text, mode: currentMode(), color }),
    complete: state.completer,
    onShiftTab: async () => {
      const mode = nextMode(currentMode(), { allowBypass: Boolean(SESSION_OPTIONS.allowBypass) });
      await runBuiltinCommand('mode', mode, { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS });
    },
    onDoubleEscape: () => '/rewind',
    onPasteImage: () => pasteClipboardImage(root),
    onTodos: async () => {
      const handled = await runBuiltinCommand('todos', '', { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS }).catch(() => null);
      return handled ? String(handled.output).split('\n') : [];
    }
  });
  if (result.type === 'eof') throw new Error('eof');
  state.history.push(result.text);
  appendHistory(root, result.text).catch(() => {});
  return result.text;
}

async function interactive(root, autoApprove, persistence = {}) {
  let session = null;
  await ensureModelProviderSetup(root);
  const bannerConfig = await loadConfig().catch(() => ({}));
  if (stdout.isTTY) await showStartupBanner({ root, model: SESSION_OPTIONS.model || bannerConfig.model || '', provider: bannerConfig.protocol || '', mode: SESSION_OPTIONS.permissionMode || 'default' }).catch(() => {});
  else stdout.write('\nOasis OSS — coding agent\nWorkspace: ' + root + '\nType your task in plain English. Use /help or /exit. Commands run locally; review permissions carefully.\n');
  const startupSettings = await loadSettings(root).catch(() => null);
  const inputState = { history: await loadHistory(root).catch(() => []), completer: createCompleter({ root, commands: () => interactiveCommandList(root) }) };
  const pendingShell = [];
  while (true) {
    let input;
    const statusLine = (session && session.settings || startupSettings || {}).statusLine;
    if (statusLine) {
      const line = await renderStatusLine(statusLine, statusLinePayload({ root, session, config: await loadConfig().catch(() => ({})), usage: USAGE, outputStyle: SESSION_OPTIONS.outputStyle }), { root, env: process.env, keepColor: Boolean(stdout.isTTY) }).catch(() => null);
      if (line) stdout.write('\n' + line);
    }
    if (QUEUED_INPUT.length) {
      input = QUEUED_INPUT.shift();
      stdout.write('\n' + (colorEnabled(stdout) ? '\x1b[2m❯ ' + input + '\x1b[22m' : '> ' + input) + '\n');
      inputState.history.push(input);
      appendHistory(root, input).catch(() => {});
    } else {
      try { input = await readMainInput(root, session, inputState); } catch { break; }
    }
    let text = input.trim();
    if (!text) continue;
    if (text.startsWith('!') && text.length > 1) {
      const command = text.slice(1).trim();
      const ran = await runShellPassthrough(command, { root });
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
    if (text === '/plan' || text.startsWith('/plan ')) {
      const planPrompt = text.slice('/plan'.length).trim();
      if (!planPrompt) { stdout.write('Usage: /plan Describe the task to plan.\n'); continue; }
      session = await runPrompt(planPrompt, root, autoApprove, session, persistence, { planOnly: true });
      persistence.resumeId = null;
      continue;
    }
    if (text === '/clear') { closeSession(session); session = null; persistence.resumeId = null; stdout.write('Conversation context cleared. Project instructions will be loaded again on the next task.\n'); continue; }
    if (text === '/status') { try { printConfig(await loadConfig()); } catch (e) { stdout.write(e.message + '\n'); } continue; }
    if (text === '/setup') { try { await configureProvider(root); closeSession(session); session = null; persistence.resumeId = null; } catch (e) { stdout.write(e.message + '\n'); } continue; }
    const slash = text.match(/^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i);
    if (slash && slash[1].toLowerCase() === 'init') { try { await initWorkspace(root); } catch (error) { stdout.write(error.message + '\n'); } continue; }
    if (slash && Object.hasOwn(BUILTIN_COMMANDS, slash[1].toLowerCase())) {
      try {
        const handled = await runBuiltinCommand(slash[1].toLowerCase(), String(slash[2] || '').trim(), { root, session, env: process.env, usage: USAGE, sessionOptions: SESSION_OPTIONS });
        if (handled) {
          stdout.write(handled.output + '\n');
          if (handled.osc52 && stdout.isTTY) stdout.write('\x1b]52;c;' + handled.osc52 + '\x07');
          if (handled.forked) persistence.enabled = true;
          if (handled.mcpLogin) {
            try { stdout.write((await (await import('./mcp-auth-commands.mjs')).mcpLogin(root, handled.mcpLogin, { env: process.env, session, print: (text) => stdout.write(text + '\n') })) + '\n'); }
            catch (error) { stdout.write('[mcp] ' + error.message + '\n'); }
          }
          if (handled.resume) { closeSession(session); session = null; persistence.enabled = true; persistence.resumeId = handled.resume; }
          if (handled.prompt) { session = await runPrompt(handled.prompt, root, autoApprove, session, persistence); persistence.resumeId = null; }
          if (handled.cd) { await fireCwdChanged(session, root, handled.cd); closeSession(session); session = null; persistence.resumeId = null; root = handled.cd; try { process.chdir(root); } catch {} }
          if (handled.loop) session = await runLoop(handled.loop, root, autoApprove, session, persistence);
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
    let providerReadyForThisTurn = false;
    try { providerReadyForThisTurn = Boolean((await loadConfig()).configured); } catch {}
    if (isOmniRouteSetupIntent(text)) {
      if (!providerReadyForThisTurn) {
        try {
          await configureOmniRoute(root);
          closeSession(session);
          session = null;
          persistence.resumeId = null;
        } catch (error) {
          stdout.write('OmniRoute setup failed: ' + String(error && error.message || error) + '\n');
        }
      } else {
        session = await runPrompt(text, root, autoApprove, session, persistence);
        persistence.resumeId = null;
      }
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


async function startWebWorkspace(root, args) {
  await ensureModelProviderSetup(root);
  let host = '127.0.0.1';
  let port = 3917;
  let tlsCertFile = null;
  let tlsKeyFile = null;
  let allowInsecureLan = false;
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
    else throw new Error('Unknown web option: ' + arg + '. Supported options: --host HOST, --port PORT, --tls-cert FILE, --tls-key FILE, --allow-insecure-lan.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535 (0 chooses an available port).');
  const normalizedHost = host.toLowerCase();
  if (normalizedHost !== 'localhost' && isIP(host) === 0) throw new Error('--host must be localhost or a literal IP address. Use --host 0.0.0.0 only when you intentionally want other devices on your private network to connect.');
  const app = await startOasisWebServer({ root, host, port, tlsCertFile, tlsKeyFile, allowInsecureLan });
  const scheme = app.secure ? 'https' : 'http';
  const urlHost = host.includes(':') ? '[' + host + ']' : host;
  const localUrl = scheme + '://' + (host === '0.0.0.0' ? '127.0.0.1' : urlHost) + ':' + app.port + '/';
  stdout.write('\nOasis browser workspace is running.\n');
  stdout.write('Workspace: ' + root + '\n');
  stdout.write('Open on this device: ' + localUrl + '\n');
  stdout.write('Connection token (paste into Agent → Connect; keep private):\n' + app.token + '\n');
  stdout.write('Every agent chat action requires an in-browser approval before running a command, installing a package, deleting a file, or installing a bundle.\n');
  if (host === '0.0.0.0' || (isIP(host) > 0 && !['127.0.0.1', '::1'].includes(host))) {
    if (app.secure) {
      stdout.write('HTTPS is active. The certificate must be trusted by each client device and include the exact LAN IP in its subject alternative names.\n');
      stdout.write('On your phone, open https://<this-computer-LAN-IP>:' + app.port + '/ while connected to the same private Wi-Fi, then paste the token.\n');
    } else {
      stdout.write('UNENCRYPTED LAN WARNING: explicit --allow-insecure-lan is active. The token and workspace traffic can be observed on the network. Never use public Wi-Fi or expose this port to the Internet.\n');
      stdout.write('On your phone, open http://<this-computer-LAN-IP>:' + app.port + '/ while connected to the same private Wi-Fi, then paste the token.\n');
    }
  } else {
    stdout.write('This listener is local-only. Network access requires a trusted TLS certificate, or the explicit and unsafe --allow-insecure-lan flag.\n');
  }
  stdout.write('Press Ctrl+C to stop Oasis web.\n');
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
  const rawArgs = process.argv.slice(2);
  let autoApprove = process.env.OASIS_AUTO_APPROVE === '1';
  let persistSession = process.env.OASIS_PERSIST_SESSIONS === '1';
  let continueSession = false;
  let resumeId = null;
  let workspace = process.cwd();
  let worktreeName = null;
  const args = [];
  const headless = { enabled: false, prompt: '', outputFormat: 'text', maxTurns: null, planOnly: false };
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--yes' || arg === '-y' || arg === '--auto') { autoApprove = true; continue; }
    if (arg === '--permission-mode') {
      const mode = rawArgs[++i];
      if (!PERMISSION_MODES.includes(mode)) throw new Error('--permission-mode must be one of ' + PERMISSION_MODES.join(', ') + '.');
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
    if (arg === '--append-system-prompt') { SESSION_OPTIONS.appendSystemPrompt = [SESSION_OPTIONS.appendSystemPrompt, rawArgs[++i] || ''].filter(Boolean).join('\n\n'); continue; }
    const needValue = (flag) => { const value = rawArgs[i + 1]; if (value === undefined) throw new Error(flag + ' requires a value.'); i += 1; return value; };
    if (arg === '--system-prompt') { SESSION_OPTIONS.systemPromptOverride = needValue(arg); continue; }
    if (arg === '--system-prompt-file') { SESSION_OPTIONS.pendingFiles.push({ kind: 'system', file: needValue(arg) }); continue; }
    if (arg === '--append-system-prompt-file') { SESSION_OPTIONS.pendingFiles.push({ kind: 'append', file: needValue(arg) }); continue; }
    if (arg === '--fallback-model') { SESSION_OPTIONS.fallbackModel = needValue(arg); continue; }
    if (arg === '--max-budget-usd') {
      const value = Number(needValue(arg));
      if (!Number.isFinite(value) || value <= 0) throw new Error('--max-budget-usd must be a positive dollar amount, for example 2.50.');
      SESSION_OPTIONS.maxBudgetUsd = value;
      continue;
    }
    if (arg === '--tools') { SESSION_OPTIONS.tools = needValue(arg).split(/[\s,]+/).filter(Boolean); continue; }
    if (arg === '--mcp-config') { SESSION_OPTIONS.pendingFiles.push({ kind: 'mcp', file: needValue(arg) }); continue; }
    if (arg === '--strict-mcp-config') { SESSION_OPTIONS.strictMcpConfig = true; continue; }
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
    if (arg === '--debug') { SESSION_OPTIONS.debug = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') && !/\s/.test(rawArgs[i + 1]) && /^[a-z,!]+$/i.test(rawArgs[i + 1]) ? rawArgs[++i] : 'all'; process.env.OASIS_DEBUG = SESSION_OPTIONS.debug; continue; }
    if (arg === '--disable-slash-commands') { SESSION_OPTIONS.disableSlashCommands = true; continue; }
    if (arg === '--input-format') {
      headless.inputFormat = needValue(arg);
      if (!['text', 'stream-json'].includes(headless.inputFormat)) throw new Error('--input-format must be text or stream-json.');
      continue;
    }
    if (arg === '--include-partial-messages') { headless.includePartial = true; continue; }
    if (arg === '--replay-user-messages') { headless.replayUser = true; continue; }
    if (arg === '--permission-prompt-tool') { headless.permissionPromptTool = needValue(arg); continue; }
    if (arg === '--init' || arg === '--init-only') { SESSION_OPTIONS.runInit = arg === '--init-only' ? 'only' : 'continue'; continue; }
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
    if (arg === '--json-schema') {
      const value = rawArgs[++i];
      if (!value) throw new Error('--json-schema needs a JSON Schema (inline JSON or @path/to/schema.json).');
      headless.jsonSchemaSource = value;
      continue;
    }
    if (arg === '-w' || arg === '--worktree') {
      worktreeName = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-') ? rawArgs[++i] : 'session';
      continue;
    }
    if (arg === '--plan') { headless.planOnly = true; continue; }
    if (arg === '--add-dir') { const dir = rawArgs[++i]; if (!dir) throw new Error('--add-dir needs a directory.'); SESSION_OPTIONS.addDirs.push(path.resolve(dir)); continue; }
    if (arg === '--dangerously-skip-permissions') { SESSION_OPTIONS.permissionMode = 'bypassPermissions'; autoApprove = true; continue; }
    if (arg === '--continue' || arg === '-c') { persistSession = true; continueSession = true; continue; }
    if (arg === '--resume' || arg === '-r') {
      if (!rawArgs[i + 1]) throw new Error('--resume requires a saved session ID.');
      resumeId = rawArgs[++i]; persistSession = true; continue;
    }
    if (arg === '--workspace' || arg === '-C') {
      if (!rawArgs[i + 1]) throw new Error('--workspace requires a path.');
      workspace = path.resolve(rawArgs[++i]);
      continue;
    }
    if (arg.startsWith('--workspace=')) { workspace = path.resolve(arg.slice('--workspace='.length)); continue; }
    args.push(arg);
  }
  await access(workspace);
  await resolveFlagFiles(workspace);
  if (SESSION_OPTIONS.runInit) {
    await initWorkspace(workspace);
    if (SESSION_OPTIONS.runInit === 'only') return;
  }
  const command = args[0];
  const rest = args.slice(1);
  const persistence = { enabled: persistSession || Boolean(resumeId), resumeId };
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
  if (worktreeName && (headless.enabled || !command || command === '--interactive')) {
    const session = await startSessionWorktree(workspace, worktreeName, headless.enabled ? stderr : stdout);
    try {
      if (headless.enabled) return await printMode(session.path, headless, args, autoApprove, persistence);
      return await interactive(session.path, autoApprove, persistence);
    } finally { await endSessionWorktree(workspace, session, headless.enabled ? stderr : stdout); }
  }
  if (headless.enabled) return await printMode(workspace, headless, args, autoApprove, persistence);
  if (!command || command === '--interactive') return await interactive(workspace, autoApprove, persistence);
  if (command === '--help' || command === '-h' || command === 'help') return printHelp();
  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(await readFile(path.join(APP_ROOT, 'package.json'), 'utf8'));
    stdout.write('Oasis OSS ' + pkg.version + '\n');
    return;
  }
  if (command === 'setup') return await configureProvider(workspace);
  if (command === 'doctor') return await doctor(rest, workspace);
  if (command === 'memory') return await memoryCommand(rest, workspace);
  if (command === 'diagnostics') return await diagnosticsCommand(rest, workspace, autoApprove);
  if (command === 'update') return await updateOasis(rest);
  if (command === 'web') return await startWebWorkspace(workspace, rest);
  if (command === 'plan') {
    const planPrompt = rest.join(' ').trim();
    if (!planPrompt) throw new Error('Usage: oasis plan "Describe the task to plan"');
    await ensureModelProviderSetup(workspace);
    const session = await runPrompt(planPrompt, workspace, autoApprove, null, persistence, { planOnly: true });
    closeSession(session);
    return;
  }
  if (command === 'eval') {
    const result = await runEvalCommand(rest, { autoApprove, env: process.env });
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (command === 'init') return await initWorkspace(workspace);
  if (command === 'update' || command === 'self-update') return await selfUpdate(autoApprove);
  if (command === 'config' || command === 'status') return printConfig(await loadConfig());
  if (command === 'mcp') return await manageMcp(rest, workspace);
  if (command === 'extensions' || command === 'extension') return await manageExternalExtensions(workspace, rest, autoApprove);
  if (command === 'plugins' || command === 'plugin') return await managePlugins(workspace, rest);
  if (command === 'sessions') return await manageSessions(workspace, rest);
  if (command === 'skills') return await manageSkills(workspace, rest, autoApprove);
  if (command === 'permissions') return await managePermissions(workspace, rest);
  if (command === 'trust') return await manageTrust(workspace, rest);
  if (command === 'backups') return await showBackups(workspace);
  if (command === 'restore') return await restoreOne(workspace, rest[0]);
  if (command === 'install') {
    if (!rest.length) { stdout.write('Usage: oasis install PACKAGE_NAME  (or specify an ecosystem such as "npm package prettier")\n'); return; }
    const request = parseInstallIntent(args.join(' '));
    if (!request) throw new Error('Use one package name at a time. For compound setup requests, configure a provider and ask Oasis in plain English.');
    return await installRequest(request, workspace, autoApprove);
  }
  const fullPrompt = args.join(' ');
  const omniIntent = isOmniRouteSetupIntent(fullPrompt);
  let providerReadyForCommand = false;
  try { providerReadyForCommand = Boolean((await loadConfig()).configured); } catch {}
  if (omniIntent && !providerReadyForCommand) return await configureOmniRoute(workspace);
  if (!omniIntent) {
    const direct = parseInstallIntent(fullPrompt);
    if (direct) return await installRequest(direct, workspace, autoApprove);
  }
  if (!providerReadyForCommand) await ensureModelProviderSetup(workspace);
  const session = await runPrompt(fullPrompt, workspace, autoApprove, null, persistence);
  closeSession(session);
}

main().catch((error) => {
  stdout.write('Oasis error: ' + (error.message || String(error)) + '\n');
  process.exitCode = 1;
});
