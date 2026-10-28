// /doctor inside a session: a compact health report for the current workspace.
import { loadSettings } from './settings.mjs';
import { detectSandbox } from './sandbox.mjs';
import { detectCheckers, findBinary } from './diagnostics.mjs';
import { BUILTIN_SERVERS } from './lsp.mjs';
import { onPathSync } from './clipboard-path.mjs';
import { estimateTokens, contextWindowSize } from './context.mjs';

export async function workspaceDoctor(root, { env = process.env, session = null } = {}) {
  const lines = [];
  const problems = [];
  const major = Number.parseInt(process.versions.node, 10);
  lines.push('Oasis doctor: ' + root);
  lines.push('  Node.js ' + process.version + ' on ' + process.platform + '/' + process.arch + (major >= 22 ? '' : ' (Node 22+ recommended)'));
  const tools = ['git', 'rg', 'gh'].map((name) => name + (onPathSync(name, env) ? ' yes' : ' no'));
  lines.push('  Tools: ' + tools.join(', '));
  if (!onPathSync('git', env)) problems.push('git is missing: git tools, /commit, /pr and /review will not work.');
  if (!onPathSync('rg', env)) problems.push('ripgrep (rg) is missing: search falls back to a slower built-in grep.');
  if (session && session.config) lines.push('  Model: ' + (session.config.model || '(default)') + ' via ' + (session.config.protocol || 'openai-compatible') + (session.config.baseURL ? ' at ' + session.config.baseURL : ''));
  try {
    const settings = await loadSettings(root, { env });
    lines.push('  Trusted: ' + (settings.trusted ? 'yes' : 'no') + '; settings files: ' + (settings.sources.length || 'none'));
    if (settings.ignoredUntrusted.length) problems.push('Ignored until you run oasis trust: ' + settings.ignoredUntrusted.join(', '));
    const sandbox = detectSandbox();
    lines.push('  Sandbox: ' + (settings.sandbox.enabled ? 'enabled' : 'off') + ' (' + (sandbox.available ? sandbox.kind + ' available' : 'unavailable: ' + sandbox.reason) + ')');
    if (settings.sandbox.enabled && !sandbox.available) problems.push('The sandbox is enabled but unavailable: ' + sandbox.reason);
  } catch (error) { problems.push('Settings are invalid: ' + error.message); }
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
    const used = estimateTokens(session.messages);
    const windowSize = contextWindowSize(session.config || {});
    lines.push('  Context: about ' + used.toLocaleString('en-US') + ' of ' + windowSize.toLocaleString('en-US') + ' tokens (' + Math.round(used / windowSize * 100) + '%)');
    if (used / windowSize > 0.8) problems.push('Context is over 80% full; run /compact.');
    const mcp = session.mcpClients ? session.mcpClients.size : 0;
    lines.push('  MCP servers connected: ' + mcp + '; background agents: ' + (session.agentTasks ? [...session.agentTasks.agents.values()].filter((task) => task.status === 'running').length : 0) + ' running');
  }
  lines.push(problems.length ? 'Problems:\n' + problems.map((item) => '  - ' + item).join('\n') : 'No problems found.');
  lines.push('For the full report (provider test, MCP config, memory files) run oasis doctor --test-provider in a terminal.');
  return lines.join('\n');
}
