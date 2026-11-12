import test from 'node:test';
import assert from 'node:assert/strict';
import { serverLabel } from '../app/core/connect.mjs';

test('serverLabel names well-known local model servers instead of host:port', () => {
  assert.equal(serverLabel('http://127.0.0.1:11434/v1'), 'Ollama (this device)');
  assert.equal(serverLabel('http://localhost:1234/v1'), 'LM Studio (this device)');
  assert.equal(serverLabel('http://[::1]:8080/v1'), 'llama.cpp (this device)');
  assert.equal(serverLabel('http://127.0.0.1:9999/v1'), 'Local server :9999 (this device)');
  assert.equal(serverLabel('http://192.168.1.5:11434/v1'), 'Ollama (192.168.1.5:11434)');
  assert.equal(serverLabel('https://api.example.com:11434/v1'), 'api.example.com:11434');
  assert.equal(serverLabel('not a url'), '');
});
