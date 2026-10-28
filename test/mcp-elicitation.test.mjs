import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { coerceElicitationValue, validateElicitationContent, askElicitationInTerminal, sessionRoots, clientCapabilities } from '../src/mcp-client-features.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// A stdio MCP server that calls back into the client while handling tools/call.
const SERVER = String.raw`
let buffer = ''; let next = 100; const waiting = new Map(); let grown = false; let initParams = null;
process.stdin.setEncoding('utf8');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const ask = (method, params) => new Promise((resolve) => { const id = 's' + (next++); waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const schema = { type: 'object', properties: { name: { type: 'string', title: 'Name' }, plan: { type: 'string', enum: ['free', 'pro'] }, seats: { type: 'integer', minimum: 1, default: 1 } }, required: ['name', 'plan'] };
process.stdin.on('data', async (chunk) => { buffer += chunk; let i;
  while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && !m.method && waiting.has(m.id)) { const r = waiting.get(m.id); waiting.delete(m.id); r(m.result || { error: m.error }); continue; }
    if (m.id === undefined) continue;
    if (m.method === 'initialize') { initParams = m.params; reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } } }); }
    else if (m.method === 'tools/list') reply(m.id, { tools: [{ name: 'signup', inputSchema: { type: 'object' } }, { name: 'roots', inputSchema: { type: 'object' } }, { name: 'grow', inputSchema: { type: 'object' } }, ...(grown ? [{ name: 'extra', inputSchema: { type: 'object' } }] : [])] });
    else if (m.method === 'tools/call' && m.params.name === 'signup') { const answer = await ask('elicitation/create', { message: 'Create your account', requestedSchema: schema }); reply(m.id, { content: [{ type: 'text', text: 'ELICIT ' + JSON.stringify(answer) + ' CAPS ' + JSON.stringify(initParams.capabilities) }] }); }
    else if (m.method === 'tools/call' && m.params.name === 'roots') { const answer = await ask('roots/list', {}); reply(m.id, { content: [{ type: 'text', text: 'ROOTS ' + JSON.stringify(answer) }] }); }
    else if (m.method === 'tools/call' && m.params.name === 'grow') { grown = true; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); reply(m.id, { content: [{ type: 'text', text: 'grew' }] }); }
    else if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: 'called ' + m.params.name }] });
    else reply(m.id, {}); } });
`;

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-elicit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function sessionWithServer(t, steps, settings = null) {
  const root = await tmp(t);
  const home = await tmp(t);
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { acct: { command: process.execPath, args: ['-e', SERVER] } } }));
  if (settings) { await import('node:fs/promises').then((fs) => fs.mkdir(path.join(root, '.oasis'), { recursive: true })); await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify(settings)); }
  const env = { ...process.env, OASIS_CONFIG_DIR: home, HOME: home };
  await setWorkspaceTrust(root, true, env);
  const { config, requests } = await scriptedModel(t, steps);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  return { root, session, requests };
}
const toolText = (requests, index) => { const raw = requests[index].messages.filter((m) => m.role === 'tool').at(-1).content; try { return JSON.parse(raw).content; } catch { return raw; } };

test('elicitation values are coerced and validated against the schema', () => {
  assert.deepEqual(coerceElicitationValue({ type: 'string', enum: ['free', 'pro'] }, '2'), { value: 'pro' });
  assert.deepEqual(coerceElicitationValue({ type: 'boolean' }, 'Yes'), { value: true });
  assert.match(coerceElicitationValue({ type: 'integer', minimum: 1 }, '0').error, /at least 1/);
  assert.match(coerceElicitationValue({ type: 'string', format: 'email' }, 'nope').error, /email/);
  assert.deepEqual(coerceElicitationValue({ type: 'array', items: { enum: ['a', 'b', 'c'] } }, '1 c'), { value: ['a', 'c'] });
  const schema = { type: 'object', properties: { name: { type: 'string' }, seats: { type: 'integer', default: 2 } }, required: ['name'] };
  assert.deepEqual(validateElicitationContent(schema, { name: 'Ada' }), { ok: true, content: { name: 'Ada', seats: 2 } });
  assert.equal(validateElicitationContent(schema, {}).ok, false);
  assert.deepEqual(clientCapabilities().elicitation, {});
  assert.match(sessionRoots({ root: '/tmp/x', additionalDirectories: ['/tmp/y'] })[1].uri, /^file:\/\/\/tmp\/y$/);
});

test('terminal elicitation form asks each field, retries bad input, supports decline', async () => {
  const answers = ['', 'Ada', '3', '2', ''];
  const written = [];
  const result = await askElicitationInTerminal({ serverName: 's', mode: 'form', message: 'Sign up', schema: { type: 'object', properties: { name: { type: 'string' }, plan: { type: 'string', enum: ['free', 'pro'] }, seats: { type: 'integer', default: 1 } }, required: ['name', 'plan'] } }, { ask: async () => answers.shift(), write: (text) => written.push(text) });
  assert.deepEqual(result, { action: 'accept', content: { name: 'Ada', plan: 'pro', seats: 1 } });
  assert.ok(written.some((line) => /Choose one of/.test(line)));
  assert.deepEqual(await askElicitationInTerminal({ serverName: 's', mode: 'form', message: 'x', schema: { properties: {} } }, { ask: async () => 'd', write: () => {} }), { action: 'decline' });
  let opened = null;
  assert.deepEqual(await askElicitationInTerminal({ serverName: 's', mode: 'url', message: 'Authorize', url: 'https://example.com/auth' }, { ask: async () => 'y', write: () => {}, openUrl: (url) => { opened = url; } }), { action: 'accept' });
  assert.equal(opened, 'https://example.com/auth');
});

test('MCP server elicitation reaches the user mid tool call', async (t) => {
  const { session, requests } = await sessionWithServer(t, [toolCall('c1', 'mcp_acct_signup', {}), { content: 'done' }]);
  const seen = [];
  session.elicit = async (request) => { seen.push(request); return { action: 'accept', content: { name: 'Ada', plan: 'pro' } }; };
  await runAgentTurn(session, 'sign me up', { autoApprove: true });
  assert.equal(seen[0].serverName, 'acct');
  assert.equal(seen[0].message, 'Create your account');
  const text = toolText(requests, 1);
  assert.match(text, /"action":"accept"/);
  assert.match(text, /"content":\{"name":"Ada","plan":"pro","seats":1\}/);
  assert.match(text, /CAPS \{"roots":\{"listChanged":true\},"elicitation":\{\}\}/);
});

test('without an interactive handler elicitation is declined; hooks can answer or override', async (t) => {
  const { session, requests } = await sessionWithServer(t, [toolCall('c1', 'mcp_acct_signup', {}), { content: 'a' }, toolCall('c2', 'mcp_acct_signup', {}), { content: 'b' }]);
  await runAgentTurn(session, 'one', { autoApprove: true });
  assert.match(toolText(requests, 1), /ELICIT \{"action":"decline"\}/);
  const answer = { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { name: 'Bot', plan: 'free' } } };
  session.hooks = { Elicitation: [{ matcher: 'acct', hooks: [{ type: 'command', command: JSON.stringify(process.execPath) + ' -e ' + JSON.stringify('process.stdout.write(' + JSON.stringify(JSON.stringify(answer)) + ')') }] }], ElicitationResult: [{ hooks: [{ type: 'command', command: JSON.stringify(process.execPath) + ' -e ' + JSON.stringify('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"ElicitationResult",action:"accept",content:{...p.content,name:p.content.name+"!"}}}))})') }] }] };
  await runAgentTurn(session, 'two', { autoApprove: true });
  assert.match(toolText(requests, 3), /"name":"Bot!","plan":"free","seats":1/);
});

test('roots/list returns the workspace and tools/list_changed refreshes tools', async (t) => {
  const { root, session, requests } = await sessionWithServer(t, [toolCall('c1', 'mcp_acct_roots', {}), toolCall('c2', 'mcp_acct_grow', {}), { content: 'done' }]);
  assert.ok(!session.toolDefinitions.some((tool) => tool.function.name === 'mcp_acct_extra'));
  await runAgentTurn(session, 'go', { autoApprove: true });
  assert.ok(toolText(requests, 1).includes(JSON.stringify({ roots: [{ uri: new URL('file://' + root).href, name: 'workspace' }] })));
  const end = Date.now() + 3000;
  while (Date.now() < end && !session.toolDefinitions.some((tool) => tool.function.name === 'mcp_acct_extra')) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'mcp_acct_extra'), 'new tool registered');
});

test('Streamable HTTP servers can elicit over the SSE response stream', async () => {
  const { McpHttpClient } = await import('../src/mcp-project.mjs');
  let answered;
  const answeredPromise = new Promise((resolve) => { answered = resolve; });
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fakeFetch = async (_url, init) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    const message = JSON.parse(init.body);
    if (!message.method) { answered(message); return new Response(null, { status: 202 }); }
    if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'book', inputSchema: { type: 'object' } }] } });
    if (message.method === 'tools/call') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Which day?', requestedSchema: { type: 'object', properties: { day: { type: 'string', enum: ['mon', 'tue'] } }, required: ['day'] } } }) + '\n\n'));
          const response = await answeredPromise;
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'booked ' + response.result.content.day } ] } }) + '\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(null, { status: 202 });
  };
  const host = { session: { root: process.cwd(), hooks: {}, elicit: async () => ({ action: 'accept', content: { day: 'tue' } }) } };
  const client = new McpHttpClient({ name: 'cal', url: 'https://mcp.example.com/mcp', headers: { authorization: 'Bearer x' } }, { fetch: fakeFetch, host });
  await client.start();
  const result = await client.callTool('book', {}, { autoApprove: true });
  assert.match(result.content, /booked tue/);
  client.close();
});
