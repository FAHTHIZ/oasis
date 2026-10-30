import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Pages launch summary prints Markdown backticks literally', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("echo 'Add the `OASIS_REPO_ADMIN_TOKEN` Actions secret"));
  assert.ok(workflow.includes("then run this workflow again on `main`."));
  assert.ok(!workflow.includes('echo "Add the `OASIS_REPO_ADMIN_TOKEN`'));
});

test('CI keeps latest pending concurrency per ref and lets active quality runs finish', async () => {
  const cases = [
    { path: '../.github/workflows/quality.yml', group: 'group: oasis-quality-v5-${{ github.ref }}', cancel: false },
    { path: '../.github/workflows/pages.yml', group: 'group: oasis-public-launch-${{ github.ref }}', cancel: true },
    { path: '../.github/workflows/desktop-build.yml', group: 'group: oasis-desktop-${{ github.ref }}', cancel: true }
  ];
  for (const item of cases) {
    const workflow = await readFile(new URL(item.path, import.meta.url), 'utf8');
    assert.ok(workflow.includes(item.group), item.path + ' must use a per-ref concurrency group');
    assert.ok(workflow.includes('cancel-in-progress: ' + String(item.cancel)), item.path + ' has the wrong cancellation policy');
    assert.ok(!workflow.includes('${{ github.sha }}'), item.path + ' must not create a separate expensive run for every commit');
  }
  const publishing = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(publishing.includes('group: oasis-public-launch-${{ github.ref }}'));
});

test('desktop artifacts publish only from explicit package-version tags', async () => {
  const workflow = await readFile(new URL('../.github/workflows/desktop-build.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("tags: ['v*']"), 'version tags must trigger desktop release validation');
  assert.ok(workflow.includes("if: startsWith(github.ref, 'refs/tags/v')"), 'publishing must be restricted to explicit version tags');
  assert.ok(workflow.includes('TAG_NAME: ${{ github.ref_name }}'));
  assert.ok(workflow.includes('expected="v$(node -p "require(\'./package.json\').version")"'));
  assert.ok(!workflow.includes('git push origin "$tag"'), 'the build must not create and publish tags from an ordinary main push');
});
