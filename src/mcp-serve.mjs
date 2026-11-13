// oasis mcp serve: expose Oasis's own tools to other MCP clients over stdio
// (Claude Desktop, Cursor, VS Code, another Oasis...). The client is in charge
// of approvals, as with any MCP server, so only a curated set is exposed:
// read-only tools by default, edits with --allow-edits, commands with
// --allow-commands. Secret files and paths outside the workspace stay blocked.
// The protocol (version negotiation, framing, ping, errors) is the official
// MCP TypeScript SDK server; OASIS only supplies tools/list and tools/call.
import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { oasisVersion } from './version.mjs';
import path from 'node:path';
import { TOOL_DEFINITIONS, executeTool } from './tools.mjs';
import { stopLspClients } from './lsp.mjs';
import { webSearchEnabled } from './web-search.mjs';
import { protectedConfigTarget, protectedEditsAllowed } from './protected-paths.mjs';

const SERVE_READ_ONLY = ['read_file', 'list_files', 'glob_files', 'repo_map', 'grep', 'ast_grep', 'search_files', 'git_status', 'git_diff', 'git_log', 'lsp', 'diagnostics', 'fetch_url', 'web_search'];
const SERVE_EDITS = ['edit_file', 'multi_edit', 'write_file', 'notebook_edit'];
const SERVE_COMMANDS = ['run_command', 'command_output', 'kill_command', 'list_background'];

export function servedTools({ allowEdits = false, allowCommands = false, env = process.env } = {}) {
  const names = new Set([...SERVE_READ_ONLY, ...(allowEdits ? SERVE_EDITS : []), ...(allowCommands ? SERVE_COMMANDS : [])]);
  if (!webSearchEnabled(env)) names.delete('web_search');
  return TOOL_DEFINITIONS.filter((tool) => names.has(tool.function.name)).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters || { type: 'object', properties: {} },
    annotations: { readOnlyHint: SERVE_READ_ONLY.includes(tool.function.name), destructiveHint: tool.function.name === 'write_file' || SERVE_COMMANDS.includes(tool.function.name) }
  }));
}

function createMcpServer({ root, allowEdits = false, allowCommands = false, env = process.env, version = oasisVersion() } = {}) {
  const tools = servedTools({ allowEdits, allowCommands, env });
  const allowed = new Set(tools.map((tool) => tool.name));
  const session = { root, background: new Map(), settings: {} };
  const server = new Server({ name: 'oasis', version }, { capabilities: { tools: { listChanged: false } }, instructions: 'Oasis workspace tools for ' + root + '. Paths are relative to that folder.' });
  const text = (value, isError) => ({ content: [{ type: 'text', text: value }], isError });
  server.setRequestHandler('tools/list', async () => ({ tools }));
  server.setRequestHandler('tools/call', async (request) => {
    const name = request.params && request.params.name;
    const args = request.params && request.params.arguments || {};
    if (!allowed.has(name)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown or disabled tool: ' + name);
    // Oasis's own agent always asks before these edits; there is no one to ask
    // here, and MCP clients often auto-approve edits, so refuse them.
    if (SERVE_EDITS.includes(name) && !protectedEditsAllowed(env)) {
      const hit = await protectedConfigTarget(root, args.path || args.notebook_path || args.file_path).catch(() => null);
      if (hit) return text('Error: ' + hit.path + ' is a protected configuration file (' + hit.reason + '). oasis mcp serve does not change it; ask the user to edit it or set OASIS_ALLOW_CONFIG_EDITS=1.', true);
    }
    try {
      const result = await executeTool(name, args, { root, env, session, autoApprove: true, ruleAllowed: true, approval: async () => true });
      const body = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return text(body.slice(0, 200000), Boolean(result && typeof result === 'object' && (result.error || result.ok === false)));
    } catch (error) {
      return text('Error: ' + (error.message || String(error)), true);
    }
  });
  const close = async () => { await stopLspClients(session).catch(() => {}); await server.close().catch(() => {}); };
  return { server, close };
}

export async function serveMcp({ root, args = [], env = process.env, input = process.stdin, output = process.stdout, log = process.stderr } = {}) {
  const allowEdits = args.includes('--allow-edits') || args.includes('--allow-all');
  const allowCommands = args.includes('--allow-commands') || args.includes('--allow-all');
  const { server, close } = createMcpServer({ root: path.resolve(root), allowEdits, allowCommands, env });
  log.write('Oasis MCP server on stdio for ' + path.resolve(root) + ' (' + ['read-only tools', allowEdits && 'edits', allowCommands && 'commands'].filter(Boolean).join(', ') + ')\n');
  const transport = new StdioServerTransport(input, output);
  const closed = new Promise((resolve) => { transport.onclose = resolve; input.once('end', resolve); input.once('close', resolve); });
  await server.connect(transport);
  await closed;
  await close();
}
