import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');

test('the "Other devices and terminal" list offers Archive for saved, idle sessions', () => {
  const body = app.slice(app.indexOf('async function renderRuntimeSessions()'), app.indexOf('async function openRuntimeSession('));
  assert.match(body, /if \(!item\.running && !item\.unsaved\)/, 'running or unsaved sessions cannot be archived');
  assert.match(body, /'\/api\/sessions\/' \+ encodeURIComponent\(item\.id\) \+ '\/archive', \{ method: 'POST' \}/);
  assert.match(body, /aria-label', 'Archive session /);
  assert.match(body, /oasis sessions unarchive/, 'the toast says how to undo');
  assert.match(body, /void renderRuntimeSessions\(\)/, 'the list refreshes after archiving');
});
