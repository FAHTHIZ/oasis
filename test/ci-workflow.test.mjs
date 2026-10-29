import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Pages launch summary prints Markdown backticks literally', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /echo 'Add the `OASIS_REPO_ADMIN_TOKEN` Actions secret[\s\S]*?`main`.'/);
  assert.doesNotMatch(workflow, /echo "Add the `OASIS_REPO_ADMIN_TOKEN`/);
});
