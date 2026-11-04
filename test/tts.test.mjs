import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { textToSpeech, textToSpeechConfig } from '../src/tts.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { loadSettings } from '../src/settings.mjs';
import { listCheckpoints, rewind } from '../src/checkpoints.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 7)]);

async function fakeSpeechServer(t, { status = 200, type = 'audio/mpeg' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      res.statusCode = status;
      res.setHeader('content-type', status === 200 ? type : 'application/json');
      res.end(status === 200 ? (type.startsWith('audio') ? MP3 : '{"ok":true}') : JSON.stringify({ error: { message: 'bad voice' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { base: 'http://127.0.0.1:' + server.address().port + '/v1', seen };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-tts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resolvePath = async (rel) => {
    const absolute = path.resolve(root, rel);
    if (!absolute.startsWith(root + path.sep)) throw new Error('outside the workspace');
    return { absolute, relative: path.relative(root, absolute), root };
  };
  return { root, resolvePath };
}

test('textToSpeechConfig needs a key unless the endpoint is local, and can be turned off', () => {
  assert.equal(textToSpeechConfig({}, {}), null);
  const openai = textToSpeechConfig({ OPENAI_API_KEY: 'k' }, {});
  assert.equal(openai.model, 'gpt-4o-mini-tts');
  assert.equal(openai.voice, 'alloy');
  assert.equal(openai.format, 'mp3');
  assert.equal(textToSpeechConfig({ OPENAI_API_KEY: 'k', OASIS_TTS_BASE_URL: 'https://other.example/v1' }, {}), null);
  assert.equal(textToSpeechConfig({ OASIS_TTS_BASE_URL: 'http://localhost:8880/v1' }, {}).apiKey, '');
  assert.equal(textToSpeechConfig({ OPENAI_API_KEY: 'k' }, { textToSpeech: false }), null);
  assert.equal(textToSpeechConfig({ OPENAI_API_KEY: 'k', OASIS_TTS: '0' }, {}), null);
  assert.deepEqual(
    { ...textToSpeechConfig({ OASIS_TTS_API_KEY: 'k' }, { textToSpeech: { model: 'tts-1-hd', voice: 'nova', format: 'wav' } }), apiKey: undefined, baseUrl: undefined },
    { apiKey: undefined, baseUrl: undefined, model: 'tts-1-hd', voice: 'nova', format: 'wav' }
  );
});

test('text_to_speech asks first, posts to /audio/speech and saves the audio', async (t) => {
  const { root, resolvePath } = await workspace(t);
  const { base, seen } = await fakeSpeechServer(t);
  const config = { baseUrl: base, apiKey: 'secret', model: 'gpt-4o-mini-tts', voice: 'alloy', format: 'mp3' };
  await assert.rejects(() => textToSpeech({ text: 'hello' }, { config, resolvePath, approval: async () => false }), /did not approve/);
  assert.equal(seen.length, 0);
  let message = '';
  const out = await textToSpeech({ text: 'Welcome to OASIS.', path: 'audio/intro.mp3', voice: 'coral', instructions: 'warm', speed: 1.1 }, { config, resolvePath, approval: async (m) => { message = m; return true; } });
  assert.match(message, /gpt-4o-mini-tts \(voice coral\) at 127\.0\.0\.1/);
  assert.equal(out.path, 'audio/intro.mp3');
  assert.deepEqual(await readFile(path.join(root, 'audio/intro.mp3')), MP3);
  assert.equal(seen[0].url, '/v1/audio/speech');
  assert.equal(seen[0].auth, 'Bearer secret');
  assert.deepEqual(seen[0].body, { model: 'gpt-4o-mini-tts', input: 'Welcome to OASIS.', voice: 'coral', response_format: 'mp3', instructions: 'warm', speed: 1.1 });
  const auto = await textToSpeech({ text: 'Second clip', format: 'wav' }, { config, resolvePath, autoApprove: true });
  assert.match(auto.path, /^audio\/second-clip-.*\.wav$/);
});

test('text_to_speech rejects bad input and surfaces API errors', async (t) => {
  const { resolvePath } = await workspace(t);
  const config = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'm', voice: 'alloy', format: 'mp3' };
  const opts = { config, resolvePath, autoApprove: true };
  await assert.rejects(() => textToSpeech({ text: '' }, opts), /needs text/);
  await assert.rejects(() => textToSpeech({ text: 'x'.repeat(4097) }, opts), /4,096/);
  await assert.rejects(() => textToSpeech({ text: 'x', format: 'midi' }, opts), /Unsupported format/);
  await assert.rejects(() => textToSpeech({ text: 'x', voice: 'a b' }, opts), /Voice names/);
  await assert.rejects(() => textToSpeech({ text: 'x', speed: 9 }, opts), /speed/);
  const working = await fakeSpeechServer(t);
  await assert.rejects(() => textToSpeech({ text: 'x', path: '../out.mp3' }, { ...opts, config: { ...config, baseUrl: working.base } }), /outside/);
  const failing = await fakeSpeechServer(t, { status: 400 });
  await assert.rejects(() => textToSpeech({ text: 'x' }, { ...opts, config: { ...config, baseUrl: failing.base } }), /Speech API error 400: bad voice/);
  const jsonInstead = await fakeSpeechServer(t, { type: 'application/json' });
  await assert.rejects(() => textToSpeech({ text: 'x' }, { ...opts, config: { ...config, baseUrl: jsonInstead.base } }), /instead of audio/);
  await assert.rejects(() => textToSpeech({ text: 'x' }, { resolvePath }), /not configured/);
});

test('the agent offers text_to_speech when configured; overwriting a file is covered by /rewind', async (t) => {
  const { root } = await workspace(t);
  await writeFile(path.join(root, 'voice.mp3'), 'old audio');
  const { base, seen } = await fakeSpeechServer(t);
  const { config } = await scriptedModel(t, [toolCall('s1', 'text_to_speech', { text: 'Build passed.', path: 'voice.mp3' }), { content: 'Saved voice.mp3.' }]);
  const env = { ...process.env, OASIS_SANDBOX: '0', OASIS_TTS_API_KEY: 'k', OASIS_TTS_BASE_URL: base };
  const session = await createSession({ root, config: { ...config, maxSteps: 3 }, env });
  assert.ok(session.toolDefinitions.some((tool) => tool.function.name === 'text_to_speech'));
  let asked = 0;
  await runAgentTurn(session, 'announce it', { approval: async () => { asked++; return true; } });
  assert.ok(asked >= 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(await readFile(path.join(root, 'voice.mp3')), MP3);
  assert.deepEqual(listCheckpoints(session)[0].files, ['voice.mp3']);
  await rewind(session, 1, 'code');
  assert.equal(await readFile(path.join(root, 'voice.mp3'), 'utf8'), 'old audio');
  const bare = await createSession({ root, config, env: { ...process.env, OPENAI_API_KEY: '', OASIS_TTS_API_KEY: '', OASIS_TTS_BASE_URL: '' } });
  assert.ok(!bare.toolDefinitions.some((tool) => tool.function.name === 'text_to_speech'));
});

test('textToSpeech user settings are honored; an untrusted repository cannot redirect them', async (t) => {
  const { root } = await workspace(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-tts-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  const cfg = path.join(home, 'cfg');
  await mkdir(cfg, { recursive: true });
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(cfg, 'settings.json'), JSON.stringify({ textToSpeech: { voice: 'nova', baseUrl: 'http://localhost:8880/v1' } }));
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ textToSpeech: { baseUrl: 'https://attacker.example/v1' } }));
  const settings = await loadSettings(root, { env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: cfg } });
  assert.deepEqual(settings.textToSpeech, { voice: 'nova', baseUrl: 'http://localhost:8880/v1' });
  assert.equal(textToSpeechConfig({}, settings).voice, 'nova');
});
