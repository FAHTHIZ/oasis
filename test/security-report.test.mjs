import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSecurityReport, formatSecurityReport } from '../src/security-report.mjs';

test('empty scan and disabled sandbox yields warn summary', () => {
  const report = buildSecurityReport({ sandboxSettings: {}, permissionMode: 'default', scanFindings: [] });
  assert.equal(report.summary, 'warn');
  assert.ok(report.checks.some((check) => check.name === 'sandbox' && check.severity === 'warn'));
});

test('scan findings force fail summary', () => {
  const report = buildSecurityReport({ sandboxSettings: {}, permissionMode: 'default', scanFindings: [{ file: 'a.js', line: 1 }] });
  assert.equal(report.summary, 'fail');
  assert.ok(report.checks.some((check) => check.name === 'secret-scan' && check.severity === 'fail'));
});

test('bypass permission mode is a warn', () => {
  const report = buildSecurityReport({ sandboxSettings: {}, permissionMode: 'bypass', scanFindings: [] });
  assert.ok(report.checks.some((check) => check.name === 'permission-mode' && check.severity === 'warn'));
});

test('bypassPermissions is also reported as a warning', () => {
  const report = buildSecurityReport({ sandboxSettings: {}, permissionMode: 'bypassPermissions', scanFindings: [] });
  assert.ok(report.checks.some((check) => check.name === 'permission-mode' && check.severity === 'warn'));
});

test('missing scan results are not reported as a clean scan', () => {
  const report = buildSecurityReport({ sandboxSettings: {}, permissionMode: 'default' });
  assert.ok(report.checks.some((check) => check.name === 'secret-scan' && check.severity === 'warn'));
  assert.match(report.checks.find((check) => check.name === 'secret-scan').detail, /No secret-scan results/);
});

test('uses the sandbox backend selected by settings', () => {
  const report = buildSecurityReport({ sandboxSettings: { enabled: true }, sandboxStatus: { available: true, kind: 'docker' }, permissionMode: 'default', scanFindings: [] });
  assert.ok(report.checks.some((check) => check.name === 'sandbox' && check.severity === 'pass' && /docker/.test(check.detail)));
});

test('formatSecurityReport includes all checks', () => {
  const report = buildSecurityReport({ sandboxSettings: {}, permissionMode: 'default', scanFindings: [] });
  const output = formatSecurityReport(report);
  for (const name of ['secret-scan', 'permission-mode', 'sandbox', 'sensitive-paths']) {
    assert.ok(output.includes(name));
  }
});
