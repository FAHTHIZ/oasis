import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { generateImage, imageGenerationConfig } from '../src/image-gen.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

async function fakeImageServer(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('latin1') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a red fox, flat style' }], usage: { total_tokens: 10 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { base: 'http://127.0.0.1:' + server.address().port + '/v1', seen };
}

test('imageGenerationConfig needs a key unless the endpoint is local, and can be turned off', () => {
  assert.equal(imageGenerationConfig({}, {}), null);
  assert.equal(imageGenerationConfig({ OPENAI_API_KEY: 'k' }, {}).model, 'gpt-image-1');
  assert.equal(imageGenerationConfig({ OPENAI_API_KEY: 'k', OASIS_IMAGE_BASE_URL: 'https://other.example/v1' }, {}), null);
  assert.equal(imageGenerationConfig({ OASIS_IMAGE_BASE_URL: 'http://localhost:8080/v1' }, {}).apiKey, '');
  assert.equal(imageGenerationConfig({ OPENAI_API_KEY: 'k' }, { imageGeneration: false }), null);
  assert.equal(imageGenerationConfig({ OPENAI_API_KEY: 'k', OASIS_IMAGE_GENERATION: '0' }, {}), null);
  assert.equal(imageGenerationConfig({ OASIS_IMAGE_API_KEY: 'k', OASIS_IMAGE_MODEL: 'dall-e-3' }, {}).model, 'dall-e-3');
});

test('generate_image asks first, saves into the workspace and supports edits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-img-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { base, seen } = await fakeImageServer(t);
  const config = { baseUrl: base, apiKey: 'secret', model: 'gpt-image-1', size: 'auto' };
  const resolvePath = async (rel) => {
    const absolute = path.resolve(root, rel);
    if (!absolute.startsWith(root + path.sep)) throw new Error('outside the workspace');
    return { absolute, relative: path.relative(root, absolute), root };
  };
  await assert.rejects(() => generateImage({ prompt: 'fox' }, { config, resolvePath, approval: async () => false }), /did not approve/);
  assert.equal(seen.length, 0);
  let message = '';
  const out = await generateImage({ prompt: 'a red fox', path: 'assets/fox.png', size: '1024x1024' }, { config, resolvePath, approval: async (m) => { message = m; return true; } });
  assert.match(message, /gpt-image-1/);
  assert.equal(out.path, 'assets/fox.png');
  assert.equal(out.revisedPrompt, 'a red fox, flat style');
  assert.deepEqual(await readFile(path.join(root, 'assets/fox.png')), PNG);
  assert.equal(seen[0].url, '/v1/images/generations');
  assert.equal(seen[0].auth, 'Bearer secret');
  assert.equal(JSON.parse(seen[0].body).size, '1024x1024');
  const edited = await generateImage({ prompt: 'make it blue', input_images: ['assets/fox.png'] }, { config, resolvePath, autoApprove: true });
  assert.match(edited.path, /^images\/make-it-blue-.*\.png$/);
  assert.equal(seen[1].url, '/v1/images/edits');
  assert.match(seen[1].type, /multipart\/form-data/);
  assert.match(seen[1].body, /name="image"; filename="fox.png"/);
  await assert.rejects(() => generateImage({ prompt: 'x', path: '../escape.png' }, { config, resolvePath, autoApprove: true }), /outside/);
  await assert.rejects(() => generateImage({ prompt: 'x', size: '3x3' }, { config, resolvePath, autoApprove: true }), /Unsupported size/);
});

test('the agent offers generate_image when a key is configured and it goes through approval', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-img-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { base, seen } = await fakeImageServer(t);
  const { config } = await scriptedModel(t, [toolCall('g1', 'generate_image', { prompt: 'app icon', path: 'icon.png' }), { content: 'Saved icon.png.' }]);
  const env = { ...process.env, OASIS_SANDBOX: '0', OASIS_IMAGE_API_KEY: 'k', OASIS_IMAGE_BASE_URL: base };
  const session = await createSession({ root, config: { ...config, maxSteps: 3 }, env });
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'generate_image'));
  let asked = 0;
  const result = await runAgentTurn(session, 'make an icon', { approval: async () => { asked++; return true; } });
  assert.match(result.text, /icon/);
  assert.ok(asked >= 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(await readFile(path.join(root, 'icon.png')), PNG);
  const bare = await createSession({ root, config, env: { ...process.env, OPENAI_API_KEY: '', OASIS_IMAGE_API_KEY: '', OASIS_IMAGE_BASE_URL: '' } });
  assert.ok(!bare.toolDefinitions.some((tool) => tool.function.name === 'generate_image'));
});
