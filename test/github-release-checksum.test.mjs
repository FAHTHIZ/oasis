import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChecksums, verifyChecksum } from '../src/github-release.mjs';

const sums = 'abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890  OASIS-1.1.0-x64.AppImage\n\nfeed567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef  OASIS-1.1.0-x64.dmg\n';

test('parseChecksums extracts name->hash pairs', () => {
  const map = parseChecksums(sums);
  assert.equal(map['OASIS-1.1.0-x64.AppImage'], 'abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890');
  assert.equal(map['OASIS-1.1.0-x64.dmg'], 'feed567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
});

test('verifyChecksum passes on match', () => {
  const map = parseChecksums(sums);
  assert.equal(verifyChecksum('ABC123DEF4567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890', map, 'OASIS-1.1.0-x64.AppImage'), true);
});

test('verifyChecksum throws on mismatch', () => {
  const map = parseChecksums(sums);
  assert.throws(() => verifyChecksum('deadbeef', map, 'OASIS-1.1.0-x64.AppImage'), /Checksum mismatch/);
});

test('verifyChecksum throws on missing filename', () => {
  const map = parseChecksums(sums);
  assert.throws(() => verifyChecksum('abc', map, 'unknown-file.exe'), /No published checksum/);
});
