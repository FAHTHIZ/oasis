import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');

test('the welcome screen offers a no-key start next to the OpenRouter link', () => {
  assert.match(html, /id="connectKeyless"[^>]*>try a free model that needs no key</);
  assert.match(main, /\$\('connectKeyless'\)\.addEventListener\('click'/);
  assert.match(main, /'https:\/\/text\.pollinations\.ai\/openai'/);
  assert.match(main, /\$\('connectForm'\)\.requestSubmit\(\)/);
});

test('on a phone the context percentage folds into its ring so the model name stays readable', () => {
  const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width:440px\)\{[^\n]*\.usage:not\(\.warn\):not\(\.full\) \.usage-text\{display:none\}/);
  assert.match(main, /label\.className = 'usage-text'/);
});
