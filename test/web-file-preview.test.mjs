import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

test('inline file previews are authenticated and cannot read outside or secret paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-preview-test-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'preview.mjs'), 'export const answer = 42;\n');
  await writeFile(path.join(root, '.env'), 'SECRET_VALUE=do-not-return\n');
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
  const anonymous = await fetch(base + '/api/workspace/file?path=src%2Fpreview.mjs');
  assert.equal(anonymous.status, 401);

  const headers = { authorization: 'Bearer ' + app.token };
  const response = await fetch(base + '/api/workspace/file?path=' + encodeURIComponent('src/preview.mjs'), { headers });
  assert.equal(response.status, 200);
  const file = await response.json();
  assert.equal(file.path, 'src/preview.mjs');
  assert.equal(file.content, 'export const answer = 42;\n');
  assert.equal(file.lineCount, 1, 'a final newline terminates the last line; it does not create a second line');

  await writeFile(path.join(root, 'src', 'single-line.txt'), 'one line without a final newline');
  const noFinalNewline = await fetch(base + '/api/workspace/file?path=' + encodeURIComponent('src/single-line.txt'), { headers });
  assert.equal(noFinalNewline.status, 200);
  const noFinalNewlineBody = await noFinalNewline.json();
  assert.equal(noFinalNewlineBody.content, 'one line without a final newline');
  assert.equal(noFinalNewlineBody.lineCount, 1);

  const secret = await fetch(base + '/api/workspace/file?path=' + encodeURIComponent('.env'), { headers });
  assert.equal(secret.status, 403);
  assert.doesNotMatch(await secret.text(), /SECRET_VALUE|do-not-return/);

  const outside = await fetch(base + '/api/workspace/file?path=' + encodeURIComponent('../outside.txt'), { headers });
  assert.equal(outside.status, 403);
});
