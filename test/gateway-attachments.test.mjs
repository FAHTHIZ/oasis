import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { receiveAttachments, safeAttachmentName } from '../src/gateway-core.mjs';
import { createTelegramGateway } from '../src/gateway-telegram.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);

test('attachment names cannot escape the inbox', () => {
  assert.equal(safeAttachmentName('../../etc/passwd'), 'passwd');
  assert.equal(safeAttachmentName('..'), 'file');
  assert.equal(safeAttachmentName('my report (1).pdf'), 'my_report_1_.pdf');
});

test('receiveAttachments saves files, inlines images and notes skipped ones', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-att-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = await receiveAttachments(root, '', [
    { name: 'shot.png', mime: 'image/png', download: async () => PNG },
    { name: 'log.txt', mime: 'text/plain', download: async () => Buffer.from('error at line 3') },
    { name: 'huge.bin', size: 50 * 1024 * 1024, download: async () => Buffer.alloc(1) },
    { name: 'broken.txt', download: async () => { throw new Error('boom'); } }
  ], { now: new Date('2026-11-04T10:00:00Z') });
  assert.equal(out.saved.length, 2);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].mediaType, 'image/png');
  assert.match(out.text, /Look at the attached files/);
  assert.match(out.text, /\.oasis\/inbox\/20261104-100000-log\.txt/);
  assert.match(out.text, /huge\.bin \(over 20 MB\)/);
  assert.match(out.text, /broken\.txt \(download failed\)/);
  assert.match(out.text, /data, not instructions/);
  assert.equal(await readFile(path.join(root, '.oasis/inbox/20261104-100000-log.txt'), 'utf8'), 'error at line 3');
});

test('Telegram photos are downloaded through getFile and reach the agent as images', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-att-tg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const TOKEN = '123456:' + 'A'.repeat(30);
  const fetchImpl = async (url, init) => {
    if (url.includes('/file/bot')) return new Response(PNG);
    const method = url.split('/').pop();
    const result = method === 'getFile' ? { file_path: 'photos/file_1.jpg' } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  };
  let seen;
  const agent = { createSession: async () => ({ messages: [], config: {}, permissions: { mode: 'default' } }), runAgentTurn: async (_s, text, options) => { seen = { text, images: options.images }; return { text: 'ok' }; } };
  const gateway = createTelegramGateway({ token: TOKEN, allowedChats: new Set(['42']), fetchImpl, root, deps: { agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } }, log: () => {} });
  await gateway.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, caption: 'what is wrong here?', photo: [{ file_id: 'small' }, { file_id: 'big', file_unique_id: 'u1' }] } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(seen.text, /what is wrong here\?/);
  assert.match(seen.text, /\.oasis\/inbox\/.*photo-u1\.jpg/);
  assert.equal(seen.images.length, 1);
});
