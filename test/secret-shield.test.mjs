import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maskSecrets, unmaskSecrets } from '../src/secret-shield.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const OPENAI = 'sk-proj-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0';

test('masks token formats, secret assignments, and URL passwords', () => {
  const session = {};
  const input = [
    'OPENAI_API_KEY=' + OPENAI,
    'export GITHUB_TOKEN="' + GH + '"',
    'DB_PASSWORD=correct-horse-battery',
    'DATABASE_URL=postgres://app:s3cretPass@db.internal:5432/app',
    'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
  ].join('\n');
  const { text, count } = maskSecrets(session, input);
  assert.ok(count >= 6, 'count=' + count);
  for (const secret of [OPENAI, GH, 'correct-horse-battery', 's3cretPass', 'AKIAABCDEFGHIJKLMNOP', 'MIIEow']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /OPENAI_API_KEY=«secret:[0-9a-f]{8}»/);
  assert.equal(unmaskSecrets(session, text), input, 'round trip restores every value');
});

test('leaves ordinary code and non-secret values alone', () => {
  const session = {};
  const code = [
    'const token = req.headers.authorization;',
    'API_KEY=${OPENAI_API_KEY}',
    'PASSWORD=changeme',
    'SECRET_TIMEOUT=30000',
    'apiKey: process.env.API_KEY',
    'TOKEN_LIMIT=4096'
  ].join('\n');
  assert.equal(maskSecrets(session, code).count, 0);
});

test('placeholders are stable and unmask deeply inside tool arguments', () => {
  const session = {};
  const first = maskSecrets(session, 'GITHUB_TOKEN=' + GH).text;
  const second = maskSecrets(session, 'token ' + GH).text;
  const id = first.match(/«secret:[0-9a-f]{8}»/)[0];
  assert.ok(second.includes(id));
  assert.deepEqual(unmaskSecrets(session, { args: ['--token', id], nested: { v: 'x' + id } }), { args: ['--token', GH], nested: { v: 'x' + GH } });
  assert.equal(unmaskSecrets({}, 'keep «secret:deadbeef»'), 'keep «secret:deadbeef»');
});

test('secrets never reach the model, yet the agent can still edit the file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-shield-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'deploy.ini'), 'GITHUB_TOKEN=' + GH + '\nPORT=3000\n');
  const bodies = [];
  let placeholder = '';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    bodies.push(body);
    const step = bodies.length;
    let message;
    if (step === 1) message = { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"deploy.ini"}' } }] };
    else if (step === 2) {
      placeholder = (body.match(/«secret:[0-9a-f]{8}»/) || [''])[0];
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'e1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'deploy.ini', old_string: 'GITHUB_TOKEN=' + placeholder + '\nPORT=3000', new_string: 'GITHUB_TOKEN=' + placeholder + '\nPORT=8080' }) } }] };
    } else message = { role: 'assistant', content: 'Changed the port.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 } });
  await runAgentTurn(session, 'Change the port to 8080.', { autoApprove: true });
  assert.ok(placeholder, 'model saw a placeholder');
  for (const body of bodies) assert.ok(!body.includes(GH), 'real token must never be sent to the provider');
  assert.equal(await readFile(path.join(root, 'deploy.ini'), 'utf8'), 'GITHUB_TOKEN=' + GH + '\nPORT=8080\n');
  assert.ok(!JSON.stringify(session.messages).includes(GH), 'transcript holds placeholders only');
});
