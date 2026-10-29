import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Pages launch summary prints Markdown backticks literally', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("echo 'Add the `OASIS_REPO_ADMIN_TOKEN` Actions secret"));
  assert.ok(workflow.includes("then run this workflow again on `main`."));
  assert.ok(!workflow.includes('echo "Add the `OASIS_REPO_ADMIN_TOKEN`'));
});
