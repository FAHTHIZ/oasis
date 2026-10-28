// oasis mcp login|logout NAME and /mcp login|logout NAME.
import { loadProjectMcpServers } from './mcp-project.mjs';
import { loginMcpServer, deleteStoredToken } from './mcp-oauth.mjs';
import { reconnectMcpServer } from './mcp.mjs';

export async function findHttpServer(root, name, { env = process.env } = {}) {
  const project = await loadProjectMcpServers(root, { env });
  const server = project.servers.find((item) => item.name === name);
  if (server && server.type === 'http') return server;
  if (server) throw new Error(name + ' is a stdio server; it gets credentials from environment variables, not sign-in.');
  const failure = project.failures.find((item) => item.name === name);
  throw new Error(failure ? name + ' is not usable: ' + failure.error : 'No HTTP MCP server named ' + name + ' in .mcp.json.');
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
