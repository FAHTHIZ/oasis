import test from 'node:test';
import assert from 'node:assert/strict';
import { crashRecoveryHtml } from '../desktop/crash-screen.mjs';

test('crash screen explains the failure and gives an accessible restart link', () => {
  const html = crashRecoveryHtml({ reason: 'crashed', exitCode: 17, restartUrl: 'http://127.0.0.1:43210/' });
  assert.match(html, /OASIS stopped unexpectedly/);
  assert.match(html, /Restart OASIS workspace/);
  assert.match(html, /Reason: crashed/);
  assert.match(html, /Exit code: 17/);
  assert.match(html, /No renderer log lines were available/);
});

test('crash details are escaped before being rendered', () => {
  const html = crashRecoveryHtml({ reason: '<script>alert(1)</script>', restartUrl: 'http://127.0.0.1:43210/' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('crash recovery refuses non-loopback restart URLs', () => {
  const html = crashRecoveryHtml({ restartUrl: 'https://attacker.example/' });
  assert.match(html, /href="http:\/\/127\.0\.0\.1\/"/);
  assert.doesNotMatch(html, /href="https:\/\/attacker\.example/);
});
