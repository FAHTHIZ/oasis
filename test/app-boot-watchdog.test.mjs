import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

const APP = new URL('../app/', import.meta.url);
const source = await readFile(new URL('boot-watchdog.js', APP), 'utf8');

function boot() {
  const { window, document } = parseHTML('<!doctype html><html><body><p>Connecting…</p></body></html>');
  const timers = [];
  const listeners = [];
  const env = {
    window: { addEventListener: (type, fn) => listeners.push(fn) }, document, location: { origin: 'http://127.0.0.1:3920', reload() { env.reloaded = true; } },
    performance: { getEntriesByType: () => [] },
    ErrorEvent: class ErrorEvent {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}
  };
  new Function(...Object.keys(env), source)(...Object.values(env));
  return { env, document, window, timers, fire: (event) => listeners.forEach((fn) => fn(event)) };
}

test('index.html loads the watchdog before the module graph and main.mjs marks itself booted', async () => {
  const html = await readFile(new URL('index.html', APP), 'utf8');
  assert.ok(html.indexOf('<script src="boot-watchdog.js"></script>') < html.indexOf('<script type="module" src="main.mjs">'));
  const main = await readFile(new URL('main.mjs', APP), 'utf8');
  const firstStatement = main.split('\n').findIndex((line) => line && !line.startsWith('import ') && !line.startsWith('//'));
  assert.match(main.split('\n')[firstStatement], /dataset\.booted = '1'/, 'set right after the imports');
});

test('a failed module script shows the restart message with its URL and a Reload button', () => {
  const { env, document, window, fire } = boot();
  const script = document.createElement('script');
  script.src = 'http://127.0.0.1:3920/vendor/tinykeys/dist/tinykeys.mjs';
  fire({ target: script });
  const box = document.querySelector('.boot-failure');
  assert.ok(box);
  assert.match(box.textContent, /could not load part of the app \(\/vendor\/tinykeys\/dist\/tinykeys\.mjs\)\. Restart oasis web/);
  box.querySelector('button').dispatchEvent(new window.Event('click'));
  assert.equal(env.reloaded, true);
});

test('silence past the deadline shows the message; a booted app never does', () => {
  const late = boot();
  late.timers[0]();
  assert.ok(late.document.querySelector('.boot-failure'));
  const fine = boot();
  fine.document.documentElement.dataset.booted = '1';
  fine.timers[0]();
  assert.equal(fine.document.querySelector('.boot-failure'), null);
});
