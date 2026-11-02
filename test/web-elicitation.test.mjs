import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { startOasisWebServer, elicitationSchemaForPage } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const SERVER = String.raw`
let buffer = ''; let next = 100; const waiting = new Map();
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
    if (m.method === 'initialize') reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    else if (m.method === 'tools/list') reply(m.id, { tools: [{ name: 'signup', inputSchema: { type: 'object' } }] });
    else if (m.method === 'tools/call') { const answer = await ask('elicitation/create', { message: 'Create your account', requestedSchema: schema }); reply(m.id, { content: [{ type: 'text', text: 'ANSWER ' + JSON.stringify(answer) }] }); }
    else reply(m.id, {}); } });
`;

test('the page only receives the flat primitive schema MCP allows', () => {
  const out = elicitationSchemaForPage({ type: 'object', properties: { name: { type: 'string', title: 'N'.repeat(500) }, plan: { enum: ['a', 'b'] }, nested: { type: 'object', properties: {} }, 'bad key!': { type: 'string' }, tags: { type: 'array', items: { enum: ['x', 'y'] } } }, required: ['name', 'nested'] });
  assert.deepEqual(Object.keys(out.properties), ['name', 'plan', 'tags']);
  assert.equal(out.properties.name.title.length, 120);
  assert.deepEqual(out.properties.plan.options, [{ const: 'a' }, { const: 'b' }]);
  assert.deepEqual(out.required, ['name']);
});

test('MCP elicitation in the browser: a form card, answered through its own endpoint', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-elicit-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
  // Sessions created by the web server read trust from process.env.
  const saved = { OASIS_CONFIG_DIR: process.env.OASIS_CONFIG_DIR, HOME: process.env.HOME };
  Object.assign(process.env, { OASIS_CONFIG_DIR: env.OASIS_CONFIG_DIR, HOME: root });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { acct: { command: process.execPath, args: ['-e', SERVER] } } }));
  await setWorkspaceTrust(root, true, env);
  const toolText = (payload) => payload.messages.filter((m) => m.role === 'tool').at(-1).content;
  const { config } = await scriptedModel(t, [toolCall('c1', 'mcp_acct_signup', {}), (payload) => ({ content: 'tool said: ' + toolText(payload) })]);
  await saveConfig(config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const started = await (await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'sign me up' }) })).json();
  const poll = async (until) => {
    let snapshot;
    for (let i = 0; i < 600; i++) {
      snapshot = await (await fetch(base + '/api/jobs/' + started.jobId + '?after=0', { headers })).json();
      for (const e of snapshot.events) if (e.type === 'approval_required' && !snapshot.__approved?.has(e.data.approvalId)) {
        await fetch(base + '/api/jobs/' + started.jobId + '/approval', { method: 'POST', headers, body: JSON.stringify({ approvalId: e.data.approvalId, approved: true }) });
      }
      if (until(snapshot)) return snapshot;
      await new Promise((r) => setTimeout(r, 25));
    }
    return snapshot;
  };
  let snapshot = await poll((s) => s.events.some((e) => e.type === 'elicitation') || ['completed', 'failed'].includes(s.status));
  const card = snapshot.events.find((e) => e.type === 'elicitation');
  assert.ok(card, JSON.stringify(snapshot.events.filter((e) => e.type === 'tool_result').map((e) => e.data)).slice(0, 600));
  assert.equal(card.data.serverName, 'acct');
  assert.equal(card.data.message, 'Create your account');
  assert.deepEqual(Object.keys(card.data.schema.properties), ['name', 'plan', 'seats']);
  const viaApproval = await fetch(base + '/api/jobs/' + started.jobId + '/approval', { method: 'POST', headers, body: JSON.stringify({ approvalId: card.data.elicitationId, approved: true }) });
  assert.equal(viaApproval.status, 404, 'a form cannot be resolved through the approval endpoint');
  const bad = await fetch(base + '/api/jobs/' + started.jobId + '/elicitation', { method: 'POST', headers, body: JSON.stringify({ elicitationId: card.data.elicitationId, action: 'yes' }) });
  assert.equal(bad.status, 400);
  const sent = await fetch(base + '/api/jobs/' + started.jobId + '/elicitation', { method: 'POST', headers, body: JSON.stringify({ elicitationId: card.data.elicitationId, action: 'accept', content: { name: 'Ada', plan: 'pro', extra: 'dropped' } }) });
  assert.equal(sent.status, 200);
  snapshot = await poll((s) => ['completed', 'failed'].includes(s.status));
  assert.equal(snapshot.status, 'completed', snapshot.error);
  assert.ok(snapshot.events.some((e) => e.type === 'elicitation_resolved' && e.data.action === 'accept'));
  assert.match(snapshot.result.text, /ANSWER .*"action\\?":\\?"accept\\?"/);
  assert.match(snapshot.result.text, /Ada/);
  assert.match(snapshot.result.text, /seats\\?":1/, 'schema defaults are filled in');
  assert.doesNotMatch(snapshot.result.text, /dropped/, 'fields outside the schema never reach the server');
});
