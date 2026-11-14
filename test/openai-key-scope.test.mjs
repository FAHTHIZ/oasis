// OPENAI_API_KEY often holds another provider's key: OPENAI_BASE_URL (or
// OASIS_BASE_URL without OASIS_API_KEY) points the chat client at OpenRouter,
// OVH or a company gateway. Image generation, text to speech and voice
// transcription used to send that key to api.openai.com whenever their own
// endpoint was the default, leaking it to a third party.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAIPlatformKey } from '../src/config.mjs';
import { imageGenerationConfig } from '../src/image-gen.mjs';
import { textToSpeechConfig } from '../src/tts.mjs';
import { transcriptionTarget } from '../src/voice.mjs';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

const foreign = [
  { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' },
  { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1' },
  { OPENAI_API_KEY: KEY, OASIS_BASE_URL: 'https://gateway.example.com/v1' },
  { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'not a url' }
];

test('OPENAI_API_KEY that serves another provider is not used for OpenAI media APIs', () => {
  for (const env of foreign) {
    assert.equal(openAIPlatformKey(env), '', JSON.stringify(env));
    assert.equal(imageGenerationConfig(env), null, 'image: ' + JSON.stringify(env));
    assert.equal(textToSpeechConfig(env), null, 'speech: ' + JSON.stringify(env));
    assert.equal(transcriptionTarget({}, env).apiKey, '', 'voice: ' + JSON.stringify(env));
  }
});

test('a real OpenAI key is still used for images, speech and transcription', () => {
  for (const env of [
    { OPENAI_API_KEY: KEY },
    { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://api.openai.com/v1' },
    // OASIS_API_KEY is the gateway's key, so OPENAI_API_KEY is OpenAI's own.
    { OPENAI_API_KEY: KEY, OASIS_BASE_URL: 'https://gateway.example.com/v1', OASIS_API_KEY: 'gw-key-123456789' }
  ]) {
    assert.equal(openAIPlatformKey(env), KEY, JSON.stringify(env));
    assert.equal(imageGenerationConfig(env).apiKey, KEY);
    assert.equal(textToSpeechConfig(env).apiKey, KEY);
    assert.equal(transcriptionTarget({}, env).apiKey, KEY);
  }
});

test('feature-specific keys still work with a foreign OPENAI_BASE_URL', () => {
  const env = { ...foreign[0], OASIS_IMAGE_API_KEY: 'img-key-1234567890', OASIS_TTS_API_KEY: 'tts-key-1234567890', OASIS_VOICE_API_KEY: 'voice-key-123456789' };
  assert.equal(imageGenerationConfig(env).apiKey, 'img-key-1234567890');
  assert.equal(textToSpeechConfig(env).apiKey, 'tts-key-1234567890');
  assert.equal(transcriptionTarget({}, env).apiKey, 'voice-key-123456789');
});
