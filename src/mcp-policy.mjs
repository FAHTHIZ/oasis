// Claude Code's MCP server policy settings.
//
//   allowedMcpServers / deniedMcpServers   [{ serverName } | { serverCommand: [cmd, ...args] } | { serverUrl: "https://*.corp/*" }]
//     The denylist merges from every scope and always wins. The allowlist merges
//     too (managed only with allowManagedMcpServersOnly); once it has a
//     serverCommand entry, stdio servers must match one, and once it has a
//     serverUrl entry, remote servers must match one. An empty allowlist blocks all.
//   enableAllProjectMcpServers / enabledMcpjsonServers / disabledMcpjsonServers
//     Approvals for servers in the project's .mcp.json. OASIS loads .mcp.json for
//     trusted workspaces; in an untrusted one, these approvals count only from
//     your user settings, --settings or managed settings. A rejection counts from
//     any file, the shared project settings included.

function entryList(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value.slice(0, 500)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.serverName === 'string' && item.serverName.trim()) out.push({ serverName: item.serverName.trim().slice(0, 200) });
    else if (Array.isArray(item.serverCommand) && item.serverCommand.length && item.serverCommand.every((part) => typeof part === 'string')) out.push({ serverCommand: item.serverCommand.map((part) => part.slice(0, 2000)) });
    else if (typeof item.serverUrl === 'string' && item.serverUrl.trim()) out.push({ serverUrl: item.serverUrl.trim().slice(0, 2000) });
  }
  return out;
}

const names = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 200)).slice(0, 500) : null;

// Called by loadSettings for every settings file. `trusted` is false for project
// files in an untrusted workspace; those may only add denials and rejections.
export function collectMcpPolicy(result, settings, scope, trusted) {
  const policy = (result.mcpPolicy ||= { denied: [], allowed: null, allowedManaged: null, managedOnly: false, rejected: [], approvedAll: undefined, approved: [] });
  const denied = entryList(settings.deniedMcpServers);
  if (denied) policy.denied.push(...denied);
  const rejected = names(settings.disabledMcpjsonServers);
  if (rejected) policy.rejected.push(...rejected);
  if (!trusted) return;
  const allowed = entryList(settings.allowedMcpServers);
  if (allowed) {
    policy.allowed = [...(policy.allowed || []), ...allowed];
    if (scope === 'managed') policy.allowedManaged = [...(policy.allowedManaged || []), ...allowed];
  }
  if (scope === 'managed' && settings.allowManagedMcpServersOnly === true) policy.managedOnly = true;
  const personal = scope === 'user' || scope === 'flag' || scope === 'managed';
  if (personal && typeof settings.enableAllProjectMcpServers === 'boolean') policy.approvedAll = settings.enableAllProjectMcpServers;
  const approved = names(settings.enabledMcpjsonServers);
  if (personal && approved) policy.approved.push(...approved);
}

function urlPatternMatches(pattern, url) {
  const source = String(pattern).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp('^' + source + '$', 'i').test(String(url)); } catch { return false; }
}

const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function entryMatches(entry, server) {
  if (entry.serverName) return sameName(entry.serverName, server.name) || sameName(entry.serverName, server.originalName);
  const remote = Boolean(server.url);
  if (entry.serverCommand) return !remote && [server.command, ...(server.args || [])].length === entry.serverCommand.length && entry.serverCommand.every((part, index) => part === [server.command, ...(server.args || [])][index]);
  if (entry.serverUrl) return remote && urlPatternMatches(entry.serverUrl, server.url);
  return false;
}

// Returns '' when the server may load, otherwise the reason it is blocked.
export function mcpServerBlocked(server, policy) {
  if (!policy || !server) return '';
  if (policy.denied.some((entry) => entryMatches(entry, server))) return 'blocked by deniedMcpServers in settings';
  const allowed = policy.managedOnly ? policy.allowedManaged : policy.allowed;
  if (!allowed) return '';
  const remote = Boolean(server.url);
  const kind = remote ? 'serverUrl' : 'serverCommand';
  const candidates = allowed.some((entry) => entry[kind]) ? allowed.filter((entry) => entry[kind]) : allowed.filter((entry) => entry.serverName);
  if (candidates.some((entry) => entryMatches(entry, server))) return '';
  return 'not in allowedMcpServers' + (policy.managedOnly ? ' (managed settings)' : '') + ' in settings';
}

// Project .mcp.json servers after approvals: { servers, rejected, approvedNames }.
export function approvedProjectServers(servers, policy, { trusted }) {
  const rejected = new Set((policy && policy.rejected || []).map((name) => name.toLowerCase()));
  const kept = [];
  const dropped = [];
  for (const server of servers) {
    if (rejected.has(String(server.name).toLowerCase()) || rejected.has(String(server.originalName || '').toLowerCase())) { dropped.push(server.name); continue; }
    if (trusted || (policy && policy.approvedAll === true)) { kept.push(server); continue; }
    const approved = policy && policy.approved.some((name) => sameName(name, server.name) || sameName(name, server.originalName));
    if (approved) kept.push(server);
  }
  return { servers: kept, rejected: dropped };
}
