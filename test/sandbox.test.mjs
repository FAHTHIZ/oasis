import test from 'node:test';
import assert from 'node:assert/strict';
import { macProfile } from '../src/sandbox.mjs';

test('macOS Seatbelt profile rejects control characters in writable paths', () => {
  const unsafePaths = [
    '/workspace\n(allow file-write* (subpath "/"))',
    '/workspace\r(allow file-write* (subpath "/"))',
    '/workspace\u0000extra',
    '/workspace\u2028(allow file-write* (subpath "/"))',
    '/workspace\u2029(allow file-write* (subpath "/"))'
  ];

  for (const writablePath of unsafePaths) {
    assert.throws(
      () => macProfile({ writable: [writablePath], maskedPaths: [], network: false }),
      /control characters/
    );
  }
});

test('macOS Seatbelt profile rejects control characters in masked paths', () => {
  assert.throws(
    () => macProfile({
      writable: ['/workspace'],
      maskedPaths: [{ path: '/home/user/.ssh\n(allow file-read*)', type: 'directory' }],
      network: false
    }),
    /control characters/
  );
});
