import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, compactHistoryIfNeeded } from '../src/agent.mjs';

test('a hung summary request falls back to a local summary within the compaction deadline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-compact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sockets = new Set();
  const server = createServer(() => { /* never answers */ });
  server.on('connection', (socket) => { sockets.add(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '' } });
  for (let i = 0; i < 6; i++) {
    session.messages.push({ role: 'user', content: 'Please change file ' + i });
    session.messages.push({ role: 'assistant', content: 'Changed src/file' + i + '.js' });
  }
  const starts = [];
  const errors = [];
  const begin = Date.now();
  const result = await compactHistoryIfNeeded(session, {
    force: true,
    persistSessionNotes: false,
    env: { ...process.env, OASIS_COMPACT_TIMEOUT_SECONDS: '1' },
    onCompactionStart: (info) => starts.push(info),
    onCompactionError: (error) => errors.push(error.message)
  });
  const elapsed = Date.now() - begin;
  assert.equal(result.compacted, true);
  assert.ok(elapsed < 8000, 'finished in ' + elapsed + 'ms');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].timeoutSeconds, 1);
  assert.match(errors.join('\n'), /longer than 1s; used a local summary/);
  assert.match(session.messages[1].content, /Context digest/);
});
