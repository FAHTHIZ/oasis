import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyToolError } from '../src/agent.mjs';

test('ENOENT becomes a relative, actionable message', () => {
  const error = Object.assign(new Error("ENOENT: no such file or directory, stat '/tmp/proj/package.json'"), { code: 'ENOENT', path: '/tmp/proj/package.json' });
  assert.equal(friendlyToolError(error, { path: 'package.json' }, '/tmp/proj'), 'No such file or folder: package.json. Use glob_files or list_files to find the right path.');
});

test('EISDIR and other errors', () => {
  const dir = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' });
  assert.match(friendlyToolError(dir, { path: 'src' }, '/r'), /^src is a folder/);
  assert.equal(friendlyToolError(new Error('boom'), {}, '/r'), 'boom');
});
