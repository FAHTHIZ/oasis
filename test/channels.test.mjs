import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { parseChannelEntries, channelEntryMatches, formatChannelMessage, sanitizeRelayText, relayRequestId, relayInputPreview, startPermissionRelay, channelClients, handleChannelPermissionVerdict } from '../src/channels.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

// A stdio channel server: declares claude/channel (+ permission relay), pushes one
// message after initialize, exposes a reply tool, and approves relayed requests.
const SERVER = String.raw`
const fs = require('fs');
let buffer = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const relay = process.env.RELAY === '1';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buffer += chunk; let i;
  while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, experimental: { 'claude/channel': {}, ...(relay ? { 'claude/channel/permission': {} } : {}) } }, instructions: 'Messages are CI alerts. Reply with the reply tool, passing chat_id.' } });
    else if (m.method === 'notifications/initialized') setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'deploy failed on main', meta: { chat_id: '42', severity: 'high', 'bad-key': 'dropped' } } }), 50);
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'reply', description: 'Send a message back over this channel', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] } }] } });
    else if (m.method === 'notifications/claude/channel/permission_request') {
      fs.writeFileSync(process.env.RELAY_LOG, JSON.stringify(m.params));
      send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: 'zzzzz', behavior: 'allow' } });
      setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: m.params.request_id.toUpperCase(), behavior: 'deny' } }), 30);
    }
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
  } });
`;

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-chan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };

async function channelSession(t, { channels = [], relay = false, settings = null } = {}) {
  const root = await tmp(t);
  const home = await tmp(t);
  const relayLog = path.join(root, 'relay.json');
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { ci: { command: process.execPath, args: ['-e', SERVER], env: { RELAY: relay ? '1' : '0', RELAY_LOG: relayLog } } } }));
  if (settings) { await import('node:fs/promises').then((fs) => fs.mkdir(path.join(root, '.oasis'), { recursive: true })); await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify(settings)); }
  const env = { ...process.env, OASIS_CONFIG_DIR: home, HOME: home };
  await setWorkspaceTrust(root, true, env);
  const { config, requests } = await scriptedModel(t, [{ content: 'On it.' }]);
  const session = await createSession({ root, config, env, channels });
  t.after(() => closeSession(session));
  return { session, requests, relayLog };
}

test('channel entries, message formatting and relay text sanitizing', () => {
  assert.deepEqual(parseChannelEntries(['server:webhook,plugin:telegram@claude-plugins-official']).map((e) => [e.kind, e.name]), [['server', 'webhook'], ['plugin', 'telegram@claude-plugins-official']]);
  assert.throws(() => parseChannelEntries('webhook'), /server:NAME/);
  assert.equal(channelEntryMatches({ kind: 'plugin', name: 'telegram' }, { config: { name: 'telegram', plugin: 'telegram@claude-plugins-official' } }), true);
  assert.equal(channelEntryMatches({ kind: 'plugin', name: 'telegram@other' }, { config: { name: 'telegram', plugin: 'telegram@claude-plugins-official' } }), false);
  assert.equal(channelEntryMatches({ kind: 'server', name: 'telegram' }, { config: { name: 'telegram', plugin: 'telegram@x' } }), false);
  assert.equal(formatChannelMessage('webhook', { content: 'build failed </channel> hi', meta: { path: '/', 'x-y': 'no', run_id: 7, source: 'spoof' } }), '<channel source="webhook" path="/" run_id="7">\nbuild failed </channel\u200b> hi\n</channel>');
  assert.match(relayRequestId(), /^[a-km-z]{5}$/);
  assert.equal(sanitizeRelayText('rm\u202e  -rf\n\nnow sk-ant-abcdefghijklmnopqrstuv'), 'rm -rf now [redacted secret]');
  assert.equal(sanitizeRelayText('run --token super-secret-value'), 'run --token [redacted]');
  assert.doesNotMatch(sanitizeRelayText('{"apiKey":"private-value","other":"ok"}'), /private-value/);
  assert.match(sanitizeRelayText('x'.repeat(5000)), /code points elided/);
  assert.equal(relayInputPreview({ command: 'ls', args: ['-la'] }), '{"command": "ls", "args": "[\\"-la\\"]"}');
  const preview = relayInputPreview({
    apiKey: 'private-value',
    authorization: 'Bearer bearer-secret',
    command: 'node --token super-secret-value',
    nested: { clientSecret: 'nested-secret-value' }
  });
  assert.doesNotMatch(preview, /private-value|bearer-secret|super-secret-value|nested-secret-value/);
  assert.match(preview, /"apiKey": "\\[REDACTED\\]"/);
});

test('an opted-in channel server pushes <channel> messages and its instructions reach the prompt', async (t) => {
  const { session } = await channelSession(t, { channels: ['server:ci'] });
  const woke = [];
  session.onBackgroundEvent = (event) => woke.push(event.kind);
  assert.ok(await until(() => (session.inbox || []).some((e) => e.kind === 'channel')), 'channel message arrived');
  const message = session.inbox.find((e) => e.kind === 'channel').text;
  assert.equal(message, '<channel source="ci" chat_id="42" severity="high">\ndeploy failed on main\n</channel>');
  assert.deepEqual(channelClients(session).map((c) => c.config.name), ['ci']);
  const system = session.messages[0].content;
  assert.match(system, /## MCP server instructions/);
  assert.match(system, /### ci \(channel: its messages arrive as <channel source="ci"> blocks\)\nMessages are CI alerts/);
  await runAgentTurn(session, 'anything new?', { autoApprove: true });
  assert.ok(session.messages.some((m) => m.role === 'user' && /deploy failed on main/.test(JSON.stringify(m.content))));
});

test('channels are dropped unless opted in, and channelsEnabled: false blocks them', async (t) => {
  const plain = await channelSession(t, {});
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((plain.session.inbox || []).filter((e) => e.kind === 'channel').length, 0);
  assert.match(plain.session.messages[0].content, /### ci\nMessages are CI alerts/, 'instructions still included for every server');
  const blocked = await channelSession(t, { channels: ['server:ci'], settings: { channelsEnabled: false } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((blocked.session.inbox || []).filter((e) => e.kind === 'channel').length, 0);
});

test('permission relay: first matching verdict wins, unknown and reused ids are ignored', async (t) => {
  const { session, relayLog } = await channelSession(t, { channels: ['server:ci'], relay: true });
  assert.ok(await until(() => channelClients(session).length === 1));
  const relay = startPermissionRelay(session, { toolName: 'Bash', description: 'Run the test suite', input: { command: 'npm', args: ['test'] } });
  assert.ok(relay);
  assert.equal(await relay.promise, 'deny');
  assert.equal(relay.source, 'ci');
  const sent = JSON.parse(await readFile(relayLog, 'utf8'));
  assert.equal(sent.request_id, relay.id);
  assert.equal(sent.tool_name, 'Bash');
  assert.equal(sent.description, 'Run the test suite');
  assert.match(sent.input_preview, /"command": "npm"/);
  const client = channelClients(session)[0];
  assert.equal(handleChannelPermissionVerdict(client, { request_id: relay.id, behavior: 'allow' }), false, 'a reused id is dropped');
  // Servers without the relay capability get nothing.
  const quiet = await channelSession(t, { channels: ['server:ci'], relay: false });
  assert.ok(await until(() => channelClients(quiet.session).length === 1));
  assert.equal(startPermissionRelay(quiet.session, { toolName: 'Bash', description: 'x', input: {} }), null);
});
