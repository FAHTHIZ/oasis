import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { getAgent, listAgents } from '../src/agent-tasks.mjs';
import { normalizeAgentDefinition } from '../src/subagents.mjs';

const ECHO_SERVER = [
  "let buffer = ''; process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue; let result = {};",
  "    if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', serverInfo: { name: 'echo', version: '1' }, capabilities: { tools: {} } };",
  "    if (m.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Replies pong', inputSchema: { type: 'object', properties: {} } }] };",
  "    if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'pong-from-agent-server' }] };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); } });"
].join('\n');

test('mcpServers front matter: names are references, inline entries are kept, plugins get none', () => {
  const agent = normalizeAgentDefinition({ mcpServers: ['github', { echo: { command: 'node' } }] }, '', { name: 'a', source: 'user:/x' });
  assert.deepEqual(agent.mcpServers.refs, ['github']);
  assert.deepEqual(Object.keys(agent.mcpServers.inline), ['echo']);
  assert.equal(normalizeAgentDefinition({ mcpServers: { echo: { command: 'node' } } }, '', { name: 'p:a', source: 'plugin:p', plugin: true }).mcpServers, null);
});

async function run(t, { inline = null, projectFile = false }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-agentmcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = { echo: { command: process.execPath, args: ['-e', ECHO_SERVER] } };
  if (projectFile) {
    await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
    await writeFile(path.join(root, '.oasis', 'agents', 'pinger.md'), '---\nname: pinger\ndescription: Pings\nmcpServers:\n  echo:\n    command: ' + JSON.stringify(process.execPath) + '\n    args: ["-e", ' + JSON.stringify(ECHO_SERVER) + ']\n---\nYou ping.\n');
  }
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    const isChild = /SUBAGENT MODE \(pinger\)/.test(payload.messages[0].content);
    const tools = (payload.tools || []).map((tool) => tool.function.name);
    const toolMessage = payload.messages.findLast((message) => message.role === 'tool');
    seen.push({ isChild, tools, toolMessage: toolMessage ? String(toolMessage.content) : '' });
    let message;
    if (isChild) message = toolMessage || !tools.includes('mcp_echo_ping') ? { role: 'assistant', content: 'report: ' + (toolMessage ? toolMessage.content : 'no tool') } : { role: 'assistant', content: null, tool_calls: [{ id: 'm1', type: 'function', function: { name: 'mcp_echo_ping', arguments: '{}' } }] };
    else message = toolMessage ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'ping', prompt: 'ping it', subagent_type: 'pinger' }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '' };
  const session = await createSession({ root, env, agentsInline: inline ? { pinger: { description: 'Pings', prompt: 'You ping.', mcpServers: spec } } : null, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  return { seen, session };
}

test('an inline MCP server from the agent definition is available only to that agent and closed after', async (t) => {
  const { seen, session } = await run(t, { inline: true });
  const parent = seen.find((entry) => !entry.isChild);
  assert.ok(!parent.tools.includes('mcp_echo_ping'), 'the parent does not get the agent server');
  const child = seen.filter((entry) => entry.isChild);
  assert.ok(child[0].tools.includes('mcp_echo_ping'), child[0].tools.join(','));
  assert.match(child.at(-1).toolMessage, /pong-from-agent-server/);
  assert.ok(!session.mcpClients.has('echo'));
  const record = getAgent(session, listAgents(session)[0].id);
  assert.equal(record.child.agentMcpClients, null, 'the agent server is closed when the turn ends');
});

test('a project agent file in an untrusted workspace does not start its MCP servers', async (t) => {
  const { seen } = await run(t, { projectFile: true });
  const child = seen.find((entry) => entry.isChild);
  assert.ok(child, 'the agent still runs');
  assert.ok(!child.tools.includes('mcp_echo_ping'));
});
