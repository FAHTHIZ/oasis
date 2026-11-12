import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import '../src/tools.mjs';
import { findChrome } from '../src/cdp.mjs';
import { addFrame, newRecording, recordingHtml, stepCaption, MAX_FRAMES } from '../src/browser-recording.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const chrome = findChrome(process.env);

test('captions never include typed text', () => {
  assert.equal(stepCaption('type', { text: 'hunter2', submit: true }), 'Typed 7 characters and submitted');
  assert.equal(stepCaption('navigate', { url: 'http://a.test/' }, { url: 'http://a.test/home' }), 'Opened http://a.test/home');
});

test('long recordings thin the middle and keep both ends', async () => {
  const recording = newRecording();
  for (let i = 0; i < MAX_FRAMES + 40; i += 1) await addFrame(recording, 'step ' + i, async () => ({ data: 'AAAA', url: '' }));
  assert.ok(recording.frames.length <= MAX_FRAMES);
  assert.equal(recording.frames[0].caption, 'step 0');
  assert.equal(recording.frames.at(-1).caption, 'step ' + (MAX_FRAMES + 39));
  assert.ok(recording.dropped > 0);
});

test('the player is self-contained and escapes captions', () => {
  const recording = newRecording();
  recording.frames.push({ at: recording.startedAt, caption: '</script><b>x', url: 'http://a.test', data: 'AAAA' });
  const html = recordingHtml(recording, { title: '<Demo>' });
  assert.match(html, /<title>&lt;Demo&gt;<\/title>/);
  assert.doesNotMatch(html, /<\/script><b>/);
  assert.match(html, /default-src 'none'/);
});

test('the browser tool records steps and saves a replay', { skip: chrome ? false : 'no Chrome/Chromium installed' }, async (t) => {
  const page = '<html><head><title>Rec</title></head><body><input placeholder="Name"><button onclick="document.title=\'done\'">Go</button></body></html>';
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = 'http://localhost:' + server.address().port + '/';
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, OASIS_CHROME_HEADLESS: '1', OASIS_CHROME_PATH: chrome };
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const { config } = await scriptedModel(t, [
    toolCall('n', 'browser', { action: 'navigate', url }),
    toolCall('ty', 'browser', { action: 'type', selector: 'input', text: 'secret-words' }),
    toolCall('c', 'browser', { action: 'click', text: 'Go' }),
    toolCall('r', 'browser', { action: 'recording' }),
    toolCall('n2', 'browser', { action: 'navigate', url: url + '?again' }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config: { ...config, maxSteps: 20 }, settings, env, chrome: true });
  await runAgentTurn(session, 'record', { env, approval: async () => false });
  const tools = Object.fromEntries(session.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
  const saved = JSON.parse(tools.r.content).recording;
  assert.match(saved, /^\.oasis[\\/]recordings[\\/]browser-.*\.html$/);
  const html = await readFile(path.join(root, saved), 'utf8');
  assert.match(html, /Typed 12 characters/);
  assert.doesNotMatch(html, /secret-words/);
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 3);
  // Closing saves the steps after the last save.
  await closeSession(session);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const files = await readdir(path.join(root, '.oasis', 'recordings'));
  assert.equal(files.length, 2, "closing saved the steps after the last save");
});
