import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

test('closing the browser server does not wait on a client that keeps its socket open', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, token: 'test-runtime-token-0123456789' });

  // A raw socket that sends a partial request and never finishes it, like a
  // stalled browser tab or a long-lived event stream.
  const socket = net.connect(app.port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  socket.on('error', () => {});
  t.after(() => socket.destroy());

  const started = Date.now();
  await Promise.race([
    app.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('close() hung')), 8000).unref())
  ]);
  assert.ok(Date.now() - started < 8000);
});
