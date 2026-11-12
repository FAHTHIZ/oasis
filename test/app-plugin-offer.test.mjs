import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('marketplace offer row sits inside its own list (no stray bullet)', async () => {
  const main = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
  const body = main.slice(main.indexOf('function renderClaudePlugins'), main.indexOf("const items = searchMarketplace"));
  assert.doesNotMatch(body, /\$\('ccInstalled'\)\.after\(offer\)/);
  assert.match(body, /list\.className = 'connection-list'/);
  assert.match(body, /list\.append\(offer\)/);
});
