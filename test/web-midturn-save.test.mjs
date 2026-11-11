import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { listSessions, loadSession } from '../src/sessions.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// A browser task keeps finished steps on disk while it runs, so a server
// restart mid-task leaves a conversation that can be continued.
test('web task: finished tool steps are saved before the turn ends', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-midturn-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
  const saved = { OASIS_CONFIG_DIR: process.env.OASIS_CONFIG_DIR, HOME: process.env.HOME };
  Object.assign(process.env, { OASIS_CONFIG_DIR: env.OASIS_CONFIG_DIR, HOME: root });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await setWorkspaceTrust(root, true, env);
  await writeFile(path.join(root, 'notes.txt'), 'midturn marker 4242\n');
  let seenWhileRunning = null;
  const { config } = await scriptedModel(t, [
    toolCall('r1', 'read_file', { path: 'notes.txt' }),
    async (payload) => {
      // The second model request runs while the turn is still open: the
      // session on disk must already hold the read and its result.
      if (!payload.messages.some((m) => m.role === 'tool')) return { content: 'done' };
      for (let i = 0; i < 100 && !seenWhileRunning; i++) {
        for (const entry of await listSessions(root, { env })) {
          const loaded = await loadSession(root, entry.id, { env }).catch(() => null);
          const messages = loaded && (loaded.messages || loaded.session?.messages) || [];
          if (messages.some((m) => m.role === 'tool' && /midturn marker 4242/.test(String(m.content)))) seenWhileRunning = entry.id;
        }
        if (!seenWhileRunning) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { content: 'done' };
    }
  ]);
  await saveConfig(config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const started = await (await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'read notes.txt', mode: 'ask' }) })).json();
  let snapshot = { status: 'running', events: [] };
  let after = 0;
  for (let i = 0; i < 200 && !['completed', 'error', 'cancelled'].includes(snapshot.status); i++) {
    snapshot = await (await fetch(base + '/api/jobs/' + started.jobId + '?after=' + after + '&wait=5000', { headers })).json();
    for (const event of snapshot.events || []) after = Math.max(after, event.id);
  }
  assert.equal(snapshot.status, 'completed');
  assert.ok(seenWhileRunning, 'the session was saved mid-turn');
  assert.equal(seenWhileRunning, snapshot.result && snapshot.result.sessionId, 'the mid-turn save uses the task session id');
});
