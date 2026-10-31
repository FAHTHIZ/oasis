import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, mkdir, stat, utimes, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { ensureScratch, isScratchPath, scratchKey } from '../src/scratch.mjs';
import { unrequestedDocWarning } from '../src/tools.mjs';

test('scratch paths, keys and doc warnings', () => {
  assert.equal(isScratchPath('.oasis/scratch/ab12/repro.py'), true);
  assert.equal(isScratchPath('./.oasis/scratch/x'), true);
  assert.equal(isScratchPath('.oasis\\scratch\\x\\y.txt'), true);
  assert.equal(isScratchPath('.oasis/scratchy/x'), false);
  assert.equal(isScratchPath('src/scratch/x.js'), false);
  assert.equal(scratchKey('2026-10-31_abc/../x'), '2026-10-31ab');
  assert.match(scratchKey(''), /^[0-9a-f]{8}$/);
  assert.equal(unrequestedDocWarning('.oasis/scratch/ab/SUMMARY.md', 'fix the bug'), '');
  assert.match(unrequestedDocWarning('SUMMARY.md', 'fix the bug'), /Unrequested document/);
});

test('ensureScratch creates a git-ignored folder and prunes week-old sessions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-scratch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = path.join(root, '.oasis', 'scratch', 'old1');
  await mkdir(old, { recursive: true });
  const weekAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  await utimes(old, weekAgo, weekAgo);
  await mkdir(path.join(root, '.oasis', 'scratch', 'recent'), { recursive: true });
  const dir = await ensureScratch(root, 'abcd');
  assert.equal(dir, path.join(root, '.oasis', 'scratch', 'abcd'));
  assert.ok((await stat(dir)).isDirectory());
  assert.match(await readFile(path.join(root, '.oasis', 'scratch', '.gitignore'), 'utf8'), /^\*$/m);
  assert.deepEqual((await readdir(path.join(root, '.oasis', 'scratch'))).sort(), ['.gitignore', 'abcd', 'recent']);
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.doesNotMatch(status, /scratch/);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
});

test('the agent is told about scratch space, and scratch writes skip the change-verification gate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-scratch-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let session;
  let n = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    n += 1;
    const message = n === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: session.scratchDir + '/repro.py', content: 'print(1)\n' }) } }] }
      : { role: 'assistant', content: 'Reproduced.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 }, env: { ...process.env, OASIS_SCRATCH: '' } });
  assert.match(session.scratchDir, /^\.oasis\/scratch\/[a-zA-Z0-9-]+$/);
  assert.match(session.messages[0].content, /<scratch-space>\nFor throwaway files/);
  const result = await runAgentTurn(session, 'reproduce the crash', { autoApprove: true, approval: async () => true });
  assert.equal(await readFile(path.join(root, ...session.scratchDir.split('/'), 'repro.py'), 'utf8'), 'print(1)\n');
  assert.equal(n, 2, 'no extra verification nudge round for a scratch-only change');
  const verification = result && result.verification || session.lastVerification || {};
  assert.ok(!verification.changedFiles || verification.changedFiles.length === 0);
  const off = await createSession({ root, config: session.config, env: { ...process.env, OASIS_SCRATCH: '0' } });
  assert.equal(off.scratchDir, undefined);
  assert.doesNotMatch(off.messages[0].content, /<scratch-space>/);
});
