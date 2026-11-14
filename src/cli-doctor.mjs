import { probeLocalContext, isLocalModelEndpoint, localContextAdvice, needsLocalContextAdvice, SMALL_CONTEXT_TOKENS } from './local-context.mjs';
import { stdout as processStdout, stderr } from 'node:process';
import { wrapTerminalText } from './term-wrap.mjs';

// Reports wrap between words on a terminal; piped output is left as is.
const stdout = {
  get isTTY() { return processStdout.isTTY; },
  get columns() { return processStdout.columns; },
  write: (text) => processStdout.write(processStdout.isTTY ? wrapTerminalText(String(text), (processStdout.columns || 80) - 1) : text)
};
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getProviderSummary, isLoopbackUrl, isNodeVersionSupported, MIN_NODE_VERSION } from './config.mjs';
import { testProviderConnection } from './agent.mjs';
import { getMcpConfigPath } from './mcp.mjs';
import { loadProjectMcpServers } from './mcp-project.mjs';
import { resolveUninstallPlan } from './uninstall.mjs';
import { loadSettings } from './settings.mjs';
import { loadCustomCommands } from './commands.mjs';
import { searchBackend } from './web-search.mjs';
import { loadAgentDefinitions } from './subagents.mjs';
import { loadOutputStyles } from './output-styles.mjs';
import { memoryFiles } from './memory.mjs';
import { colorEnabled } from './markdown.mjs';
import { commandAvailable } from './command-lookup.mjs';
import { currentProxy } from './proxy.mjs';
import { describeRipgrep } from './ripgrep.mjs';
import { bannerProviderLabel } from './terminal-ui.mjs';

// `oasis doctor`, `oasis update` and `oasis uninstall`.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** "Ollama (this device) at 127.0.0.1:11434 (openai-compatible)" rather than a bare host:port. */
export function doctorProviderLine(summary = {}, config = {}) {
  const label = bannerProviderLabel(config);
  const named = label && label !== summary.protocol && label !== summary.provider;
  return (named ? label + ' at ' : '') + summary.provider + ' (' + summary.protocol + ')';
}

/**
 * One tool probe line. A missing ollama command used to read "not found" next
 * to "Local model server: Ollama"; OASIS talks to the server over HTTP and
 * only needs the command to pull models.
 */
export function doctorToolLine(name, available, config = {}) {
  if (available) return name + ': available';
  if (name === 'ollama' && /Ollama/.test(bannerProviderLabel(config))) return 'ollama: command not on PATH (fine: OASIS uses the Ollama server over HTTP; the command is only needed to pull models)';
  return name + ': not found';
}

export async function doctor(args = [], root = process.cwd(), { fallbackModel = '' } = {}) {
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
  detail('  Node.js: ' + process.version + (isNodeVersionSupported() ? ' (supported)' : ' (requires Node.js ' + MIN_NODE_VERSION + ' or newer)') + '\n');
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
  let config = {};
  try { config = await loadConfig(); } catch {}
  for (const item of probes) detail('  ' + doctorToolLine(item, commandAvailable(item), config) + '\n');
  try {
    config = await loadConfig();
    modelConfigured = Boolean(config.configured);
    const summary = getProviderSummary(config);
    detail('  Model provider: ' + (modelConfigured ? doctorProviderLine(summary, config) : 'not set yet — run oasis setup') + '\n');
    detail('  Model: ' + (modelConfigured ? summary.model : 'not set yet') + '\n');
    detail('  Authentication: ' + summary.authentication + '\n');
    detail('  Config: ' + summary.configPath + '\n');
    try {
      const { parseFallbackChain, describeFallbackChain } = await import('./fallback-chain.mjs');
      const loaded = await loadSettings(root).catch(() => ({}));
      // Same precedence as createSession: flag, then settings, then the saved
      // connection (where `oasis connect` stores its backup models).
      const chain = parseFallbackChain(fallbackModel || (loaded && loaded.fallbackModel) || (config && typeof config.fallbackModel === 'string' ? config.fallbackModel : '') || '');
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
  const sharpAvailable = await import('sharp').then(() => true).catch(() => false);
  stdout.write('OASIS check\n');
  stdout.write('  Node.js 22+: ' + statusLabel(nodeOK) + '\n');
  stdout.write('  Git: ' + (gitOK ? 'available (optional)' : 'not found (optional)') + '\n');
  stdout.write('  Model connection: ' + (modelConfigured ? statusLabel(true) : statusLabel(false) + ' — run oasis setup') + '\n');
  stdout.write('  Native terminal panel (PTY): ' + (ptyAvailable ? 'available' : 'not available (optional native component)') + '\n');
  stdout.write('  Image downscaling (sharp): ' + (sharpAvailable ? 'available' : 'not available (optional; images over 3.75 MB are refused)') + '\n');
  const nextStep = !nodeOK ? 'install Node.js 22 or newer, then run oasis doctor again.'
    : !modelConfigured ? 'run oasis setup to connect a model.'
    : 'run oasis in a project folder, or oasis web --open for the browser workspace.';
  stdout.write('\nNext step: ' + nextStep + '\n\n');
  stdout.write(details.join(''));
  await doctorWorkspaceReport(root, { modelConfigured, nodeOK });
}

// Workspace-level checks: tools Oasis relies on, settings/trust, sandbox, MCP,
// memory and extension files. Problems are listed with a suggested fix.
export async function updateOasis(args = [], { ask } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write([
      'Usage: oasis update [--check] [--yes]',
      '',
      'Installs the latest stable OASIS release for this CLI install (git checkout or npm).',
      '  --check   Show the installed and latest versions without changing anything.',
      '  --yes     Install without asking first.',
      '',
      'The web workspace shows a notice when a new version is out.',
      'Set OASIS_NO_UPDATE_CHECK=1 to turn off update notices.',
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
    const answer = (await ask('Install the update now? [y/N] ')).trim().toLowerCase();
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


export async function uninstallOasis(args = [], { ask } = {}) {
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
    const answer = (await ask('Remove the OASIS CLI now? [y/N] ')).trim().toLowerCase();
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
      const configured = Number(config && config.contextWindow) || Number(process.env.OASIS_CONTEXT_WINDOW) || 0;
      if (configured > 0) write('  Local model server: no context window reported; using the configured ' + configured.toLocaleString('en-US') + '-token window (contextWindow). Make sure the server really loads that many tokens.\n');
      else write('  Local model server: no context window reported (the server is not running, or it does not publish one; set contextWindow in config if replies get cut off)\n');
      return;
    }
    const window = Number(probe.contextLength);
    const server = names[probe.server] || 'local server';
    write('  Local model server: ' + server + ', ' + window.toLocaleString('en-US') + '-token context window\n');
    write('  Tool profile for this window: ' + (window <= SMALL_CONTEXT_TOKENS
      ? 'small (essential tools up front, the rest behind tool_search) because the window is ' + SMALL_CONTEXT_TOKENS.toLocaleString('en-US') + ' tokens or less'
      : 'full') + '\n');
    if (!isLocalModelEndpoint(config, process.env)) write('  Note: OASIS reads this window during work only on default ports (Ollama 11434, LM Studio 1234, llama-server 8080). Set OASIS_LOCAL_CONTEXT_PROBE=1 for this server; otherwise the first request may overflow once and then resize itself.\n');
    if (needsLocalContextAdvice(config.model, window)) write('  Advice: ' + localContextAdvice(config.model, window, probe.server) + '\n');
  } catch (error) {
    write('  Local model server: not reachable (' + String(error && error.message || error).slice(0, 160) + ')\n');
  }
}

async function doctorWorkspaceReport(root, status = {}) {
  const problems = [];
  stdout.write('\nTools\n');
  const rg = describeRipgrep(process.env);
  stdout.write('  ripgrep (rg): ' + (rg ? rg + ' (fast grep)' : 'not found (grep uses a slower built-in search)') + '\n');
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
  if (settings) {
    const { sandboxDoctor } = await import('./doctor.mjs');
    const report = sandboxDoctor(settings, root);
    for (const line of report.lines) stdout.write(line + '\n');
    problems.push(...report.problems);
  }
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

