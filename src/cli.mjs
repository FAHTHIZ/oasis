#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, getProviderSummary, DEFAULT_BASE_URL, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_MODEL, validateBaseUrl, validateProtocol, isLoopbackUrl } from './config.mjs';
import { createSession, runAgentTurn, closeSession } from './agent.mjs';
import { loadMcpServers, saveMcpServers, getMcpConfigPath, validateMcpServerConfig } from './mcp.mjs';
import { loadSession, saveSession, listSessions, deleteSession } from './sessions.mjs';
import { executeTool } from './tools.mjs';
import { parseInstallIntent, planPackageInstall } from './installer.mjs';
import { listBackups, restoreBackup } from './backups.mjs';
import { runEvalCommand } from './eval.mjs';

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
    '  oasis doctor                  Check the local environment',
    '  oasis init                    Create OASIS.md project instructions',
    '  oasis install pnpm            Install a tool using a detected manager',
    '  oasis sessions list           List locally saved sessions for this workspace',
    '  oasis --continue              Resume the most recent saved session and keep saving it',
    '  oasis --resume SESSION_ID     Resume one saved session',
    '  oasis mcp list                List configured Model Context Protocol servers',
    '  oasis mcp add NAME -- COMMAND Configure a stdio MCP server',
    '  oasis mcp remove NAME         Remove a configured server',
    '  oasis skills list             List available agent skills',
    '  oasis skills install debugging Install a bundled skill in this workspace',
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
    '  --help, -h                    Show this help',
    '  --version                     Show the installed version',
    '',
    'Setup: npm install -g ' + INSTALL_URL,
    'Then:  oasis setup',
    'MCP:   oasis mcp add docs -- npx -y @modelcontextprotocol/server-filesystem /path/to/share',
    'Safety: command execution is not a sandbox. Review approvals; --yes increases risk.',
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

async function configureProvider() {
  stdout.write('\nOasis setup — model provider\n');
  stdout.write('Choose the native OpenAI Responses API (recommended for current OpenAI reasoning models), the native Anthropic Messages API, or an OpenAI-compatible endpoint. Local Ollama-style endpoints use OpenAI-compatible mode.\n');
  const rl = createInterface({ input: stdin, output: stdout });
  let protocol, baseURL, model;
  try {
    const selected = (await rl.question('Protocol [openai-responses / anthropic / openai-compatible] (default openai-responses): ')).trim().toLowerCase();
    protocol = validateProtocol(selected || 'openai-responses');
    const defaultBase = protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
    baseURL = (await rl.question('Base URL [' + defaultBase + ']: ')).trim() || defaultBase;
    const defaultModel = protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : '');
    const modelPrompt = defaultModel ? 'Model name [' + defaultModel + ']: ' : 'Model name (required for a compatible endpoint): ';
    model = (await rl.question(modelPrompt)).trim() || defaultModel;
    if (!model) throw new Error('Enter the exact model name supported by this compatible endpoint.');
  } finally { rl.close(); }
  protocol = validateProtocol(protocol);
  baseURL = validateBaseUrl(baseURL);
  const existing = await loadConfig().catch(() => ({ apiKey: '', baseURL: '', protocol: '' }));
  let apiKey = '';
  if (!isLoopbackUrl(baseURL)) {
    const label = protocol === 'anthropic' ? 'ANTHROPIC API key' : 'API key';
    apiKey = await askSecret(label + ' (input hidden; Enter keeps the key only if the endpoint is unchanged, otherwise use the matching environment variable): ');
    if (!apiKey && existing.baseURL === baseURL && existing.protocol === protocol) apiKey = existing.apiKey || '';
    if (!apiKey) apiKey = process.env.OASIS_API_KEY || (protocol === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || '';
  }
  const configPath = await saveConfig({ protocol, baseURL, model, apiKey });
  stdout.write('Saved provider settings to ' + configPath + '\n');
  stdout.write('Protocol: ' + protocol + '\n');
  stdout.write('Authentication: ' + (apiKey ? 'configured' : (isLoopbackUrl(baseURL) ? 'local endpoint; no API key required' : 'not configured')) + '\n');
  stdout.write('Run oasis doctor to inspect the environment, then oasis to start chatting.\n');
}
function commandAvailable(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [name], { stdio: 'ignore', timeout: 1500, windowsHide: true }).status === 0;
}

async function doctor() {
  stdout.write('Oasis environment report\n');
  stdout.write('  OS / architecture: ' + process.platform + ' / ' + process.arch + '\n');
  stdout.write('  Node.js: ' + process.version + (Number(process.versions.node.split('.')[0]) >= 20 ? ' (supported)' : ' (requires Node 20+)') + '\n');
  const probes = ['git', 'npm', 'python3', 'python', 'pipx', 'pkg', 'apt-get', 'dnf', 'pacman', 'brew', 'winget', 'ollama'];
  for (const item of probes) stdout.write('  ' + item + ': ' + (commandAvailable(item) ? 'available' : 'not found') + '\n');
  try {
    const config = await loadConfig();
    const summary = getProviderSummary(config);
    stdout.write('  Model provider: ' + summary.provider + ' (' + summary.protocol + ')\n');
    stdout.write('  Model: ' + summary.model + '\n');
    stdout.write('  Authentication: ' + summary.authentication + '\n');
    stdout.write('  Config: ' + summary.configPath + '\n');
  } catch (error) { stdout.write('  Provider config: invalid (' + error.message + ')\n'); }
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

async function approve(prompt, forceInteractive = false, autoApprove = false) {
  if (autoApprove && !forceInteractive) return true;
  try {
    stdout.write('\nPermission request\n' + prompt + '\n');
    const answer = (await askLine('Proceed? [y/N] ')).trim().toLowerCase();
    return ['y', 'yes'].includes(answer);
  } catch {
    stdout.write('No interactive approval was available; action denied.\n');
    return false;
  }
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
  const installedRoot = path.join(root, '.oasis', 'skills');
  const installed = new Set();
  try { for (const item of await readdir(installedRoot, { withFileTypes: true })) if (item.isDirectory()) installed.add(item.name); } catch {}
  const bundledRoot = path.join(APP_ROOT, 'skills');
  let bundled = [];
  try { bundled = (await readdir(bundledRoot, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name); } catch {}
  stdout.write('Built-in skill templates:\n');
  for (const name of bundled) stdout.write('  ' + name + (installed.has(name) ? ' (installed in this workspace)' : '') + '\n');
  if (!bundled.length) stdout.write('  No bundled skills were found in this installation.\n');
  if (installed.size) stdout.write('\nAdditional workspace skills:\n  ' + [...installed].filter((name) => !bundled.includes(name)).join('\n  ') + '\n');
}

async function installSkill(root, name) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name || '')) throw new Error('Skill name must use lowercase letters, numbers, and hyphens.');
  const source = path.join(APP_ROOT, 'skills', name, 'SKILL.md');
  const destination = path.join(root, '.oasis', 'skills', name, 'SKILL.md');
  try { await access(source); } catch { throw new Error('No bundled skill named "' + name + '". Use oasis skills list.'); }
  try { await access(destination); stdout.write('Skill already exists at ' + destination + '; leaving it unchanged.\n'); return; } catch {}
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, 0);
  stdout.write('Installed skill "' + name + '" into ' + destination + '. It will be loaded as project context in the next agent session.\n');
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

async function runPrompt(prompt, root, autoApprove, session = null, persistence = {}) {
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
    session = await createSession({ root, config, restore: restored });
  } else if (path.resolve(session.root) !== path.resolve(root)) {
    closeSession(session);
    session = await createSession({ root, config });
  }
  session.config = config;
  if (session.mcpFailures && session.mcpFailures.length) {
    for (const failure of session.mcpFailures) stdout.write('[MCP] ' + failure.name + ' did not start: ' + failure.error + '\n');
    session.mcpFailures = [];
  }
  try {
    const result = await runAgentTurn(session, prompt, {
      autoApprove,
      approval: (message) => approve(message, false, autoApprove),
      onToolStart: ({ name }) => stdout.write('\n[tool] ' + name + '\n'),
      onToolResult: ({ name, result }) => {
        if (result && (result.error || result.exitCode !== undefined && result.exitCode !== 0)) {
          stdout.write('[tool result] ' + name + ': ' + String(result.error || ('exit code ' + result.exitCode)).slice(0, 700) + '\n');
        }
      },
      onText: (text) => stdout.write('\nOasis> ' + text + '\n')
    });
    if (!result.finished) stdout.write('Oasis reached a safety limit before the task was fully completed. Review the summary and continue in a new turn if appropriate.\n');
  } catch (error) {
    stdout.write('\nOasis error: ' + (error.message || String(error)) + '\n');
  }
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
  stdout.write('Type your task in plain English. Use /help or /exit. Commands run locally; review permissions carefully.\n');
  let session = null;
  while (true) {
    let input;
    try { input = await askLine('\nYou> '); } catch { break; }
    const text = input.trim();
    if (!text) continue;
    if (['/exit', '/quit', 'exit', 'quit'].includes(text.toLowerCase())) break;
    if (text === '/help') { stdout.write('Commands: /help /status /clear /setup /exit. You can also say “install pnpm” or “install yourself”.\n'); continue; }
    if (text === '/clear') { closeSession(session); session = null; persistence.resumeId = null; stdout.write('Conversation context cleared. Project instructions will be loaded again on the next task.\n'); continue; }
    if (text === '/status') { try { printConfig(await loadConfig()); } catch (e) { stdout.write(e.message + '\n'); } continue; }
    if (text === '/setup') { try { await configureProvider(); closeSession(session); session = null; persistence.resumeId = null; } catch (e) { stdout.write(e.message + '\n'); } continue; }
    if (text.startsWith('/')) { stdout.write('Unknown command. Type /help.\n'); continue; }
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
  if (command === 'setup') return await configureProvider();
  if (command === 'doctor') return await doctor();
  if (command === 'eval') {
    const result = await runEvalCommand(rest, { autoApprove, env: process.env });
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (command === 'init') return await initWorkspace(workspace);
  if (command === 'update' || command === 'self-update') return await selfUpdate(autoApprove);
  if (command === 'config' || command === 'status') return printConfig(await loadConfig());
  if (command === 'mcp') return await manageMcp(rest);
  if (command === 'sessions') return await manageSessions(workspace, rest);
  if (command === 'skills') {
    if (rest[0] === 'install') return await installSkill(workspace, rest[1]);
    return await listSkills(workspace);
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
  const direct = parseInstallIntent(fullPrompt);
  if (direct) return await installRequest(direct, workspace, autoApprove);
  const session = await runPrompt(fullPrompt, workspace, autoApprove, null, persistence);
  closeSession(session);
}

main().catch((error) => {
  stdout.write('Oasis error: ' + (error.message || String(error)) + '\n');
  process.exitCode = 1;
});
