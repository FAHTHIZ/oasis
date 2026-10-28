import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import '../src/tools.mjs';
import { findChrome } from '../src/cdp.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const chrome = findChrome(process.env);
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
