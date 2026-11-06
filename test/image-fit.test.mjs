import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fitImage, fitImages, readImageFile, imageMaxEdge, MAX_IMAGE_BYTES } from '../src/images.mjs';
import { imageTokenEstimate, estimateTokens } from '../src/context.mjs';

// sharp is an optional native dependency; platforms without a prebuilt skip these.
const sharp = await import('sharp').then((module) => module.default).catch(() => null);
const test = sharp ? nodeTest : nodeTest.skip;

const png = (width, height) => sharp({ create: { width, height, channels: 3, background: '#3366aa' } }).png().toBuffer();
// Random pixels do not compress, so this PNG is far over the byte limit.
const noisyPng = (width, height) => sharp(Buffer.from(Array.from({ length: width * height * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();

test('images within the limits pass through untouched without decoding', async () => {
  const buffer = await png(800, 600);
  const data = buffer.toString('base64');
  const fitted = await fitImage({ mediaType: 'image/png', data }, { env: {}, sharp: () => { throw new Error('sharp must not be called'); } });
  assert.equal(fitted.data, data);
  assert.deepEqual([fitted.width, fitted.height, fitted.resizedFrom], [800, 600, undefined]);
});

test('a tall full-page screenshot is downscaled to the long-edge cap, keeping its aspect ratio', async () => {
  const fitted = await fitImage({ mediaType: 'image/png', data: (await png(1280, 8000)).toString('base64') }, { env: {} });
  assert.equal(fitted.mediaType, 'image/png');
  assert.deepEqual([fitted.width, fitted.height, fitted.resizedFrom], [320, 2000, '1280x8000']);
  const meta = await sharp(Buffer.from(fitted.data, 'base64')).metadata();
  assert.deepEqual([meta.width, meta.height], [320, 2000]);
  assert.equal((await fitImage({ mediaType: 'image/png', data: (await png(3000, 1000)).toString('base64') }, { env: { OASIS_IMAGE_MAX_EDGE: '1568' } })).width, 1568);
  assert.equal(imageMaxEdge({ OASIS_IMAGE_MAX_EDGE: '50' }), 2000);
});

test('an image over the byte limit is re-encoded until it fits', async () => {
  const buffer = await noisyPng(1800, 1200);
  assert.ok(buffer.length > MAX_IMAGE_BYTES);
  const fitted = await fitImage({ mediaType: 'image/png', data: buffer.toString('base64') }, { env: {} });
  assert.equal(fitted.error, undefined);
  assert.ok(Buffer.from(fitted.data, 'base64').length <= MAX_IMAGE_BYTES);
  assert.equal(fitted.mediaType, 'image/jpeg');
});

test('without sharp an oversized image is refused with a note instead of breaking the request', async () => {
  const big = await noisyPng(1800, 1200);
  const small = (await png(100, 100)).toString('base64');
  const { images, notes } = await fitImages([{ mediaType: 'image/png', data: small }, { mediaType: 'image/png', data: big.toString('base64'), path: 'shot.png' }], { env: {}, sharp: false });
  assert.equal(images.length, 1);
  assert.equal(images[0].data, small);
  assert.match(notes[0], /^shot\.png: .*sharp/);
  // A large-dimension image under the byte limit is still sent; the provider downscales it.
  assert.equal((await fitImage({ mediaType: 'image/png', buffer: await png(4000, 3000) }, { env: {}, sharp: false })).width, 4000);
});

test('read_file downscales a large image and reports both sizes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'wide.png'), await png(4000, 2000));
  const result = await readImageFile(root, 'wide.png', { env: {} });
  assert.deepEqual([result.width, result.height, result.resizedFrom], [2000, 1000, '4000x2000']);
  assert.match(result.note, /downscaled from 4000x2000 to 2000x1000/);
  assert.equal(result.imageData.width, 2000);
});

test('image token estimates follow the 28-pixel patch count, capped at 1600', () => {
  assert.equal(imageTokenEstimate({ width: 280, height: 280 }), 100);
  assert.equal(imageTokenEstimate({ width: 2000, height: 2000 }), 1600);
  assert.equal(imageTokenEstimate({}), 1600);
  const small = estimateTokens([{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: '', width: 280, height: 280 }] }]);
  const unknown = estimateTokens([{ role: 'user', content: 'x', images: [{ mediaType: 'image/png', data: '' }] }]);
  assert.equal(unknown - small, 1500);
});

test('a pasted 4K screenshot and a browser-sized tool image reach the provider downscaled', async (t) => {
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-image-run-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-image-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  await writeFile(path.join(root, 'page.png'), await png(1200, 6000));
  const { config, requests } = await scriptedModel(t, [toolCall('c1', 'read_file', { path: 'page.png' }), { content: 'done' }]);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const pasted = (await png(3840, 2160)).toString('base64');
  await runAgentTurn(session, 'compare', { autoApprove: true, env, approval: async () => true, images: [{ mediaType: 'image/png', data: pasted }] });
  const urls = requests[1].messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url) : []);
  assert.equal(urls.length, 2);
  const sizes = await Promise.all(urls.map(async (url) => { const meta = await sharp(Buffer.from(url.split(',')[1], 'base64')).metadata(); return meta.width + 'x' + meta.height; }));
  assert.deepEqual(sizes.sort(), ['2000x1125', '400x2000']);
});
