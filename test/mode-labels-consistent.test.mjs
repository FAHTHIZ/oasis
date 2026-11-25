import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const NAMES = { ask: 'Ask first', edits: 'Auto edit', auto: 'Full auto', plan: 'Plan' };
const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');

test('Settings approval options start with the same mode names as the composer chip', () => {
  const select = html.match(/<select id="modeSelect">([\s\S]*?)<\/select>/)[1];
  for (const [value, name] of Object.entries(NAMES)) {
    const label = select.match(new RegExp(`value="${value}"[^>]*>([^<]+)<`))[1];
    assert.ok(label.startsWith(`${name}:`), `${value}: ${label}`);
    assert.match(html, new RegExp(`data-mode="${value}"[^>]*><strong>${name}</strong>`));
  }
  const runtime = main.match(/option\.textContent = (\{ ask: [^}]+\})/)[1];
  for (const [value, name] of Object.entries(NAMES)) assert.match(runtime, new RegExp(`${value}: '${name}:`));
});
