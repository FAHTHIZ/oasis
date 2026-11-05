import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionFields } from '../src/eval.mjs';

// A live run started before a fix was committed but reported the later HEAD,
// so its results were credited to code it never loaded.
test('eval reports the revision loaded at start, not HEAD at the end', async () => {
  const fields = await revisionFields({ ...process.env, OASIS_SOURCE_REVISION: '', GITHUB_SHA: '' });
  assert.ok(fields.sourceRevision === null || /^[a-f0-9]{40}$/.test(fields.sourceRevision));
  assert.equal(fields.sourceChangedDuringRun, undefined);
  const pinned = await revisionFields({ ...process.env, OASIS_SOURCE_REVISION: 'a'.repeat(40) });
  assert.equal(pinned.sourceRevision, 'a'.repeat(40));
  assert.equal(pinned.sourceChangedDuringRun, undefined);
});
