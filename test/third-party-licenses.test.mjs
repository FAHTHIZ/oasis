// Production dependency licenses must be ones THIRD-PARTY-NOTICES.md accounts for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

// Permissive licenses that need only attribution.
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0']);
// Licenses reviewed one by one in THIRD-PARTY-NOTICES.md, with the package that may carry them.
const REVIEWED = new Map([
  ['(MPL-2.0 OR Apache-2.0)', /^node_modules\/dompurify$/],
  ['(BSD-3-Clause OR GPL-2.0)', /^node_modules\/node-forge$/],
  ['EPL-2.0', /^node_modules\/elkjs$/],
  ['LGPL-3.0-or-later', /^node_modules\/@img\/sharp-libvips-[^/]+$/],
  ['Apache-2.0 AND LGPL-3.0-or-later', /^node_modules\/@img\/sharp-[^/]+$/],
  ['Apache-2.0 AND LGPL-3.0-or-later AND MIT', /^node_modules\/@img\/sharp-wasm32$/]
]);

test('every production dependency has a permissive or reviewed license', async () => {
  const lock = JSON.parse(await read('package-lock.json'));
  const problems = [];
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || entry.dev || entry.link) continue;
    const license = entry.license;
    if (PERMISSIVE.has(license)) continue;
    const allowed = REVIEWED.get(license);
    if (allowed && allowed.test(key)) continue;
    problems.push(key + '@' + entry.version + ': ' + (license || 'no license field'));
  }
  assert.deepEqual(problems, [], 'Review these licenses and record them in THIRD-PARTY-NOTICES.md');
});

test('THIRD-PARTY-NOTICES.md covers the vendored files and ships in the package', async () => {
  const [notices, pkgText] = await Promise.all([read('THIRD-PARTY-NOTICES.md'), read('package.json')]);
  for (const file of ['assets/vendor/xterm.js', 'assets/vendor/xterm-addon-fit.js', 'app/vendor/sucrase.mjs', 'app/icons/lucide.svg', 'app/fonts/geist.woff2', 'app/fonts/jetbrains-mono.woff2', 'skills/ponytail', 'src/data']) {
    assert.ok(notices.includes(file), 'THIRD-PARTY-NOTICES.md must list ' + file);
  }
  for (const name of ['dompurify', 'node-forge', 'elkjs', 'sharp']) assert.ok(notices.includes(name), 'THIRD-PARTY-NOTICES.md must explain ' + name);
  assert.ok(JSON.parse(pkgText).files.includes('THIRD-PARTY-NOTICES.md'));
});
