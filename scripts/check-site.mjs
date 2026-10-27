import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const required = [
  '<!doctype html>', 'id="view-home"', 'id="view-projects"',
  'id="view-tasks"', 'id="view-notes"', 'id="dashboardProjects"',
  'id="allProjects"', 'id="allTasks"', 'id="notesEditor"',
  'id="exportBtn"', 'id="importFile"', 'localStorage',
  'function exportBackup()', 'function importBackup(file)',
  'prefers-reduced-motion', 'aria-live="polite"'
];
for (const marker of required) {
  assert.ok(html.includes(marker), 'Missing required app feature/anchor: ' + marker);
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
assert.equal(scripts.length, 1, 'Expected exactly one inline application script.');
assert.ok(scripts[0][1].trim().length > 0, 'Inline app script must not be empty.');
new Function(scripts[0][1]);
assert.ok(!/<script[^>]+src=/i.test(html), 'The starter should not depend on external scripts.');
console.log('Oasis integrity checks passed: views, persistence, backup/import, accessibility markers, and JavaScript syntax.');
