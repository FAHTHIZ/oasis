import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { setPreset } from '../src/presets.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

// /presets N in the browser: a saved prompt becomes the turn, and a saved
// built-in /command runs once.
test('web: /presets N sends the saved prompt or runs the saved command', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-presets-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
  const saved = { OASIS_CONFIG_DIR: process.env.OASIS_CONFIG_DIR, HOME: process.env.HOME };
  Object.assign(process.env, { OASIS_CONFIG_DIR: env.OASIS_CONFIG_DIR, HOME: root });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await setWorkspaceTrust(root, true, env);
  const model = await scriptedModel(t, [{ content: 'Here is the summary.' }]);
  await saveConfig(model.config, { env });
  await setPreset(1, 'Summarize this project in one line', env);
  await setPreset(2, '/cost', env);
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const finish = async (message) => {
    const started = await (await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message, mode: 'ask' }) })).json();
    let after = 0; let snapshot; const events = [];
    for (let i = 0; i < 200; i++) {
      snapshot = await (await fetch(base + '/api/jobs/' + started.jobId + '?after=' + after + '&wait=10000', { headers })).json();
      for (const event of snapshot.events) { after = Math.max(after, event.id); events.push(event); }
      if (['completed', 'error'].includes(snapshot.status)) break;
    }
    return { snapshot, events };
  };
  const ran = await finish('/presets 2');
  assert.equal(ran.snapshot.status, 'completed');
  const output = ran.events.find((event) => event.type === 'command_output').data.text;
  assert.match(output, /Preset 2: \/cost/);
  assert.match(output, /Session usage/);
  const sent = await finish('/presets 1');
  assert.equal(sent.snapshot.status, 'completed');
  assert.match(String(sent.snapshot.result && sent.snapshot.result.text || ''), /Here is the summary/);
  const asked = model.requests.at(-1).messages.filter((item) => item.role === 'user').map((item) => item.content).join('\n');
  assert.match(asked, /Summarize this project in one line/);
});
