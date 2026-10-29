import test from 'node:test';
import assert from 'node:assert/strict';
import { secureSet } from '../src/secure-store.mjs';

test('macOS Keychain storage keeps the secret out of subprocess arguments', () => {
  const secret = 'oasis-secret-fixture-do-not-log';
  let invocation;
  const result = secureSet('provider:example', secret, {}, 'keychain', (command, args, options) => {
    invocation = { command, args, options };
    return { ok: true, stdout: '', error: '' };
  });

  assert.equal(result.ok, true);
  assert.equal(invocation.command, 'security');
  assert.deepEqual(invocation.args, ['-i']);
  assert.equal(invocation.options.input.endsWith('\n'), true);
  assert.match(invocation.options.input, /add-generic-password -U/);
  assert.match(invocation.options.input, / -X [0-9a-f]+\n$/);
  assert.equal(invocation.options.input.includes(secret), false, 'stdin command stores the value as hex');
  assert.equal(JSON.stringify(invocation.args).includes(secret), false, 'argv contains no plaintext secret');
  assert.equal(invocation.options.input.includes(Buffer.from(secret, 'utf8').toString('hex')), true);
});

test('macOS Keychain storage refuses control characters that could escape the interactive command', () => {
  let called = false;
  const result = secureSet('provider\nremove-keychain', 'fixture-secret', {}, 'keychain', () => {
    called = true;
    return { ok: true, stdout: '', error: '' };
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /control characters/);
  assert.equal(called, false);
});

test('oversized Keychain requests fail closed for the protected-file fallback', () => {
  let called = false;
  const result = secureSet('provider:example', 'x'.repeat(2200), {}, 'keychain', () => {
    called = true;
    return { ok: true, stdout: '', error: '' };
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /too large for safe interactive input/);
  assert.equal(called, false);
});
