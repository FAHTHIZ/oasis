import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-web-pty-test-'));
}

function fakePtyManager() {
  const calls = [];
  return {
    calls,
    async start(command, args, options) {
      calls.push({ kind: 'start', command, args, options });
      return { id: 'term_web_test', command, state: 'running', cwd: options.cwd, cols: 100, rows: 30, outputOffset: 6, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: 'Interactive terminal started.' };
    },
    list() { return { sessions: [{ id: 'term_web_test', state: 'running' }] }; },
    async read(id, options) {
      calls.push({ kind: 'read', id, options });
      if (id !== 'term_web_test') throw new Error('No terminal session exists with that id in this OASIS session.');
      return { id, state: 'running', output: 'ready\n', offset: options.offset || 0, nextOffset: (options.offset || 0) + 6, truncated: false, waiting: false };
    },
    write(id, data) { calls.push({ kind: 'write', id, data }); return { id, writtenChars: data.length, state: 'running' }; },
    resize(id, cols, rows) { calls.push({ kind: 'resize', id, cols, rows }); return { id, cols, rows, state: 'running' }; },
    interrupt(id) { calls.push({ kind: 'interrupt', id }); return { id, interrupted: true, state: 'running' }; },
    stop(id) { calls.push({ kind: 'stop', id }); return { id, stopped: true, state: 'stopping' }; },
    closeAll() { calls.push({ kind: 'close' }); return { stopped: 0 }; }
  };
}

async function waitForApproval(base, token, jobId) {
  const headers = { authorization: 'Bearer ' + token };
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(base + '/api/jobs/' + jobId + '?after=0', { headers });
    const body = await response.json();
    const approval = body.events.find((event) => event.type === 'approval_required');
    if (approval) {
      const approved = await fetch(base + '/api/jobs/' + jobId + '/approval', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ approvalId: approval.data.approvalId, approved: true })
      });
      assert.equal(approved.status, 200, await approved.text());
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Terminal command never requested explicit approval.');
}

test('browser PTY endpoints require the bearer token and control only authorized sessions', async (t) => {
  const root = await tempDir();
  const ptyManager = fakePtyManager();
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, token: 'web-pty-test-token-0123456789', env: { OASIS_CONFIG_DIR: path.join(root, 'config') }, ptyManager });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const auth = { authorization: 'Bearer ' + app.token };
  const denied = await fetch(base + '/api/terminal/pty/list');
  assert.equal(denied.status, 401);
  assert.deepEqual((await (await fetch(base + '/api/terminal/pty/list', { headers: auth })).json()).sessions[0].id, 'term_web_test');

  const start = await fetch(base + '/api/terminal/command', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'npm', args: ['--version'], interactive: true })
  });
  assert.equal(start.status, 202);
  const { jobId } = await start.json();
  await waitForApproval(base, app.token, jobId);
  let final = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    final = await (await fetch(base + '/api/jobs/' + jobId + '?after=0', { headers: auth })).json();
    if (final.status === 'completed' || final.status === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(final.status, 'completed', JSON.stringify(final.events));
  assert.ok(final.events.some((event) => event.type === 'terminal_pty_started'));
  assert.ok(ptyManager.calls.some((call) => call.kind === 'start' && call.command === 'npm'));

  const read = await fetch(base + '/api/terminal/pty/read?id=term_web_test&offset=0&wait_seconds=1', { headers: auth });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).output, 'ready\n');

  const post = async (path, body) => fetch(base + '/api/terminal/pty/' + path, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal((await post('input', { id: 'term_web_test', data: 'hello\r' })).status, 200);
  assert.equal((await post('resize', { id: 'term_web_test', cols: 120, rows: 40 })).status, 200);
  assert.equal((await post('interrupt', { id: 'term_web_test' })).status, 200);
  assert.equal((await post('stop', { id: 'term_web_test' })).status, 200);
  assert.equal((await post('input', { id: 'unknown-id', data: 'no' })).status, 404);
  assert.ok(ptyManager.calls.some((call) => call.kind === 'write' && call.data === 'hello\r'));
});
