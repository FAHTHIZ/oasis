import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer, validateWebImages, MAX_WEB_IMAGES } from '../src/web.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex').toString('base64');
const vision = { env: { OASIS_MODEL_VISION: '1' } };

test('browser images: valid PNG passes with a safe display name', () => {
  const [image] = validateWebImages([{ name: 'shot<script>.png', mediaType: 'image/png', data: PNG }], vision);
  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.data, PNG);
  assert.equal(image.path, 'shot_script_.png');
  assert.deepEqual(validateWebImages(undefined, vision), []);
});

test('browser images: wrong type, fake signature, bad base64, too many and text-only models are rejected', () => {
  const code = (fn) => { try { fn(); } catch (error) { return error.statusCode; } return 0; };
  assert.equal(code(() => validateWebImages([{ mediaType: 'image/svg+xml', data: PNG }], vision)), 415);
  assert.equal(code(() => validateWebImages([{ mediaType: 'image/jpeg', data: PNG }], vision)), 415);
  assert.equal(code(() => validateWebImages([{ mediaType: 'image/png', data: Buffer.from('not a png at all').toString('base64') }], vision)), 415);
  assert.equal(code(() => validateWebImages([{ mediaType: 'image/png', data: 'abc$' }], vision)), 400);
  assert.equal(code(() => validateWebImages('x', vision)), 400);
  assert.equal(code(() => validateWebImages(Array.from({ length: MAX_WEB_IMAGES + 1 }, () => ({ mediaType: 'image/png', data: PNG })), vision)), 413);
  assert.equal(code(() => validateWebImages([{ mediaType: 'image/png', data: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(3_800_000)]).toString('base64') }], vision)), 413);
  assert.equal(code(() => validateWebImages([{ mediaType: 'image/png', data: PNG }], { env: { OASIS_MODEL_VISION: '0' } })), 400);
});

test('chat endpoint accepts an image-sized body but rejects a fake image before starting a job', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-images-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-images-config-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(configDir, { recursive: true, force: true })]));
  const previous = { dir: process.env.OASIS_CONFIG_DIR, vision: process.env.OASIS_MODEL_VISION };
  process.env.OASIS_CONFIG_DIR = configDir; process.env.OASIS_MODEL_VISION = '1';
  t.after(() => { for (const [key, value] of [['OASIS_CONFIG_DIR', previous.dir], ['OASIS_MODEL_VISION', previous.vision]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, token });
  t.after(() => app.close());
  const fake = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200_000)]).toString('base64'); // > 32 KB, real GIF header, labelled PNG
  const response = await fetch('http://127.0.0.1:' + app.port + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ message: 'look', images: [{ mediaType: 'image/png', data: fake }] }) });
  assert.equal(response.status, 415, 'A large body is read (not 413), then the mislabelled image is refused.');
  assert.match((await response.json()).error, /does not look like a PNG/);
});
