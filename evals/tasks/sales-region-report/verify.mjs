import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const ws = process.argv[2];
const lines = readFileSync(path.join(ws, 'data', 'sales.csv'), 'utf8').trim().split('\n').slice(1);
const seen = new Set(); const by = {}; let total = 0; let skipped = 0;
for (const line of lines) {
  const [id, region, , units, price] = line.split(',');
  const u = Number(units); const p = Number(price);
  if (units === '' || price === '' || !Number.isFinite(u) || !Number.isFinite(p)) { skipped++; continue; }
  if (seen.has(id)) { skipped++; continue; }
  seen.add(id); total += u * p; by[region] = (by[region] || 0) + u * p;
}
const round = (n) => Math.round(n * 100) / 100;
const summary = JSON.parse(readFileSync(path.join(ws, 'report', 'summary.json'), 'utf8'));
assert.deepEqual(Object.keys(summary).sort(), ['byRegion', 'skippedRows', 'topRegion', 'totalRevenue']);
assert.ok(Math.abs(summary.totalRevenue - round(total)) < 0.006, 'totalRevenue');
for (const [region, value] of Object.entries(by)) assert.ok(Math.abs(summary.byRegion[region] - round(value)) < 0.006, 'byRegion.' + region);
assert.equal(Object.keys(summary.byRegion).length, Object.keys(by).length);
const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0][0];
assert.equal(summary.topRegion, top);
assert.equal(summary.skippedRows, skipped);
const md = readFileSync(path.join(ws, 'report', 'summary.md'), 'utf8');
const plain = md.replace(/,/g, '');
assert.ok(plain.includes(round(total).toFixed(2)) || plain.includes(String(round(total))), 'summary.md states the total');
assert.match(md, new RegExp('\\b' + top + '\\b', 'i'));
assert.ok(plain.includes(round(by[top]).toFixed(2)) || plain.includes(String(round(by[top]))), 'summary.md states the top region revenue');
assert.match(md, new RegExp('\\b' + skipped + '\\b'));
