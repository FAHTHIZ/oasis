import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

test('the steer endpoint validates the job, the message, and the token', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-steer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, token });
  t.after(() => app.close());
  const url = 'http://127.0.0.1:' + app.port + '/api/jobs/00000000-0000-4000-8000-000000000000/steer';
  const post = (body, auth = true) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ message: 'hi' }, false)).status, 401);
  assert.equal((await post({ message: 'hi' })).status, 404);
});
