import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

test('does not claim sensitive paths are masked when sandbox is disabled', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-security-report-'));
  try {
    await mkdir(path.join(home, '.ssh'));
    const report = buildSecurityReport({
      env: { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'config') },
      sandboxSettings: { enabled: false, maskSensitivePaths: true },
      sandboxStatus: { available: true, kind: 'bubblewrap' },
      permissionMode: 'default',
      scanFindings: []
    });
    const check = report.checks.find((item) => item.name === 'sensitive-paths');
    assert.equal(check.severity, 'warn');
    assert.match(check.detail, /masking is not active/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('reports sensitive-path masking only for an enabled available sandbox', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-security-report-'));
  try {
    await mkdir(path.join(home, '.ssh'));
    const report = buildSecurityReport({
      env: { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'config') },
      sandboxSettings: { enabled: true, maskSensitivePaths: true },
      sandboxStatus: { available: true, kind: 'docker' },
      permissionMode: 'default',
      scanFindings: []
    });
    const check = report.checks.find((item) => item.name === 'sensitive-paths');
    assert.equal(check.severity, 'pass');
    assert.match(check.detail, /configured for sandbox read masking/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('formatSecurityReport includes all checks', () => {
  const report = buildSecurityReport({ sandboxSettings: {}, permissionMode: 'default', scanFindings: [] });
  const output = formatSecurityReport(report);
  for (const name of ['secret-scan', 'permission-mode', 'sandbox', 'sensitive-paths']) {
    assert.ok(output.includes(name));
  }
});
