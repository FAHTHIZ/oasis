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
  assert.equal(searchAppCommands('termnal')[0].id, 'open-terminal', 'tolerates a missing letter');
  assert.equal(searchAppCommands('log out')[0].id, 'sign-out', 'terms may match keywords');
  assert.equal(searchAppCommands('').length, APP_PALETTE_COMMANDS.length, 'an empty query lists every command in order');
});

test('browser workspace exposes an accessible native command panel and shortcut guide', () => {
  assert.ok(html.includes('id="commandPaletteButton"'));
  assert.ok(html.includes('id="commandPaletteDialog"'));
  assert.ok(html.includes('id="commandPaletteInput"'));
  assert.ok(html.includes('id="commandPaletteResults" role="listbox"'));
  assert.ok(html.includes('id="shortcutsDialog"'));
  assert.ok(html.includes('id="shortcutsFilter"'));
  assert.ok(main.includes("'$mod+KeyK':"), 'MOD+K opens the palette (tinykeys)');
  assert.ok(main.includes("'[Shift]+/':"), '/ in the empty message box');
  assert.ok(main.includes('searchAppCommands('));
  assert.ok(css.includes('.native-dialog::backdrop'));
  assert.ok(css.includes('.command-result[aria-selected="true"]'));
});

test('keyboard guide documents only shortcuts wired by the browser workspace', () => {
  const keys = APP_KEYBOARD_SHORTCUTS.map((item) => item.keys);
  assert.ok(keys.includes('MOD+K'));
  assert.ok(keys.includes('MOD+/'));
  assert.ok(keys.includes('/'));
  assert.ok(keys.includes('Shift+Enter'));
  assert.ok(keys.includes('Escape'));
  assert.ok(keys.includes('@'));
  assert.ok(keys.includes('Tab'));
  assert.ok(keys.includes('Shift+Tab'));
  assert.ok(keys.includes('Ctrl+`'));
  assert.ok(keys.includes('MOD+B'));
  assert.ok(keys.includes('MOD+Shift+A'));
  // Each global chord in the guide has its tinykeys binding in main.mjs.
  const bindings = { 'MOD+K': '$mod+KeyK', 'MOD+/': '$mod+[Shift]+Slash', 'Ctrl+`': 'Control+Backquote', 'MOD+B': '$mod+KeyB', 'MOD+Shift+A': '$mod+Shift+KeyA', '?': '[Shift]+?' };
  for (const [guide, binding] of Object.entries(bindings)) {
    if (keys.includes(guide)) assert.ok(main.includes("'" + binding + "':"), guide + ' is wired as ' + binding);
  }
  assert.ok(main.includes("from 'tinykeys'"));
  assert.equal(APP_KEYBOARD_SHORTCUTS.length, 15);
});
