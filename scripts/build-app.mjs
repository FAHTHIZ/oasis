#!/usr/bin/env node
// Build the OASIS universal app into a static folder (default: site/app).
// Copies the app, the shared browser-safe src modules it imports, the bundled
// skills with a name/description index, and fonts; stamps the offline cache.
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PACKAGES, appModuleGraph, appPackageDir, skillsIndex } from '../src/app-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(root, outArg > 0 ? process.argv[outArg + 1] : 'site/app');
const srcOut = path.join(path.dirname(out), 'src');
const vendorOut = path.join(path.dirname(out), 'vendor');

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

async function main() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(path.join(root, 'app'), out, { recursive: true });

  const { modules, packages } = await appModuleGraph(root);
  await mkdir(srcOut, { recursive: true });
  for (const file of modules) await cp(file, path.join(srcOut, path.basename(file)));
  // Browser builds of npm packages the shared modules import (see the app's import map).
  await rm(vendorOut, { recursive: true, force: true });
  const vendorFiles = [];
  for (const name of packages) {
    const target = path.join(vendorOut, name, path.dirname(APP_PACKAGES[name]));
    await cp(appPackageDir(root, name), target, { recursive: true });
    for (const license of ['LICENSE', 'LICENSE.md']) {
      try { await cp(path.join(root, 'node_modules', name, license), path.join(vendorOut, name, license)); } catch {}
    }
    vendorFiles.push(...await walk(path.join(vendorOut, name)));
  }

  const index = await skillsIndex(root);
  for (const skill of index) await cp(path.join(root, 'skills', path.dirname(skill.path)), path.join(out, 'skills', path.dirname(skill.path)), { recursive: true });
  await mkdir(path.join(out, 'skills'), { recursive: true });
  await writeFile(path.join(out, 'skills', 'index.json'), JSON.stringify(index, null, 1) + '\n');

  const fonts = path.join(root, 'site', 'assets', 'fonts');
  await mkdir(path.join(out, 'fonts'), { recursive: true });
  for (const font of ['geist.woff2', 'jetbrains-mono.woff2', 'LICENSES-OFL.txt']) {
    try { await cp(path.join(fonts, font), path.join(out, 'fonts', font)); } catch { /* fonts are optional; system fonts take over */ }
  }

  const hash = createHash('sha256');
  for (const file of (await walk(out)).sort()) hash.update(path.relative(out, file)).update(await readFile(file));
  for (const file of modules) hash.update(await readFile(file));
  for (const file of vendorFiles.sort()) hash.update(await readFile(file));
  const build = hash.digest('hex').slice(0, 12);
  const sw = path.join(out, 'sw.js');
  await writeFile(sw, (await readFile(sw, 'utf8')).replace('__BUILD__', build));
  console.log('Built OASIS app into ' + path.relative(root, out) + ' (' + modules.length + ' shared modules, ' + packages.length + ' packages, ' + index.length + ' skills, build ' + build + ').');
}

main().catch((error) => { console.error(error.message); process.exit(1); });
