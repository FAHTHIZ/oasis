// oasis mcp serve: expose OASIS's own tools to other MCP clients over stdio
// (Claude Desktop, Cursor, VS Code, another OASIS...). The client is in charge
// of approvals, as with any MCP server, so only a curated set is exposed:
// read-only tools by default, edits with --allow-edits, commands with
// --allow-commands. Secret files and paths outside the workspace stay blocked.
// The protocol (version negotiation, framing, ping, errors) is the official
// MCP TypeScript SDK server; OASIS only supplies tools/list and tools/call.
//
// It is also the universal plugin bridge: every slash command OASIS can read
// (its own, Claude Code plugins, Gemini CLI TOML, Cursor, VS Code prompt
// files, Continue, OpenCode, Windsurf workflows...) is served as an MCP
// prompt, and every skill through list_skills / load_skill, so any MCP
// client can use them without converting anything. --no-prompts turns the
// prompts off. Inline shell in a command runs only with --allow-commands.
import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { oasisVersion } from './version.mjs';
import path from 'node:path';
import { TOOL_DEFINITIONS, executeTool } from './tools.mjs';
import { stopLspClients } from './lsp.mjs';
import { webSearchEnabled } from './web-search.mjs';
import { protectedConfigTarget, protectedEditsAllowed } from './protected-paths.mjs';
import { getTelemetry, shutdownTelemetry } from './telemetry.mjs';

const SERVE_READ_ONLY = ['list_skills', 'load_skill', 'read_skill_resource', 'read_file', 'list_files', 'glob_files', 'repo_map', 'grep', 'ast_grep', 'search_files', 'git_status', 'git_diff', 'git_log', 'lsp', 'diagnostics', 'fetch_url', 'web_search'];
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

// MCP prompt names allow letters, digits, -, _ and . ; OASIS namespaces use ':'.
const promptName = (name) => String(name).replace(/:/g, '.');

/** Every slash command OASIS can read, as MCP prompts. */
export async function servedPrompts(root, { env = process.env } = {}) {
  const { loadCustomCommands } = await import('./commands.mjs');
  const commands = await loadCustomCommands(root, { env }).catch(() => new Map());
  return [...commands.values()].map((command) => ({
    name: promptName(command.name),
    description: String(command.description || 'Custom command').slice(0, 300),
    arguments: [{ name: 'arguments', description: command.argumentHint ? 'Arguments: ' + command.argumentHint : 'What to run the command on', required: false }]
  }));
}

function createMcpServer({ root, allowEdits = false, allowCommands = false, prompts = true, env = process.env, version = oasisVersion() } = {}) {
  const tools = servedTools({ allowEdits, allowCommands, env });
  const allowed = new Set(tools.map((tool) => tool.name));
  const session = { root, background: new Map(), settings: {} };
  const server = new Server({ name: 'oasis', version }, { capabilities: { tools: { listChanged: false }, ...(prompts ? { prompts: { listChanged: false } } : {}) }, instructions: 'OASIS workspace tools for ' + root + '. Paths are relative to that folder.' + (prompts ? ' Slash commands from every agent format in this workspace are available as prompts; skills through list_skills and load_skill.' : ' Skills are available through list_skills and load_skill.') });
  const text = (value, isError) => ({ content: [{ type: 'text', text: value }], isError });
  server.setRequestHandler('tools/list', async () => ({ tools }));
  if (prompts) {
    server.setRequestHandler('prompts/list', async () => ({ prompts: await servedPrompts(root, { env }) }));
    server.setRequestHandler('prompts/get', async (request) => {
      const { loadCustomCommands, resolveCustomCommand } = await import('./commands.mjs');
      const wanted = String(request.params && request.params.name || '');
      const commands = await loadCustomCommands(root, { env }).catch(() => new Map());
      const command = [...commands.values()].find((item) => promptName(item.name) === wanted);
      if (!command) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown prompt: ' + wanted);
      const args = request.params && request.params.arguments || {};
      const argumentText = String(args.arguments ?? Object.values(args).join(' ') ?? '');
      const resolved = await resolveCustomCommand(root, '/' + command.name + (argumentText ? ' ' + argumentText : ''), { commands, env, disableShell: !allowCommands });
      if (!resolved) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown prompt: ' + wanted);
      return { description: command.description, messages: [{ role: 'user', content: { type: 'text', text: String(resolved.prompt).slice(0, 200000) } }] };
    });
  }
  server.setRequestHandler('tools/call', async (request) => {
    const name = request.params && request.params.name;
    const args = request.params && request.params.arguments || {};
    if (!allowed.has(name)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown or disabled tool: ' + name);
    // OASIS's own agent always asks before these edits; there is no one to ask
    // here, and MCP clients often auto-approve edits, so refuse them.
    if (SERVE_EDITS.includes(name) && !protectedEditsAllowed(env)) {
      const hit = await protectedConfigTarget(root, args.path || args.notebook_path || args.file_path).catch(() => null);
      if (hit) return text('Error: ' + hit.path + ' is a protected configuration file (' + hit.reason + '). oasis mcp serve does not change it; ask the user to edit it or set OASIS_ALLOW_CONFIG_EDITS=1.', true);
    }
    // With telemetry on, each call is a server span under the client's
    // execute_tool span when the request carries params._meta.traceparent
    // (MCP SEP-414); commands it runs inherit that trace in TRACEPARENT.
    const meta = request.params && request.params._meta || {};
    const tel = getTelemetry(env);
    const run = () => executeTool(name, args, { root, env, session, autoApprove: true, ruleAllowed: true, approval: async () => true });
    try {
      const result = tel
        ? await tel.span('tools/call ' + name, { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': name, 'gen_ai.operation.name': 'execute_tool' }, run, { kind: 2, traceparent: typeof meta.traceparent === 'string' ? meta.traceparent : '', tracestate: typeof meta.tracestate === 'string' ? meta.tracestate : '' })
        : await run();
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
  const prompts = !args.includes('--no-prompts');
  const { server, close } = createMcpServer({ root: path.resolve(root), allowEdits, allowCommands, prompts, env });
  log.write('OASIS MCP server on stdio for ' + path.resolve(root) + ' (' + ['read-only tools', 'skills', prompts && 'commands as prompts', allowEdits && 'edits', allowCommands && 'commands'].filter(Boolean).join(', ') + ')\n');
  const transport = new StdioServerTransport(input, output);
  const closed = new Promise((resolve) => { transport.onclose = resolve; input.once('end', resolve); input.once('close', resolve); });
  // Clients usually stop a stdio server with SIGTERM and SIGKILL it 1-2 s
  // later; with telemetry on, the last spans are exported first.
  const onTerm = getTelemetry(env) ? () => { shutdownTelemetry(1000).finally(() => process.exit(0)); } : null;
  if (onTerm) process.once('SIGTERM', onTerm);
  await server.connect(transport);
  await closed;
  await close();
  if (onTerm) { process.removeListener('SIGTERM', onTerm); await shutdownTelemetry(1000); }
}
