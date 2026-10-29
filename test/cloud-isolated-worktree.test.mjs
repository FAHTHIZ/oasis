import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { saveConfig } from '../src/config.mjs';
import { startOasisWebServer } from '../src/web.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
}

test('browser coding task can run in a clean isolated worktree and leaves a reviewable branch', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'oasis-cloud-isolated-'));
  const root = path.join(temp, 'workspace');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'oasis-test@example.invalid');
  git(root, 'config', 'user.name', 'Oasis Test');
  await writeFile(path.join(root, 'README.md'), '# Fixture repository\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'Initial fixture');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(temp, 'config') };

  let providerRequests = 0;
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const payload = JSON.parse(raw);
    providerRequests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (providerRequests === 1) {
      res.end(JSON.stringify({
        choices: [{ message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'isolated-write-file',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'task-output.txt', content: 'Created inside isolated worktree.\n' })
            }
          }]
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }));
    } else {
      assert.ok(Array.isArray(payload.messages));
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'The isolated change is ready for review.' } }],
        usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 }
      }));
    }
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:' + provider.address().port + '/v1',
    model: 'fixture-model',
    apiKey: ''
  }, { env });
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env,
    token: 'isolated-worktree-test-token-123456789'
  });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => provider.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const headers = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const started = await fetch(base + '/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'Create task-output.txt with a short confirmation.', isolation: 'worktree' })
  });
  assert.equal(started.status, 202, await started.clone().text());
  const { jobId, isolation, branch } = await started.json();
  assert.ok(jobId);
  assert.equal(isolation, 'worktree');
  assert.match(branch, /^oasis\/cloud-/);

  let snapshot;
  let approved = false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const response = await fetch(base + '/api/jobs/' + jobId + '?after=0', { headers });
    assert.equal(response.status, 200);
    snapshot = await response.json();
    const approval = (snapshot.events || []).find((event) => event.type === 'approval_required');
    if (approval && !approved) {
      const decision = await fetch(base + '/api/jobs/' + jobId + '/approval', {
        method: 'POST',
        headers,
        body: JSON.stringify({ approvalId: approval.data.approvalId, approved: true })
      });
      assert.equal(decision.status, 200, await decision.clone().text());
      approved = true;
    }
    if (['completed', 'error', 'cancelled'].includes(snapshot.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot));
  assert.ok(snapshot.result.isolatedWorktree, JSON.stringify(snapshot.result));
  assert.equal(snapshot.result.isolatedWorktree.changed, true, JSON.stringify(snapshot.result.isolatedWorktree));
  assert.equal(snapshot.result.isolatedWorktree.branch, branch);
  assert.ok(snapshot.result.isolatedWorktree.files.includes('task-output.txt'));

  const anonymousDiff = await fetch(base + '/api/jobs/' + jobId + '/diff');
  assert.equal(anonymousDiff.status, 401);
  const diffResponse = await fetch(base + '/api/jobs/' + jobId + '/diff', { headers });
  assert.equal(diffResponse.status, 200, await diffResponse.clone().text());
  const artifact = await diffResponse.json();
  assert.equal(artifact.branch, branch);
  assert.equal(artifact.commit, snapshot.result.isolatedWorktree.commit);
  assert.ok(artifact.diff.includes('task-output.txt'));
  assert.match(artifact.diff, /Created inside isolated worktree/);
  assert.equal(artifact.truncated, false);
  assert.equal(git(root, 'show', branch + ':task-output.txt'), 'Created inside isolated worktree.');
  await assert.rejects(readFile(path.join(root, 'task-output.txt')));
  assert.equal(git(root, 'status', '--porcelain'), '');

  await writeFile(path.join(root, 'uncommitted.txt'), 'local edits must not be omitted silently');
  const dirty = await fetch(base + '/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'This must not branch from HEAD while edits exist.', isolation: 'worktree' })
  });
  assert.equal(dirty.status, 409);
  assert.match((await dirty.json()).error, /clean Git workspace/i);
  await rm(path.join(root, 'uncommitted.txt'));
});
