import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const ws = process.argv[2];
const logs = path.join(ws, 'logs');
const moved = ['app-2026-10-30.log', 'app-2026-11-01.log', 'app-2026-11-02.log', 'app-2026-11-03.log', 'app-2026-11-04.log'];
for (const name of moved) {
  assert.ok(!existsSync(path.join(logs, name)), name + ' left logs/');
  assert.ok(existsSync(path.join(logs, 'archive', name.slice(4, 11), name)), name + ' is archived by month');
}
for (const day of [5, 6, 7, 8]) assert.ok(existsSync(path.join(logs, 'app-2026-11-0' + day + '.log')), 'newer log stays');
assert.ok(existsSync(path.join(logs, 'README.md')));
const manifest = JSON.parse(readFileSync(path.join(logs, 'archive', 'manifest.json'), 'utf8'));
assert.deepEqual(manifest.moved.map((item) => item.file).sort(), moved);
for (const item of manifest.moved) assert.equal(item.to, 'archive/' + item.file.slice(4, 11) + '/' + item.file);
// The script itself, on a fresh directory.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'oasis-eval-logs-'));
try {
  const dir = path.join(tmp, 'd');
  mkdirSync(dir);
  for (const name of ['app-2025-12-31.log', 'app-2026-01-02.log', 'app-2026-01-03.log', 'notes.txt']) writeFileSync(path.join(dir, name), 'x\n');
  const script = path.join(ws, 'scripts', 'archive-logs.mjs');
  const bad = spawnSync(process.execPath, [script, '--before', 'yesterday', '--dir', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 2, 'invalid date exits 2');
  assert.ok(!existsSync(path.join(dir, 'archive')), 'invalid date changes nothing');
  const run = spawnSync(process.execPath, [script, '--before', '2026-01-03', '--dir', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(path.join(dir, 'archive', '2025-12', 'app-2025-12-31.log')));
  assert.ok(existsSync(path.join(dir, 'archive', '2026-01', 'app-2026-01-02.log')));
  assert.ok(existsSync(path.join(dir, 'app-2026-01-03.log')), 'the boundary day is not before');
  assert.ok(existsSync(path.join(dir, 'notes.txt')));
  writeFileSync(path.join(dir, 'app-2026-01-01.log'), 'x\n');
  const again = spawnSync(process.execPath, [script, '--before', '2026-01-03', '--dir', dir], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  const second = JSON.parse(readFileSync(path.join(dir, 'archive', 'manifest.json'), 'utf8'));
  assert.equal(second.moved.length, 3, 'a second run appends to the manifest');
} finally { rmSync(tmp, { recursive: true, force: true }); }
