import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { friendlyStartError } = require('../ide/vscode/src/chat-process.js');

test('VS Code explains when the OASIS command is missing', () => {
  const message = friendlyStartError({ code: 'ENOENT', message: 'spawn oasis ENOENT' }, 'oasis');
  assert.match(message, /could not be found/i);
  assert.match(message, /Install it/i);
  assert.match(message, /oasis\.command/);
});

test('VS Code explains how to recover from command permission errors', () => {
  const message = friendlyStartError({ code: 'EACCES', message: 'permission denied' }, '/opt/oasis/oasis');
  assert.match(message, /refused to run/i);
  assert.match(message, /executable/i);
  assert.match(message, /oasis\.command/);
});

test('unexpected startup errors include a next step and doctor hint', () => {
  const message = friendlyStartError({ code: 'UNKNOWN', message: 'unexpected failure' }, 'custom-oasis');
  assert.match(message, /custom-oasis/);
  assert.match(message, /Check the command setting/i);
  assert.match(message, /oasis doctor/);
});
