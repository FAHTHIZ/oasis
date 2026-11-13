import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cvssScore, parseJsonStream, parseGovulncheck, parseCargoAudit, parseBandit, parseZizmor, planScanners, runSecurityScan } from '../src/security-scan.mjs';
import { onPathSync } from '../src/clipboard-path.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'security-scan');
const fixture = async (name) => readFile(path.join(FIXTURES, name), 'utf8');
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'oasis-scan-more-'));

test('cvssScore matches the FIRST calculators', () => {
  assert.equal(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
  assert.equal(cvssScore('CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H'), 6.2);
  assert.equal(cvssScore('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N'), 5.5);
  assert.equal(cvssScore('CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N'), 6.4);
  assert.equal(cvssScore('CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N'), 3.1);
  assert.equal(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N'), 0);
  assert.equal(cvssScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'), 9.3);
  assert.equal(cvssScore('CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'), 8.5);
  assert.equal(cvssScore('AV:N/AC:L/Au:N/C:P/I:P/A:P'), 7.5);
  assert.equal(cvssScore('CVSS:3.1/AV:N'), null);
  assert.equal(cvssScore('CVSS:3.1/AV:Q/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), null);
  assert.equal(cvssScore('garbage'), null);
});

test('parseJsonStream splits concatenated JSON, ignoring braces inside strings', () => {
  const items = parseJsonStream('{"a":"}{"}\n{"b":[1,{"c":"\\"}"}]}\n  [3]  {broken');
  assert.deepEqual(items, [{ a: '}{' }, { b: [1, { c: '"}' }] }, [3]]);
});

test('govulncheck reports only called vulnerabilities, with the call site', async () => {
  const messages = parseJsonStream(await fixture('govulncheck.jsonl'));
  const findings = parseGovulncheck(messages, '/ws', '/ws/svc');
  assert.equal(findings.length, 1, 'GO-2022-1059 is imported but never called');
  const [hit] = findings;
  assert.equal(hit.rule, 'GO-2021-0113');
  assert.deepEqual(hit.cve, ['CVE-2021-38561']);
  assert.equal(hit.called, 'golang.org/x/text/language.Parse');
  assert.equal(hit.file, 'svc/main.go');
  assert.equal(hit.line, 9);
  assert.match(hit.fix, /v0\.3\.7/);
  assert.deepEqual(findings.meta.notCalled, ['GO-2022-1059']);
});

test('cargo-audit findings get CVSS bands, patched versions and warnings', async () => {
  const findings = parseCargoAudit(JSON.parse(await fixture('cargo-audit.json')), '/ws', '/ws/crate');
  const byRule = Object.fromEntries(findings.map((item) => [item.rule, item]));
  assert.equal(byRule['RUSTSEC-2021-0003'].severity, 'critical');
  assert.equal(byRule['RUSTSEC-2021-0003'].package, 'smallvec@1.6.0 (crates.io)');
  assert.deepEqual(byRule['RUSTSEC-2021-0003'].affected_functions, ['smallvec::SmallVec::insert_many']);
  assert.match(byRule['RUSTSEC-2021-0003'].fix, />=1\.6\.1/);
  assert.equal(byRule['RUSTSEC-2021-0003'].file, 'crate/Cargo.lock');
  assert.equal(byRule['RUSTSEC-2020-0071'].severity, 'medium', 'CVSS 6.2');
  assert.equal(byRule['RUSTSEC-2021-0139'].severity, 'low');
  assert.match(byRule['RUSTSEC-2021-0139'].title, /unmaintained/);
});

test('bandit findings keep CWE and confidence but never the matched source', async () => {
  const findings = parseBandit(JSON.parse(await fixture('bandit.json')), '/ws');
  assert.equal(findings.length, 5);
  const shell = findings.find((item) => item.rule.startsWith('B602'));
  assert.equal(shell.severity, 'high');
  assert.equal(shell.file, 'py/app.py');
  assert.equal(shell.line, 3);
  assert.equal(shell.cwe, 'CWE-78');
  assert.ok(!JSON.stringify(findings).includes('SOURCE-LINE-MARKER'));
});

test('zizmor findings point at the workflow line (zizmor rows are zero-based)', async () => {
  const findings = parseZizmor(JSON.parse(await fixture('zizmor.json')), '/ws');
  const artipacked = findings.find((item) => item.rule === 'artipacked');
  assert.equal(artipacked.severity, 'medium');
  assert.equal(artipacked.file, '.github/workflows/cleanup-merged-branches.yml');
  assert.equal(artipacked.line, 22);
  assert.match(artipacked.title, /persist-credentials/);
  assert.match(artipacked.fix, /docs\.zizmor\.sh/);
  assert.equal(findings.find((item) => item.rule === 'superfluous-actions').severity, 'info');
});

test('planScanners adds govulncheck, bandit, zizmor and cargo-audit where they apply', async () => {
  const dir = await tmp();
  try {
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    for (const name of ['govulncheck', 'bandit', 'zizmor', 'cargo-audit', 'osv-scanner']) { await writeFile(path.join(bin, name), '#!/bin/sh\n'); await chmod(path.join(bin, name), 0o755); }
    await writeFile(path.join(dir, 'go.mod'), 'module x\n');
    await writeFile(path.join(dir, 'Cargo.lock'), '');
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'tool.py'), 'print(1)\n');
    await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
    const plan = Object.fromEntries(planScanners(dir, { PATH: bin }).map((item) => [item.name, item]));
    assert.equal(plan.govulncheck.applies && plan.govulncheck.installed, true, 'govulncheck runs alongside osv-scanner');
    assert.equal(plan['cargo-audit'], undefined, 'osv-scanner already covers Cargo.lock');
    assert.equal(plan.bandit.applies, true);
    assert.equal(plan.zizmor.applies, true);
    const fallback = Object.fromEntries(planScanners(dir, { PATH: '' }).map((item) => [item.name, item]));
    assert.equal(fallback['cargo-audit'].applies, true, 'cargo-audit stands in when osv-scanner is missing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('govulncheck marks osv-scanner Go findings it proved unreachable', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  try {
    const bin = path.join(dir, '.bin-outside');
    await mkdir(bin);
    const stream = (await fixture('govulncheck.jsonl')).replace(/'/g, "'\\''");
    await writeFile(path.join(bin, 'govulncheck'), "#!/bin/sh\nprintf '%s' '" + stream + "'\n");
    const osv = { results: [{ source: { path: 'go.mod' }, packages: [
      { package: { name: 'golang.org/x/text', version: '0.3.5', ecosystem: 'Go' }, vulnerabilities: [{ id: 'GO-2022-1059', aliases: ['CVE-2022-32149'], summary: 'DoS in language', affected: [] }, { id: 'GO-2021-0113', aliases: ['CVE-2021-38561'], summary: 'OOB read', affected: [] }], groups: [{ ids: ['GO-2022-1059'], aliases: ['CVE-2022-32149'], max_severity: '7.5' }, { ids: ['GO-2021-0113'], aliases: ['CVE-2021-38561'], max_severity: '7.5' }] }
    ] }] };
    await writeFile(path.join(bin, 'osv-scanner'), "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = \"--output\" ]; then out=\"$2\"; fi; shift; done\nprintf '%s' '" + JSON.stringify(osv) + "' > \"$out\"\n");
    for (const name of ['govulncheck', 'osv-scanner']) await chmod(path.join(bin, name), 0o755);
    await writeFile(path.join(dir, 'go.mod'), 'module example.com/vulnapp\n');
    const result = await runSecurityScan(dir, { scanners: ['osv-scanner', 'govulncheck'] }, { env: { PATH: bin + ':' + process.env.PATH, HOME: dir }, approval: async () => true });
    assert.deepEqual(result.ran.map((item) => [item.scanner, item.findings]), [['osv-scanner', 2], ['govulncheck', 1]]);
    assert.equal(result.ran[1].not_called, 1);
    const unreachable = result.findings.find((item) => item.scanner === 'osv-scanner' && item.rule === 'GO-2022-1059');
    assert.equal(unreachable.not_called, true);
    assert.equal(unreachable.severity, 'info');
    const reachable = result.findings.find((item) => item.scanner === 'osv-scanner' && item.rule === 'GO-2021-0113');
    assert.equal(reachable.not_called, undefined);
    assert.equal(result.findings.at(-1), unreachable, 'unreachable findings sort last');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real zizmor flags template injection in a workflow', { skip: !onPathSync('zizmor') && 'zizmor is not installed' }, async () => {
  const dir = await tmp();
  try {
    await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
    await writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), [
      'on: pull_request_target', 'permissions: {}', 'jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:',
      '      - run: echo "${{ github.event.pull_request.title }}"', ''
    ].join('\n'));
    const result = await runSecurityScan(dir, { scanners: ['zizmor'] }, { env: { ...process.env, ZIZMOR_OFFLINE: 'true' }, approval: async () => true });
    assert.equal(result.ran[0].scanner, 'zizmor');
    assert.ok(result.ran[0].findings >= 1, JSON.stringify(result.ran));
    const injection = result.findings.find((item) => item.rule === 'template-injection');
    assert.ok(injection, JSON.stringify(result.findings.map((item) => item.rule)));
    assert.equal(injection.file, '.github/workflows/ci.yml');
    assert.equal(injection.line, 7);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a scanner that prints nothing is reported as an error, not a clean result', { skip: process.platform === 'win32' }, async () => {
  const dir = await tmp();
  try {
    const bin = path.join(dir, '.bin-outside');
    await mkdir(bin);
    await writeFile(path.join(bin, 'zizmor'), '#!/bin/sh\necho "error: invalid value" >&2\nexit 2\n');
    await chmod(path.join(bin, 'zizmor'), 0o755);
    await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
    const result = await runSecurityScan(dir, { scanners: ['zizmor'] }, { env: { PATH: bin + ':' + process.env.PATH, HOME: dir }, approval: async () => true });
    assert.equal(result.ran[0].findings, undefined);
    assert.match(result.ran[0].error, /printed no report.*invalid value/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real bandit flags shell=True', { skip: !onPathSync('bandit') && 'bandit is not installed' }, async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'app.py'), 'import subprocess\n\ndef run(cmd):\n    subprocess.call(cmd, shell=True)\n');
    const result = await runSecurityScan(dir, { scanners: ['bandit'] }, { env: process.env, approval: async () => true });
    const hit = result.findings.find((item) => item.rule.startsWith('B602'));
    assert.ok(hit, JSON.stringify(result));
    assert.equal(hit.file, 'app.py');
    assert.equal(hit.line, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
