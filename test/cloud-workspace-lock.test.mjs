import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { saveConfig } from '../src/config.mjs';
import { startOasisWebServer } from '../src/web.mjs';

test('browser runtime prevents two mutating jobs from running in one workspace at once', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'oasis-workspace-lock-'));
  const root = path.join(temp, 'workspace');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(temp, 'config') };
  let providerResolve;
  let providerRelease;
  const providerStarted = new Promise((resolve) => { providerResolve = resolve; });
  const providerServer = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume provider request */ }
    providerRelease = () => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'The test task finished.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }));
    };
    providerResolve();
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  let app;
  t.after(async () => {
    if (providerRelease) providerRelease();
    if (app) await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });

  const providerPort = providerServer.address().port;
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:' + providerPort + '/v1',
    model: 'fixture-model',
    apiKey: ''
  }, { env });
  app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env,
    token: 'workspace-lock-test-token-1234567890'
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = {
    authorization: 'Bearer ' + app.token,
    'content-type': 'application/json'
  };
  const first = await fetch(base + '/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'Keep this task running until the test releases the provider.' })
  });
  assert.equal(first.status, 202);
  const firstJob = await first.json();
  await providerStarted;

  const secondChat = await fetch(base + '/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'A second independent session must not write to this same workspace.' })
  });
  assert.equal(secondChat.status, 409);
  assert.match((await secondChat.json()).error, /workspace already has an active task/i);

  const terminal = await fetch(base + '/api/terminal/command', {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: 'node', args: ['--version'] })
  });
  assert.equal(terminal.status, 409);
  assert.match((await terminal.json()).error, /workspace already has an active task/i);

  const reset = await fetch(base + '/api/workspace/reset', {
    method: 'POST',
    headers,
    body: JSON.stringify({})
  });
  assert.equal(reset.status, 409);

  providerRelease();
  let finalState;
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await fetch(base + '/api/jobs/' + firstJob.jobId, { headers });
    finalState = await response.json();
    if (['completed', 'error', 'cancelled'].includes(finalState.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(finalState.status, 'completed', JSON.stringify(finalState));
});
