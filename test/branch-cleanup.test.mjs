import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRetirement, AUDITED_SUPERSEDED_HEADS } from '../scripts/cleanup-merged-branches.mjs';

const mainTree = new Map([
  ['src/merged.mjs', 'blob-merged'],
  ['docs/guide.md', 'blob-guide'],
  ['STATUS.md', 'blob-status'],
  ['CHANGELOG.md', 'blob-changelog'],
  ['docs/TERMUX.md', 'blob-termux'],
  ['scripts/install.sh', 'blob-sh'],
  ['scripts/install.ps1', 'blob-ps'],
  ['src/agent.mjs', 'blob-agent'],
  ['test/runtime.test.mjs', 'blob-runtime'],
  ['test/approval-language.test.mjs', 'blob-approval'],
  ['docs/BENCHMARKS.md', 'blob-benchmarks'],
  ['docs/CURRENT_STATUS.md', 'blob-status-current'],
  ['src/config.mjs', 'blob-config'],
  ['src/cli.mjs', 'blob-cli'],
  ['.github/workflows/pages.yml', 'blob-pages-workflow'],
  ['src/workflow-sandbox.mjs', 'blob-workflow-sandbox'],
  ['test/workflows.test.mjs', 'blob-workflows-test'],
  ['test/ci-workflow.test.mjs', 'blob-ci-workflow-test'],
  ['test/helpers/block-quickjs-loader.mjs', 'blob-quickjs-helper'],
  ['.github/scripts/browser-e2e.mjs', 'blob-browser-e2e'],
  ['.github/workflows/quality.yml', 'blob-quality-workflow'],
  ['index.html', 'blob-index'],
  ['scripts/vendor-terminal.mjs', 'blob-vendor-terminal'],
  ['src/web.mjs', 'blob-web'],
  ['sw.js', 'blob-sw'],
  ['scripts/check-site.mjs', 'blob-check-site'],
  ['test/index-inline-scripts.test.mjs', 'blob-inline-script-test'],
  ['test/web-static-assets.test.mjs', 'blob-static-assets-test'],
  ['test/web-terminal-optional.test.mjs', 'blob-optional-terminal-test']
  ['src/permissions.mjs', 'blob-permissions'],
  ['test/permissions.test.mjs', 'blob-permissions-test'],
  ['src/mcp-oauth.mjs', 'blob-mcp-oauth'],
  ['test/mcp-oauth.test.mjs', 'blob-mcp-oauth-test'],
  ['src/model-routing.mjs', 'blob-routing'],
  ['test/model-routing.test.mjs', 'blob-routing-test'],
  ['src/approval-language.mjs', 'blob-approval-language'],
  ['src/session-notes.mjs', 'blob-session-notes'],
  ['test/session-notes.test.mjs', 'blob-session-notes-test'],
  ['src/command-output-log.mjs', 'blob-command-output'],
  ['src/tools.mjs', 'blob-tools'],
  ['src/context.mjs', 'blob-context'],
  ['.github/scripts/check-eval-quarantine.mjs', 'blob-quarantine'],
  ['test/eval-quarantine.test.mjs', 'blob-quarantine-test'],
  ['bench/README.md', 'blob-bench'],
  ['docs/NEXT_MILESTONE.md', 'blob-next-milestone'],
  ['README.md', 'blob-readme']
]);
const openPRs = new Set(['feat/open-review']);
const mergedHeads = new Map([['feat/merged', new Set(['merged-head-sha'])]]);

test('retirement requires ancestry, a merged PR head, or byte-identical net changes', () => {
  assert.equal(classifyRetirement({ name: 'fix/old' }, { status: 'behind', ahead_by: 0, behind_by: 4, files: [] }, 'main', openPRs, mainTree).retire, true);
  assert.equal(classifyRetirement({ name: 'chore/same-tip' }, { status: 'identical', ahead_by: 0, behind_by: 0, files: [] }, 'main', openPRs, mainTree).retire, true);
  assert.equal(classifyRetirement({ name: 'feat/merged', commit: { sha: 'merged-head-sha' } }, null, 'main', openPRs, mainTree, mergedHeads).retire, true);
  assert.equal(classifyRetirement({ name: 'feat/ported-by-squash' }, { status: 'diverged', ahead_by: 2, behind_by: 8, files: [
    { filename: 'src/merged.mjs', status: 'modified', sha: 'blob-merged' },
    { filename: 'docs/guide.md', status: 'added', sha: 'blob-guide' }
  ] }, 'main', openPRs, mainTree).retire, true);
  assert.equal(classifyRetirement({ name: 'feat/unique-work' }, { status: 'diverged', ahead_by: 1, behind_by: 5, files: [
    { filename: 'src/merged.mjs', status: 'modified', sha: 'different-blob' }
  ] }, 'main', openPRs, mainTree).retire, false);
});

test('reviewed superseded heads retire only when the exact SHA and replacement paths match', () => {
  const entry = AUDITED_SUPERSEDED_HEADS.get('installer/painless-cli-2026-10-29');
  assert.ok(entry);
  assert.equal(classifyRetirement({ name: 'installer/painless-cli-2026-10-29', commit: { sha: entry.sha } }, null, 'main', openPRs, mainTree).retire, true);
  const missing = new Map(mainTree); missing.delete('scripts/install.sh');
  assert.equal(classifyRetirement({ name: 'installer/painless-cli-2026-10-29', commit: { sha: entry.sha } }, null, 'main', openPRs, missing).retire, false);
  assert.equal(classifyRetirement({ name: 'installer/painless-cli-2026-10-29', commit: { sha: 'changed-head' } }, null, 'main', openPRs, mainTree).retire, false);
});

test('the reviewed unattended-verification branch retires only at its exact audited head', () => {
  const entry = AUDITED_SUPERSEDED_HEADS.get('fix/unattended-verification-rule');
  assert.ok(entry);
  const branch = { name: 'fix/unattended-verification-rule', commit: { sha: entry.sha } };
  assert.equal(classifyRetirement(branch, null, 'main', openPRs, mainTree).retire, true);
  assert.equal(
    classifyRetirement({ ...branch, commit: { sha: 'different-head' } }, null, 'main', openPRs, mainTree).retire,
    false
  );
  const missing = new Map(mainTree);
  missing.delete('docs/BENCHMARKS.md');
  assert.equal(classifyRetirement(branch, null, 'main', openPRs, missing).retire, false);
});

test('audited superseded branch set uses exact heads and existing replacement paths', () => {
  const reviewed = [
    ['fix/chained-command-permissions', '20906cc1cecd811b85125c79d9dc51088592b4b0'],
    ['security/bound-mcp-oauth-metadata', '65eb635e7051012edd2f55c64a679bf855cc491f'],
    ['security/public-fetch-ssrf-hardening', 'a3d9fd154e16718fc4adfab69f17d40904aef029'],
    ['feat/cost-aware-model-routing', 'dd41821b6397f0c227e0a4aa68d76d17eaecb498'],
    ['fix/approval-secret-redaction', '81cbd727f5cf60c00c309a62d86b3b5dfff856d9'],
    ['fix/compaction-session-notes', '0d4cd105d6cb7170d203db46510fe1a33a53cdc5'],
    ['fix/tool-output-preservation', 'e8381ca00f778d7944d037f850156e900f56a5e6'],
    ['feat/context-ordering-todo', '7032a34f8a8146b64eafb3e51521cc1ffbc8b2ac'],
    ['bench/infrastructure-gate-2026-10-31', 'b0098a8072ff837f46056e70a47a5153d701289d'],
    ['docs/alpha-confidence-milestone-2026-10-29', 'd865e22e5eeb530a8caeab2370e08da519d05dbc'],
    ['fix/omniroute-setup-default-20261027', '669463e59184a95419dfa1d6f51b78b2dbe0a915'],
    ['fix/preserve-current-provider-on-setup-20261027', 'c11d8210d244d8e1121a85beb563e99458f79e71'],
    ['fix/safety-part-1-completion', 'bebab129d0a1168b38c258ed7edbc05f146831c4'],
    ['ci/gate1-branch-validation', '271c8a77e3db9b6170838e44a5c9867c7df990b7'],
    ['ci/gate1-corrected-integrity-check', 'a949fff353370c4902234162a0a843397d45ba78'],
    ['fix/gate1-optional-terminal', '133aa7d1c042aaca52387bba62feb7060bc92c4b'],
    ['fix/gate1-site-mark-assertion', 'a949fff353370c4902234162a0a843397d45ba78'],
    ['fix/gate1-static-asset-routes', 'fae5b813f8e5147e40de04970d6f45a246f60660'],
    ['test/gate1-browser-and-asset-smoke', '73d6baecc843fa336c88366f3c57d549673bf2c1']
  ];
  for (const [name, sha] of reviewed) {
    const entry = AUDITED_SUPERSEDED_HEADS.get(name);
    assert.ok(entry, name + ' must have an explicit audit record');
    assert.equal(entry.sha, sha, name + ' must match the audited head exactly');
    assert.ok(entry.paths.every((file) => mainTree.has(file)), name + ' must have all canonical replacement paths');
    assert.equal(classifyRetirement({ name, commit: { sha } }, null, 'main', openPRs, mainTree).retire, true, name);
    assert.equal(classifyRetirement({ name, commit: { sha: 'not-' + sha } }, null, 'main', openPRs, mainTree).retire, false, name);
  }
});

test('default, protected, and open-PR branches are never retired', () => {
  const behind = { status: 'behind', ahead_by: 0, behind_by: 10, files: [] };
  assert.equal(classifyRetirement({ name: 'main' }, behind, 'main', openPRs, mainTree).retire, false);
  assert.equal(classifyRetirement({ name: 'release', protected: true }, behind, 'main', openPRs, mainTree).retire, false);
  assert.equal(classifyRetirement({ name: 'feat/open-review' }, behind, 'main', openPRs, mainTree).retire, false);
});

test('incomplete, oversized, and unique file states fail closed', () => {
  assert.equal(classifyRetirement({ name: 'feat/missing-data' }, { status: 'diverged', ahead_by: 1, behind_by: 1 }, 'main', openPRs, mainTree).retire, false);
  assert.equal(classifyRetirement({ name: 'feat/too-large' }, { status: 'diverged', ahead_by: 1, behind_by: 1, too_large: true, files: [] }, 'main', openPRs, mainTree).retire, false);
  assert.equal(classifyRetirement({ name: 'feat/many-files' }, { status: 'diverged', ahead_by: 1, behind_by: 1, files: Array.from({ length: 300 }, () => ({ filename: 'src/x', sha: 'blob' })) }, 'main', openPRs, mainTree).retire, false);
  assert.equal(classifyRetirement({ name: 'feat/new-doc' }, { status: 'diverged', ahead_by: 1, behind_by: 1, files: [{ filename: 'docs/new.md', status: 'added', sha: 'new-blob' }] }, 'main', openPRs, mainTree).retire, false);
  assert.equal(classifyRetirement({ name: 'feat/rename' }, { status: 'diverged', ahead_by: 1, behind_by: 1, files: [{ filename: 'src/merged.mjs', previous_filename: 'src/old.mjs', status: 'renamed', sha: 'blob-merged' }] }, 'main', openPRs, mainTree).retire, true);
});


test('cleanup workflow pins action SHAs and runs policy tests before deletion', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workflow = await readFile(path.join(root, '.github', 'workflows', 'cleanup-merged-branches.yml'), 'utf8');
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/);
  assert.match(workflow, /permissions:\s+contents: write\s+pull-requests: read/);
  const verification = workflow.indexOf('node --test test/branch-cleanup.test.mjs');
  const deletion = workflow.indexOf('node scripts/cleanup-merged-branches.mjs --apply');
  assert.ok(verification >= 0 && deletion > verification, 'branch deletion must be gated by focused cleanup tests');
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
});
