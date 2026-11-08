// Files added from the browser's Files panel in `oasis web` go into the real
// project folder, within the same boundaries as the agent's own writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

test('POST /api/workspace/upload writes into the project, refuses protected paths and asks before overwriting', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-upload-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-upload-home-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-upload-out-'));
  await writeFile(path.join(root, 'existing.txt'), 'old\n');
  await mkdir(path.join(root, '.git'));
  await symlink(outside, path.join(root, 'linked'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'upload-test-token-0123456789' });
  t.after(async () => { await app.close(); await Promise.all([root, home, outside].map((dir) => rm(dir, { recursive: true, force: true }))); });
  const upload = (body) => fetch('http://127.0.0.1:' + app.port + '/api/workspace/upload', { method: 'POST', headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pdf = Buffer.from('%PDF-1.4\n\x00\xff binary\n', 'latin1');

  const first = await upload({ files: [
    { path: 'docs/report.pdf', base64: pdf.toString('base64') },
    { path: '.env', content: 'SECRET=1' },
    { path: '.git/config', content: 'x' },
    { path: '../escape.txt', content: 'x' },
    { path: 'linked/through.txt', content: 'x' }
  ] });
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.deepEqual(result.written, ['docs/report.pdf']);
  assert.deepEqual(result.refused.map((item) => item.path).sort(), ['.env', '.git/config', '../escape.txt', 'linked/through.txt'].sort());
  assert.deepEqual(await readFile(path.join(root, 'docs/report.pdf')), pdf);
  await assert.rejects(readFile(path.join(outside, 'through.txt')));

  const conflict = await upload({ files: [{ path: 'existing.txt', content: 'new\n' }] });
  assert.equal(conflict.status, 409);
  assert.deepEqual((await conflict.json()).existing, ['existing.txt']);
  assert.equal(await readFile(path.join(root, 'existing.txt'), 'utf8'), 'old\n');
  const replaced = await upload({ files: [{ path: 'existing.txt', content: 'new\n' }], overwrite: true });
  assert.equal(replaced.status, 200);
  assert.equal(await readFile(path.join(root, 'existing.txt'), 'utf8'), 'new\n');

  const anonymous = await fetch('http://127.0.0.1:' + app.port + '/api/workspace/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ path: 'a.txt', content: 'x' }] }) });
  assert.equal(anonymous.status, 401);
});
