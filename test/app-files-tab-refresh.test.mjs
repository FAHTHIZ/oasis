import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('picking the Files or Changes tab re-reads the workspace so outside edits show up', async () => {
  const main = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
  const body = main.slice(main.indexOf('function showPanelTab(name)'), main.indexOf('function currentPanelTab()'));
  assert.match(body, /\(name === 'files' \|\| name === 'changes'\) && RT && workspace && !agent\.busy[^\n]*refreshFiles\(\)/);
});
