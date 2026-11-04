import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { receiveAttachments, guessAudioType, gatewayTranscriber } from '../src/gateway-core.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-gw-voice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const file = (name, mime, text = 'audio-bytes') => ({ name, mime, size: text.length, download: async () => Buffer.from(text) });

test('audio types are recognized from MIME type or extension', () => {
  assert.equal(guessAudioType('voice.ogg', 'audio/ogg'), 'audio/ogg');
  assert.equal(guessAudioType('note', 'audio/opus'), 'audio/ogg');
  assert.equal(guessAudioType('clip.m4a', ''), 'audio/mp4');
  assert.equal(guessAudioType('clip.webm', 'application/octet-stream'), 'audio/webm');
  assert.equal(guessAudioType('photo.jpg', 'image/jpeg'), '');
  assert.equal(guessAudioType('notes.txt', 'text/plain'), '');
});

test('a voice note on its own becomes the request, with the audio saved', async (t) => {
  const root = await workspace(t);
  const calls = [];
  const transcribe = async (bytes, type) => { calls.push({ bytes: bytes.toString(), type }); return 'Fix the failing login test please'; };
  const result = await receiveAttachments(root, '', [file('voice-abc.ogg', 'audio/ogg')], { transcribe, now: new Date('2026-11-04T10:00:00Z') });
  assert.deepEqual(calls, [{ bytes: 'audio-bytes', type: 'audio/ogg' }]);
  assert.match(result.text, /^Fix the failing login test please\n\n\[Sent as a voice message/);
  assert.equal(result.saved.length, 1);
  assert.equal(await readFile(path.join(root, result.saved[0].path), 'utf8'), 'audio-bytes');
});

test('audio sent with text or other files is attached as a transcript', async (t) => {
  const root = await workspace(t);
  const transcribe = async () => 'meeting notes: ship on Friday';
  const result = await receiveAttachments(root, 'summarize this recording', [file('call.mp3', 'audio/mpeg'), file('readme.txt', 'text/plain', 'hi')], { transcribe });
  assert.match(result.text, /^summarize this recording/);
  assert.match(result.text, /\[Transcript of \.oasis\/inbox\/[^\]]+call\.mp3\]\nmeeting notes: ship on Friday/);
  assert.match(result.text, /readme\.txt/);
});

test('a failed transcription keeps the file and says so, without "Not saved"', async (t) => {
  const root = await workspace(t);
  const transcribe = async () => { throw new Error('Transcription failed (HTTP 401)'); };
  const result = await receiveAttachments(root, '', [file('voice.ogg', 'audio/ogg')], { transcribe });
  assert.equal(result.saved.length, 1);
  assert.doesNotMatch(result.text, /Not saved/);
  assert.match(result.text, /Could not transcribe: voice\.ogg \(Transcription failed \(HTTP 401\)/);
});

test('without a transcriber, audio is just a saved file', async (t) => {
  const root = await workspace(t);
  const result = await receiveAttachments(root, '', [file('voice.ogg', 'audio/ogg')]);
  assert.match(result.text, /Look at the attached file/);
  assert.equal(result.transcripts.length, 0);
});

test('gateway transcription is opt-in: no upload unless voice or OASIS_GATEWAY_TRANSCRIBE is on', async () => {
  const realFetch = globalThis.fetch;
  const uploads = [];
  globalThis.fetch = async (url) => { uploads.push(String(url)); return new Response(JSON.stringify({ text: 'hello there' }), { status: 200 }); };
  try {
    const base = { OPENAI_API_KEY: 'sk-test', HOME: os.tmpdir() };
    assert.equal(await gatewayTranscriber(base, {})(Buffer.from('x'), 'audio/ogg'), null);
    assert.equal(gatewayTranscriber({ ...base, OASIS_GATEWAY_TRANSCRIBE: '0', OASIS_VOICE: '1' }, {}), null);
    assert.equal(uploads.length, 0);
    assert.equal(await gatewayTranscriber({ ...base, OASIS_GATEWAY_TRANSCRIBE: '1' }, {})(Buffer.from('x'), 'audio/ogg'), 'hello there');
    assert.equal(await gatewayTranscriber({ ...base, OASIS_VOICE: '1' }, {})(Buffer.from('x'), 'audio/ogg'), 'hello there');
    assert.equal(await gatewayTranscriber(base, { voice: { enabled: true } })(Buffer.from('x'), 'audio/ogg'), 'hello there');
    assert.equal(uploads.length, 3);
    assert.match(uploads[0], /audio\/transcriptions$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { createTelegramGateway } from '../src/gateway-telegram.mjs';
import { speakableText, voiceReplyMode } from '../src/tts.mjs';

test('speakableText drops code, links and markup and caps length', () => {
  const text = speakableText('## Fixed\n\nI changed `login.js`:\n\n```js\nconst a = 1;\n```\n\nSee [the docs](https://example.com) or https://x.y/z.\n\n| a | b |\n|---|---|\n\n- **All** tests pass.');
  assert.equal(text, 'Fixed\nI changed login.js:\n(code omitted)\nSee the docs or a link.\nAll tests pass.');
  const long = speakableText('One sentence. '.repeat(300), 200);
  assert.ok(long.length < 260 && long.endsWith('The full reply is in the text message.'));
  assert.equal(voiceReplyMode(''), 'off');
  assert.equal(voiceReplyMode('auto'), 'auto');
  assert.equal(voiceReplyMode('always'), 'always');
});

function telegramHarness(t, { voiceReply, speechConfig, transcribe }) {
  const TOKEN = '123456:' + 'A'.repeat(30);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/file/bot')) return new Response(Buffer.from('OggS-voice-note'));
    if (url.endsWith('/audio/speech')) { calls.push({ method: 'speech', body: JSON.parse(init.body) }); return new Response(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)]), { headers: { 'content-type': 'audio/ogg' } }); }
    const method = url.split('/').pop();
    if (method === 'sendVoice') { calls.push({ method, form: init.body }); return new Response(JSON.stringify({ ok: true, result: {} })); }
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === 'getFile' ? { file_path: 'voice/file_1.oga' } : true }));
  };
  const prompts = [];
  const agent = { createSession: async () => ({ messages: [], config: {}, permissions: { mode: 'default' } }), runAgentTurn: async (_s, text) => { prompts.push(text); return { text: 'All **12** tests pass now.\n\n```\nok\n```' }; } };
  return {
    calls, prompts,
    gateway: createTelegramGateway({ token: TOKEN, allowedChats: new Set(['42']), fetchImpl, root: t.root, voiceReply, speechConfig, transcribe, deps: { agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } }, log: () => {} })
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const speechConfig = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'tts-1', voice: 'nova', format: 'mp3' };

test('Telegram: a voice note is transcribed, and with voice replies on "auto" the answer comes back as voice too', async (t) => {
  t.root = await workspace(t);
  const { calls, prompts, gateway } = telegramHarness(t, { voiceReply: 'auto', speechConfig, transcribe: async () => 'run the tests' });
  await gateway.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, voice: { file_id: 'v1', file_unique_id: 'u1', mime_type: 'audio/ogg' } } });
  await settle();
  assert.match(prompts[0], /^run the tests\n\n\[Sent as a voice message/);
  assert.ok(calls.some((c) => c.method === 'sendMessage' && /12\*\* tests pass/.test(c.body.text)), 'the text reply is still sent');
  const speech = calls.find((c) => c.method === 'speech');
  assert.deepEqual({ input: speech.body.input, format: speech.body.response_format, voice: speech.body.voice }, { input: 'All 12 tests pass now.\n(code omitted)', format: 'opus', voice: 'nova' });
  const voice = calls.find((c) => c.method === 'sendVoice');
  assert.equal(voice.form.get('chat_id'), '42');
  assert.equal(voice.form.get('voice').type, 'audio/ogg');

  // A typed message in "auto" mode gets text only.
  calls.length = 0;
  await gateway.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: 'thanks' } });
  await settle();
  assert.ok(calls.some((c) => c.method === 'sendMessage'));
  assert.ok(!calls.some((c) => c.method === 'sendVoice'));
});

test('Telegram: voice replies are off by default and /voice turns them on per chat', async (t) => {
  t.root = await workspace(t);
  const { calls, gateway } = telegramHarness(t, { voiceReply: undefined, speechConfig, transcribe: async () => 'hi' });
  await gateway.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, voice: { file_id: 'v1', mime_type: 'audio/ogg' } } });
  await settle();
  assert.ok(!calls.some((c) => c.method === 'sendVoice'));
  await gateway.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: '/voice on' } });
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.body.text === 'Voice replies: always.'));
  calls.length = 0;
  await gateway.handleUpdate({ update_id: 3, message: { chat: { id: 42 }, text: 'status?' } });
  await settle();
  assert.ok(calls.some((c) => c.method === 'sendVoice'));
});

test('Telegram: /voice explains when text to speech is not configured', async (t) => {
  t.root = await workspace(t);
  const { calls, gateway } = telegramHarness(t, { voiceReply: 'off', speechConfig: null, transcribe: null });
  await gateway.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/voice auto' } });
  assert.match(calls.find((c) => c.method === 'sendMessage').body.text, /not configured yet/);
});
