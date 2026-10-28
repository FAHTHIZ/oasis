// oasis mcp serve: expose Oasis's own tools to other MCP clients over stdio
// (Claude Desktop, Cursor, VS Code, another Oasis...). The client is in charge
// of approvals, as with any MCP server, so only a curated set is exposed:
// read-only tools by default, edits with --allow-edits, commands with
// --allow-commands. Secret files and paths outside the workspace stay blocked.
import { createInterface } from 'node:readline';
import path from 'node:path';
import { TOOL_DEFINITIONS, executeTool } from './tools.mjs';
import { stopLspClients } from './lsp.mjs';
import { webSearchEnabled } from './web-search.mjs';

export const SERVE_READ_ONLY = ['read_file', 'list_files', 'glob_files', 'grep', 'search_files', 'git_status', 'git_diff', 'git_log', 'lsp', 'diagnostics', 'fetch_url', 'web_search'];
export const SERVE_EDITS = ['edit_file', 'multi_edit', 'write_file', 'notebook_edit'];
export const SERVE_COMMANDS = ['run_command', 'command_output', 'kill_command', 'list_background'];
const PROTOCOL_VERSION = '2025-06-18';

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

export function createMcpServeHandler({ root, allowEdits = false, allowCommands = false, env = process.env, version = '0.2.0' } = {}) {
  const tools = servedTools({ allowEdits, allowCommands, env });
  const allowed = new Set(tools.map((tool) => tool.name));
  const session = { root, background: new Map(), settings: {} };
  const handle = async (message) => {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return message && message.id !== undefined ? { jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid request' } } : null;
    if (message.id === undefined) return null; // notifications
    const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
    switch (message.method) {
      case 'initialize':
        return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'oasis', version }, instructions: 'Oasis workspace tools for ' + root + '. Paths are relative to that folder.' });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools });
      case 'tools/call': {
        const name = message.params && message.params.name;
        const args = message.params && message.params.arguments || {};
        if (!allowed.has(name)) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown or disabled tool: ' + name } };
        try {
          const result = await executeTool(name, args, { root, env, session, autoApprove: true, ruleAllowed: true, approval: async () => true });
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          const isError = Boolean(result && typeof result === 'object' && (result.error || result.ok === false));
          return reply({ content: [{ type: 'text', text: text.slice(0, 200000) }], isError });
        } catch (error) {
          return reply({ content: [{ type: 'text', text: 'Error: ' + (error.message || String(error)) }], isError: true });
        }
      }
      default:
        return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } };
    }
  };
  handle.close = async () => { await stopLspClients(session).catch(() => {}); };
  return handle;
}

export async function serveMcp({ root, args = [], env = process.env, input = process.stdin, output = process.stdout, log = process.stderr } = {}) {
  const allowEdits = args.includes('--allow-edits') || args.includes('--allow-all');
  const allowCommands = args.includes('--allow-commands') || args.includes('--allow-all');
  const handle = createMcpServeHandler({ root: path.resolve(root), allowEdits, allowCommands, env });
  log.write('Oasis MCP server on stdio for ' + path.resolve(root) + ' (' + ['read-only tools', allowEdits && 'edits', allowCommands && 'commands'].filter(Boolean).join(', ') + ')\n');
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
    const job = (Array.isArray(message) ? Promise.all(message.map(handle)).then((items) => items.filter(Boolean)) : handle(message))
      .then((response) => { if (response && (!Array.isArray(response) || response.length)) output.write(JSON.stringify(response) + '\n'); })
      .finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all(pending);
  await handle.close();
}
