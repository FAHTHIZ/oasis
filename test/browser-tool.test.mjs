import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import '../src/tools.mjs';
import { findChrome } from '../src/cdp.mjs';
import { browserNavigationNeedsApproval, browserNavigationPolicy, isPrivateBrowserRequest } from '../src/browser-tool.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const chrome = findChrome(process.env);

test('browser navigation approvals scope web URLs by origin and opaque URLs by exact target', () => {
  const approved = new Set();
  const firstWeb = browserNavigationPolicy('https://example.test/one');
  assert.equal(browserNavigationNeedsApproval(firstWeb, approved), true);
  approved.add(firstWeb.approvalKey);
  assert.equal(browserNavigationNeedsApproval('https://example.test/two', approved), false);

  const dataOne = browserNavigationPolicy('data:text/html,<title>one</title>');
  const dataTwo = browserNavigationPolicy('data:text/html,<title>two</title>');
  assert.equal(dataOne.local, false);
  assert.notEqual(dataOne.approvalKey, dataTwo.approvalKey);
  assert.equal(browserNavigationNeedsApproval(dataTwo, approved), true);

  const fileOne = browserNavigationPolicy('file:///tmp/first.html');
  const fileTwo = browserNavigationPolicy('file:///tmp/second.html');
  assert.equal(fileOne.local, false);
  assert.notEqual(fileOne.approvalKey, fileTwo.approvalKey);
  assert.equal(browserNavigationNeedsApproval(fileTwo, approved), true);

  assert.equal(browserNavigationPolicy('about:blank').local, true);
  assert.equal(browserNavigationPolicy('about:srcdoc').local, false);
  assert.equal(browserNavigationNeedsApproval('about:srcdoc', approved), true);
  const loopback = browserNavigationPolicy('http://127.0.0.1:8123/');
  assert.equal(loopback.local, true);
  assert.equal(browserNavigationNeedsApproval(loopback, new Set()), false, 'explicit local navigation remains convenient for development');
  assert.equal(browserNavigationNeedsApproval(loopback, new Set(), { strictLocal: true }), true, 'page-triggered localhost access must ask first');
  assert.equal(isPrivateBrowserRequest('http://127.0.0.1:8123/api'), true);
  assert.equal(isPrivateBrowserRequest('http://192.168.1.1/admin'), true);
  assert.equal(isPrivateBrowserRequest('http://169.254.169.254/latest/meta-data/'), true);
  assert.equal(isPrivateBrowserRequest('http://metadata.google.internal/'), true);
  assert.equal(isPrivateBrowserRequest('http://printer.local/'), true);
  assert.equal(isPrivateBrowserRequest('http://[::1]:9222/json'), true);
  assert.equal(isPrivateBrowserRequest('http://[fd00::1]/private'), true);
  assert.equal(isPrivateBrowserRequest('https://cdn.example.com/script.js'), false);
  assert.equal(isPrivateBrowserRequest('data:image/png;base64,AAAA'), false);
  assert.throws(() => browserNavigationPolicy('https://example.test/' + 'x'.repeat(33000)), /too long/);
  assert.throws(() => browserNavigationPolicy('https://user:pass@example.test/'), /must not embed/);
});
const PAGE = '<html><head><title>Fixture</title></head><body><h1>Hello browser</h1><input placeholder="Search"><button onclick="document.getElementById(\'out\').textContent=\'clicked:\'+document.querySelector(\'input\').value;console.log(\'btn\')">Go</button><div id="out"></div><script>console.error(\'boom-fixture\');fetch(\'/missing\')</script></body></html>';

test('the browser tool drives Chrome inside an agent turn', { skip: chrome ? false : 'no Chrome/Chromium installed' }, async (t) => {
  const server = http.createServer((req, res) => { if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); } else { res.statusCode = 404; res.end('no'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = 'http://localhost:' + server.address().port + '/';
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-browser-'));
  const env = { ...process.env, HOME: root, OASIS_CHROME_HEADLESS: '1' };
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const { config, requests } = await scriptedModel(t, [
    toolCall('n', 'browser', { action: 'navigate', url }),
    toolCall('s', 'browser', { action: 'snapshot' }),
    toolCall('ty', 'browser', { action: 'type', ref: 1, text: 'cats' }),
    toolCall('c', 'browser', { action: 'click', text: 'Go' }),
    toolCall('w', 'browser', { action: 'wait', text: 'clicked:cats' }),
    toolCall('co', 'browser', { action: 'console' }),
    toolCall('ne', 'browser', { action: 'network' }),
    toolCall('sh', 'browser', { action: 'screenshot' }),
    toolCall('ev', 'browser', { action: 'evaluate', expression: 'document.title' }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config: { ...config, maxSteps: 20 }, settings, env, chrome: true });
  t.after(() => closeSession(session));
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'browser'));
  const asked = [];
  await runAgentTurn(session, 'test the page', { env, approval: async (message) => { asked.push(message); return false; } });
  const tools = session.messages.filter((m) => m.role === 'tool');
  const byId = Object.fromEntries(tools.map((m) => [m.tool_call_id, m]));
  assert.match(byId.n.content, /"title":"Fixture"/);
  assert.match(byId.s.content, /"ref":1,"tag":"input","name":"Search"/);
  assert.match(byId.w.content, /"found":true/);
  assert.match(byId.co.content, /boom-fixture/);
  assert.match(byId.ne.content, /\/missing.*404|404.*\/missing/);
  assert.equal(byId.sh.images[0].mediaType, 'image/png');
  assert.match(byId.ev.content, /did not approve/);
  assert.equal(asked.length, 1, 'only page JavaScript asks; localhost navigation does not');
  assert.ok(requests.length >= 10);
  const off = await runBuiltinCommand('chrome', 'off', { session, sessionOptions: {}, env });
  assert.match(off.output, /off/);
  assert.equal(session.browserState, null);
  assert.ok(!session.toolDefinitions.some((tool) => tool.function.name === 'browser'));
});
