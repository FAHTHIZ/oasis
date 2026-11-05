import test from 'node:test';
import assert from 'node:assert/strict';
import { fileLayout } from '../src/agent.mjs';

test('small repos list every file; large ones list top-level entries with counts', () => {
  assert.equal(fileLayout(['test.mjs', 'add.mjs', '']), 'Files (2): add.mjs, test.mjs');
  const many = [...Array(50).keys()].map((i) => 'src/f' + i + '.mjs').concat(['README.md', 'test/a.test.mjs', '.oasis/scratch/x']);
  assert.equal(fileLayout(many), 'Top-level layout (52 files): README.md, src/ (50), test/ (1)');
  assert.equal(fileLayout([]), '');
});
