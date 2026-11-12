import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('settings textareas use the shared field style (the routine task box rendered small and inline)', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, /<textarea class="field" id="routinePrompt"/);
  for (const match of html.matchAll(/<textarea\b[^>]*>/g)) {
    if (/id="(input|editor)"/.test(match[0])) continue; // composer and editor have their own styles
    assert.match(match[0], /class="[^"]*\bfield\b/, match[0]);
  }
});
