// A mistyped slash command (/sttaus) only said "Unknown command. Type /help".
// It now names the closest built-in command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { slashCommandHint } from '../src/slash.mjs';

test('a mistyped slash command suggests the closest built-in', () => {
  assert.equal(slashCommandHint('/sttaus'), '/status');
  assert.equal(slashCommandHint('/compcat now'), '/compact');
  assert.equal(slashCommandHint('/modle'), '/model');
  assert.equal(slashCommandHint('/xyzzyplugh'), '');
  assert.equal(slashCommandHint('not a command'), '');
});
