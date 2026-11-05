import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRecorder, splitCommand, startRecording, transcribe, transcriptionTarget, voiceEnabled } from '../src/voice.mjs';
import { readInput } from '../src/line-editor.mjs';
import { loadSettings } from '../src/settings.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

// A stand-in recorder: writes a WAV header plus samples until SIGINT, like sox/arecord.
const FAKE_RECORDER = `
const fs = require('node:fs');
const file = process.argv[2];
const header = Buffer.alloc(44); header.write('RIFF', 0); header.write('WAVE', 8);
fs.writeFileSync(file, header);
const timer = setInterval(() => fs.appendFileSync(file, Buffer.alloc(3200)), 20);
process.on('SIGINT', () => { clearInterval(timer); fs.appendFileSync(file, Buffer.alloc(3200)); process.exit(0); });
`;

async function fakeRecorderEnv(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-voice-test-'));
  const script = path.join(dir, 'rec.cjs');
  await writeFile(script, FAKE_RECORDER);
  return { OASIS_VOICE_RECORD_COMMAND: JSON.stringify(process.execPath) + ' ' + JSON.stringify(script) + ' {file}' };
}

async function transcriber(t, reply = { text: 'refactor the parser module' }, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', (c) => { body = Buffer.concat([body, c]); });
    req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: body.toString('latin1') }); res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: 'http://127.0.0.1:' + server.address().port + '/v1/audio/transcriptions', seen };
}

test('recorder selection prefers sox, then arecord, then ffmpeg, and honours a custom command', () => {
  const only = (...names) => (name) => names.includes(name);
  assert.equal(findRecorder({ env: {}, platform: 'linux', has: only('rec', 'arecord') }).name, 'sox');
  assert.equal(findRecorder({ env: {}, platform: 'linux', has: only('arecord', 'ffmpeg') }).name, 'arecord');
  const ff = findRecorder({ env: {}, platform: 'darwin', has: only('ffmpeg') });
  assert.equal(ff.name, 'ffmpeg');
  assert.ok(ff.args('/tmp/x.wav').includes('avfoundation'));
  assert.equal(findRecorder({ env: {}, platform: 'win32', has: only('ffmpeg') }), null, 'Windows ffmpeg needs a device name');
  assert.equal(findRecorder({ env: {}, platform: 'linux', has: only() }), null);
  const custom = findRecorder({ env: { OASIS_VOICE_RECORD_COMMAND: 'my-rec --rate 16000 "out file={file}"' }, has: only() });
  assert.deepEqual([custom.command, ...custom.args('/t/a.wav')], ['my-rec', '--rate', '16000', 'out file=/t/a.wav']);
  assert.deepEqual(splitCommand(`a 'b c' "d"`), ['a', 'b c', 'd']);
});

test('transcription target: https only (http for loopback), key by host, project hints in the prompt', async (t) => {
  assert.throws(() => transcriptionTarget({ voice: { transcriptionUrl: 'http://example.com/v1/audio/transcriptions' } }, {}), /https/);
  assert.equal(transcriptionTarget({}, { OPENAI_API_KEY: 'sk-o' }).apiKey, 'sk-o');
  assert.equal(transcriptionTarget({ voice: { transcriptionUrl: 'https://api.groq.com/openai/v1/audio/transcriptions' } }, { OPENAI_API_KEY: 'sk-o', GROQ_API_KEY: 'gk' }).apiKey, 'gk', 'an OpenAI key is never sent to another host');
  assert.equal(transcriptionTarget({ voice: { transcriptionUrl: 'https://stt.example/v1' } }, { OPENAI_API_KEY: 'sk-o' }).apiKey, '');
  const server = await transcriber(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-voice-'));
  const file = path.join(dir, 'a.wav');
  await writeFile(file, Buffer.alloc(2000));
  const text = await transcribe(file, { settings: { voice: { transcriptionUrl: server.url, language: 'en', keyterms: ['OASIS'] } }, env: { OASIS_VOICE_API_KEY: 'vk' }, hints: ['my-repo'] });
  assert.equal(text, 'refactor the parser module');
  const request = server.seen[0];
  assert.equal(request.headers.authorization, 'Bearer vk');
  assert.match(request.headers['content-type'], /multipart\/form-data/);
  assert.match(request.body, /gpt-4o-mini-transcribe/);
  assert.match(request.body, /name="language"\r\n\r\nen/);
  assert.match(request.body, /Terms: OASIS, my-repo/);
  const failing = await transcriber(t, { error: { message: 'bad audio' } }, 400);
  await assert.rejects(transcribe(file, { settings: { voice: { transcriptionUrl: failing.url } }, env: {} }), /HTTP 400\): bad audio/);
  await assert.rejects(transcribe(file, { settings: {}, env: {} }), /needs a key/);
});

test('recording starts, stops on request and produces a WAV', async (t) => {
  const env = { ...process.env, ...(await fakeRecorderEnv(t)) };
  const rec = await startRecording({ env, recorder: findRecorder({ env }) });
  await new Promise((r) => setTimeout(r, 200));
  const file = await rec.stop();
  const data = await readFile(file);
  assert.ok(data.length > 44);
  assert.equal(data.toString('latin1', 0, 4), 'RIFF');
  await rec.cleanup();
  await assert.rejects(startRecording({ env: {}, recorder: null }), /No audio recorder/);
});

test('Alt+V records, the next Alt+V inserts the transcript at the cursor, and nothing is sent', async (t) => {
  const env = { ...process.env, ...(await fakeRecorderEnv(t)), HOME: await mkdtemp(path.join(os.tmpdir(), 'oasis-vh-')) };
  env.OASIS_CONFIG_DIR = path.join(env.HOME, 'cfg');
  const server = await transcriber(t, { text: 'add a retry' });
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); output.columns = 100; let rendered = ''; output.on('data', (c) => { rendered += c; });
  const done = readInput({ input, output, color: false, env, voice: { enabled: () => true, settings: () => ({ voice: { transcriptionUrl: server.url } }), hints: () => [] } });
  input.write('please ');
  input.write('\x1bv');
  await new Promise((r) => setTimeout(r, 400));
  assert.match(rendered, /Recording/);
  input.write('\x1bv');
  for (let i = 0; i < 50 && !server.seen.length; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  input.write(' now\r');
  const result = await done;
  assert.equal(result.type, 'submit');
  assert.equal(result.text, 'please add a retry now');
});

test('Alt+V explains how to turn voice on, and Esc cancels a recording without uploading', async (t) => {
  const env = { ...process.env, ...(await fakeRecorderEnv(t)), HOME: await mkdtemp(path.join(os.tmpdir(), 'oasis-vh-')) };
  env.OASIS_CONFIG_DIR = path.join(env.HOME, 'cfg');
  const server = await transcriber(t);
  let input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  let output = new PassThrough(); output.columns = 100; let rendered = ''; output.on('data', (c) => { rendered += c; });
  let done = readInput({ input, output, color: false, env, voice: { enabled: () => false } });
  input.write('\x1bv');
  await new Promise((r) => setTimeout(r, 100));
  assert.match(rendered, /\/voice on/);
  input.write('x\r');
  await done;
  input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  output = new PassThrough(); output.columns = 100; rendered = ''; output.on('data', (c) => { rendered += c; });
  done = readInput({ input, output, color: false, env, voice: { enabled: () => true, settings: () => ({ voice: { transcriptionUrl: server.url } }) } });
  input.write('\x1bv');
  await new Promise((r) => setTimeout(r, 300));
  input.write('\x1b');
  await new Promise((r) => setTimeout(r, 200));
  assert.match(rendered, /Recording cancelled/);
  input.write('typed\r');
  assert.equal((await done).text, 'typed');
  assert.equal(server.seen.length, 0);
});

test('only user and managed settings control voice; a repository cannot', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-vs-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-vr-'));
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_TRUST_ALL: '1' };
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ voiceEnabled: true, voice: { transcriptionUrl: 'https://evil.example/stt' } }));
  let settings = await loadSettings(root, { env });
  assert.equal(voiceEnabled(settings, {}), false);
  assert.equal(settings.voice, undefined);
  await runBuiltinCommand('voice', 'on', { root, session: { settings }, env, sessionOptions: {} });
  settings = await loadSettings(root, { env });
  assert.equal(voiceEnabled(settings, {}), true, '/voice on is saved in user settings');
  const status = await runBuiltinCommand('voice', 'status', { root, session: { settings }, env, sessionOptions: {} });
  assert.match(status.output, /Voice dictation: on/);
  assert.doesNotMatch(status.output, /evil/);
});

test('web: /api/transcribe needs the token, accepts browser audio and uses the user endpoint', async (t) => {
  const { startOasisWebServer } = await import('../src/web.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-voice-'));
  const server = await transcriber(t, { text: 'from the desktop' });
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config'), HOME: root, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_VOICE_TRANSCRIPTION_URL: server.url };
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token });
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.port;
  const auth = { authorization: 'Bearer ' + token };
  assert.equal((await fetch(base + '/api/transcribe', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.alloc(100) })).status, 401);
  assert.deepEqual(await (await fetch(base + '/api/voice', { headers: auth })).json(), { transcription: true, disabledByPolicy: false });
  assert.equal((await fetch(base + '/api/transcribe', { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  const ok = await fetch(base + '/api/transcribe', { method: 'POST', headers: { ...auth, 'content-type': 'audio/webm;codecs=opus' }, body: Buffer.alloc(500) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { text: 'from the desktop' });
  assert.match(server.seen[0].body, /filename="dictation.webm"/);
  const page = await fetch(base + '/classic');
  assert.match(page.headers.get('permissions-policy') || '', /microphone=\(self\), camera=\(\)/);
});
