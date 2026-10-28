import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { parsePromptArguments, renderPromptMessages, formatResourceContents } from '../src/mcp-extras.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const SERVER = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
  "process.stdin.on('data', (chunk) => { buffer += chunk; let i;",
  "  while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);",
  "    let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === undefined) continue;",
  "    if (m.method === 'initialize') reply(m.id, { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} } });",
  "    else if (m.method === 'tools/list') reply(m.id, { tools: [] });",
  "    else if (m.method === 'resources/list') reply(m.id, { resources: [{ uri: 'notes://todo', name: 'todo', mimeType: 'text/plain' }] });",
  "    else if (m.method === 'resources/templates/list') reply(m.id, { resourceTemplates: [{ uriTemplate: 'notes://{name}', name: 'note' }] });",
  "    else if (m.method === 'resources/read') reply(m.id, { contents: [{ uri: m.params.uri, mimeType: 'text/plain', text: 'CONTENT OF ' + m.params.uri }] });",
  "    else if (m.method === 'prompts/list') reply(m.id, { prompts: [{ name: 'review', description: 'Review a file', arguments: [{ name: 'file', required: true }, { name: 'focus' }] }] });",
  "    else if (m.method === 'prompts/get') reply(m.id, { messages: [{ role: 'user', content: { type: 'text', text: 'Review ' + m.params.arguments.file + ' focusing on ' + (m.params.arguments.focus || 'everything') } }] });",
  "    else reply(m.id, {}); } });"
].join('\n');

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcpx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('prompt arguments accept positional and name=value forms', () => {
  const prompt = { arguments: [{ name: 'file', required: true }, { name: 'focus' }] };
  assert.deepEqual(parsePromptArguments(prompt, 'src/a.js error handling').values, { file: 'src/a.js', focus: 'error handling' });
  assert.deepEqual(parsePromptArguments(prompt, 'focus="naming" src/b.js').values, { focus: 'naming', file: 'src/b.js' });
  assert.deepEqual(parsePromptArguments(prompt, '').missing, ['file']);
  assert.equal(renderPromptMessages({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }), 'hi\n\n[assistant] ok');
  assert.match(formatResourceContents({ contents: [{ blob: 'AAAA', mimeType: 'image/png' }] }), /binary content image\/png/);
});

test('MCP resources and prompts work end to end in a session', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: process.execPath, args: ['-e', SERVER] } } }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home, HOME: home };
  await setWorkspaceTrust(root, true, env);
  const { config, requests } = await scriptedModel(t, [
    { content: 'prompt done' },
    { content: 'mention done' },
    toolCall('c1', 'list_mcp_resources', {}),
    toolCall('c2', 'read_mcp_resource', { server: 'docs', uri: 'notes://ideas' }),
    { content: 'tools done' }
  ]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const names = session.toolDefinitions.map((tool) => tool.function.name);
  assert.ok(names.includes('list_mcp_resources') && names.includes('read_mcp_resource'));

  const listing = (await runBuiltinCommand('mcp', '', { root, session, env })).output;
  assert.match(listing, /resources: 2/);
  assert.match(listing, /\/mcp__docs__review <file> \[focus\]/);

  const missing = await runAgentTurn(session, '/mcp__docs__review', { env, autoApprove: true });
  assert.match(missing.text, /needs: file/);
  assert.equal(requests.length, 0);

  await runAgentTurn(session, '/mcp__docs__review src/app.js security', { env, autoApprove: true });
  assert.equal(requests[0].messages.at(-1).content, 'Review src/app.js focusing on security');

  await runAgentTurn(session, 'summarize @docs:notes://todo please', { env, autoApprove: true });
  assert.match(requests[1].messages.at(-1).content, /<mcp-resource server="docs" uri="notes:\/\/todo">\nCONTENT OF notes:\/\/todo/);

  const result = await runAgentTurn(session, 'use the tools', { env, autoApprove: false, approval: async () => false });
  assert.equal(result.text, 'tools done');
  const toolMessages = requests[4].messages.filter((m) => m.role === 'tool');
  assert.match(toolMessages.at(-2).content, /notes:\/\/todo/);
  assert.match(toolMessages.at(-2).content, /notes:\/\/\{name\}/);
  assert.match(toolMessages.at(-1).content, /CONTENT OF notes:\/\/ideas/);
});
