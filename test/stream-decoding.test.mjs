import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorktreeCommand } from '../src/worktrees.mjs';

// Each chunk used to be decoded alone, so a multi-byte character split
// across two writes came out as two U+FFFD replacement characters.
const SPLIT = 'const b = Buffer.from("é", "utf8"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => { process.stdout.write(b.subarray(1)); process.stderr.write(b.subarray(0, 1)); setTimeout(() => process.stderr.write(b.subarray(1)), 50); }, 50);';

test('child output split inside a character decodes cleanly', async () => {
  const result = await runWorktreeCommand(process.execPath, ['-e', SPLIT]);
  assert.equal(result.stdout, 'é');
  assert.equal(result.stderr.trim(), 'é');
});
