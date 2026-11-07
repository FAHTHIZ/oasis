// Unified security posture report for OASIS.
//
// Aggregates secret-scan findings, permission-mode status, sandbox
// availability/kind, and protected-path coverage into a single structured
// report with a pass/warn/fail summary. Read-only; does not modify any state.
import { collectSensitivePaths } from './sandbox.mjs';
import { detectSandbox } from './sandbox.mjs';

// Severity rollup: any 'fail' dominates, then 'warn', then 'pass'.
function rollup(items) {
  if (!Array.isArray(items) || !items.length) return 'pass';
  if (items.some((item) => item.severity === 'fail')) return 'fail';
  if (items.some((item) => item.severity === 'warn')) return 'warn';
  return 'pass';
}

// Build the security posture report from current runtime state.
export function buildSecurityReport({ env = process.env, sandboxSettings = {}, permissionMode = 'default', scanFindings = [] } = {}) {
  const checks = [];

  // Secret scan findings: each finding is a fail; none is a pass.
  const findings = Array.isArray(scanFindings) ? scanFindings : [];
  checks.push({
    name: 'secret-scan',
    severity: findings.length ? 'fail' : 'pass',
    detail: findings.length ? findings.length + ' potential secret(s) detected.' : 'No secrets detected in the current scan.',
    findings
  });

  // Permission mode: bypass is a warn (no approval gate); others are pass.
  const mode = String(permissionMode || 'default');
  checks.push({
    name: 'permission-mode',
    severity: mode === 'bypass' ? 'warn' : 'pass',
    detail: mode === 'bypass' ? 'Approval prompts are bypassed; commands run without confirmation.' : 'Permission mode is ' + mode + '; approvals apply where configured.'
  });

  // Sandbox availability: enabled but unavailable is a fail; disabled is a warn.
  const sandbox = detectSandbox(false);
  const enabled = Boolean(sandboxSettings.enabled);
  if (enabled && !sandbox.available) {
    checks.push({ name: 'sandbox', severity: 'fail', detail: 'Sandbox is enabled but unavailable: ' + (sandbox.reason || 'no supported backend.') });
  } else if (!enabled) {
    checks.push({ name: 'sandbox', severity: 'warn', detail: 'Sandbox is disabled; commands rely on approvals only.' });
  } else {
    checks.push({ name: 'sandbox', severity: 'pass', detail: 'Sandbox is enabled (' + sandbox.kind + ').' });
  }

  // Sensitive-path coverage: masked paths reduce exposure.
  const masked = collectSensitivePaths(env);
  checks.push({
    name: 'sensitive-paths',
    severity: masked.length ? 'pass' : 'warn',
    detail: masked.length ? masked.length + ' sensitive path(s) masked.' : 'No sensitive paths detected to mask.'
  });

  const summary = rollup(checks);
  return { summary, checks, generatedAt: new Date().toISOString() };
}

// Human-readable one-line-per-check output.
export function formatSecurityReport(report) {
  const icon = { pass: '[ok]', warn: '[warn]', fail: '[fail]' };
  const lines = ['Security posture: ' + report.summary.toUpperCase()];
  for (const check of report.checks) {
    lines.push(icon[check.severity] + ' ' + check.name + ': ' + check.detail);
  }
  return lines.join('\n');
}
