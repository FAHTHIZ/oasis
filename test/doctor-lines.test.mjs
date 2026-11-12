import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorProviderLine, doctorToolLine } from '../src/cli-doctor.mjs';

const ollama = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' };

test('doctor names a local Ollama server instead of a bare host:port', () => {
  assert.equal(doctorProviderLine({ provider: '127.0.0.1:11434', protocol: 'openai-compatible' }, ollama), 'Ollama (this device) at 127.0.0.1:11434 (openai-compatible)');
  assert.equal(doctorProviderLine({ provider: 'openrouter.ai', protocol: 'openai-compatible' }, { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1' }), 'openrouter.ai (openai-compatible)');
  assert.equal(doctorProviderLine({ provider: 'anthropic', protocol: 'anthropic' }, { protocol: 'anthropic' }), 'anthropic (anthropic)');
});

test('a missing ollama command is not reported as a problem while its server is in use', () => {
  assert.match(doctorToolLine('ollama', false, ollama), /not on PATH \(fine: OASIS uses the Ollama server/);
  assert.equal(doctorToolLine('ollama', false, { protocol: 'anthropic' }), 'ollama: not found');
  assert.equal(doctorToolLine('ollama', true, ollama), 'ollama: available');
  assert.equal(doctorToolLine('brew', false, ollama), 'brew: not found');
});
