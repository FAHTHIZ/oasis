import test from 'node:test';
import assert from 'node:assert/strict';
import { containerArgs } from '../src/sandbox.mjs';

const base = {
  kind: 'docker',
  enabled: true,
  available: true,
  network: false,
  writable: ['/tmp/workspace'],
  maskedPaths: [],
  protectedRoots: []
};

test('readOnlyRoot disabled by default', () => {
  const args = containerArgs('sh', ['-c', 'true'], { ...base, readOnlyRoot: false }, '/tmp/workspace');
  assert.ok(!args.includes('--read-only'));
});

test('readOnlyRoot enabled adds --read-only and /tmp tmpfs', () => {
  const args = containerArgs('sh', ['-c', 'true'], { ...base, readOnlyRoot: true }, '/tmp/workspace');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.some((arg) => String(arg).startsWith('/tmp:rw,nosuid,nodev,noexec')));
});
