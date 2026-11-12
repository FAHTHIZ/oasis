import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { helpEntry, runBuiltinCommand } from '../src/slash.mjs';
import { hintRows } from '../src/terminal-ui.mjs';

test('help rows wrap between words under the description column', () => {
  const rows = helpEntry('/reload-skills'.padEnd(19), 'Re-scan skill and command directories without losing the conversation', 60);
  assert.ok(rows.length > 1);
  for (const row of rows) assert.ok(row.length <= 59, row);
  assert.equal(rows.join(' ').replace(/\s+/g, ' ').includes('without losing the conversation'), true);
  assert.match(rows[1], /^ {22}\S/);
  // Without a width (piped output, tests) the row is unchanged.
  assert.deepEqual(helpEntry('/x'.padEnd(19), 'one two', undefined), ['  /x                  one two']);
  // Very narrow terminals put the description on its own lines.
  const narrow = helpEntry('/reload-skills'.padEnd(19), 'Re-scan skill and command directories', 40);
  assert.equal(narrow[0], '  /reload-skills');
  for (const row of narrow.slice(1)) { assert.ok(row.length <= 39, row); assert.match(row, /^ {6}\S/); }
});

test('/help output fits the terminal width without splitting words', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-help-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  const { output } = await runBuiltinCommand('help', '', { root: home, env, width: 70 });
  const long = output.split('\n').filter((line) => line.length > 69 && /\s/.test(line.trim()));
  assert.deepEqual(long, []);
  assert.match(output, /\/reload-skills/);
});

test('the startup hint row breaks between items', () => {
  const items = ['? shortcuts', '/ commands', '@ files', '! shell', '# memory', 'Shift+Tab modes'];
  assert.deepEqual(hintRows(items, 200), ['? shortcuts · / commands · @ files · ! shell · # memory · Shift+Tab modes']);
  const rows = hintRows(items, 66);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.length <= 66));
  assert.equal(rows[1], 'Shift+Tab modes');
});
