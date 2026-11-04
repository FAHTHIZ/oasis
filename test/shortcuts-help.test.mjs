import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/oasis-interface.css', import.meta.url), 'utf8');
const guide = readFileSync(new URL('../docs/USER_GUIDE.md', import.meta.url), 'utf8');

test('workspace ships an accessible keyboard shortcuts and help guide', () => {
  assert.match(html, /<dialog class="modal shortcuts-dialog" id="shortcutsDialog" aria-labelledby="shortcutsTitle" aria-describedby="shortcutsIntro">/);
  assert.match(html, /id="shortcutsFilter" type="search"/);
  assert.match(html, /<span class="sr-only">Search shortcuts<\/span>/);
  assert.match(html, /id="sidebarHelpButton" type="button"/);
});

test('guide opens from Ctrl or Cmd plus slash, the palette and the sidebar', () => {
  assert.match(html, /if\(mod&&e\.key==='\/'\)\{e\.preventDefault\(\);window\.oasisShowShortcuts/);
  assert.match(html, /id:'keyboard-help'[^\n]*oasisShowShortcuts/);
  assert.match(html, /\$\('sidebarHelpButton'\)/);
});

test('every global and composer shortcut is explained in plain words', () => {
  for (const phrase of ['Open the command palette', 'Start a new chat', 'Show or hide the terminal', 'Collapse or expand the sidebar',
    'Send your message', 'Add a new line', 'Bring back your last message', 'Steer the current task', 'Queue a message for later',
    'Stop the task', 'What the key names mean', 'On a phone or tablet']) {
    assert.ok(html.includes(phrase), phrase);
  }
});

test('guide is full screen on phones and documented in the user guide', () => {
  assert.match(css, /@media \(max-width:640px\)\{dialog\.shortcuts-dialog\{[^}]*height:100dvh/);
  assert.match(guide, /## Browser workspace keyboard shortcuts/);
  assert.match(guide, /\(#browser-workspace-keyboard-shortcuts\)/);
});

test('language-server notices render as a quiet, expandable note in the browser', () => {
  assert.match(html, /if\(\/\^LSP verification unavailable\/\.test\(para\[0\]\)\)body='<details class="md-note"><summary>One extra code check was skipped\. Show why<\/summary>'\+body\+'<\/details>'/);
  assert.match(css, /\.md details\.md-note\{/);
});
