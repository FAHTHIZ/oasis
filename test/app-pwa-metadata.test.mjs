import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('connected workspace is not exposed as a standalone installable PWA', async () => {
  const [html, main] = await Promise.all([
    read('../app/index.html'),
    read('../app/main.mjs')
  ]);
  assert.ok(html.includes('<title>OASIS — Coding Agent Workspace</title>'));
  assert.ok(html.includes('The OASIS connected workspace UI'));
  assert.ok(html.includes('name="robots" content="noindex,nofollow"'));
  assert.ok(!html.includes('rel="manifest"'));
  assert.ok(!html.includes('id="installButton"'));
  assert.ok(!main.includes('beforeinstallprompt'));
  assert.ok(!main.includes('appinstalled'));
  assert.ok(!main.includes("navigator.serviceWorker.register('sw.js')"));
});
