import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_PALETTE_COMMANDS, APP_KEYBOARD_SHORTCUTS, searchAppCommands } from '../app/core/command-palette.mjs';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8');

test('browser command panel indexes real workspace actions and integrations', () => {
  assert.ok(APP_PALETTE_COMMANDS.some((item) => item.id === 'new-chat'));
  assert.ok(APP_PALETTE_COMMANDS.some((item) => item.id === 'open-plugins'));
  assert.ok(APP_PALETTE_COMMANDS.some((item) => item.id === 'keyboard-help'));
  assert.deepEqual(searchAppCommands('plugins skills').map((item) => item.id), ['open-plugins']);
  assert.deepEqual(searchAppCommands('new chat').map((item) => item.id), ['new-chat']);
  assert.ok(searchAppCommands('provider').some((item) => item.id === 'open-settings'));
  assert.deepEqual(searchAppCommands('no-such-command'), []);
});

test('browser workspace exposes an accessible native command panel and shortcut guide', () => {
  assert.match(html, /id="commandPaletteButton"/);
  assert.match(html, /<dialog[^>]*id="commandPaletteDialog"/);
  assert.match(html, /id="commandPaletteInput"/);
  assert.match(html, /id="commandPaletteResults"[^>]*role="listbox"/);
  assert.match(html, /<dialog[^>]*id="shortcutsDialog"/);
  assert.match(html, /id="shortcutsFilter"/);
  assert.match(main, /event\.key\.toLowerCase\(\)==='k'/);
  assert.match(main, /event\.key==='\/'/);
  assert.match(main, /searchAppCommands\(/);
  assert.match(css, /\.native-dialog::backdrop/);
  assert.match(css, /\.command-result\[aria-selected="true"\]/);
});

test('keyboard guide documents only shortcuts wired by the browser workspace', () => {
  const keys = APP_KEYBOARD_SHORTCUTS.map((item) => item.keys);
  assert.ok(keys.includes('MOD+K'));
  assert.ok(keys.includes('MOD+/'));
  assert.ok(keys.includes('/'));
  assert.ok(keys.includes('Shift+Enter'));
  assert.ok(keys.includes('Escape'));
  assert.equal(APP_KEYBOARD_SHORTCUTS.length, 8);
});
