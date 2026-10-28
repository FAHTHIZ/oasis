#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, getProviderSummary, DEFAULT_BASE_URL, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_MODEL, validateBaseUrl, validateProtocol, isLoopbackUrl, isNodeVersionSupported, resolveSetupProviderPreset } from './config.mjs';
import { createSession, runAgentTurn, runAgentPlan, closeSession, testProviderConnection } from './agent.mjs';
import { loadMcpServers, saveMcpServers, getMcpConfigPath, validateMcpServerConfig } from './mcp.mjs';
import { loadSession, saveSession, listSessions, deleteSession } from './sessions.mjs';
import { executeTool, listAvailableSkills } from './tools.mjs';
import { parseInstallIntent, planPackageInstall } from './installer.mjs';
import { listBackups, restoreBackup } from './backups.mjs';
import { runEvalCommand } from './eval.mjs';
import { managePlugins } from './plugins.mjs';
import { inspectGitHubExtension, inspectGitHubMcpServers, selectReviewedMcpServers, resolveImportedSlashCommand, installGitHubExtension, updateGitHubExtension, rollbackGitHubExtension, listInstalledExtensions, removeGitHubExtension } from './extensions.mjs';
import { startOasisWebServer } from './web.mjs';
import { loadSettings, setWorkspaceTrust, addPermissionRule, PERMISSION_MODES, userSettingsPath } from './settings.mjs';
import { detectSandbox } from './sandbox.mjs';

// Options that shape every agent session created by this process.
const SESSION_OPTIONS = { permissionMode: null, allowedTools: [], disallowedTools: [], appendSystemPrompt: '' };
let settingsWarningShown = false;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_URL = 'git+https://github.com/gtxnrg-ship-it/Oasis.git#main';

function printHelp() {
  stdout.write([
    'Oasis OSS — a plain-English coding agent',
    '',
    'Usage:',
    '  oasis                         Start an interactive agent session',
    '  oasis "fix the failing tests"  Give a task in plain English',
    '  oasis setup                   Configure a model provider',
    '  oasis doctor [--test-provider] Check the environment; optionally verify live tool calling',
    '  oasis web [--host HOST] [--port PORT] [--tls-cert FILE --tls-key FILE]  Start browser workspace',
    '  oasis init                    Create OASIS.md project instructions',
    '  oasis plan "task"             Inspect the workspace and produce a read-only implementation plan',
    '  oasis install pnpm            Install a tool using a detected manager',
    '  oasis sessions list           List locally saved sessions for this workspace',
    '  oasis --continue              Resume the most recent saved session and keep saving it',
    '  oasis --resume SESSION_ID     Resume one saved session',
    '  oasis mcp list                List configured Model Context Protocol servers',
    '  oasis mcp add NAME -- COMMAND Configure a stdio MCP server',
    '  oasis mcp remove NAME         Remove a configured server',
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
    '  --permission-mode MODE        default | acceptEdits | plan | bypassPermissions',
    '  --allowedTools RULES          Extra allow rules, e.g. "run_command(npm test:*),Edit(src/**)"',
    '  --disallowedTools RULES       Extra deny rules for this run',
    '  --append-system-prompt TEXT   Add instructions to the system prompt',
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

async function askLine(question) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('This action needs an interactive terminal. Re-run it from a terminal session.');
  const rl = createInterface({ input: stdin, output: stdout });
  try { return await rl.question(question); } finally { rl.close(); }
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
  stdout.write('A successful model response is required before settings are saved or coding tools are used. Presets include OmniRoute, OpenAI, Anthropic, OpenRouter, Gemini, and local Ollama.\n');
  const rl = createInterface({ input: stdin, output: stdout });
  let protocol, baseURL, model, presetName;
  const presets = {
    openai: { protocol: 'openai-responses', baseURL: DEFAULT_BASE_URL, model: DEFAULT_MODEL },
    anthropic: { protocol: 'anthropic', baseURL: DEFAULT_ANTHROPIC_BASE_URL, model: 'claude-sonnet-5' },
    openrouter: { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: '' },
    gemini: { protocol: 'openai-compatible', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash' },
    ollama: { protocol: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: '' },
    omniroute: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:20128/v1', model: 'auto' }
  };
  try {
    const defaultPreset = resolveSetupProviderPreset(options.defaultPreset);
    presetName = (await rl.question('Provider preset [omniroute / openai / anthropic / openrouter / gemini / ollama / custom] (default ' + defaultPreset + '): ')).trim().toLowerCase() || defaultPreset;
    if (presetName === 'custom') {
      protocol = validateProtocol((await rl.question('Protocol [openai-responses / anthropic / openai-compatible] (default openai-responses): ')).trim().toLowerCase() || 'openai-responses');
      const defaultBase = protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
      baseURL = (await rl.question('Base URL [' + defaultBase + ']: ')).trim() || defaultBase;
      const defaultModel = protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : '');
      const modelPrompt = defaultModel ? 'Model name [' + defaultModel + ']: ' : 'Model name (exact model ID required): ';
      model = (await rl.question(modelPrompt)).trim() || defaultModel;
    } else {
      const selected = presets[presetName];
      if (!selected) throw new Error('Unknown provider preset. Choose omniroute, openai, anthropic, openrouter, gemini, ollama, or custom.');
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
  if (!localEndpoint || presetName === 'custom') {
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

async function doctor(args = []) {
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
  stdout.write('  Workspace: ' + process.cwd() + '\n');
  stdout.write('  MCP config: ' + getMcpConfigPath() + '\n');
  stdout.write('  Note: terminal commands run locally and are not sandboxed by Oasis.\n');
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

async function approve(prompt, forceInteractive = false, autoApprove = false, meta = {}) {
  if (autoApprove && !forceInteractive) return true;
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

function sessionCreateOptions() {
  return {
    permissionMode: SESSION_OPTIONS.permissionMode,
    allowedTools: SESSION_OPTIONS.allowedTools,
    disallowedTools: SESSION_OPTIONS.disallowedTools,
    appendSystemPrompt: SESSION_OPTIONS.appendSystemPrompt
  };
}

function reportSessionNotices(session) {
  if (!session) return;
  if (!settingsWarningShown) {
    settingsWarningShown = true;
    if (session.settingsError) stdout.write('[settings] ' + session.settingsError + '\n');
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

async function manageMcp(rest) {
  const action = rest[0] || 'list';
  const config = await loadMcpServers();
  if (action === 'list') {
    stdout.write('MCP server configuration: ' + config.configPath + '\n');
    if (!config.servers.length) {
      stdout.write('No MCP servers configured. See README.md for setup syntax.\n');
      return;
    }
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
    stdout.write('Configured MCP servers start when a new agent session begins; each tool call asks for approval by default.\n');
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
  if (!config.configured) {
    stdout.write('Oasis needs a model provider for general coding tasks. Run oasis setup first, or configure OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL, and the matching API-key environment variable. Local Ollama-style endpoints can use a loopback URL without an API key.\n');
    return session;
  }
  if (!session) {
    let restored = null;
    if (persistence.resumeId) {
      restored = await loadSession(root, persistence.resumeId);
      stdout.write('[session] Resuming ' + restored.id + ' (' + restored.messages.length + ' saved messages, last updated ' + restored.updatedAt + ').\n');
    }
    session = await createSession({ root, config, restore: restored, ...sessionCreateOptions() });
  } else if (path.resolve(session.root) !== path.resolve(root)) {
    closeSession(session);
    session = await createSession({ root, config, ...sessionCreateOptions() });
  }
  session.config = config;
  reportSessionNotices(session);
  if (session.mcpFailures && session.mcpFailures.length) {
    for (const failure of session.mcpFailures) stdout.write('[MCP] ' + failure.name + ' did not start: ' + failure.error + '\n');
    session.mcpFailures = [];
  }
  try {
    const runner = modeOptions.planOnly ? runAgentPlan : runAgentTurn;
    const result = await runner(session, prompt, {
      autoApprove,
      approval: (message, forceInteractive = false, meta = {}) => approve(message, forceInteractive, autoApprove, meta),
      onToolStart: ({ name }) => stdout.write('\n[tool] ' + name + '\n'),
      onToolResult: ({ name, result }) => {
        if (result && (result.error || result.exitCode !== undefined && result.exitCode !== 0)) {
          stdout.write('[tool result] ' + name + ': ' + String(result.error || ('exit code ' + result.exitCode)).slice(0, 700) + '\n');
        }
      },
      onText: (text) => stdout.write('\nOasis> ' + text + '\n')
    });
    if (result.verificationIncomplete && Array.isArray(result.verificationIssues) && result.verificationIssues.length) {
      stdout.write('[verification] Incomplete: ' + result.verificationIssues.join('; ') + '. Do not treat the task as fully verified yet.\n');
    } else if (!result.finished) {
      stdout.write('Oasis reached a safety limit before the task was fully completed. Review the summary and continue in a new turn if appropriate.\n');
    }
  } catch (error) {
    stdout.write('\nOasis error: ' + (error.message || String(error)) + '\n');
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

async function interactive(root, autoApprove, persistence = {}) {
  stdout.write('\nOasis OSS — coding agent\nWorkspace: ' + root + '\n');
  let session = null;
  await ensureModelProviderSetup(root);
  stdout.write('Type your task in plain English. Use /help or /exit. Commands run locally; review permissions carefully.\n');
  while (true) {
    let input;
    try { input = await askLine('\nYou> '); } catch { break; }
    const text = input.trim();
    if (!text) continue;
    if (['/exit', '/quit', 'exit', 'quit'].includes(text.toLowerCase())) break;
    if (text === '/help') { stdout.write('Commands: /help /status /clear /setup /plan TASK /exit. Use /plan TASK to inspect and plan without writing files or running commands. You can also say “install pnpm” or “install yourself”.\n'); continue; }
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
    if (text.startsWith('/')) {
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
      stdout.write('Unknown command. Type /help or use oasis extensions list to view imported commands.\n');
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
  const args = [];
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
    if (arg === '--append-system-prompt') { SESSION_OPTIONS.appendSystemPrompt = rawArgs[++i] || ''; continue; }
    if (arg === '--continue') { persistSession = true; continueSession = true; continue; }
    if (arg === '--resume') {
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
  const command = args[0];
  const rest = args.slice(1);
  const persistence = { enabled: persistSession || Boolean(resumeId), resumeId };
  if (continueSession && !resumeId) {
    const saved = await listSessions(workspace);
    persistence.resumeId = saved[0] && saved[0].id || null;
    if (!persistence.resumeId) stdout.write('No previous session exists for this workspace; a new session will be saved after your next task.\n');
  }

  if (!command || command === '--interactive') return await interactive(workspace, autoApprove, persistence);
  if (command === '--help' || command === '-h' || command === 'help') return printHelp();
  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(await readFile(path.join(APP_ROOT, 'package.json'), 'utf8'));
    stdout.write('Oasis OSS ' + pkg.version + '\n');
    return;
  }
  if (command === 'setup') return await configureProvider(workspace);
  if (command === 'doctor') return await doctor(rest);
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
  if (command === 'mcp') return await manageMcp(rest);
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
