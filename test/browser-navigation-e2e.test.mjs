// Live Chrome E2E for browser-tool navigation guards (skipped without Chrome).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import '../src/tools.mjs';
import { findChrome } from '../src/cdp.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const chrome = findChrome(process.env);

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('browser guards: same-origin passes, cross-origin link/form/redirect ask, denial blocks, opaque targets never load', { skip: chrome ? false : 'no Chrome/Chromium installed', timeout: 120000 }, async (t) => {
  const other = await listen((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Other</title><h1>other origin</h1>'); });
  const otherUrl = 'http://127.0.0.1:' + other.address().port;
  const home = await listen((req, res) => {
    if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', otherUrl + '/redirected'); res.end(); return; }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/two') { res.end('<title>Two</title><p>same origin page</p>'); return; }
    res.end('<title>Home</title>' +
      '<a href="/two">Same</a> <a href="' + otherUrl + '/">Cross</a> <a href="/redirect">Redir</a> ' +
      '<a href="file:///etc/hostname">FileLink</a> <a href="data:text/html,<title>Data</title>">DataLink</a>' +
      '<form action="' + otherUrl + '/form" method="post"><button>Send</button></form>');
  });
  t.after(() => { home.close(); other.close(); });
  const homeUrl = 'http://localhost:' + home.address().port + '/';
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-nav-e2e-'));
  const env = { ...process.env, HOME: root, OASIS_CHROME_HEADLESS: '1' };
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const { config } = await scriptedModel(t, [
    toolCall('n1', 'browser', { action: 'navigate', url: homeUrl }),
    toolCall('same', 'browser', { action: 'click', text: 'Same' }),
    toolCall('n2', 'browser', { action: 'navigate', url: homeUrl }),
    toolCall('cross', 'browser', { action: 'click', text: 'Cross' }),
    toolCall('form', 'browser', { action: 'click', text: 'Send' }),
    toolCall('redir', 'browser', { action: 'click', text: 'Redir' }),
    toolCall('file', 'browser', { action: 'click', text: 'FileLink' }),
    toolCall('data', 'browser', { action: 'click', text: 'DataLink' }),
    toolCall('cross2', 'browser', { action: 'click', text: 'Cross' }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config: { ...config, maxSteps: 30 }, settings, env, chrome: true });
  t.after(() => closeSession(session));
  const asked = [];
  // Deny everything until the final "Cross" click, which the user approves.
  let approveNext = false;
  await runAgentTurn(session, 'exercise navigation guards', {
    env,
    onToolStart: () => {},
    approval: async (message) => { asked.push(message); return approveNext; },
    onToolResult: ({ call }) => { if (call && call.id === 'data') approveNext = true; }
  });
  const byId = Object.fromEntries(session.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
  if (process.env.NAV_DEBUG) console.error(JSON.stringify({ byId, asked }, null, 1));
  const parse = (id) => { try { return JSON.parse(byId[id]); } catch { return { raw: byId[id] }; } };

  assert.match(parse('same').url || '', /\/two$/, 'same-origin link navigates without a prompt');
  for (const id of ['cross', 'form', 'redir']) {
    const result = parse(id);
    assert.ok(Array.isArray(result.blockedNavigations) && result.blockedNavigations.length, id + ' should report a blocked navigation: ' + byId[id]);
    assert.match(result.blockedNavigations[0].url, new RegExp(otherUrl.replace(/[.:/]/g, '\\$&')), id + ' blocked the cross-origin target');
    assert.equal(result.url, homeUrl, id + ' must leave the page on the original origin');
  }
  for (const id of ['file', 'data']) {
    const result = parse(id);
    assert.doesNotMatch(String(result.url || ''), /^(file|data):/, id + ' must not load an opaque target: ' + byId[id]);
  }
  const prompts = asked.filter((m) => m.includes(otherUrl));
  assert.ok(prompts.length >= 3, 'cross-origin link, form and redirect each asked: ' + JSON.stringify(asked));
  assert.ok(asked.every((m) => !/\/two/.test(m)), 'same-origin navigation never asked');
  assert.match(parse('cross2').url || '', new RegExp('^' + otherUrl.replace(/[.:/]/g, '\\$&')), 'an approved cross-origin navigation proceeds: ' + byId.cross2);
});
