import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CI keeps latest pending concurrency per ref and lets active quality runs finish', async () => {
  const cases = [
    { path: '../.github/workflows/quality.yml', group: 'group: oasis-quality-v15-${{ github.ref }}', cancel: false },
    { path: '../.github/workflows/desktop-build.yml', group: 'group: oasis-desktop-${{ github.ref }}', cancel: true }
  ];
  for (const item of cases) {
    const workflow = await readFile(new URL(item.path, import.meta.url), 'utf8');
    assert.ok(workflow.includes(item.group), item.path + ' must use a per-ref concurrency group');
    assert.ok(workflow.includes('cancel-in-progress: ' + String(item.cancel)), item.path + ' has the wrong cancellation policy');
    const concurrencyGroup = workflow.match(/concurrency:\s*(?:#[^\r\n]*\r?\n\s*)*group:\s*([^\r\n]+)/);
    assert.ok(concurrencyGroup, item.path + ' must declare a concurrency group');
    assert.ok(!concurrencyGroup[1].includes('${{ github.sha }}'), item.path + ' must not create a separate expensive run for every commit');
  }
  await assert.rejects(readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8'), { code: 'ENOENT' }, 'the retired marketing site must not be republished');
});

test('README and package metadata describe the current product without unsupported claims', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(readme.includes('The open-source coding agent for any model.'));
  assert.ok(readme.includes('does not guarantee that every model will solve every task'));
  assert.ok(readme.includes('Approval prompts are not a replacement for operating-system isolation'));
  assert.ok(readme.includes('Apache License 2.0'));
  assert.ok(readme.includes('npm run check'));
  assert.ok(!readme.includes('beats Claude Code') && !readme.includes('100% success') && !readme.includes('security certified'));
  assert.match(pkg.description, /native desktop, connected browser sessions/);
  assert.equal(pkg.version.split('.').length, 3);
  assert.equal(pkg.oasisRelease?.channel, 'stable');
  assert.equal(pkg.oasisRelease?.stableTag, 'v' + pkg.version);
});
test('architecture and readiness docs describe the normal session and native desktop product', async () => {
  const [architecture, scorecard, index] = await Promise.all([
    readFile(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/ENGINEERING-SCORECARD.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/README.md', import.meta.url), 'utf8')
  ]);
  for (const doc of [architecture, scorecard, index]) {
    assert.doesNotMatch(doc, /standalone browser app|PWA install|installable browser app/i);
  }
  assert.ok(scorecard.includes('Connected workspace delivery'));
  assert.ok(index.includes('connected browser sessions'));
});

test('desktop release requires a stable version and same-commit gates, with generated release notes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/desktop-build.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('branches: [main]'));
  assert.ok(!workflow.includes("tags: ['v*']"));
  assert.ok(workflow.includes('publish_release:'));
  assert.ok(workflow.includes('confirm_stable_release:'));
  assert.ok(workflow.includes('inputs.publish_release == true'));
  assert.ok(workflow.includes('inputs.confirm_stable_release == true'));
  assert.ok(workflow.includes("github.event_name == 'push'"));
  assert.ok(workflow.includes('release_channel='));
  assert.ok(workflow.includes('oasisRelease?.channel'));
  assert.ok(workflow.includes('must be stable'));
  assert.ok(workflow.includes('tag="$expected"'));
  assert.ok(workflow.includes('echo "publish=false"'));
  assert.ok(workflow.includes('echo "publish=true"'));
  assert.ok(workflow.includes("if: steps.release-version.outputs.publish == 'true'"));
  assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
  assert.ok(workflow.includes('Require same-commit quality and installer gates'));
  assert.ok(workflow.includes('timeout-minutes: 45'));
  assert.ok(workflow.includes('Waiting for $workflow to pass on $TARGET_SHA'));
  assert.ok(workflow.includes('sleep 20'));
  assert.ok(workflow.includes('Timed out waiting for $workflow to pass'));
  for (const name of ['quality.yml', 'installer-checks.yml']) assert.ok(workflow.includes(name));
  assert.ok(!workflow.includes('pages.yml'), 'releases must not wait on the retired Pages workflow');
  assert.ok(workflow.includes('target_commitish: ${{ steps.release-version.outputs.target_commitish }}'));
  assert.ok(workflow.includes('make_latest:'));
  assert.ok(workflow.includes('generate_release_notes: true'));
  assert.ok(!workflow.includes('docs/releases') && !workflow.includes('body_path:'));
  assert.ok(workflow.includes('sha256sum'));
  assert.ok(!workflow.includes('git push origin "$tag"'));
});
test('quality runs the live Docker sandbox isolation test and requires a real engine', async () => {
  const workflow = await readFile(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8');
  const job = workflow.slice(workflow.indexOf('  docker-sandbox:'), workflow.indexOf('  browser-e2e:'));
  assert.ok(job.includes('runs-on: ubuntu-latest'));
  assert.ok(job.includes("OASIS_REQUIRE_DOCKER: '1'"), 'a missing engine must fail the job, not skip it');
  assert.ok(job.includes('node --test test/sandbox-docker-live.test.mjs'));
});
