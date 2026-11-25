// The terminal's first-run setup offers the same free, keyless model as the
// web app's "try a free model that needs no key" link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KEYLESS_MODEL_URL, isFreeChoice } from '../src/cli-setup.mjs';

test('free, keyless and "no key" pick the keyless model; keys and links do not', () => {
  for (const text of ['free', 'FREE', ' keyless ', 'no key']) assert.equal(isFreeChoice(text), true, text);
  for (const text of ['', 'freedom', 'sk-free', 'https://free.example/v1', 'later']) assert.equal(isFreeChoice(text), false, text);
});

test('the terminal and the web app use the same keyless endpoint', async () => {
  const app = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes("'" + KEYLESS_MODEL_URL + "'"), 'app/main.mjs connects to ' + KEYLESS_MODEL_URL);
  const setup = await readFile(new URL('../src/cli-setup.mjs', import.meta.url), 'utf8');
  assert.match(setup, /4\. Try a free model that needs no key/);
  assert.match(setup, /Type free to try a free model/);
});
