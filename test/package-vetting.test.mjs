import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vetPackage, nearMiss, bareName } from '../src/package-vetting.mjs';
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
