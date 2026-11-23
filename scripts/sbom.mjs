#!/usr/bin/env node
// CycloneDX 1.6 software bill of materials for the package OASIS ships.
//
//   node scripts/sbom.mjs [--out FILE] [--include-dev]
//   node scripts/sbom.mjs --check [FILE]
//
// The SBOM lists every package an `npm install oasis-oss` resolves from
// package-lock.json: the production closure, with optional (platform)
// packages marked as such and dev-only packages left out unless asked for.
// Each component carries its purl, license, the registry tarball it came
// from and the lockfile integrity hash (sha512, converted to hex), and the
// dependency graph records which package pulled in which.
//
// The output is deterministic: components are sorted, the serial number is
// derived from the lockfile's contents, and the timestamp comes from
// SOURCE_DATE_EPOCH (else the last commit's date), so two builds of the same
// commit write byte-identical SBOMs. That is what lets the release job attest
// it and anyone re-create it to compare.
//
// --check compares an SBOM (default: generate one now) against the packages
// actually present in node_modules and exits 1 on a missing package, a
// different version, or a package the SBOM does not list. It reads only
// package.json files, never runs package code.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SBOM_SPEC = '1.6';

function packageNameFromPath(lockPath) {
  // node_modules/a/node_modules/@scope/b -> @scope/b
  const parts = lockPath.split('node_modules/').filter(Boolean);
  return parts[parts.length - 1].replace(/\/$/, '');
}

export function purlFor(name, version) {
  // pkg:npm/%40scope/name@1.2.3 (purl spec: the scope's @ is percent-encoded).
  const encoded = name.startsWith('@') ? '%40' + name.slice(1) : name;
  return 'pkg:npm/' + encoded + '@' + encodeURIComponent(version);
}

export function integrityToHashes(integrity) {
  const hashes = [];
  for (const item of String(integrity || '').split(/\s+/).filter(Boolean)) {
    const match = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(item);
    if (!match) continue;
    const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[match[1]];
    hashes.push({ alg, content: Buffer.from(match[2], 'base64').toString('hex') });
  }
  return hashes;
}

function licenseEntry(license) {
  if (!license) return undefined;
  const text = typeof license === 'string' ? license : license.type || '';
  if (!text) return undefined;
  // A single SPDX id or an SPDX expression; CycloneDX takes either form.
  if (/^\(?[A-Za-z0-9.+-]+(\s+(AND|OR|WITH)\s+\(?[A-Za-z0-9.+-]+\)?)+\)?$/.test(text)) return [{ expression: text }];
  if (/^[A-Za-z0-9.+-]+$/.test(text) && !/^(UNLICENSED|SEE)$/i.test(text)) return [{ license: { id: text } }];
  return [{ license: { name: text.slice(0, 200) } }];
}

// Resolve a dependency the way Node does: the nearest node_modules up the
// tree from the requiring package.
function resolveDependency(packages, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const candidate = (base ? base + '/' : '') + 'node_modules/' + name;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const index = base.lastIndexOf('/node_modules/');
    base = index >= 0 ? base.slice(0, index) : '';
  }
}

function commitDate(root) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/**
 * Builds the SBOM object from a package.json and package-lock.json (v2/v3).
 * `timestamp` overrides the metadata time (ISO string); otherwise
 * SOURCE_DATE_EPOCH, then the last commit, then the epoch.
 */
export function buildSbom({ pkg, lock, includeDev = false, timestamp = '', env = process.env, root = '' } = {}) {
  if (!lock || !lock.packages) throw new Error('package-lock.json v2 or v3 with a "packages" map is required');
  const packages = lock.packages;
  const rootRef = purlFor(pkg.name, pkg.version);
  const refs = new Map();
  const components = [];
  for (const [lockPath, entry] of Object.entries(packages)) {
    if (!lockPath || entry.link) continue;
    if (entry.dev && !includeDev) continue;
    if (entry.extraneous) continue;
    const name = entry.name || packageNameFromPath(lockPath);
    const version = String(entry.version || '');
    if (!version) continue;
    const ref = purlFor(name, version);
    refs.set(lockPath, ref);
    if (components.some((component) => component['bom-ref'] === ref)) continue;
    const scoped = name.startsWith('@') ? name.split('/') : null;
    const component = {
      type: 'library',
      'bom-ref': ref,
      ...(scoped ? { group: scoped[0] } : {}),
      name: scoped ? scoped[1] : name,
      version,
      purl: ref
    };
    const hashes = integrityToHashes(entry.integrity);
    if (hashes.length) component.hashes = hashes;
    const licenses = licenseEntry(entry.license);
    if (licenses) component.licenses = licenses;
    if (entry.resolved) component.externalReferences = [{ type: 'distribution', url: entry.resolved }];
    if (entry.optional || entry.devOptional) component.scope = 'optional';
    else if (entry.dev) component.scope = 'excluded';
    else component.scope = 'required';
    components.push(component);
  }
  components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

  const edges = new Map();
  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    if (to) edges.get(from).add(to);
  };
  const rootEntry = packages[''] || {};
  for (const name of Object.keys({ ...(rootEntry.dependencies || pkg.dependencies || {}), ...(rootEntry.optionalDependencies || pkg.optionalDependencies || {}), ...(includeDev ? rootEntry.devDependencies || pkg.devDependencies || {} : {}) })) {
    const resolved = resolveDependency(packages, '', name);
    if (resolved && refs.has(resolved)) addEdge(rootRef, refs.get(resolved));
  }
  addEdge(rootRef, null);
  for (const [lockPath, ref] of refs) {
    const entry = packages[lockPath];
    addEdge(ref, null);
    for (const name of Object.keys({ ...(entry.dependencies || {}), ...(entry.optionalDependencies || {}) })) {
      const resolved = resolveDependency(packages, lockPath, name);
      if (resolved && refs.has(resolved)) addEdge(ref, refs.get(resolved));
    }
  }
  const dependencies = [...edges].map(([ref, set]) => ({ ref, dependsOn: [...set].sort() })).sort((a, b) => a.ref.localeCompare(b.ref));

  let time = timestamp;
  if (!time) {
    const epoch = Number(env.SOURCE_DATE_EPOCH || (root ? commitDate(root) : '') || 0);
    time = new Date((Number.isFinite(epoch) ? epoch : 0) * 1000).toISOString();
  }
  // RFC 4122 v5-style UUID from the lockfile's packages, so the same lock
  // always yields the same serial number.
  const digest = createHash('sha256').update(JSON.stringify({ name: pkg.name, version: pkg.version, includeDev, packages })).digest('hex');
  const uuid = [digest.slice(0, 8), digest.slice(8, 12), '5' + digest.slice(13, 16), ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20), digest.slice(20, 32)].join('-');

  return {
    bomFormat: 'CycloneDX',
    specVersion: SBOM_SPEC,
    serialNumber: 'urn:uuid:' + uuid,
    version: 1,
    metadata: {
      timestamp: time,
      lifecycles: [{ phase: 'build' }],
      tools: { components: [{ type: 'application', name: 'oasis-sbom', version: pkg.version }] },
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: pkg.name,
        version: pkg.version,
        purl: rootRef,
        ...(licenseEntry(pkg.license) ? { licenses: licenseEntry(pkg.license) } : {}),
        ...(pkg.repository && pkg.repository.url ? { externalReferences: [{ type: 'vcs', url: pkg.repository.url }] } : {})
      }
    },
    components,
    dependencies
  };
}

export function serializeSbom(sbom) {
  return JSON.stringify(sbom, null, 2) + '\n';
}

/**
 * Compares an SBOM with what is installed under root/node_modules. Returns
 * { ok, missing, mismatched, unlisted, checked }. Optional components that
 * are absent (another platform's binary) are not missing.
 */
export function checkInstalled(sbom, root) {
  const expected = new Map();
  for (const component of sbom.components || []) {
    const name = component.group ? component.group + '/' + component.name : component.name;
    if (!expected.has(name)) expected.set(name, { versions: new Set(), optional: true });
    const item = expected.get(name);
    item.versions.add(component.version);
    if (component.scope !== 'optional') item.optional = false;
  }
  const lockPath = path.join(root, 'node_modules', '.package-lock.json');
  const missing = [];
  const mismatched = [];
  const unlisted = [];
  let checked = 0;
  const installed = new Map();
  if (existsSync(lockPath)) {
    // npm's hidden lockfile describes exactly what is on disk.
    const hidden = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const [lockKey, entry] of Object.entries(hidden.packages || {})) {
      if (!lockKey || entry.link) continue;
      const manifest = path.join(root, lockKey, 'package.json');
      if (!existsSync(manifest)) continue;
      let version = entry.version;
      try { version = JSON.parse(readFileSync(manifest, 'utf8')).version || version; } catch { /* keep the lock's */ }
      const name = entry.name || packageNameFromPath(lockKey);
      if (!installed.has(name)) installed.set(name, new Set());
      installed.get(name).add(version);
      if (entry.dev) continue;
      checked += 1;
      const want = expected.get(name);
      if (!want) unlisted.push(name + '@' + version);
      else if (!want.versions.has(version)) mismatched.push(name + '@' + version + ' (SBOM: ' + [...want.versions].join(', ') + ')');
    }
  }
  for (const [name, want] of expected) {
    if (want.optional) continue;
    const have = installed.get(name);
    if (!have) missing.push(name + '@' + [...want.versions].join(', '));
  }
  return { ok: !missing.length && !mismatched.length && !unlisted.length, missing, mismatched, unlisted, checked };
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const includeDev = argv.includes('--include-dev');
  const checkIndex = argv.indexOf('--check');
  if (checkIndex >= 0) {
    const file = argv[checkIndex + 1] && !argv[checkIndex + 1].startsWith('--') ? argv[checkIndex + 1] : '';
    const sbom = file ? JSON.parse(readFileSync(file, 'utf8')) : buildSbom({ pkg, lock, includeDev, root });
    const result = checkInstalled(sbom, root);
    for (const item of result.missing) console.error('missing: ' + item);
    for (const item of result.mismatched) console.error('different version: ' + item);
    for (const item of result.unlisted) console.error('not in the SBOM: ' + item);
    console.log((result.ok ? 'ok' : 'FAIL') + ': ' + result.checked + ' installed package(s) checked against ' + (sbom.components || []).length + ' SBOM component(s)');
    return result.ok ? 0 : 1;
  }
  const outIndex = argv.indexOf('--out');
  const text = serializeSbom(buildSbom({ pkg, lock, includeDev, root }));
  if (outIndex >= 0 && argv[outIndex + 1]) writeFileSync(argv[outIndex + 1], text);
  else process.stdout.write(text);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
