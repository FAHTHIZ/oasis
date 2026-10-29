import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Pages launch summary prints Markdown backticks literally', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("echo 'Add the `OASIS_REPO_ADMIN_TOKEN` Actions secret"));
  assert.ok(workflow.includes("then run this workflow again on `main`."));
  assert.ok(!workflow.includes('echo "Add the `OASIS_REPO_ADMIN_TOKEN`'));
});

test('main revisions receive unique CI groups while superseded PR runs remain cancellable', async () => {
  const cases = [
    {
      path: '../.github/workflows/quality.yml',
      group: "group: oasis-quality-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
      cancel: "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"
    },
    {
      path: '../.github/workflows/pages.yml',
      group: "group: oasis-public-launch-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
      cancel: "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"
    },
    {
      path: '../.github/workflows/desktop-build.yml',
      group: 'group: oasis-desktop-${{ github.sha }}',
      cancel: 'cancel-in-progress: false'
    }
  ];

  for (const item of cases) {
    const workflow = await readFile(new URL(item.path, import.meta.url), 'utf8');
    assert.ok(workflow.includes(item.group), item.path + ' must key main-run concurrency by commit SHA');
    assert.ok(workflow.includes(item.cancel), item.path + ' has incorrect cancellation policy');
    assert.ok(!workflow.includes('cancel-in-progress: true'), item.path + ' must not cancel main-commit verification');
  }
});
