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
  ['docs/CURRENT_STATUS.md', 'blob-status-current']
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
