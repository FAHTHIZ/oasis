import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('installable browser app has accurate PWA and social metadata', async () => {
  const [html, manifestText] = await Promise.all([
    read('../app/index.html'),
    read('../app/manifest.webmanifest')
  ]);
  const manifest = JSON.parse(manifestText);
  assert.ok(html.includes('<title>OASIS — Coding Agent Workspace</title>'));
  assert.ok(html.includes('rel="canonical" href="https://fahthiz.github.io/oasis/app/"'));
  assert.ok(html.includes('property="og:title"'));
  assert.ok(html.includes('property="og:description"'));
  assert.ok(html.includes('property="og:image"'));
  assert.ok(html.includes('name="twitter:card"'));
  assert.ok(html.includes('name="twitter:image"'));
  assert.ok(html.includes('rel="manifest" href="manifest.webmanifest"'));
  assert.ok(manifest.name === 'OASIS');
  assert.ok(manifest.description.includes('Installable browser workspace'));
  assert.equal(manifest.display, 'standalone');
  for (const name of ['icons/oasis-192.png', 'icons/oasis-512.png', 'icons/oasis-maskable-512.png']) {
    assert.ok(manifest.icons.some((icon) => icon.src === name), 'Missing PWA icon: ' + name);
  }
});
