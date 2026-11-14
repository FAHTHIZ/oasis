import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer, MAX_CHAT_MESSAGE_CHARS } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

// A pasted log easily passes 12,000 characters, which the browser app cut
// and the runtime refused.
test('web: a 60,000-character pasted log reaches the model whole', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-long-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
  const saved = { OASIS_CONFIG_DIR: process.env.OASIS_CONFIG_DIR, HOME: process.env.HOME };
  Object.assign(process.env, { OASIS_CONFIG_DIR: env.OASIS_CONFIG_DIR, HOME: root });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await setWorkspaceTrust(root, true, env);
  const model = await scriptedModel(t, [{ content: 'Read the log.' }]);
  await saveConfig(model.config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const log = 'Why does this fail?\n' + Array.from({ length: 1200 }, (_, i) => 'ERROR at frame ' + i + ' in module/path/file.js:42').join('\n') + '\nLOG-END';
  assert.ok(log.length > 40000);
  const response = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: log, mode: 'ask' }) });
  assert.equal(response.status, 202, await response.clone().text());
  const started = await response.json();
  let snapshot;
  let after = 0;
  for (let i = 0; i < 200; i++) {
    snapshot = await (await fetch(base + '/api/jobs/' + started.jobId + '?after=' + after + '&wait=10000', { headers })).json();
    for (const event of snapshot.events) after = Math.max(after, event.id);
    if (['completed', 'error'].includes(snapshot.status)) break;
  }
  assert.equal(snapshot.status, 'completed');
  const asked = model.requests.at(-1).messages.filter((item) => item.role === 'user').map((item) => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n');
  assert.match(asked, /LOG-END/);
  const tooLong = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'x'.repeat(MAX_CHAT_MESSAGE_CHARS + 1), mode: 'ask' }) });
  assert.equal(tooLong.status, 413);
});
