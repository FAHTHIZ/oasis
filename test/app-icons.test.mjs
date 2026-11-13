import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { SPRITE_PATH, buildSprite, usedIcons } from '../scripts/vendor-icons.mjs';
import { icon, kindIcon, KIND_ICONS } from '../app/core/icons.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('the Lucide sprite holds exactly the icons the app references', async () => {
  const sprite = await readFile(SPRITE_PATH, 'utf8');
  const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, await usedIcons(root));
  for (const name of Object.values(KIND_ICONS)) assert.ok(ids.includes(name), name);
});

test('the committed sprite matches lucide-static (run node scripts/vendor-icons.mjs)', { skip: !existsSync(new URL('../node_modules/lucide-static/package.json', import.meta.url)) }, async () => {
  assert.equal(await readFile(SPRITE_PATH, 'utf8'), await buildSprite(await usedIcons(root), root));
});

test('the app draws no hand-made inline SVG icons', async () => {
  for (const file of ['../app/index.html', '../app/main.mjs', '../app/activity.mjs']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /<svg[^>]*viewBox/, file + ' has an inline SVG icon; use icon() or the Lucide sprite');
  }
});

test('icon() references the sprite and refuses odd names', () => {
  assert.equal(icon('copy'), '<svg class="icon" aria-hidden="true" focusable="false"><use href="icons/lucide.svg#copy"/></svg>');
  assert.match(icon('x', 'small'), /class="icon small"/);
  assert.match(kindIcon('shell'), /#square-terminal"/);
  assert.match(kindIcon('nope'), /#wrench"/);
  assert.throws(() => icon('"><script>'));
});
