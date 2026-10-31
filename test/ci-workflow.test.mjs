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
    { path: '../.github/workflows/quality.yml', group: 'group: oasis-quality-v8-${{ github.ref }}', cancel: false },
    { path: '../.github/workflows/pages.yml', group: 'group: oasis-public-launch-${{ github.ref }}', cancel: true },
    { path: '../.github/workflows/desktop-build.yml', group: 'group: oasis-desktop-${{ github.ref }}', cancel: true }
  ];
  for (const item of cases) {
    const workflow = await readFile(new URL(item.path, import.meta.url), 'utf8');
    assert.ok(workflow.includes(item.group), item.path + ' must use a per-ref concurrency group');
    assert.ok(workflow.includes('cancel-in-progress: ' + String(item.cancel)), item.path + ' has the wrong cancellation policy');
    const concurrencyGroup = workflow.match(/concurrency:\s*\n\s*group:\s*([^\r\n]+)/);
    assert.ok(concurrencyGroup, item.path + ' must declare a concurrency group');
    assert.ok(!concurrencyGroup[1].includes('${{ github.sha }}'), item.path + ' must not create a separate expensive run for every commit');
  }
  const publishing = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(publishing.includes('group: oasis-public-launch-${{ github.ref }}'));
});

test('public product lifecycle is Beta, not Alpha', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const status = await readFile(new URL('../docs/CURRENT_STATUS.md', import.meta.url), 'utf8');
  assert.match(readme, /status-beta-/);
  assert.match(readme, /OASIS is in beta/i);
  assert.doesNotMatch(readme, /status-alpha|OASIS is in alpha/i);
  assert.match(status, /public product lifecycle is Beta/i);
});

test('desktop release requires a version tag or explicit opt-in from main', async () => {
  const workflow = await readFile(new URL('../.github/workflows/desktop-build.yml', import.meta.url), 'utf8');
  const notes = await readFile(new URL('../docs/releases/v0.4.0.md', import.meta.url), 'utf8');
  assert.ok(workflow.includes("tags: ['v*']"));
  assert.ok(workflow.includes('publish_release:'));
  assert.ok(workflow.includes('default: false'));
  assert.ok(workflow.includes('type: boolean'));
  assert.ok(workflow.includes('inputs.publish_release == true'));
  assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
  assert.ok(workflow.includes('Require same-commit quality, site, and installer gates'));
  for (const name of ['quality.yml', 'pages.yml', 'installer-checks.yml']) assert.ok(workflow.includes(name));
  assert.ok(workflow.includes('target_commitish: ${{ steps.release-version.outputs.target_commitish }}'));
  assert.ok(workflow.includes('make_latest: true'));
  assert.ok(workflow.includes('body_path: ${{ steps.release-version.outputs.notes_path }}'));
  assert.ok(workflow.includes('sha256sum'));
  assert.ok(!workflow.includes('git push origin "$tag"'));
  assert.match(notes, /OASIS 0\.4\.0.*Beta/i);
  assert.match(notes, /unsigned/i);
  assert.match(notes, /SHA256SUMS/);
});
