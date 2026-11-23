// A live run (gpt-oss-20b, conflicting-sources-answer) read two of the four
// files in sources/, wrote "## Contradiction" where the request asked for a
// paragraph beginning "Contradiction:", and finished. The task contract had
// no way to see either miss: reads left no evidence and citations had to be
// URLs. These criteria make both checkable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveTaskSpec, evaluateAcceptance, gateProblems, assessOutcome, sourceFolders, requiredOpenings, hasOpening } from '../src/task-model.mjs';
import { createEvidenceLedger, recordEvidence, evidenceFromToolResult } from '../src/evidence-ledger.mjs';

const REQUEST = 'Using only the files in sources/, answer: what is the current Acme API rate limit per key? Write answer.md. State the current limit as a number of requests per minute, cite the file path of each source that supports it, and add a paragraph that begins with "Contradiction:" naming every source that gives a different figure.';

function workspace(answer) {
  const root = mkdtempSync(path.join(tmpdir(), 'oasis-local-sources-'));
  mkdirSync(path.join(root, 'sources'));
  for (const name of ['official-api-docs.md', 'forum-thread.md', 'press-release-2025.md', 'blog-repost.md']) writeFileSync(path.join(root, 'sources', name), name + ' body\n');
  writeFileSync(path.join(root, 'answer.md'), answer);
  return root;
}

function ledgerWith(reads, extra = []) {
  const ledger = createEvidenceLedger();
  for (const file of reads) recordEvidence(ledger, evidenceFromToolResult('read_file', { path: file }, { path: file, content: file + ' body\n' }));
  for (const event of extra) recordEvidence(ledger, event);
  recordEvidence(ledger, evidenceFromToolResult('write_file', { path: 'answer.md' }, { path: 'answer.md', writtenBytes: 10 }, { edited: true, path: 'answer.md' }));
  return ledger.events;
}

const byKind = (list, kind) => list.find((item) => item.kind === kind);

test('the request yields a source-folder criterion and an exact-opening criterion', () => {
  assert.deepEqual(sourceFolders(REQUEST), ['sources']);
  assert.deepEqual(requiredOpenings(REQUEST), ['Contradiction:']);
  const kinds = deriveTaskSpec(REQUEST).acceptance.map((item) => item.kind);
  assert.ok(kinds.includes('sources_read'));
  assert.ok(kinds.includes('opening'));
});

test('the live failure: two sources unread and a heading instead of the paragraph', () => {
  const root = workspace('The limit is 1200 requests per minute (sources/official-api-docs.md).\n\n## Contradiction\n\n- sources/forum-thread.md mentions 600.\n');
  const spec = deriveTaskSpec(REQUEST);
  const events = ledgerWith(['sources/official-api-docs.md', 'sources/forum-thread.md']);
  const result = evaluateAcceptance(spec, { events, reply: 'Wrote answer.md.', root });
  const read = byKind(result, 'sources_read');
  assert.equal(read.status, 'unmet');
  assert.match(read.detail, /sources\/blog-repost\.md/);
  assert.match(read.detail, /sources\/press-release-2025\.md/);
  assert.equal(byKind(result, 'opening').status, 'unmet');
  // The cited files were read, and answer.md (written, not a source) is not counted.
  assert.equal(byKind(result, 'cites_sources').status, 'met');
  const problems = gateProblems(assessOutcome(spec, { events, reply: 'Wrote answer.md.', root }));
  assert.ok(problems.some((item) => item.kind === 'sources_read'));
  assert.ok(problems.some((item) => item.kind === 'opening'));
});

test('every file read and the exact opening present meets both', () => {
  const root = workspace('The limit is 1,200 requests per minute (sources/official-api-docs.md).\n\n**Contradiction:** sources/press-release-2025.md says 600; sources/blog-repost.md copies it.\n');
  const spec = deriveTaskSpec(REQUEST);
  const events = ledgerWith(['sources/official-api-docs.md', 'sources/forum-thread.md', 'sources/press-release-2025.md'], [{ kind: 'command', tool: 'run_command', command: 'cat sources/blog-repost.md', exitCode: 0, finished: true, numbers: [] }]);
  const result = evaluateAcceptance(spec, { events, reply: 'Wrote answer.md.', root });
  assert.equal(byKind(result, 'sources_read').status, 'met');
  assert.equal(byKind(result, 'opening').status, 'met');
  assert.equal(byKind(result, 'cites_sources').status, 'met');
});

test('a cited workspace file that was never read is not support', () => {
  const root = workspace('1200 per minute, per sources/official-api-docs.md and sources/blog-repost.md.\n\nContradiction: none.\n');
  const spec = deriveTaskSpec(REQUEST);
  const result = evaluateAcceptance(spec, { events: ledgerWith(['sources/official-api-docs.md']), reply: 'Done.', root });
  const cites = byKind(result, 'cites_sources');
  assert.equal(cites.status, 'unmet');
  assert.match(cites.detail, /blog-repost/);
});

test('openings are not taken from data-selection phrasing', () => {
  assert.deepEqual(requiredOpenings('Remove lines that begin with "#" from data.txt'), []);
  assert.deepEqual(requiredOpenings('Delete files whose name starts with "tmp"'), []);
  assert.deepEqual(requiredOpenings('Check if it begins with "http"'), []);
  assert.deepEqual(requiredOpenings('Write an email to the team that starts with "Hi all"'), ['Hi all']);
  assert.deepEqual(sourceFolders('Summarize it using the files in this folder'), []);
  assert.deepEqual(sourceFolders('Based on the documents in notes/meetings, list the decisions.'), ['notes/meetings']);
});

test('hasOpening ignores Markdown markup but not missing words', () => {
  assert.equal(hasOpening('**Contradiction:** text', 'Contradiction:'), true);
  assert.equal(hasOpening('> - Contradiction: text', 'Contradiction:'), true);
  assert.equal(hasOpening('## Contradiction\ntext', 'Contradiction:'), false);
});

test('rereading an unchanged file adds no second evidence event', () => {
  const ledger = createEvidenceLedger();
  const event = () => evidenceFromToolResult('read_file', { path: 'a.md' }, { path: 'a.md', content: 'x' });
  recordEvidence(ledger, event());
  recordEvidence(ledger, event());
  assert.equal(ledger.events.length, 1);
  assert.equal(evidenceFromToolResult('read_file', { path: 'b.md' }, { error: 'missing' }), null);
});
