import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vetPackage, nearMiss, bareName, pinnedVersion } from '../src/package-vetting.mjs';
import { executeTool } from '../src/tools.mjs';

const NOW = Date.parse('2026-10-31T00:00:00Z');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fakeRegistry(packages) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    for (const [name, info] of Object.entries(packages)) {
      if (url === 'https://registry.npmjs.org/' + encodeURIComponent(name)) return json(200, { time: { created: info.created } });
      if (url === 'https://api.npmjs.org/downloads/point/last-week/' + encodeURIComponent(name)) return json(200, { downloads: info.downloads });
      if (url === 'https://pypi.org/pypi/' + name + '/json') return json(200, { releases: { '1.0': [{ upload_time_iso_8601: info.created }] } });
    }
    return json(404, {});
  };
  return { fetchImpl, urls };
}

test('typosquat detection and version stripping', () => {
  assert.equal(nearMiss('npm', 'lodahs'), 'lodash', 'swapped letters');
  assert.equal(nearMiss('npm', 'lodsh'), 'lodash');
  assert.equal(nearMiss('npm', 'expresss'), 'express');
  assert.equal(nearMiss('pypi', 'reqeusts'), 'requests');
  assert.equal(nearMiss('pypi', 'request'), 'requests');
  assert.equal(nearMiss('pypi', 'python_dotenv'), '', 'separator variants of the same name are fine');
  assert.equal(nearMiss('npm', 'left-pad-utils-extra'), '');
  assert.equal(nearMiss('npm', 'react'), '');
  assert.equal(nearMiss('npm', 'preact'), '');
  assert.equal(bareName('npm', '@scope/pkg@1.2.3'), '@scope/pkg');
  assert.equal(bareName('npm', 'lodash@4'), 'lodash');
  assert.equal(bareName('pip', 'requests>=2.0'), 'requests');
});

test('vetPackage: missing, new, unpopular and healthy packages', async () => {
  const { fetchImpl } = fakeRegistry({ lodash: { created: '2012-04-23T00:00:00Z', downloads: 50000000 }, 'shiny-new-thing': { created: '2026-10-25T00:00:00Z', downloads: 3 } });
  const missing = await vetPackage({ ecosystem: 'npm', packageName: 'totally-invented-pkg' }, { fetchImpl, now: NOW });
  assert.equal(missing.missing, true);
  assert.match(missing.warnings[0], /does not exist on the npm registry/);
  const fresh = await vetPackage({ ecosystem: 'npm', packageName: 'shiny-new-thing@1.0.0' }, { fetchImpl, now: NOW });
  assert.equal(fresh.risky, true);
  assert.match(fresh.warnings.join(' '), /first published 6 day/);
  assert.match(fresh.warnings.join(' '), /only 3 download/);
  const healthy = await vetPackage({ ecosystem: 'npm', packageName: 'lodash' }, { fetchImpl, now: NOW });
  assert.equal(healthy.risky, false);
  assert.deepEqual(healthy.warnings, []);
  const pypiMissing = await vetPackage({ ecosystem: 'pip', packageName: 'huggingface-cli-tools-pro' }, { fetchImpl, now: NOW });
  assert.match(pypiMissing.warnings[0], /does not exist on PyPI/);
  const offline = await vetPackage({ ecosystem: 'npm', packageName: 'lodash' }, { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, now: NOW });
  assert.equal(offline.checked, false);
  assert.equal(offline.risky, false, 'network problems never block');
  assert.equal((await vetPackage({ ecosystem: 'npm', packageName: 'x' }, { fetchImpl, env: { OASIS_PACKAGE_VETTING: '0' } })).checked, false);
  assert.equal((await vetPackage({ ecosystem: 'apt', packageName: 'jq' }, { fetchImpl })).checked, false, 'system packages are not vetted');
});

test('install_package refuses hallucinated names and asks a human for risky ones even with auto-approve', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-vet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
  const { fetchImpl } = fakeRegistry({ 'shiny-new-thing': { created: new Date(Date.now() - 2 * 86400000).toISOString(), downloads: 1 } });
  const blocked = await executeTool('install_package', { packageName: 'totally-invented-pkg', ecosystem: 'npm' }, { root, autoApprove: true, approval: async () => true, fetchImpl });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.message, /does not exist on the npm registry\. Nothing was installed/);
  const prompts = [];
  const declined = await executeTool('install_package', { packageName: 'shiny-new-thing', ecosystem: 'npm' }, { root, autoApprove: true, approval: async (text) => { prompts.push(text); return false; }, fetchImpl });
  assert.equal(declined.approved, false);
  assert.equal(prompts.length, 1, 'auto-approve was overridden for a risky package');
  assert.match(prompts[0], /Package check: .*first published/);
  assert.match(JSON.stringify(declined.vetting), /only 1 download/);
});

test('shell and run_command installs are vetted too', async (t) => {
  const { extractInstallTargets } = await import('../src/package-vetting.mjs');
  assert.deepEqual(extractInstallTargets('cd web && npm install lodash@4 -D @types/node').map((item) => item.spec), ['lodash@4', '@types/node']);
  assert.deepEqual(extractInstallTargets('python3 -m pip install -r req.txt requests>=2').map((item) => item.spec), ['requests>=2']);
  assert.deepEqual(extractInstallTargets('npm ci && npm install && npm install ./pkg git+https://x/y.git'), []);
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-vet-cmd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { fetchImpl } = fakeRegistry({});
  const viaCommand = await executeTool('run_command', { command: 'npm', args: ['install', 'totally-invented-pkg'] }, { root, autoApprove: true, approval: async () => true, fetchImpl, env: process.env });
  assert.equal(viaCommand.blocked, true);
  assert.match(viaCommand.message, /does not exist on the npm registry\. The command was not run/);
  const { executePowerTool } = await import('../src/power-tools.mjs');
  const viaShell = await executePowerTool('run_shell', { command: 'pip install reqeusts && echo ran' }, { root, autoApprove: true, approval: async () => true, fetchImpl, env: process.env }, root);
  assert.equal(viaShell.blocked, true);
  assert.match(viaShell.message, /does not exist on PyPI/);
  assert.equal(viaShell.stdout, undefined, 'nothing ran');
});

test('OSV.dev advisories: malicious packages force a prompt, known vulnerabilities are noted', async () => {
  const queries = [];
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://api.osv.dev/v1/query') {
      const body = JSON.parse(init.body);
      queries.push(body);
      if (body.package.name === 'evil-helper') return json(200, { vulns: [{ id: 'MAL-2026-1234', summary: 'Malicious code in evil-helper (npm)' }] });
      if (body.package.name === 'old-lib' && body.version === '1.2.3') return json(200, { vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', summary: 'old-lib leaks credentials via malicious URLs' }, { id: 'CVE-2026-0001', aliases: [] }] });
      return json(200, {});
    }
    if (url === 'https://registry.npmjs.org/evil-helper' || url === 'https://registry.npmjs.org/old-lib') return json(200, { time: { created: '2015-01-01T00:00:00Z' }, 'dist-tags': { latest: '9.9.9' } });
    if (url.startsWith('https://api.npmjs.org/downloads/')) return json(200, { downloads: 100000 });
    if (url === 'https://pypi.org/pypi/requests/json') return json(200, { info: { version: '2.32.3' }, releases: { '2.32.3': [{ upload_time_iso_8601: '2014-01-01T00:00:00Z' }] } });
    return json(404, {});
  };
  const evil = await vetPackage({ ecosystem: 'npm', packageName: 'evil-helper' }, { fetchImpl, now: NOW });
  assert.equal(evil.risky, true);
  assert.match(evil.warnings.join(' '), /evil-helper@9\.9\.9" is reported as malicious in OSV \(MAL-2026-1234\)/);
  assert.equal(queries[0].version, '9.9.9', 'without a pin, the latest version is checked');
  assert.deepEqual(queries[0].package, { name: 'evil-helper', ecosystem: 'npm' });
  const old = await vetPackage({ ecosystem: 'npm', packageName: 'old-lib@1.2.3' }, { fetchImpl, now: NOW });
  assert.equal(old.risky, false, 'vulnerabilities alone (even ones that mention "malicious" input) do not force a prompt');
  assert.match(old.warnings.join(' '), /old-lib@1\.2\.3" has 2 known vulnerabilities in OSV \(GHSA-aaaa-bbbb-cccc, CVE-2026-0001\)/);
  await vetPackage({ ecosystem: 'pip', packageName: 'requests' }, { fetchImpl, now: NOW });
  assert.deepEqual(queries.at(-1), { package: { name: 'requests', ecosystem: 'PyPI' }, version: '2.32.3' });
  const unreachable = await vetPackage({ ecosystem: 'npm', packageName: 'old-lib' }, { fetchImpl: async (url, init) => (url.includes('osv.dev') ? json(503, {}) : fetchImpl(url, init)), now: NOW });
  assert.equal(unreachable.checked, true);
  assert.deepEqual(unreachable.warnings, [], 'OSV being down never adds warnings or blocks');
  assert.equal(pinnedVersion('npm', 'lodash@4.17.21'), '4.17.21');
  assert.equal(pinnedVersion('npm', '@scope/pkg@1.0.0-beta.1'), '1.0.0-beta.1');
  assert.equal(pinnedVersion('npm', 'lodash@4'), '');
  assert.equal(pinnedVersion('npm', 'lodash@^4.17.0'), '');
  assert.equal(pinnedVersion('pip', 'requests==2.31.0'), '2.31.0');
  assert.equal(pinnedVersion('pip', 'requests>=2'), '');
  assert.equal(pinnedVersion('cargo', 'serde@1.0.200'), '1.0.200');
});
