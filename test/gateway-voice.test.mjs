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
