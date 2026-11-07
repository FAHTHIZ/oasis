import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('GitHub Pages publishes the product website and installable browser app on every main push', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('pages: write') && workflow.includes('id-token: write'));
  assert.ok(workflow.includes('actions/deploy-pages@'));
  assert.ok(workflow.includes('Build the installable universal browser app'));
  assert.ok(workflow.includes('Upload public website and installable browser app'));
  assert.ok(workflow.includes('Deploy installable browser app'));
  assert.ok(!workflow.includes('assets/demo/') && !workflow.includes('demo video'), 'The browser-app deployment must not depend on demo videos.');
  assert.ok(workflow.includes('node .github/scripts/stamp-site.mjs'));
  assert.ok(workflow.includes('fetch-depth: 20'), 'The publish checkout needs history for the changes feed.');
  // Deployment must not be gated on the optional admin secret; only metadata is.
  const deploy = workflow.slice(workflow.indexOf('- name: Deploy installable browser app'));
  assert.ok(!deploy.split('- name:')[1].includes('launch-auth'), 'Deploy must not depend on OASIS_REPO_ADMIN_TOKEN.');
  assert.ok(workflow.includes("if: ${{ steps.launch-auth.outputs.ready == 'true' }}"), 'Metadata updates stay gated on the admin secret.');
});

test('the Pages root is the product website, links to the separate app, and keeps build stamps', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<title>OASIS — Open-source coding-agent runtime</title>'));
  assert.ok(html.includes('Bring the model.'));
  assert.ok(html.includes('href="./app/"'), 'The product website must link to the separate installable app.');
  assert.ok(html.includes('rel="canonical" href="https://fahthiz.github.io/oasis/"'));
  assert.ok(html.includes('./assets/site.css') && html.includes('./assets/site.js'));
  assert.ok(!html.includes('http-equiv="refresh"') && !html.includes("location.replace('app/')"), 'The website root must not redirect into the browser app.');
  for (const name of ['CHANGES', 'BUILD']) {
    assert.ok(html.includes('<!--OASIS:' + name + '-->') && html.includes('<!--/OASIS:' + name + '-->'), 'missing OASIS:' + name);
  }
});

test('CI keeps latest pending concurrency per ref and lets active quality runs finish', async () => {
  const cases = [
    { path: '../.github/workflows/quality.yml', group: 'group: oasis-quality-v15-${{ github.ref }}', cancel: false },
    { path: '../.github/workflows/pages.yml', group: 'group: oasis-public-launch-${{ github.ref }}', cancel: true },
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
  const publishing = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(publishing.includes('group: oasis-public-launch-${{ github.ref }}'));
});

test('README and package metadata describe the current product without unsupported claims', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(readme.includes('open-source coding-agent runtime and development workspace'));
  assert.ok(readme.includes('does not guarantee that every model will solve every task'));
  assert.ok(readme.includes('Approval prompts are not a replacement for operating-system isolation'));
  assert.ok(readme.includes('Apache License 2.0'));
  assert.ok(readme.includes('npm run check'));
  assert.ok(!readme.includes('beats Claude Code') && !readme.includes('100% success') && !readme.includes('security certified'));
  assert.equal(pkg.version.split('.').length, 3);
  assert.equal(pkg.oasisRelease?.channel, 'stable');
  assert.equal(pkg.oasisRelease?.stableTag, 'v' + pkg.version);
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
  assert.ok(workflow.includes('Require same-commit quality, site, and installer gates'));
  assert.ok(workflow.includes('timeout-minutes: 45'));
  assert.ok(workflow.includes('Waiting for $workflow to pass on $TARGET_SHA'));
  assert.ok(workflow.includes('sleep 20'));
  assert.ok(workflow.includes('Timed out waiting for $workflow to pass'));
  for (const name of ['quality.yml', 'pages.yml', 'installer-checks.yml']) assert.ok(workflow.includes(name));
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
