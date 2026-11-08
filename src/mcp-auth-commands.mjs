// oasis mcp login|logout NAME and /mcp login|logout NAME.
import { loadProjectMcpServers, loadUserMcpJson, loadClaudeCodeMcpServers } from './mcp-project.mjs';
import { loginMcpServer, deleteStoredToken } from './mcp-oauth.mjs';
import { reconnectMcpServer } from './mcp.mjs';

// MCP servers from enabled Claude Code (and converted Codex) plugins, such as context7.
async function pluginHttpServers(root, env) {
  try {
    const { loadEnabledPlugins, pluginMcpServers } = await import('./claude-plugins.mjs');
    const { parseMcpServerEntries } = await import('./mcp-project.mjs');
    const out = [];
    for (const item of await pluginMcpServers(await loadEnabledPlugins(root, { env }), { env, root })) {
      out.push(...parseMcpServerEntries({ mcpServers: item.mcpServers }, { ...env, ...item.env }, 'plugin').servers);
    }
    return out;
  } catch { return []; }
}

// Looks in the project .mcp.json first, then the user mcp.json, then Claude Code's ~/.claude.json, then plugins.
export async function findHttpServer(root, name, { env = process.env } = {}) {
  const project = await loadProjectMcpServers(root, { env });
  const user = await loadUserMcpJson({ env }).catch(() => ({ servers: [], failures: [] }));
  const claude = await loadClaudeCodeMcpServers(root, { env }).catch(() => ({ local: [], user: [], failures: [] }));
  const plugins = await pluginHttpServers(root, env);
  const all = [...project.servers, ...user.servers, ...(claude.local || []), ...(claude.user || []), ...plugins];
  const server = all.find((item) => item.name === name);
  if (server && (server.type === 'http' || server.type === 'sse')) return server;
  if (server) throw new Error(name + ' is a stdio server; it gets credentials from environment variables, not sign-in.');
  const failure = [...project.failures, ...(user.failures || [])].find((item) => item.name === name);
  throw new Error(failure ? name + ' is not usable: ' + failure.error : 'No HTTP or SSE MCP server named ' + name + ' in .mcp.json, ' + (user.file || 'mcp.json') + ' or ~/.claude.json, or in an enabled plugin.');
}

export async function mcpLogin(root, name, { env = process.env, print = () => {}, session = null, fetch: fetchImpl, open } = {}) {
  const server = await findHttpServer(root, name, { env });
  const result = await loginMcpServer(server, { env, print, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(open ? { open } : {}) });
  let message = 'Signed in to ' + name + (result.scope ? ' (scope: ' + result.scope + ')' : '') + '. The token is stored in your Oasis config folder, not in the project.';
  if (session && session.mcpClients) {
    try {
      const client = await reconnectMcpServer(session, server, { env, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
      message += ' Connected: ' + client.tools.length + ' tool(s) are available now.';
    } catch (error) { message += ' Reconnecting failed: ' + error.message; }
  }
  return message;
}

export async function mcpLogout(root, name, { env = process.env } = {}) {
  const server = await findHttpServer(root, name, { env });
  return (await deleteStoredToken(server.url, env)) ? 'Signed out of ' + name + '; its stored token was deleted.' : 'There was no stored sign-in for ' + name + '.';
}
