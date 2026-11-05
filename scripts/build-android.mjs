#!/usr/bin/env node
// Copies the built universal app into the Android project's assets, so the
// APK carries the whole app and runs with no connection.
//   node scripts/build-app.mjs && node scripts/build-android.mjs
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');
const out = join(root, 'android', 'app', 'build', 'web-assets', 'web');

for (const dir of ['app', 'src']) {
  try { await stat(join(site, dir)); } catch { throw new Error('Run node scripts/build-app.mjs first: site/' + dir + ' is missing.'); }
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(site, 'app'), join(out, 'app'), { recursive: true });
await cp(join(site, 'src'), join(out, 'src'), { recursive: true });
console.log('Android assets ready: ' + out);
