import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startOasisWebServer } from '../src/web.mjs';
import { saveSession, listSessions } from '../src/sessions.mjs';

test('DELETE /api/sessions/:id removes a saved chat behind the token', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-del-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const saved = await saveSession({ root, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hello' }], config: { model: 'x' } }, { env });
  const base = 'http://127.0.0.1:' + app.port;
  const url = base + '/api/sessions/' + saved.id;
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 401);
  assert.equal((await listSessions(root, { env })).length, 1);
  const response = await fetch(url, { method: 'DELETE', headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: saved.id, deleted: true });
  assert.equal((await listSessions(root, { env })).length, 0);
  assert.equal((await fetch(url, { method: 'DELETE', headers: { authorization: 'Bearer ' + token } })).status, 404);
});
