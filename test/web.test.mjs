import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createOasisWebServer, startOasisWebServer } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-web-test-'));
}

test('network listeners require TLS unless unencrypted LAN access is explicitly acknowledged', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(
    () => createOasisWebServer({ root, host: '0.0.0.0', token: 'test-runtime-token-0123456789' }),
    /requires HTTPS.*allow-insecure-lan/i
  );
  assert.throws(
    () => createOasisWebServer({ root, host: '127.0.0.1', tlsCertFile: 'cert.pem', token: 'test-runtime-token-0123456789' }),
    /requires both.*tls-key/i
  );
  const explicitlyInsecure = createOasisWebServer({
    root, host: '0.0.0.0', allowInsecureLan: true, token: 'test-runtime-token-0123456789'
  });
  assert.equal(explicitlyInsecure.secure, false);
  await explicitlyInsecure.close();
});

test('HTTPS browser bridge serves authenticated API traffic and rejects an HTTP Origin downgrade', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const certPath = path.join(root, 'localhost-cert.pem');
  const keyPath = path.join(root, 'localhost-key.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'
    ], { stdio: 'ignore' });
    await chmod(keyPath, 0o600);
  } catch {
    t.skip('OpenSSL is required to generate an ephemeral TLS fixture for this test.');
    return;
  }
  const app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0,
    tlsCertFile: certPath, tlsKeyFile: keyPath,
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => app.close());
  assert.equal(app.secure, true);
  const origin = 'https://127.0.0.1:' + app.port;
  function getStatus(requestOrigin) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(origin + '/api/status', {
        rejectUnauthorized: false,
        headers: {
          authorization: 'Bearer ' + app.token,
          origin: requestOrigin
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  const allowed = await getStatus(origin);
  assert.equal(allowed.status, 200, allowed.body);
  assert.equal(JSON.parse(allowed.body).connected, true);
  const downgrade = await getStatus('http://127.0.0.1:' + app.port);
  assert.equal(downgrade.status, 421);
  assert.match(JSON.parse(downgrade.body).error, /same-origin/i);
});

test('browser runtime serves the app but requires a bearer token for every agent API', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="view-agent"/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  const anonymous = await fetch(base + '/api/status');
  assert.equal(anonymous.status, 401);
  assert.match((await anonymous.json()).error, /connection token/i);

  const auth = { authorization: 'Bearer ' + app.token };
  const status = await fetch(base + '/api/status', { headers: auth });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.connected, true);
  assert.equal(statusBody.providerConfigured, false);
  assert.equal(statusBody.approvalMode, 'per-action');
  assert.equal(statusBody.providerSetupAvailable, true);
  assert.equal(statusBody.workspacePath, root);
  assert.equal(statusBody.workspaceName, path.basename(root));
  assert.equal('apiKey' in statusBody, false);

  const sessions = await fetch(base + '/api/sessions', { headers: auth });
  assert.equal(sessions.status, 200);
  assert.deepEqual((await sessions.json()).sessions, []);
});

test('provider setup verifies a valid tool-call response before saving local configuration', async (t) => {
  const root = await tempDir();
  const providerServer = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-call', type: 'function', function: { name: 'oasis_connection_probe', arguments: '{\"ready\":true}' } }] } }] }));
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const providerPort = providerServer.address().port;
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const saved = await fetch(base + '/api/provider/config', {
    method: 'POST', headers,
    body: JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + providerPort + '/v1', model: 'local-test-model', apiKey: '' })
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.saved, true);
  assert.equal(savedBody.verified, true);
  assert.equal(savedBody.provider.model, 'local-test-model');
  assert.equal('apiKey' in savedBody, false);

  const status = await fetch(base + '/api/status', { headers: { authorization: 'Bearer ' + app.token } });
  const statusBody = await status.json();
  assert.equal(statusBody.providerConfigured, true);
  assert.equal(statusBody.providerSetupAvailable, true);
  assert.equal(statusBody.provider.model, 'local-test-model');
  assert.equal('apiKey' in statusBody, false);
});

test('provider setup does not persist credentials when the provider fails verification', async (t) => {
  const root = await tempDir();
  const providerServer = createServer((req, res) => {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture unauthorized' } }));
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const providerPort = providerServer.address().port;
  const configDir = path.join(root, 'config');
  const app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0,
    env: { OASIS_CONFIG_DIR: configDir },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch('http://127.0.0.1:' + app.port + '/api/provider/config', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: 'openai-compatible',
      baseURL: 'http://127.0.0.1:' + providerPort + '/v1',
      model: 'local-test-model',
      apiKey: 'not-saved-key'
    })
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.saved, false);
  assert.equal(body.verified, false);
  assert.doesNotMatch(body.error, /not-saved-key/);
  await assert.rejects(readFile(path.join(configDir, 'config.json')), { code: 'ENOENT' });
});

test('provider setup requires credentials for remote providers and rejects invalid protocols', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const missingKey = await fetch(base + '/api/provider/config', {
    method: 'POST', headers,
    body: JSON.stringify({ protocol: 'openai-compatible', baseURL: 'https://api.example.test/v1', model: 'test-model', apiKey: '' })
  });
  assert.equal(missingKey.status, 400);
  assert.match((await missingKey.json()).error, /API key/i);

  const invalidProtocol = await fetch(base + '/api/provider/config', {
    method: 'POST', headers,
    body: JSON.stringify({ protocol: 'unknown-provider', baseURL: 'https://api.example.test/v1', model: 'test-model', apiKey: 'not-used' })
  });
  assert.equal(invalidProtocol.status, 400);
  assert.match((await invalidProtocol.json()).error, /protocol/i);
});

test('GitHub workspace routes validate repository input before starting external commands', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const malformed = await fetch(base + '/api/github/clone', {
    method: 'POST', headers,
    body: JSON.stringify({ repository: '../../outside' })
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /owner\/name/i);

  const reset = await fetch(base + '/api/workspace/reset', {
    method: 'POST', headers, body: JSON.stringify({})
  });
  assert.equal(reset.status, 200);
  const data = await reset.json();
  assert.equal(data.reset, true);
  assert.equal(data.workspacePath, root);
});

test('web runtime rejects cross-origin API access even with the runtime token', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch('http://127.0.0.1:' + app.port + '/api/status', {
    headers: { authorization: 'Bearer ' + app.token, origin: 'http://attacker.example' }
  });
  assert.equal(response.status, 421);
  assert.match((await response.json()).error, /same-origin/i);
});

test('web runtime validates message sizes and approval decisions before queueing work', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch('http://127.0.0.1:' + app.port + '/api/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '' })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /enter a task/i);

  const unconfigured = await fetch('http://127.0.0.1:' + app.port + '/api/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Inspect this project and summarize it.' })
  });
  assert.equal(unconfigured.status, 503);
  assert.match((await unconfigured.json()).error, /oasis setup/i);
});

test('web terminal runner executes an approved command and captures its output', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const start = await fetch(base + '/api/terminal/command', {
    method: 'POST', headers, body: JSON.stringify({ command: process.execPath, args: ['--version'] })
  });
  assert.equal(start.status, 202);
  const { jobId } = await start.json();
  let approval = null;
  let snapshot;
  for (let i = 0; i < 60 && !approval; i++) {
    const response = await fetch(base + '/api/jobs/' + jobId, { headers: { authorization: 'Bearer ' + app.token } });
    snapshot = await response.json();
    approval = snapshot.events.find((event) => event.type === 'approval_required') || null;
    if (!approval) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(approval, 'the command must wait for an approval decision');

  const allowed = await fetch(base + '/api/jobs/' + jobId + '/approval', {
    method: 'POST', headers,
    body: JSON.stringify({ approvalId: approval.data.approvalId, approved: true })
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).approved, true);

  for (let i = 0; i < 80; i++) {
    const response = await fetch(base + '/api/jobs/' + jobId, { headers: { authorization: 'Bearer ' + app.token } });
    snapshot = await response.json();
    if (snapshot.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.result.approved, true);
  assert.equal(snapshot.result.exitCode, 0);
  assert.ok(snapshot.events.some((event) => event.type === 'terminal_output' && event.data.output.includes(process.versions.node)));
});

test('web terminal runner pauses for an explicit approval before starting a command', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const start = await fetch(base + '/api/terminal/command', {
    method: 'POST', headers, body: JSON.stringify({ command: 'node', args: ['--version'] })
  });
  assert.equal(start.status, 202);
  const { jobId } = await start.json();
  let approval = null;
  for (let i = 0; i < 40 && !approval; i++) {
    const response = await fetch(base + '/api/jobs/' + jobId, { headers: { authorization: 'Bearer ' + app.token } });
    const snapshot = await response.json();
    approval = snapshot.events.find((event) => event.type === 'approval_required') || null;
    if (!approval) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(approval, 'the command must wait for a browser approval decision');
  const denied = await fetch(base + '/api/jobs/' + jobId + '/approval', {
    method: 'POST', headers,
    body: JSON.stringify({ approvalId: approval.data.approvalId, approved: false })
  });
  assert.equal(denied.status, 200);
  assert.equal((await denied.json()).approved, false);

  let finalState;
  for (let i = 0; i < 40; i++) {
    const response = await fetch(base + '/api/jobs/' + jobId, { headers: { authorization: 'Bearer ' + app.token } });
    finalState = await response.json();
    if (finalState.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(finalState.status, 'completed');
  assert.equal(finalState.result.approved, false);
  assert.ok(finalState.events.some((event) => event.type === 'terminal_output' && event.data.approved === false));
});



test('browser chat runs a model tool call through approval and completes the same job', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  let providerRequests = 0;
  let receivedToolResult = false;
  const providerServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const payload = JSON.parse(raw);
    providerRequests++;
    if (providerRequests > 1) {
      const toolResult = (payload.messages || []).find((message) => message.role === 'tool');
      receivedToolResult = Boolean(toolResult && String(toolResult.content || '').includes(process.versions.node));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (providerRequests === 1) {
      res.end(JSON.stringify({ choices: [{ message: {
        role: 'assistant',
        content: 'I will run the Node.js version check after approval.',
        tool_calls: [{
          id: 'web-chat-node-version',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: JSON.stringify({
              command: process.execPath,
              args: ['--version'],
              timeoutSeconds: 10
            })
          }
        }]
      } }] }));
    } else {
      res.end(JSON.stringify({ choices: [{ message: {
        role: 'assistant',
        content: 'The Node.js version command completed successfully.'
      } }] }));
    }
  });
  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
    model: 'fixture-model',
    apiKey: ''
  }, { env });
  const app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0, env,
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const started = await fetch(base + '/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'Check the Node.js runtime version with the installed executable.' })
  });
  assert.equal(started.status, 202, await started.clone().text());
  const { jobId, sessionId } = await started.json();
  assert.ok(jobId);
  assert.ok(sessionId);

  let snapshot;
  let approval;
  const approvalDeadline = Date.now() + 5000;
  while (Date.now() < approvalDeadline && !approval) {
    const response = await fetch(base + '/api/jobs/' + jobId + '?after=0', {
      headers: { authorization: 'Bearer ' + app.token }
    });
    assert.equal(response.status, 200);
    snapshot = await response.json();
    approval = (snapshot.events || []).find((event) => event.type === 'approval_required') || null;
    if (!approval) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(approval, 'the agent tool call must ask the browser user for approval');
  assert.match(approval.data.prompt, /node|command/i);
  assert.equal(snapshot.status, 'waiting_approval');

  const approve = await fetch(base + '/api/jobs/' + jobId + '/approval', {
    method: 'POST',
    headers,
    body: JSON.stringify({ approvalId: approval.data.approvalId, approved: true })
  });
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).approved, true);

  const completionDeadline = Date.now() + 8000;
  while (Date.now() < completionDeadline) {
    const response = await fetch(base + '/api/jobs/' + jobId + '?after=0', {
      headers: { authorization: 'Bearer ' + app.token }
    });
    assert.equal(response.status, 200);
    snapshot = await response.json();
    if (['completed', 'error', 'cancelled'].includes(snapshot.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  assert.equal(snapshot.status, 'completed', snapshot.error || JSON.stringify(snapshot.result));
  assert.equal(snapshot.result.finished, true);
  assert.equal(snapshot.result.sessionId, sessionId);
  assert.equal(snapshot.result.toolCalls, 1);
  assert.ok(providerRequests >= 2);
  assert.equal(receivedToolResult, true, 'the model should receive the output from the approved command');
  assert.ok(snapshot.events.some((event) => event.type === 'assistant_delta'));
  assert.ok(snapshot.events.some((event) => event.type === 'tool_start' && event.data.name === 'run_command'));
  assert.ok(snapshot.events.some((event) => event.type === 'tool_result' && event.data.name === 'run_command'));
  assert.ok(snapshot.events.some((event) => event.type === 'completed'));
});


test('browser runtime rejects a 21st active job instead of exceeding its bounded job history', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const pendingResponses = [];
  let releaseResponses = false;
  const fixtureResponse = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fixture task completed.' } }] });
  const providerServer = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    if (releaseResponses) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixtureResponse);
    } else {
      pendingResponses.push(res);
    }
  });
  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
    model: 'fixture-model',
    apiKey: ''
  }, { env });
  const app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0, env,
    token: 'test-runtime-token-0123456789'
  });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const jobIds = [];
  const releaseProvider = () => {
    releaseResponses = true;
    for (const res of pendingResponses.splice(0)) {
      if (res.writableEnded) continue;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixtureResponse);
    }
  };
  const finishActiveJobs = async () => {
    const deadline = Date.now() + 5000;
    while (jobIds.length && Date.now() < deadline) {
      const snapshots = await Promise.all(jobIds.map(async (id) => {
        try {
          const response = await fetch(base + '/api/jobs/' + id + '?after=0', {
            headers: { authorization: 'Bearer ' + app.token }
          });
          return response.ok ? await response.json() : null;
        } catch { return null; }
      }));
      if (snapshots.every((snapshot) => snapshot && ['completed', 'error', 'cancelled'].includes(snapshot.status))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  t.after(async () => {
    releaseProvider();
    await finishActiveJobs();
    await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  for (let index = 0; index < 20; index++) {
    const response = await fetch(base + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Keep active capacity fixture ' + index + ' running.' })
    });
    assert.equal(response.status, 202, 'job ' + (index + 1) + ' should be admitted');
    const body = await response.json();
    assert.ok(body.jobId);
    jobIds.push(body.jobId);
  }

  const overflow = await fetch(base + '/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'This 21st active job must be rejected.' })
  });
  assert.equal(overflow.status, 429, await overflow.clone().text());
  assert.match((await overflow.json()).error, /20-job limit/i);

  const deadline = Date.now() + 5000;
  while (pendingResponses.length < 20 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pendingResponses.length, 20, 'all admitted jobs should reach the intentionally held provider response');
  releaseProvider();
  await finishActiveJobs();
});

test('browser runtime rejects a second concurrent request for the same saved session', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const pendingResponses = [];
  let holdResponses = false;
  const fixtureResponse = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fixture task completed.' } }] });
  const providerServer = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    if (holdResponses) pendingResponses.push(res);
    else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixtureResponse);
    }
  });
  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
    model: 'fixture-model',
    apiKey: ''
  }, { env });
  const app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0, env,
    token: 'test-runtime-token-0123456789'
  });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const jobIds = [];
  const releaseProvider = () => {
    holdResponses = false;
    for (const res of pendingResponses.splice(0)) {
      if (res.writableEnded) continue;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixtureResponse);
    }
  };
  const getSnapshot = async (jobId) => {
    const response = await fetch(base + '/api/jobs/' + jobId + '?after=0', {
      headers: { authorization: 'Bearer ' + app.token }
    });
    assert.equal(response.status, 200);
    return await response.json();
  };
  const waitForTerminalStatus = async (jobId) => {
    const deadline = Date.now() + 5000;
    let snapshot;
    while (Date.now() < deadline) {
      snapshot = await getSnapshot(jobId);
      if (['completed', 'error', 'cancelled'].includes(snapshot.status)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Job did not finish: ' + JSON.stringify(snapshot));
  };
  t.after(async () => {
    releaseProvider();
    await Promise.all(jobIds.map((jobId) => waitForTerminalStatus(jobId).catch(() => null)));
    await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const initial = await fetch(base + '/api/chat', {
    method: 'POST', headers,
    body: JSON.stringify({ message: 'Create a saved session for the concurrency check.' })
  });
  assert.equal(initial.status, 202, await initial.clone().text());
  const initialJob = await initial.json();
  jobIds.push(initialJob.jobId);
  const initialSnapshot = await waitForTerminalStatus(initialJob.jobId);
  assert.equal(initialSnapshot.status, 'completed', initialSnapshot.error || JSON.stringify(initialSnapshot.result));
  const savedSessionId = initialSnapshot.result.sessionId;
  assert.ok(savedSessionId);

  holdResponses = true;
  const requests = await Promise.all([
    fetch(base + '/api/chat', {
      method: 'POST', headers,
      body: JSON.stringify({ sessionId: savedSessionId, message: 'First message on the saved session.' })
    }),
    fetch(base + '/api/chat', {
      method: 'POST', headers,
      body: JSON.stringify({ sessionId: savedSessionId, message: 'Second message racing the first.' })
    })
  ]);
  const statuses = requests.map((response) => response.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [202, 409], 'exactly one request should own the saved session while it initializes');
  const acceptedIndex = requests.findIndex((response) => response.status === 202);
  const accepted = await requests[acceptedIndex].json();
  jobIds.push(accepted.jobId);
  assert.equal(accepted.sessionId, savedSessionId);

  const deadline = Date.now() + 5000;
  while (pendingResponses.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pendingResponses.length, 1, 'only the accepted request should reach the held provider response');
  releaseProvider();
  const finalSnapshot = await waitForTerminalStatus(accepted.jobId);
  assert.equal(finalSnapshot.status, 'completed', finalSnapshot.error || JSON.stringify(finalSnapshot.result));
});

test('extensions and MCP integration endpoints return safe inventories and require explicit API authentication', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.port;
  assert.equal((await fetch(base + '/api/extensions')).status, 401);
  assert.equal((await fetch(base + '/api/mcp')).status, 401);
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const extensions = await fetch(base + '/api/extensions', { headers });
  const extensionsText = await extensions.text();
  assert.equal(extensions.status, 200, 'Extension inventory failed: ' + extensionsText);
  assert.deepEqual(JSON.parse(extensionsText).extensions, []);
  const mcp = await fetch(base + '/api/mcp', { headers });
  assert.equal(mcp.status, 200);
  assert.deepEqual((await mcp.json()).servers, []);
  const badInspect = await fetch(base + '/api/extensions/inspect', {
    method: 'POST', headers, body: JSON.stringify({ url: 'https://github.com/acme/agents/tree/main' })
  });
  assert.equal(badInspect.status, 400);
  assert.match((await badInspect.json()).error, /repository home URL/i);
  const unreviewedInstall = await fetch(base + '/api/extensions/install', {
    method: 'POST', headers, body: JSON.stringify({ url: 'https://github.com/acme/agents', scope: 'project' })
  });
  assert.equal(unreviewedInstall.status, 400);
  assert.match((await unreviewedInstall.json()).error, /inspect the repository first/i);
  const invalidMcp = await fetch(base + '/api/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ servers: [{ name: 'bad', command: 'bash; curl', args: [], enabled: true }] })
  });
  assert.equal(invalidMcp.status, 400);
  assert.match((await invalidMcp.json()).error, /one executable path/i);
  const savedMcp = await fetch(base + '/api/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ servers: [{ name: 'review-server', command: 'node', args: ['server.mjs'], passEnv: ['REVIEW_API_KEY'], enabled: false }] })
  });
  assert.equal(savedMcp.status, 200);
  const savedBody = await savedMcp.json();
  assert.equal(savedBody.saved, true);
  assert.equal(savedBody.servers[0].name, 'review-server');
  assert.deepEqual(savedBody.servers[0].passEnv, ['REVIEW_API_KEY']);
  assert.equal(savedBody.servers[0].enabled, false);
});


test('GitHub MCP declarations can be imported only as disabled configurations without copying env secrets', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const commit = 'c'.repeat(40);
  const manifest = JSON.stringify({
    mcpServers: {
      'review-server': { command: 'node', args: ['server.mjs'], env: { API_TOKEN: 'do-not-leak-this-secret' } }
    }
  });
  const fetchImpl = async (rawUrl) => {
    const url = String(rawUrl);
    const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/vnd.github+json' } });
    if (url === 'https://api.github.com/repos/acme/mcp-extension') return response({
      full_name: 'acme/mcp-extension', name: 'mcp-extension', description: 'MCP test fixture',
      default_branch: 'main', private: false, license: { spdx_id: 'MIT' }
    });
    if (url === 'https://api.github.com/repos/acme/mcp-extension/commits/main') return response({ sha: commit });
    if (url === 'https://api.github.com/repos/acme/mcp-extension/git/trees/' + commit + '?recursive=1') return response({
      truncated: false, tree: [{ path: '.mcp.json', type: 'blob', mode: '100644', size: Buffer.byteLength(manifest), sha: '9'.repeat(40) }]
    });
    if (url === 'https://raw.githubusercontent.com/acme/mcp-extension/' + commit + '/.mcp.json') {
      return new Response(manifest, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    throw new Error('Unexpected fixture URL: ' + url);
  };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789', fetchImpl });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const inspectedResponse = await fetch(base + '/api/extensions/inspect', {
    method: 'POST', headers, body: JSON.stringify({ url: 'https://github.com/acme/mcp-extension' })
  });
  assert.equal(inspectedResponse.status, 200);
  const inspected = await inspectedResponse.json();
  assert.equal(inspected.mcpImportPlan.servers[0].name, 'review_server');
  assert.doesNotMatch(JSON.stringify(inspected), /do-not-leak-this-secret/);
  const importResponse = await fetch(base + '/api/extensions/mcp-import', {
    method: 'POST', headers,
    body: JSON.stringify({ url: 'https://github.com/acme/mcp-extension', expectedCommit: commit, serverNames: ['review_server'] })
  });
  assert.equal(importResponse.status, 200, await importResponse.clone().text());
  const imported = await importResponse.json();
  assert.equal(imported.imported[0].enabled, false);
  assert.doesNotMatch(JSON.stringify(imported), /do-not-leak-this-secret/);
  const config = await fetch(base + '/api/mcp', { headers });
  assert.equal(config.status, 200);
  const servers = (await config.json()).servers;
  assert.equal(servers.length, 1);
  assert.equal(servers[0].enabled, false);
  assert.deepEqual(servers[0].passEnv, []);
  assert.deepEqual(servers[0].origin, {
    repository: 'https://github.com/acme/mcp-extension',
    commitSha: commit,
    filePath: '.mcp.json'
  });
  const allowlistUpdate = await fetch(base + '/api/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ servers: servers.map((server) => ({ ...server, passEnv: ['API_TOKEN'] })) })
  });
  assert.equal(allowlistUpdate.status, 200);
  const allowlistResult = await allowlistUpdate.json();
  assert.deepEqual(allowlistResult.servers[0].passEnv, ['API_TOKEN']);
  assert.deepEqual(allowlistResult.servers[0].origin, servers[0].origin);
  const invalidOrigin = await fetch(base + '/api/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({ servers: [{ ...servers[0], origin: { repository: 'https://evil.example/attacker/repo', commitSha: commit, filePath: '.mcp.json' } }] })
  });
  assert.equal(invalidOrigin.status, 400);
  assert.match((await invalidOrigin.json()).error, /public GitHub repository/i);
  const duplicate = await fetch(base + '/api/extensions/mcp-import', {
    method: 'POST', headers,
    body: JSON.stringify({ url: 'https://github.com/acme/mcp-extension', expectedCommit: commit, serverNames: ['review_server'] })
  });
  assert.equal(duplicate.status, 409);
});

test('authenticated browser jobs can be cancelled while awaiting command approval', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const started = await fetch(base + '/api/terminal/command', {
    method: 'POST', headers,
    body: JSON.stringify({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'], timeoutSeconds: 30 })
  });
  assert.equal(started.status, 202);
  const { jobId } = await started.json();

  let approvalId = null;
  let snapshot;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !approvalId) {
    const response = await fetch(base + '/api/jobs/' + jobId + '?after=0', { headers });
    assert.equal(response.status, 200);
    snapshot = await response.json();
    const event = (snapshot.events || []).find((item) => item.type === 'approval_required');
    if (event) approvalId = event.data.approvalId;
    else await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(approvalId, 'The terminal command should request approval before spawning.');
  const approved = await fetch(base + '/api/jobs/' + jobId + '/approval', {
    method: 'POST', headers, body: JSON.stringify({ approvalId, approved: true })
  });
  assert.equal(approved.status, 200);

  const cancelled = await fetch(base + '/api/jobs/' + jobId + '/cancel', { method: 'POST', headers });
  assert.equal(cancelled.status, 202);
  assert.equal((await cancelled.json()).cancelRequested, true);

  const finishedBy = Date.now() + 5000;
  while (Date.now() < finishedBy) {
    const response = await fetch(base + '/api/jobs/' + jobId + '?after=0', { headers });
    assert.equal(response.status, 200);
    snapshot = await response.json();
    if (snapshot.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(snapshot.status, 'cancelled');
  assert.ok((snapshot.events || []).some((item) => item.type === 'cancel_requested'));
  assert.ok((snapshot.events || []).some((item) => item.type === 'cancelled'));
});

test('browser chat supports built-in slash commands, @file mentions, tool details, and session-wide "always allow"', async (t) => {
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
  await writeFile(path.join(root, 'NOTES.md'), 'remember the purple flag');
  const nodeVersion = toolCall('v1', 'run_command', { command: process.execPath, args: ['--version'], timeoutSeconds: 10 });
  const { config, requests } = await scriptedModel(t, [nodeVersion, { content: 'Done once.' }, { ...nodeVersion, tool_calls: [{ ...nodeVersion.tool_calls[0], id: 'v2' }] }, { content: 'Done twice.' }]);
  await saveConfig(config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  async function start(message, sessionId) {
    const response = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }) });
    assert.equal(response.status, 202, await response.clone().text());
    return await response.json();
  }
  async function waitFor(jobId, predicate) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const snapshot = await (await fetch(base + '/api/jobs/' + jobId + '?after=0', { headers })).json();
      if (predicate(snapshot)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('timed out waiting for job ' + jobId + ' ' + JSON.stringify((await (await fetch(base + '/api/jobs/' + jobId + '?after=0', { headers })).json()).events.map((e) => e.type + ':' + JSON.stringify(e.data).slice(0, 200))));
  }
  const done = (snapshot) => ['completed', 'error', 'cancelled'].includes(snapshot.status);

  const first = await start('Check node and read @NOTES.md');
  let snapshot = await waitFor(first.jobId, (s) => s.events.some((e) => e.type === 'approval_required') || done(s));
  const approval = snapshot.events.find((e) => e.type === 'approval_required');
  assert.ok(approval, JSON.stringify(snapshot));
  assert.ok(approval.data.suggestion, 'run_command approvals offer a session rule');
  assert.ok(snapshot.events.some((e) => e.type === 'context_files' && e.data.files.includes('NOTES.md')));
  assert.match(requests[0].messages.at(-1).content, /purple flag/);
  const tool = snapshot.events.find((e) => e.type === 'tool_start');
  assert.match(tool.data.detail, /--version/);
  const answered = await fetch(base + '/api/jobs/' + first.jobId + '/approval', { method: 'POST', headers, body: JSON.stringify({ approvalId: approval.data.approvalId, approved: true, always: true }) });
  assert.equal((await answered.json()).always, true);
  snapshot = await waitFor(first.jobId, done);
  assert.equal(snapshot.status, 'completed', snapshot.error);

  const second = await start('Check node again', snapshot.result.sessionId);
  snapshot = await waitFor(second.jobId, done);
  assert.equal(snapshot.status, 'completed', snapshot.error);
  assert.equal(snapshot.events.some((e) => e.type === 'approval_required'), false, 'the session rule skips the second approval');

  const cost = await start('/cost', snapshot.result.sessionId);
  snapshot = await waitFor(cost.jobId, done);
  assert.equal(snapshot.status, 'completed', snapshot.error);
  const output = snapshot.events.find((e) => e.type === 'command_output');
  assert.equal(output.data.command, 'cost');
  assert.match(output.data.text, /token/i);
  assert.equal(requests.length, 4, '/cost must not call the model');
});
