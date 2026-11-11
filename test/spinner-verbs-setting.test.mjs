import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createActivityIndicator, spinnerVerbPool, waitLabel } from '../src/activity-indicator.mjs';
import { loadSettings } from '../src/settings.mjs';

test('spinnerVerbPool: append keeps the built-in word, replace uses only the custom verbs', () => {
  assert.deepEqual(spinnerVerbPool(null), []);
  assert.deepEqual(spinnerVerbPool({ mode: 'append', verbs: ['Pondering'] }), [null, 'Pondering']);
  assert.deepEqual(spinnerVerbPool({ mode: 'replace', verbs: ['Pondering', 'Crafting'] }), ['Pondering', 'Crafting']);
  // Claude Code keeps the built-in verbs for replace with an empty list.
  assert.deepEqual(spinnerVerbPool({ mode: 'replace', verbs: [] }), []);
});

test('a spinner verb replaces only the generic label, never an informative one', () => {
  assert.equal(waitLabel({ verb: 'Pondering' }, 0), 'Pondering');
  assert.equal(waitLabel({ verb: 'Pondering', step: 3 }, 0), 'Pondering');
  assert.equal(waitLabel({ verb: 'Pondering' }, 50000), 'Still waiting for the model');
  assert.equal(waitLabel({ verb: 'Pondering', rateLimitMs: 9000 }, 0), 'Rate limited');
  assert.equal(waitLabel({ verb: 'Pondering', label: 'Compacting' }, 0), 'Compacting');
});

test('the live indicator draws a verb from the setting on each wait', () => {
  const writes = [];
  const stream = { isTTY: true, columns: 120, write: (chunk) => writes.push(chunk) };
  const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
  const indicator = createActivityIndicator({ stream, env: { OASIS_MOTION: 'full' }, color: false, verbs: () => ({ mode: 'replace', verbs: ['Pondering', 'Crafting'] }), random: () => 0.9, timers, now: () => 0 });
  indicator.start({});
  indicator.stop();
  assert.match(writes.join(''), /Crafting… · 0s/);
});

test('spinnerVerbs loads from any settings file, including an untrusted project, without control characters', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-spinner-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'repo');
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ spinnerVerbs: { mode: 'replace', verbs: ['Brewing\u001b[31m', '', 42, 'Herding cats'] } }));
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), OASIS_MANAGED_SETTINGS: '' };
  const settings = await loadSettings(root, { env });
  assert.equal(settings.trusted, false);
  assert.deepEqual(settings.spinnerVerbs, { mode: 'replace', verbs: ['Brewing[31m', 'Herding cats'] });
});
