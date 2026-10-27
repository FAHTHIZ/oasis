import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-web-test-'));
}

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
  assert.equal(statusBody.workspacePath, root);
  assert.equal(statusBody.workspaceName, path.basename(root));
  assert.equal('apiKey' in statusBody, false);

  const sessions = await fetch(base + '/api/sessions', { headers: auth });
  assert.equal(sessions.status, 200);
  assert.deepEqual((await sessions.json()).sessions, []);
});

test('provider setup stores local configuration without returning API credentials', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const saved = await fetch(base + '/api/provider/config', {
    method: 'POST', headers,
    body: JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:1234/v1', model: 'local-test-model', apiKey: '' })
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.saved, true);
  assert.equal(savedBody.provider.model, 'local-test-model');
  assert.equal('apiKey' in savedBody, false);

  const status = await fetch(base + '/api/status', { headers: { authorization: 'Bearer ' + app.token } });
  const statusBody = await status.json();
  assert.equal(statusBody.providerConfigured, true);
  assert.equal(statusBody.provider.model, 'local-test-model');
  assert.equal('apiKey' in statusBody, false);
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
