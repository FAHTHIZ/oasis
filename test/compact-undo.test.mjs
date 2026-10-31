import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runBuiltinCommand } from '../src/slash.mjs';
import { PermissionPolicy } from '../src/permissions.mjs';

test('/compact undo restores the full history and keeps messages added since', async (t) => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'SUMMARY' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-undo-'));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const session = {
    root, sessionId: randomUUID(),
    config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '' },
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Fix src/api.ts' },
      { role: 'assistant', content: 'Detail that the summary would lose.' }
    ],
    mustPreserve: [], permissions: new PermissionPolicy({ permissions: {} }), hooks: {}
  };
  const original = JSON.parse(JSON.stringify(session.messages));
  const state = { root, env, session, sessionOptions: {} };
  assert.match((await runBuiltinCommand('compact', 'undo', state)).output, /no compaction to undo/);
  await runBuiltinCommand('compact', '', state);
  const done = await runBuiltinCommand('compact', 'confirm', state);
  assert.match(done.output, /compact undo/);
  assert.match(JSON.stringify(session.messages), /SUMMARY/);
  assert.doesNotMatch(JSON.stringify(session.messages), /would lose/);
  session.messages.push({ role: 'user', content: 'new question' });
  const undone = await runBuiltinCommand('compact', 'undo', state);
  assert.match(undone.output, /Restored the full history[\s\S]*1 added since/);
  assert.deepEqual(session.messages, [...original, { role: 'user', content: 'new question' }]);
  assert.match((await runBuiltinCommand('compact', 'undo', state)).output, /no compaction to undo/);
});
