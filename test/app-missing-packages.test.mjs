import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PACKAGES, appPackageDir, missingAppPackages } from '../src/app-server.mjs';

test('missingAppPackages names browser packages a stale checkout lacks', async () => {
  // A git pull without npm install served the app without highlight.js and
  // DOMPurify; the page then sat on "Connecting…" with no hint.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(missingAppPackages(repo), []);
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-app-pkgs-'));
  for (const name of Object.keys(APP_PACKAGES).filter((n) => n !== 'dompurify' && n !== 'highlight.js')) {
    const dir = appPackageDir(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, path.basename(APP_PACKAGES[name])), '');
  }
  assert.deepEqual(missingAppPackages(root).sort(), ['dompurify', 'highlight.js']);
});
