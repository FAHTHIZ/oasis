import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PACKAGES, missingAppPackages } from '../src/app-server.mjs';

test('missingAppPackages names browser packages a stale checkout lacks', async () => {
  // A git pull without npm install served the app without highlight.js and
  // DOMPurify; the page then sat on "Connecting…" with no hint.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(missingAppPackages(repo), []);
  const empty = await mkdtemp(path.join(os.tmpdir(), 'oasis-app-pkgs-'));
  assert.deepEqual(missingAppPackages(empty), Object.keys(APP_PACKAGES));
});
