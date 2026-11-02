import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseGitleaks, parseOsv, parseNpmAudit, parsePipAudit, parseSemgrep, parseTrivy, planScanners, runSecurityScan } from '../src/security-scan.mjs';
import { onPathSync } from '../src/clipboard-path.mjs';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.mjs';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'oasis-scan-test-'));

test('gitleaks findings never carry the secret, the match, or the author', () => {
  const [finding] = parseGitleaks([{ RuleID: 'github-pat', Description: 'GitHub token', StartLine: 3, File: '/w/src/a.js', Commit: '9f018ef371532585895a', Secret: 'ghp_real', Match: 'token = ghp_real', Author: 'Jane', Email: 'jane@example.com' }], '/w');
  assert.equal(finding.file, 'src/a.js');
  assert.equal(finding.line, 3);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.in_history, true);
  assert.match(finding.fix, /rotate/i);
  assert.equal(finding.likely_fixture, undefined);
  const [generic] = parseGitleaks([{ RuleID: 'generic-api-key', File: 'test/x.test.mjs' }], '/w');
  assert.equal(generic.severity, 'medium');
  assert.equal(generic.likely_fixture, true);
  const text = JSON.stringify(finding);
  for (const leaked of ['ghp_real', 'Jane', 'jane@example.com']) assert.ok(!text.includes(leaked), leaked);
});

test('osv-scanner groups become one finding with CVSS band, CVE and fixed version', () => {
  const report = { results: [{ source: { path: '/w/package-lock.json', type: 'lockfile' }, packages: [{
    package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
    vulnerabilities: [{ id: 'GHSA-29mw-wpgm-hmr9', summary: 'ReDoS in lodash', aliases: ['CVE-2020-28500'], affected: [{ package: { name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }] }] },
      { id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command injection', affected: [] }],
    groups: [{ ids: ['GHSA-29mw-wpgm-hmr9'], aliases: ['CVE-2020-28500', 'GHSA-29mw-wpgm-hmr9'], max_severity: '5.3' }, { ids: ['GHSA-35jh-r3h4-6jhm'], max_severity: '7.2' }]
  }] }] };
  const findings = parseOsv(report, '/w');
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0].cve, ['CVE-2020-28500']);
  assert.equal(findings[0].severity, 'medium');
  assert.equal(findings[0].package, 'lodash@4.17.15 (npm)');
  assert.equal(findings[0].file, 'package-lock.json');
  assert.match(findings[0].fix, /4\.17\.21/);
  assert.equal(findings[1].severity, 'high');
});

test('npm audit, pip-audit, semgrep and trivy reports normalize', () => {
  const npm = parseNpmAudit({ vulnerabilities: {
    minimist: { severity: 'critical', via: [{ title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', severity: 'critical', range: '<1.2.6' }], fixAvailable: true },
    mkdirp: { severity: 'critical', via: ['minimist'], fixAvailable: true }
  } });
  assert.equal(npm.length, 1, 'transitive-only entries are not duplicated');
  assert.equal(npm[0].severity, 'critical');
  assert.equal(npm[0].rule, 'GHSA-xvch-5gv4-984h');

  const pip = parsePipAudit({ dependencies: [{ name: 'jinja2', version: '2.10', vulns: [{ id: 'PYSEC-2019-217', aliases: ['CVE-2019-10906'], fix_versions: ['2.10.1'], description: 'Sandbox escape' }] }, { name: 'ok', version: '1', vulns: [] }] });
  assert.equal(pip.length, 1);
  assert.match(pip[0].fix, /2\.10\.1/);

  const semgrep = parseSemgrep({ results: [{ check_id: 'javascript.lang.security.audit.eval', path: 'src/x.js', start: { line: 9 }, extra: { severity: 'ERROR', message: 'eval of user input', lines: 'eval(SECRET_TOKEN)' } }] }, '/w');
  assert.equal(semgrep[0].severity, 'high');
  assert.equal(semgrep[0].line, 9);
  assert.ok(!JSON.stringify(semgrep).includes('SECRET_TOKEN'), 'matched source is dropped');

  const trivy = parseTrivy({ Results: [{ Target: 'Dockerfile', Misconfigurations: [{ ID: 'DS002', Title: 'Image user should not be root', Severity: 'HIGH', Status: 'FAIL', CauseMetadata: { StartLine: 1 }, Resolution: 'Add USER' }, { ID: 'DS001', Status: 'PASS', Severity: 'LOW' }] }] }, '/w');
  assert.equal(trivy.length, 1);
  assert.equal(trivy[0].rule, 'DS002');
});

test('planScanners picks scanners by what the folder contains and what is installed', async () => {
  const dir = await tmp();
  try {
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    for (const name of ['gitleaks', 'npm']) { await writeFile(path.join(bin, name), '#!/bin/sh\n'); await chmod(path.join(bin, name), 0o755); }
    await writeFile(path.join(dir, 'package-lock.json'), '{}');
    const plan = Object.fromEntries(planScanners(dir, { PATH: bin }).map((item) => [item.name, item]));
    assert.equal(plan.gitleaks.installed, true);
    assert.equal(plan['osv-scanner'].installed, false);
    assert.equal(plan['npm-audit'].applies, true, 'npm audit stands in when osv-scanner is missing');
    assert.equal(plan.trivy.applies, false, 'no IaC files');
    assert.deepEqual(planScanners(dir, { PATH: bin }, ['semgrep']).map((item) => item.name), ['semgrep']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('security_scan runs installed scanners through the command gate and merges findings', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  try {
    const bin = path.join(dir, '.bin-outside');
    await mkdir(bin);
    // Fake gitleaks writes a report to --report-path; fake osv-scanner to --output.
    await writeFile(path.join(bin, 'gitleaks'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--report-path" ]; then out="$2"; fi; shift; done\nprintf \'[{"RuleID":"aws-access-token","Description":"AWS key","File":"src/a.js","StartLine":2,"Secret":"AKIAREAL","Match":"AKIAREAL"}]\' > "$out"\n');
    await writeFile(path.join(bin, 'osv-scanner'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done\nprintf \'{"results":[{"source":{"path":"package-lock.json"},"packages":[{"package":{"name":"lodash","version":"4.17.15","ecosystem":"npm"},"vulnerabilities":[{"id":"GHSA-1","summary":"bad","affected":[]}],"groups":[{"ids":["GHSA-1"],"max_severity":"9.8"}]}]}]}\' > "$out"\nexit 1\n');
    await chmod(path.join(bin, 'gitleaks'), 0o755);
    await chmod(path.join(bin, 'osv-scanner'), 0o755);
    await writeFile(path.join(dir, 'package-lock.json'), '{}');
    const env = { PATH: bin + ':' + process.env.PATH, HOME: dir };
    const asked = [];
    const result = await runSecurityScan(dir, {}, { env, approval: async (text) => { asked.push(text); return true; } });
    assert.equal(asked.length, 2, 'each scanner command needs approval');
    assert.match(asked[0], /gitleaks/);
    assert.deepEqual(result.ran.map((item) => [item.scanner, item.findings]), [['gitleaks', 1], ['osv-scanner', 1]]);
    assert.equal(result.findings[0].severity, 'critical', 'sorted by severity');
    assert.equal(result.summary.total, 2);
    assert.ok(!JSON.stringify(result).includes('AKIAREAL'));
    assert.ok(result.missing.some((item) => item.scanner === 'semgrep' && /pipx/.test(item.install)));
    assert.ok(!result.ran[0].command.includes(os.tmpdir()), 'temp report path is hidden');

    const declined = await runSecurityScan(dir, { scanners: ['gitleaks'] }, { env, approval: async () => false });
    assert.match(declined.ran[0].skipped, /not approved/i);
    assert.match(declined.note, /No scanner ran/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('security_scan is a registered tool and rejects unknown scanners', async () => {
  assert.ok(TOOL_DEFINITIONS.some((def) => def.function.name === 'security_scan'));
  const dir = await tmp();
  try {
    await assert.rejects(() => executeTool('security_scan', { scanners: ['nope'] }, { root: dir, env: { PATH: '' } }), /Unknown scanner|must be one of|enum/i);
    await assert.rejects(() => executeTool('security_scan', { path: '../..' }, { root: dir, env: { PATH: '' } }), /outside the workspace/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real gitleaks finds a token removed from the latest commit', { skip: !onPathSync('gitleaks') && 'gitleaks is not installed' }, async () => {
  const dir = await tmp();
  try {
    const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
    git('init', '-q');
    const token = 'ghp_' + 'Zq8Xw3Lm9Rt2Vb6Nc4Kd7Hf1Js5Gp0Ya3Ue8';
    await writeFile(path.join(dir, 'config.js'), 'export const token = "' + token + '";\n');
    git('add', '-A'); git('commit', '-qm', 'add');
    git('rm', '-q', 'config.js'); git('commit', '-qm', 'remove');
    const result = await runSecurityScan(dir, { scanners: ['gitleaks'] }, { env: process.env, autoApprove: true });
    assert.equal(result.ran[0].git_history, true);
    assert.equal(result.findings.length, 1, JSON.stringify(result));
    assert.equal(result.findings[0].file, 'config.js');
    assert.equal(result.findings[0].in_history, true);
    assert.ok(!JSON.stringify(result).includes(token));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
