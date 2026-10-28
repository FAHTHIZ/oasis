import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runHeadless } from '../src/headless.mjs';
import { validatePluginMonitors, validateWsUrl, validateWsProtocols, monitorTimeout, startPluginMonitorsFor, activeMonitors } from '../src/monitors.mjs';
import { pluginMonitors } from '../src/claude-plugins.mjs';
import { parseRule, ruleMatches, suggestRule } from '../src/permissions.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const TICKER = "let i = 0; const t = setInterval(() => { i++; console.log('tick ' + i); if (i === 3) { clearInterval(t); console.log('ERROR boom'); } }, 80);\n";

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const allText = (requests) => JSON.stringify(requests.map((r) => r.messages));

test('monitor inputs, plugin monitor entries and permission rules are validated', () => {
  assert.equal(monitorTimeout({}), 300000);
  assert.equal(monitorTimeout({ persistent: true }), 0);
  assert.equal(monitorTimeout({ persistent: true }, { headless: true }), 600000);
  assert.equal(monitorTimeout({ timeout_ms: 99999999 }), 3600000);
  assert.equal(validateWsUrl('wss://example.com/feed'), 'wss://example.com/feed');
  assert.throws(() => validateWsUrl('https://example.com'), /ws:\/\//);
  assert.throws(() => validateWsUrl('wss://u:p@example.com'), /credentials/);
  assert.throws(() => validateWsProtocols(['a', 'a']), /Duplicate/);
  assert.throws(() => validatePluginMonitors([{ name: 'x', command: 'y', description: 'z', extra: 1 }]), /unknown key "extra"/);
  assert.throws(() => validatePluginMonitors([{ name: 'x', command: 'echo ${user_config.token}', description: 'z' }]), /user_config/);
  assert.throws(() => validatePluginMonitors([{ name: 'x', command: 'y', description: 'z', when: 'sometimes' }]), /invalid when/);
  assert.deepEqual(validatePluginMonitors([{ name: 'x', command: 'y', description: 'z' }])[0].when, 'always');
  // Monitor commands follow Bash rules.
  assert.equal(ruleMatches(parseRule('Bash(tail:*)'), 'monitor', { command: 'tail', args: ['-F', 'a.log'] }), true);
  assert.equal(ruleMatches(parseRule('Bash(tail:*)'), 'monitor', { ws: { url: 'wss://x' } }), false);
  assert.equal(suggestRule('monitor', { command: 'tail', args: ['-F', 'a.log'] }), 'Bash(tail:*)');
});

test('monitor events reach the model between turns and a finished background command is announced', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'ticker.js'), TICKER);
  const { config, requests } = await scriptedModel(t, [(payload) => {
    const last = payload.messages.at(-1);
    const text = JSON.stringify(last.content);
    if (last.role === 'tool') return { content: 'Watching.' };
    if (/start watching/.test(text)) return toolCall('m1', 'monitor', { description: 'ticker errors', command: process.execPath, args: ['ticker.js'], pattern: 'tick [13]|ERROR' });
    if (/run in background/.test(text)) return toolCall('b1', 'run_command', { command: process.execPath, args: ['ticker.js'], run_in_background: true });
    return { content: 'Noted.' };
  }]);
  const session = await createSession({ root, config, settings, bare: true });
  t.after(() => closeSession(session));
  const woke = [];
  session.onBackgroundEvent = (event) => woke.push(event.kind);
  await runAgentTurn(session, 'start watching', { autoApprove: true });
  assert.ok(await until(() => woke.includes('monitor-end')), 'monitor finished: ' + woke.join(','));
  assert.ok(woke.includes('monitor'));
  await runAgentTurn(session, 'what happened?', { autoApprove: true });
  const seen = JSON.stringify(requests.at(-1).messages.at(-1).content);
  assert.match(seen, /monitor-event id=\\"bg_/);
  assert.match(seen, /tick 1/);
  assert.match(seen, /ERROR boom/);
  assert.doesNotMatch(seen, /tick 2/, 'pattern filters lines');
  assert.match(seen, /exited with code 0/);

  await runAgentTurn(session, 'run in background', { autoApprove: true });
  assert.ok(await until(() => woke.includes('background-exit')));
  await runAgentTurn(session, 'and now?', { autoApprove: true });
  assert.match(JSON.stringify(requests.at(-1).messages.at(-1).content), /background-command id=.*exited with code 0.*tick 3/s);
});

test('monitors need approval like commands, stop with kill_command, and honor their deadline', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'forever.js'), "setInterval(() => console.log('alive'), 50);\n");
  let call = 0;
  const { config, requests } = await scriptedModel(t, [(payload) => {
    const last = payload.messages.at(-1);
    if (last.role === 'tool') return { content: 'ok' };
    call += 1;
    if (call === 1) return toolCall('m1', 'monitor', { description: 'denied one', command: process.execPath, args: ['forever.js'] });
    if (call === 2) return toolCall('m2', 'monitor', { description: 'short', command: process.execPath, args: ['forever.js'], timeout_ms: 1000 });
    return { content: 'done' };
  }]);
  const session = await createSession({ root, config, settings, bare: true });
  t.after(() => closeSession(session));
  const asked = [];
  await runAgentTurn(session, 'one', { approval: async (message) => { asked.push(message); return false; } });
  assert.match(asked[0], /forever\.js/);
  assert.match(JSON.stringify(requests.at(-1).messages.at(-1)), /not approved/);
  assert.equal(activeMonitors(session).length, 0);
  await runAgentTurn(session, 'two', { approval: async () => true });
  assert.equal(activeMonitors(session).length, 1);
  assert.ok(await until(() => (session.inbox || []).some((e) => e.kind === 'monitor-end'), 5000));
  assert.match(session.inbox.find((e) => e.kind === 'monitor-end').text, /deadline/);
});

test('headless runs stay open for agent monitors and answer each event batch', async (t) => {
  const root = await tmp(t);
  await writeFile(path.join(root, 'ticker.js'), TICKER);
  const { config, requests } = await scriptedModel(t, [(payload) => {
    const last = payload.messages.at(-1);
    const text = JSON.stringify(last.content);
    if (last.role === 'tool') return { content: 'Watching the ticker.' };
    if (/background event/.test(text)) return { content: /ended=/.test(text) ? 'Ticker finished.' : 'Saw ticks.' };
    return toolCall('m1', 'monitor', { description: 'ticker', command: process.execPath, args: ['ticker.js'] });
  }]);
  const events = [];
  const { summary } = await runHeadless({ prompt: 'watch the ticker', root, config, autoApprove: true, outputFormat: 'stream-json', sessionOptions: { settings }, write: (line) => { for (const part of String(line).split('\n')) if (part.trim()) events.push(JSON.parse(part)); } });
  assert.ok(events.some((e) => e.type === 'system' && e.subtype === 'monitor_event'));
  assert.equal(summary.result, 'Ticker finished.');
  assert.ok(requests.length >= 3);
  assert.match(allText(requests), /tick 3/);
});

test('plugin monitors load from monitors/monitors.json and start always or on skill invoke', async (t) => {
  const root = await tmp(t);
  const pluginRoot = path.join(root, 'plug');
  await mkdir(path.join(pluginRoot, 'monitors'), { recursive: true });
  await writeFile(path.join(pluginRoot, 'emit.js'), "console.log('plugin says hi from ' + process.env.CLAUDE_PLUGIN_ROOT.length);\n");
  const node = JSON.stringify(process.execPath);
  await writeFile(path.join(pluginRoot, 'monitors', 'monitors.json'), JSON.stringify([
    { name: 'greeter', command: node + ' "${CLAUDE_PLUGIN_ROOT}/emit.js"', description: 'says hi' },
    { name: 'deploy-watch', command: node + ' "${CLAUDE_PLUGIN_ROOT}/emit.js"', description: 'deploy status', when: 'on-skill-invoke:deploy' }
  ]));
  const plugin = { id: 'plug@local', name: 'plug', root: pluginRoot, manifest: { name: 'plug' }, options: {} };
  const specs = await pluginMonitors([plugin], { env: process.env, root });
  assert.deepEqual(specs.map((s) => [s.name, s.when]), [['greeter', 'always'], ['deploy-watch', 'on-skill-invoke:deploy']]);
  assert.ok(specs[0].command.includes(pluginRoot));
  const errors = [];
  await pluginMonitors([{ ...plugin, manifest: { name: 'plug', experimental: { monitors: [{ name: 'bad' }] } } }], { errors });
  assert.match(errors[0], /needs a command/);

  const { config } = await scriptedModel(t, [{ content: 'ok' }]);
  const session = await createSession({ root, config, settings, bare: true });
  t.after(() => closeSession(session));
  session.pluginMonitors = specs;
  assert.equal(startPluginMonitorsFor(session, 'always', { root }).length, 1);
  assert.equal(startPluginMonitorsFor(session, 'always', { root }).length, 0, 'starts once');
  assert.equal(startPluginMonitorsFor(session, 'other-skill', { root }).length, 0);
  assert.equal(startPluginMonitorsFor(session, 'plug:deploy', { root }).length, 1);
  assert.ok(await until(() => (session.inbox || []).filter((e) => e.kind === 'monitor' && /plugin says hi/.test(e.text)).length === 2));
  assert.match(session.inbox.find((e) => e.kind === 'monitor').text, /plug:greeter/);
});

test('a WebSocket monitor turns messages into events', { skip: typeof WebSocket !== 'function' }, async (t) => {
  // Minimal RFC 6455 server: handshake, then two text frames and a close.
  const { createHash } = await import('node:crypto');
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const frame = (text) => { const body = Buffer.from(text); return Buffer.concat([Buffer.from([0x81, body.length]), body]); };
    setTimeout(() => { socket.write(frame('build #1 passed')); socket.write(frame('build #2 failed')); }, 50);
    setTimeout(() => { socket.write(Buffer.from([0x88, 0])); socket.end(); }, 400);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = await tmp(t);
  const url = 'ws://127.0.0.1:' + server.address().port + '/feed';
  const { config } = await scriptedModel(t, [(payload) => payload.messages.at(-1).role === 'tool' ? { content: 'ok' } : toolCall('w1', 'monitor', { description: 'builds', ws: { url }, pattern: 'failed' })]);
  const session = await createSession({ root, config, settings, bare: true });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'watch builds', { autoApprove: true });
  assert.ok(await until(() => (session.inbox || []).some((e) => e.kind === 'monitor-end'), 5000));
  const text = session.inbox.map((e) => e.text).join('\n');
  assert.match(text, /build #2 failed/);
  assert.doesNotMatch(text, /build #1 passed/);
});
