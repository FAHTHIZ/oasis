import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createOasisWebServer, startOasisWebServer, toolDetail, summarizeToolResult, summarizeAgentRun } from '../src/web.mjs';
import { saveConfig } from '../src/config.mjs';

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-web-test-'));
}

test('browser activity details and tool results redact credential values before sending them to the UI', () => {
  assert.equal(
    toolDetail('run_command', { command: 'node', args: ['--token', 'super-secret-value'] }),
    'node --token [redacted]'
  );
  assert.equal(
    toolDetail('run_command', { command: 'node', args: ['--api-key=private-value'] }),
    'node --api-key=[redacted]'
  );
  assert.doesNotMatch(
    toolDetail('run_shell', { command: 'curl https://example.test/run?access_token=abc123' }),
    /abc123/
  );
  const summarized = summarizeToolResult({ output: 'request failed for apiKey=private-value', nested: { token: 'another-private-value' } });
  assert.doesNotMatch(summarized, /private-value|another-private-value/);
  assert.match(summarized, /\[redacted\]/);
});


test('agent run monitor derives worker lifecycle and redacts activity detail', () => {
  const job = {
    id: '4ee8f9f0-c654-4c1d-9678-31a75eaa4402',
    title: 'Refactor and test provider setup',
    type: 'agent',
    status: 'completed',
    createdAt: '2026-10-29T10:00:00.000Z',
    workspaceName: 'oasis',
    worktreeBranch: 'oasis/provider-setup',
    worktreePath: '.oasis/worktrees/provider-setup',
    worktreeBaseCommit: 'a'.repeat(40),
    events: [
      { id: 1, type: 'agent_activity', at: '2026-10-29T10:00:01.000Z', data: { id: 1, at: '2026-10-29T10:00:01.000Z', type: 'team.created', team_id: 'team_1', description: 'Quality team', detail: 'Review current setup' } },
      { id: 2, type: 'agent_activity', at: '2026-10-29T10:00:02.000Z', data: { id: 2, at: '2026-10-29T10:00:02.000Z', type: 'agent.started', run_id: '4ee8f9f0-c654-4c1d-9678-31a75eaa4402', agent_id: 'agent_1', team_id: 'team_1', description: 'Inspect configuration' } },
      { id: 3, type: 'agent_activity', at: '2026-10-29T10:00:03.000Z', data: { id: 3, at: '2026-10-29T10:00:03.000Z', type: 'task.dispatched', agent_id: 'agent_1', team_id: 'team_1', description: 'task_2', detail: 'Add tests' } },
      { id: 4, type: 'agent_activity', at: '2026-10-29T10:00:04.000Z', data: { id: 4, at: '2026-10-29T10:00:04.000Z', type: 'agent.completed', agent_id: 'agent_1', team_id: 'team_1', description: 'Inspect configuration', detail: 'apiKey=private-value' } },
      { id: 5, type: 'approval_required', at: '2026-10-29T10:00:05.000Z', data: { prompt: 'Never expose private-prompt-text' } },
      { id: 6, type: 'approval_resolved', at: '2026-10-29T10:00:06.000Z', data: { approved: false } },
      { id: 7, type: 'usage', at: '2026-10-29T10:00:07.000Z', data: { totalTokens: 42 } },
      { id: 8, type: 'worktree_ready', at: '2026-10-29T10:00:08.000Z', data: { branch: 'oasis/provider-setup', baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', changed: true } }
    ]
  };
  const view = summarizeAgentRun(job);
  assert.equal(view.id, job.id);
  assert.equal(view.workerCount, 1);
  assert.equal(view.runningWorkers, 0);
  assert.equal(view.workers[0].status, 'completed');
  assert.equal(view.workers[0].taskId, 'task_2');
  assert.equal(view.teamCount, 1);
  assert.equal(view.teams[0].name, 'Quality team');
  assert.equal(view.branch, 'oasis/provider-setup');
  assert.equal(view.worktreePath, '.oasis/worktrees/provider-setup');
  assert.equal(view.baseCommit, 'a'.repeat(40));
  assert.deepEqual(view.approvals, { requested: 1, resolved: 1, approved: 0, denied: 1, pending: 0, interrupted: 0 });
  assert.equal(view.usage.totalTokens, 42);
  assert.ok(view.events.some((event) => event.type === 'run.approval_resolved' && event.description === 'Action denied'));
  assert.ok(view.events.some((event) => event.type === 'run.worktree_ready' && /oasis\/provider-setup/.test(event.detail)));
  assert.doesNotMatch(JSON.stringify(view), /private-value|Never expose private-prompt-text/);
  assert.equal(summarizeAgentRun(null), null);
});

test('agent run monitor marks workers and approvals interrupted after runtime restart', () => {
  const job = {
    id: '4ee8f9f0-c654-4c1d-9678-31a75eaa4403',
    title: 'Run integration tests',
    type: 'agent',
    status: 'interrupted',
    createdAt: '2026-10-29T10:20:00.000Z',
    updatedAt: '2026-10-29T10:20:05.000Z',
    workspaceName: 'oasis',
    events: [
      { id: 1, type: 'agent_activity', at: '2026-10-29T10:20:01.000Z', data: { id: 1, at: '2026-10-29T10:20:01.000Z', type: 'team.created', team_id: 'team_2', description: 'Test team' } },
      { id: 2, type: 'agent_activity', at: '2026-10-29T10:20:02.000Z', data: { id: 2, at: '2026-10-29T10:20:02.000Z', type: 'agent.started', agent_id: 'agent_2', team_id: 'team_2', description: 'Run test suite' } },
      { id: 3, type: 'approval_required', at: '2026-10-29T10:20:03.000Z', data: { prompt: 'Do not expose private approval prompt' } },
      { id: 4, type: 'interrupted', at: '2026-10-29T10:20:05.000Z', data: { message: 'Runtime stopped before task completion; live processes and pending approvals were not restored.' } }
    ]
  };
  const view = summarizeAgentRun(job);
  assert.equal(view.status, 'interrupted');
  assert.equal(view.runningWorkers, 0);
  assert.equal(view.workers[0].status, 'interrupted');
  assert.equal(view.workers[0].detail, 'The runtime restarted; this worker process was not restored.');
  assert.equal(view.teams[0].status, 'interrupted');
  assert.deepEqual(view.approvals, { requested: 1, resolved: 0, approved: 0, denied: 0, pending: 0, interrupted: 1 });
  assert.ok(view.events.some((event) => event.type === 'run.interrupted' && event.description === 'Runtime restarted'));
  assert.doesNotMatch(JSON.stringify(view), /Do not expose private approval prompt/);
});
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
  const homeHtml = await home.text();
  assert.match(homeHtml, /id="view-agent"/);
  assert.match(homeHtml, /id="view-monitor"/, 'the authenticated workspace includes the run monitor view');
  assert.match(homeHtml, /id="agentMonitorRefreshBtn"/);
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

  const anonymousMonitor = await fetch(base + '/api/agent-monitor');
  assert.equal(anonymousMonitor.status, 401, 'the run monitor must use the same bearer-token boundary as other APIs');
  const monitorResponse = await fetch(base + '/api/agent-monitor', { headers: auth });
  assert.equal(monitorResponse.status, 200);
  assert.deepEqual((await monitorResponse.json()).runs, []);

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


test('browser runtime rejects overlapping mutating jobs before workspace capacity can be exceeded', async (t) => {
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
  let jobId = null;
  const releaseProvider = () => {
    releaseResponses = true;
    for (const res of pendingResponses.splice(0)) {
      if (res.writableEnded) continue;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixtureResponse);
    }
  };
  const finishActiveJob = async () => {
    if (!jobId) return;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(base + '/api/jobs/' + jobId + '?after=0', {
          headers: { authorization: 'Bearer ' + app.token }
        });
        const snapshot = response.ok ? await response.json() : null;
        if (snapshot && ['completed', 'error', 'cancelled'].includes(snapshot.status)) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  t.after(async () => {
    releaseProvider();
    await finishActiveJob();
    await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const first = await fetch(base + '/api/chat', {
    method: 'POST', headers,
    body: JSON.stringify({ message: 'Keep the first mutating task active while testing workspace locking.' })
  });
  assert.equal(first.status, 202, await first.clone().text());
  jobId = (await first.json()).jobId;
  assert.ok(jobId);

  const deadline = Date.now() + 5000;
  while (pendingResponses.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pendingResponses.length, 1, 'the first task must be waiting on the held provider response');

  for (let index = 0; index < 20; index++) {
    const response = await fetch(base + '/api/chat', {
      method: 'POST', headers,
      body: JSON.stringify({ message: 'Overlapping task ' + index + ' must be rejected.' })
    });
    assert.equal(response.status, 409, await response.clone().text());
    assert.match((await response.json()).error, /workspace already has an active task/i);
  }
  assert.equal(pendingResponses.length, 1, 'rejected tasks must not reach the provider');

  releaseProvider();
  await finishActiveJob();
  const final = await (await fetch(base + '/api/jobs/' + jobId, { headers: { authorization: 'Bearer ' + app.token } })).json();
  assert.equal(final.status, 'completed', JSON.stringify(final));
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
  const state = snapshot.events.find((e) => e.type === 'session_state');
  assert.ok(state && state.data.contextWindow > 0 && state.data.totalTokens >= 15, JSON.stringify(state));

  const listing = await (await fetch(base + '/api/sessions', { headers })).json();
  assert.match(listing.sessions[0].title, /^Check node and read @NOTES\.md/);
  const plan = await start('/mode plan', snapshot.result.sessionId);
  snapshot = await waitFor(plan.jobId, done);
  assert.equal(snapshot.events.find((e) => e.type === 'session_state').data.mode, 'plan');
  const bypass = await start('/mode bypassPermissions', snapshot.result.sessionId);
  snapshot = await waitFor(bypass.jobId, done);
  assert.match(snapshot.events.find((e) => e.type === 'command_output').data.text, /only in the terminal/);
  assert.equal(snapshot.events.find((e) => e.type === 'session_state').data.mode, 'plan');
});

test('browser chat answers ask_user_question cards and the model sees the answer', async (t) => {
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root };
  const ask = toolCall('q1', 'ask_user_question', { question: 'Which database?', header: 'Database', options: [{ label: 'SQLite', description: 'Simple file' }, { label: 'Postgres' }] });
  const { config, requests } = await scriptedModel(t, [ask, (payload) => ({ content: 'Going with ' + JSON.parse(payload.messages.at(-1).content).answer })]);
  await saveConfig(config, { env });
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const started = await (await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ message: 'set up storage' }) })).json();
  let snapshot;
  for (let i = 0; i < 300; i++) {
    snapshot = await (await fetch(base + '/api/jobs/' + started.jobId + '?after=0', { headers })).json();
    if (snapshot.events.some((e) => e.type === 'question')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const question = snapshot.events.find((e) => e.type === 'question').data;
  assert.equal(question.question, 'Which database?');
  assert.deepEqual(question.options.map((o) => o.label), ['SQLite', 'Postgres']);
  assert.equal(snapshot.status, 'waiting_approval');
  const wrong = await fetch(base + '/api/jobs/' + started.jobId + '/approval', { method: 'POST', headers, body: JSON.stringify({ approvalId: question.questionId, approved: true }) });
  assert.equal(wrong.status, 404, 'questions cannot be resolved through the approval endpoint');
  const answered = await fetch(base + '/api/jobs/' + started.jobId + '/answer', { method: 'POST', headers, body: JSON.stringify({ questionId: question.questionId, answer: 'Postgres' }) });
  assert.equal(answered.status, 200);
  for (let i = 0; i < 300; i++) {
    snapshot = await (await fetch(base + '/api/jobs/' + started.jobId + '?after=0', { headers })).json();
    if (snapshot.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(snapshot.result.text, 'Going with Postgres');
  assert.equal(requests.length, 2);
});


test('browser job history API lists persisted tasks and requires authentication', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const denied = await fetch(base + '/api/jobs');
  assert.equal(denied.status, 401);
  const response = await fetch(base + '/api/jobs', { headers: { authorization: 'Bearer ' + app.token } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { jobs: [] });
});


test('browser task history survives runtime restart and exposes completed runs', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  let app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  let base = 'http://127.0.0.1:' + app.port;
  const start = await fetch(base + '/api/terminal/command', {
    method: 'POST', headers, body: JSON.stringify({ command: process.execPath, args: ['--version'] })
  });
  assert.equal(start.status, 202, await start.clone().text());
  const { jobId } = await start.json();
  let approval = null;
  let snapshot;
  for (let i = 0; i < 60 && !approval; i++) {
    snapshot = await (await fetch(base + '/api/jobs/' + jobId, { headers })).json();
    approval = snapshot.events.find((event) => event.type === 'approval_required') || null;
    if (!approval) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(approval, 'the command must wait for an approval decision');
  const allowed = await fetch(base + '/api/jobs/' + jobId + '/approval', {
    method: 'POST', headers, body: JSON.stringify({ approvalId: approval.data.approvalId, approved: true })
  });
  assert.equal(allowed.status, 200);

  for (let i = 0; i < 80; i++) {
    snapshot = await (await fetch(base + '/api/jobs/' + jobId, { headers })).json();
    if (snapshot.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.result.exitCode, 0);

  await app.close();
  app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789'
  });
  base = 'http://127.0.0.1:' + app.port;
  const listResponse = await fetch(base + '/api/jobs', { headers: { authorization: 'Bearer ' + app.token } });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const saved = list.jobs.find((task) => task.id === jobId);
  assert.ok(saved, 'completed job should remain in local task history after restart');
  assert.equal(saved.status, 'completed');
  const detailResponse = await fetch(base + '/api/jobs/' + jobId, { headers: { authorization: 'Bearer ' + app.token } });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.status, 'completed');
  assert.ok(detail.events.length > 0);
});

test('desktop provider setup stores the API key through the host callback, not config.json', async (t) => {
  const root = await tempDir();
  let captured = null;
  const providerServer = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'probe-call',
            type: 'function',
            function: { name: 'oasis_connection_probe', arguments: '{"ready":true}' }
          }]
        }
      }]
    }));
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const configDir = path.join(root, 'config');
  const env = { OASIS_CONFIG_DIR: configDir };
  const app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0, env,
    onProviderConfig: async (provider) => {
      captured = { ...provider };
      await saveConfig({
        protocol: provider.protocol,
        baseURL: provider.baseURL,
        model: provider.model,
        apiKey: ''
      }, { env });
    },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const key = 'desktop-secret-fixture-do-not-return';
  const response = await fetch('http://127.0.0.1:' + app.port + '/api/provider/config', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: 'openai-compatible',
      baseURL: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
      model: 'desktop-fixture-model',
      apiKey: key
    })
  });
  const bodyText = await response.text();
  assert.equal(response.status, 200, bodyText);
  assert.doesNotMatch(bodyText, new RegExp(key));
  assert.equal(captured.apiKey, key);

  const configText = await readFile(path.join(configDir, 'config.json'), 'utf8');
  assert.doesNotMatch(configText, new RegExp(key));
  assert.equal(JSON.parse(configText).apiKey, '');
});

test('Ollama discovery uses a fixed localhost endpoint and returns only model names', async (t) => {
  const root = await tempDir();
  let requestedUrl = '';
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({
    root, host: '127.0.0.1', port: 0, env,
    token: 'test-runtime-token-0123456789',
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({
        models: [
          { name: 'qwen2.5-coder:3b', modified_at: 'ignored' },
          { model: 'llama3.2:1b', digest: 'ignored' },
          { name: '' }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch('http://127.0.0.1:' + app.port + '/api/provider/local-models', {
    headers: { authorization: 'Bearer ' + app.token }
  });
  assert.equal(response.status, 200);
  assert.equal(requestedUrl, 'http://127.0.0.1:11434/api/tags');
  assert.deepEqual(await response.json(), {
    available: true,
    models: ['qwen2.5-coder:3b', 'llama3.2:1b'],
    message: 'Ollama is running. Choose an installed model, then test the connection.'
  });
});

test('Ollama discovery cannot be used by a non-loopback client', async (t) => {
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

  // Spoofing an external Host/Origin is rejected by the server's same-origin guard
  // before local model discovery can run.
  const response = await fetch('http://127.0.0.1:' + app.port + '/api/provider/local-models', {
    headers: { authorization: 'Bearer ' + app.token, origin: 'http://attacker.example' }
  });
  assert.equal(response.status, 421);
});
