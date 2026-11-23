import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const ws = process.argv[2];
const items = JSON.parse(readFileSync(path.join(ws, 'notes', 'actions.json'), 'utf8'));
assert.ok(Array.isArray(items));
assert.equal(items.length, 4, 'four commitments, got ' + items.length);
const expect = [['Priya', /budget/i, '2026-11-21'], ['Lena', /flaky upload test/i, '2026-11-25'], ['Tom', /venue/i, '2026-12-01'], ['Lena', /onboarding/i, null]];
for (const [owner, pattern, due] of expect) {
  const item = items.find((entry) => entry.owner === owner && pattern.test(String(entry.action)));
  assert.ok(item, owner + ' ' + pattern);
  assert.equal(item.due ?? null, due);
}
for (const item of items) assert.doesNotMatch(String(item.action), /dashboard|logo/i, 'suggestions are not actions');
