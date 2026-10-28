// MCP resources and prompts, shared by the stdio and HTTP clients.
//
// - Resources: list_mcp_resources / read_mcp_resource tools (read-only, added
//   only when a connected server offers resources) and @server:uri mentions.
// - Prompts: each server prompt becomes /mcp__server__prompt in the terminal
//   and the browser; arguments are positional or name=value.
const MAX_RESOURCE_TEXT = 40000;
const MAX_ITEMS = 200;

function cleanList(items, key) {
  return (Array.isArray(items) ? items : []).filter((item) => item && typeof item[key] === 'string' && item[key].length <= 2000).slice(0, MAX_ITEMS);
}

// Called after initialize + tools/list. Listing failures never break the server.
export async function loadMcpExtras(client, init = {}) {
  const capabilities = init && init.capabilities || {};
  client.capabilities = capabilities;
  client.resources = [];
  client.resourceTemplates = [];
  client.prompts = [];
  if (capabilities.resources) {
    try { client.resources = cleanList((await client._request('resources/list', {}, 15000)).resources, 'uri'); } catch {}
    try { client.resourceTemplates = cleanList((await client._request('resources/templates/list', {}, 15000)).resourceTemplates, 'uriTemplate'); } catch {}
  }
  if (capabilities.prompts) {
    try { client.prompts = cleanList((await client._request('prompts/list', {}, 15000)).prompts, 'name').filter((prompt) => /^[a-zA-Z0-9_.-]{1,80}$/.test(prompt.name)); } catch {}
  }
}

export function formatResourceContents(result) {
  const parts = [];
  for (const item of Array.isArray(result && result.contents) ? result.contents : []) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string') parts.push(item.text);
    else if (typeof item.blob === 'string') parts.push('[binary content ' + (item.mimeType || 'application/octet-stream') + ', about ' + Math.round(item.blob.length * 0.75) + ' bytes, omitted]');
  }
  const text = parts.join('\n\n');
  return text.length > MAX_RESOURCE_TEXT ? text.slice(0, MAX_RESOURCE_TEXT) + '\n[truncated]' : text;
}

export async function readMcpResource(client, uri) {
  if (!client.capabilities || !client.capabilities.resources) throw new Error('MCP server ' + client.config.name + ' does not offer resources.');
  const result = await client._request('resources/read', { uri: String(uri) }, 60000);
  return { uri: String(uri), mimeType: result && result.contents && result.contents[0] && result.contents[0].mimeType || null, content: formatResourceContents(result) };
}

export function promptCommandName(serverName, promptName) {
  return 'mcp__' + serverName + '__' + promptName;
}

// Renders prompts/get messages as one user prompt.
export function renderPromptMessages(result) {
  const lines = [];
  for (const message of Array.isArray(result && result.messages) ? result.messages : []) {
    const content = message && message.content;
    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') lines.push((message.role === 'assistant' ? '[assistant] ' : '') + block.text);
      else if (block.type === 'resource' && block.resource) lines.push(formatResourceContents({ contents: [block.resource] }));
    }
  }
  return lines.join('\n\n').slice(0, 60000);
}

export function parsePromptArguments(prompt, argumentText) {
  const declared = Array.isArray(prompt.arguments) ? prompt.arguments.filter((arg) => arg && typeof arg.name === 'string') : [];
  const values = {};
  const positional = [];
  const tokens = String(argumentText || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (const raw of tokens) {
    const token = raw.replace(/^(["'])([\s\S]*)\1$/, '$2');
    const named = raw.match(/^([a-zA-Z_][\w-]*)=(.*)$/);
    if (named && declared.some((arg) => arg.name === named[1])) values[named[1]] = named[2].replace(/^(["'])([\s\S]*)\1$/, '$2');
    else positional.push(token);
  }
  const unfilled = declared.filter((arg) => values[arg.name] === undefined);
  unfilled.forEach((arg, index) => { if (positional[index] !== undefined) values[arg.name] = index === unfilled.length - 1 ? positional.slice(index).join(' ') : positional[index]; });
  const missing = declared.filter((arg) => arg.required && (values[arg.name] === undefined || values[arg.name] === '')).map((arg) => arg.name);
  return { values, missing };
}

// Looks up "/mcp__server__prompt args" against connected clients.
export async function resolveMcpPrompt(session, text) {
  const match = String(text || '').match(/^\/mcp__([a-z0-9_-]+?)__([a-zA-Z0-9_.-]+)(?:\s+([\s\S]*))?$/);
  if (!match || !session || !session.mcpClients) return null;
  const client = session.mcpClients.get(match[1]);
  const prompt = client && (client.prompts || []).find((item) => item.name === match[2]);
  if (!prompt) return { error: 'No MCP prompt /' + promptCommandName(match[1], match[2]) + '. Type /mcp to see the prompts each server offers.' };
  const { values, missing } = parsePromptArguments(prompt, match[3]);
  if (missing.length) return { error: '/' + promptCommandName(match[1], match[2]) + ' needs: ' + missing.join(', ') + (prompt.arguments ? '. Arguments: ' + prompt.arguments.map((arg) => arg.name + (arg.required ? '' : '?')).join(' ') : '') };
  const result = await client._request('prompts/get', { name: prompt.name, arguments: values }, 60000);
  const rendered = renderPromptMessages(result);
  if (!rendered.trim()) return { error: 'MCP prompt ' + prompt.name + ' returned no text.' };
  return { prompt: rendered, server: match[1], name: prompt.name };
}

// @server:uri mentions in a user prompt. Returns appended context blocks.
export async function expandMcpResourceMentions(session, text) {
  if (!session || !session.mcpClients || !session.mcpClients.size) return { blocks: [], errors: [] };
  const blocks = [];
  const errors = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(/(?:^|\s)@([a-z][a-z0-9_-]*):(\S+)/g)) {
    const [server, uri] = [match[1], match[2].replace(/[),.;!?]+$/, '')];
    const client = session.mcpClients.get(server);
    if (!client || !client.capabilities || !client.capabilities.resources) continue;
    const key = server + ':' + uri;
    if (seen.has(key) || seen.size >= 5) continue;
    seen.add(key);
    try {
      const resource = await readMcpResource(client, uri);
      blocks.push('<mcp-resource server="' + server + '" uri="' + uri.replace(/"/g, '&quot;') + '">\n' + resource.content + '\n</mcp-resource>');
    } catch (error) { errors.push(key + ': ' + error.message); }
  }
  return { blocks, errors };
}

export const RESOURCE_TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'list_mcp_resources', description: 'List resources (files, records, documents) offered by connected MCP servers, with their URIs. Read-only.', parameters: { type: 'object', properties: { server: { type: 'string', description: 'Only this MCP server' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'read_mcp_resource', description: 'Read one MCP resource by server name and URI (from list_mcp_resources or a resource template). Read-only.', parameters: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } }, required: ['server', 'uri'], additionalProperties: false } } }
];

export async function runResourceTool(session, name, args = {}) {
  const clients = session.mcpClients || new Map();
  if (name === 'list_mcp_resources') {
    const servers = [];
    for (const [serverName, client] of clients) {
      if (args.server && args.server !== serverName) continue;
      if (!client.capabilities || !client.capabilities.resources) continue;
      servers.push({
        server: serverName,
        resources: (client.resources || []).map((item) => ({ uri: item.uri, name: item.name || null, description: item.description ? String(item.description).slice(0, 300) : null, mimeType: item.mimeType || null })),
        templates: (client.resourceTemplates || []).map((item) => ({ uriTemplate: item.uriTemplate, name: item.name || null, description: item.description ? String(item.description).slice(0, 300) : null }))
      });
    }
    if (args.server && !servers.length) throw new Error('MCP server ' + args.server + ' is not connected or offers no resources.');
    return { servers };
  }
  const client = clients.get(String(args.server || ''));
  if (!client) throw new Error('MCP server is not connected: ' + args.server);
  return await readMcpResource(client, args.uri);
}
