// /doctor inside a session: a compact health report for the current workspace.
import { loadSettings } from './settings.mjs';
import { isNodeVersionSupported, MIN_NODE_VERSION } from './config.mjs';
import { detectSandbox, detectContainerRuntime, detectSandboxRuntime, domainList } from './sandbox.mjs';
import { detectCheckers, findBinary } from './diagnostics.mjs';
import { BUILTIN_SERVERS } from './lsp.mjs';
import { onPathSync } from './clipboard-path.mjs';
import { contextWindowSize, contextTokens } from './context.mjs';
import { workflowRuntimeStatus } from './workflow-sandbox.mjs';
import { describeRipgrep } from './ripgrep.mjs';
import { buildSecurityReport, formatSecurityReport } from './security-report.mjs';

export async function workspaceDoctor(root, { env = process.env, session = null } = {}) {
  const lines = [];
  const problems = [];
  lines.push('Oasis doctor: ' + root);
  lines.push('  Node.js ' + process.version + ' on ' + process.platform + '/' + process.arch + (isNodeVersionSupported() ? '' : ' (Node.js ' + MIN_NODE_VERSION + ' or newer required)'));
  const ripgrep = describeRipgrep(env);
  const tools = ['git', 'rg', 'gh'].map((name) => name + (name === 'rg' ? (ripgrep ? ' ' + ripgrep : ' no') : onPathSync(name, env) ? ' yes' : ' no'));
  lines.push('  Tools: ' + tools.join(', '));
  if (!onPathSync('git', env)) problems.push('git is missing: git tools, /commit, /pr and /review will not work.');
  if (!ripgrep) problems.push('ripgrep is missing (the bundled @vscode/ripgrep binary was not installed for ' + process.platform + '-' + process.arch + ' and rg is not on PATH): grep falls back to a slower built-in search that ignores .gitignore.');
  if (session && session.config) lines.push('  Model: ' + (session.config.model || '(default)') + ' via ' + (session.config.protocol || 'openai-compatible') + (session.config.baseURL ? ' at ' + session.config.baseURL : ''));
  try {
    const settings = await loadSettings(root, { env });
    lines.push('  Trusted: ' + (settings.trusted ? 'yes' : 'no') + '; settings files: ' + (settings.sources.length || 'none'));
    if (settings.ignoredUntrusted.length) problems.push('Ignored until you run oasis trust: ' + settings.ignoredUntrusted.join(', '));
    const backend = settings.sandbox.backend || 'os';
    let sandbox;
    if (backend === 'ssh') {
      const { normalizeSshSettings, detectSshRuntime } = await import('./ssh-backend.mjs');
      sandbox = detectSshRuntime(normalizeSshSettings(settings.sandbox.ssh || {}, env, root));
    } else if (backend === 'os' && domainList(settings.sandbox.allowedDomains).length) {
      sandbox = detectSandboxRuntime();
      lines.push('  Network: only ' + domainList(settings.sandbox.allowedDomains).join(', ') + ' (sandbox-runtime proxy)');
    } else sandbox = backend === 'os' ? detectSandbox() : detectContainerRuntime(backend);
    lines.push('  Sandbox: ' + (settings.sandbox.enabled ? 'enabled' : 'off') + ' (' + (sandbox.available ? sandbox.kind + ' available' : 'unavailable: ' + sandbox.reason) + ')');
    lines.push('  Command isolation: ' + (settings.sandbox.enabled && sandbox.available
      ? (backend === 'os' ? 'OS sandbox active' : backend === 'ssh' ? 'remote execution over SSH (' + String(settings.sandbox.ssh && settings.sandbox.ssh.host || env.OASIS_SSH_HOST || '') + ')' : 'container sandbox active (' + backend + ', image ' + (settings.sandbox.image || 'node:22-bookworm') + ')')
      : 'not active; approval controls are not OS isolation'));
    if (settings.sandbox.enabled && !sandbox.available) problems.push('The sandbox is enabled but unavailable: ' + sandbox.reason);
    else if (!settings.sandbox.enabled && sandbox.available) lines.push('  Tip: commands can run inside the ' + sandbox.kind + ' sandbox (workspace writable, rest of the system read-only, credentials hidden, package caches writable). Try /sandbox on, or add "sandbox": {"enabled": true} to settings.');
    // Unified security posture (secret scan, permissions, sandbox, sensitive paths).
    const securityReport = buildSecurityReport({ env, sandboxSettings: settings.sandbox, permissionMode: 'default', scanFindings: [] });
    lines.push('  Security posture: ' + securityReport.summary + ' (' + securityReport.checks.length + ' checks)');
  } catch (error) { problems.push('Settings are invalid: ' + error.message); }
  const workflow = await workflowRuntimeStatus();
  lines.push('  Workflow runtime: ' + (workflow.available ? 'available (QuickJS)' : 'unavailable' + (workflow.reason ? ': ' + workflow.reason : '')));
  if (!workflow.available) problems.push('The workflow runtime could not initialize. Reinstall OASIS dependencies before using saved JavaScript workflows.');
  const checkers = await detectCheckers(root, { env }).catch(() => []);
  const external = checkers.filter((item) => !item.builtin);
  lines.push('  Checkers: ' + (external.length ? external.map((item) => item.name + (item.missing ? ' (missing)' : '')).join(', ') : 'built-in JS/JSON only'));
  for (const item of external.filter((checker) => checker.missing)) problems.push(item.name + ': ' + item.missing);
  const servers = [];
  for (const server of BUILTIN_SERVERS) {
    let found = false;
    for (const candidate of server.candidates) if (await findBinary(root, candidate.command, env, candidate)) { found = true; break; }
    if (!found && server.name === 'typescript') found = Boolean(await findBinary(root, 'tsc', env, { node: true }));
    if (found) servers.push(server.name);
  }
  lines.push('  Language servers: ' + (servers.length ? servers.join(', ') : 'none found (the lsp tool needs one; e.g. npm install -g typescript-language-server typescript)'));
  if (session) {
    const context = contextTokens(session);
    const used = context.tokens;
    const windowSize = contextWindowSize(session.config || {});
    lines.push('  Context: ' + (context.reported ? '' : 'about ') + used.toLocaleString('en-US') + ' of ' + windowSize.toLocaleString('en-US') + ' tokens (' + Math.round(used / windowSize * 100) + '%)');
    if (used / windowSize > 0.8) problems.push('Context is over 80% full; run /compact.');
    if (session.localContext && session.localContext.contextLength) lines.push('  Local model window: ' + session.localContext.contextLength.toLocaleString('en-US') + ' tokens (' + session.localContext.source + ' in ' + (session.localContext.server || 'ollama') + ')');
    for (const note of session.localContextNotices || []) problems.push(note);
    const mcp = session.mcpClients ? session.mcpClients.size : 0;
    lines.push('  MCP servers connected: ' + mcp + '; background agents: ' + (session.agentTasks ? [...session.agentTasks.agents.values()].filter((task) => task.status === 'running').length : 0) + ' running');
  }
  try {
    const sounds = await import('./sounds.mjs');
    const off = sounds.soundsOffReason({ env });
    lines.push('  Sound effects: ' + (off ? 'off (' + off + ')' : 'on, volume ' + sounds.soundVolume(env)));
  } catch {}
  lines.push(problems.length ? 'Problems:\n' + problems.map((item) => '  - ' + item).join('\n') : 'No problems found.');
  lines.push('For the full report (provider test, MCP config, memory files) run oasis doctor --test-provider in a terminal.');
  return lines.join('\n');
}
