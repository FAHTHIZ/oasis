// Verified updates: `oasis update` on an npm install fetches the release's own
// npm tarball (the file the release job built, packed twice and attested), not
// a GitHub source archive, and installs it only after three checks:
//
//   1. checksum   its SHA-256 matches the release's SHA256SUMS line for it;
//   2. contents   its package/package.json names oasis-oss at the release's
//                 version, so a valid file from another release (a downgrade)
//                 or another package is refused;
//   3. provenance when the GitHub CLI is installed, `gh attestation verify`
//                 checks the Sigstore-signed SLSA provenance: built by this
//                 repository's release workflow from the release tag at the
//                 release commit. A failed verification blocks the install.
//
// SHA256SUMS comes from the same release as the tarball, so the checksum alone
// guards against corruption and truncation, not against someone who can change
// release assets; provenance is what ties the bytes to the release workflow.
// OASIS_UPDATE_REQUIRE_PROVENANCE=1 refuses an update whose provenance could
// not be verified (no gh, no attestation, or gh could not reach Sigstore).
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const UPDATE_REPOSITORY = 'FAHTHIZ/oasis';
export const RELEASE_WORKFLOW = UPDATE_REPOSITORY + '/.github/workflows/release.yml';
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;
const MAX_SUMS_BYTES = 1024 * 1024;

/** The release's npm tarball and SHA256SUMS, or null when either is missing. */
export function releaseTarballAssets(release, tag) {
  const version = String(tag || '').replace(/^v/, '');
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const url = (asset) => String(asset && asset.browser_download_url || '');
  const trusted = (asset) => /^https:\/\/github\.com\/FAHTHIZ\/oasis\/releases\/download\//i.test(url(asset));
  const tarball = assets.find((asset) => asset && asset.name === 'oasis-oss-' + version + '.tgz' && trusted(asset));
  const sums = assets.find((asset) => asset && asset.name === 'SHA256SUMS' && trusted(asset));
  return tarball && sums ? { tarball: { name: tarball.name, url: url(tarball) }, sums: { name: sums.name, url: url(sums) } } : null;
}

/** SHA256SUMS lines ("<hex>  [./]name" or "<hex> *name") as a name → digest map. */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](?:\.\/)?(.+)$/.exec(line.trim());
    if (match && !sums.has(match[2])) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** package/package.json from an npm tarball (gzip + ustar), parsed, or null. */
export function tarballPackageJson(buffer) {
  let tar;
  try { tar = gunzipSync(buffer, { maxOutputLength: 1024 * 1024 * 1024 }); } catch { return null; }
  let offset = 0;
  let longName = '';
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) return null;
    const type = field(156, 1) || '0';
    const prefix = field(257, 6).startsWith('ustar') ? field(345, 155) : '';
    const body = tar.subarray(offset + 512, offset + 512 + size);
    let name = longName || (prefix ? prefix + '/' : '') + field(0, 100);
    longName = '';
    if (type === 'x') {
      const pathRecord = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (pathRecord) longName = pathRecord[1];
    } else if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
    } else if ((type === '0' || type === '\0') && name.replace(/^\.\//, '') === 'package/package.json') {
      try { return JSON.parse(body.toString('utf8')); } catch { return null; }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
    name = '';
  }
  return null;
}

async function download(url, { fetchImpl, maxBytes, timeoutMs }) {
  const response = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'oasis-update', accept: 'application/octet-stream' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status + ' for ' + url.split('/').pop() + '.');
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (declared > maxBytes) throw new Error(url.split('/').pop() + ' is larger than expected (' + declared + ' bytes).');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(url.split('/').pop() + ' is larger than expected.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function runGh(args, { exec, env }) {
  if (exec) return exec('gh', args);
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : error.code === 'ENOENT' ? 'ENOENT' : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (error && error.code !== 'ENOENT' ? error.message : '')) });
    });
  });
}

/**
 * `gh attestation verify` for the tarball, pinned to this repository's release
 * workflow, the release tag and the release commit. Status: verified, failed
 * (an attestation exists and does not match: never install), none (the release
 * has no attestation) or unavailable (no gh, or gh could not check).
 */
export async function verifyProvenance(file, { tag, commit, exec, env = process.env } = {}) {
  const args = ['attestation', 'verify', file, '--repo', UPDATE_REPOSITORY, '--signer-workflow', RELEASE_WORKFLOW, '--source-ref', 'refs/tags/' + tag, '--deny-self-hosted-runners', '--format', 'json'];
  if (commit) args.push('--source-digest', commit);
  const result = await runGh(args, { exec, env });
  if (result.code === 'ENOENT') return { status: 'unavailable', detail: 'the GitHub CLI (gh) is not installed' };
  if (result.code === 0) {
    let count = 0;
    try { count = JSON.parse(result.stdout).length || 0; } catch {}
    return { status: 'verified', detail: 'signed SLSA provenance from ' + RELEASE_WORKFLOW + ' at refs/tags/' + tag + (count ? ' (' + count + ' attestation' + (count === 1 ? '' : 's') + ')' : '') };
  }
  const text = (result.stderr + '\n' + result.stdout).trim();
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || 'exit ' + result.code;
  if (/no attestations? (were )?found|HTTP 404/i.test(text)) return { status: 'none', detail: 'the release has no provenance attestation' };
  if (/verification failed|failed to verify|does not match|expected .* got|mismatch/i.test(text)) return { status: 'failed', detail: firstLine.slice(0, 300) };
  return { status: 'unavailable', detail: 'gh could not check it: ' + firstLine.slice(0, 300) };
}

export function requireProvenance(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.OASIS_UPDATE_REQUIRE_PROVENANCE || ''));
}

/**
 * Download the release tarball into a private temporary folder and check it.
 * Resolves to { file, dir, sha256, provenance, notes } or throws with the
 * reason the update was refused. The caller removes dir when done.
 */
export async function downloadVerifiedRelease(latest, { fetchImpl = fetch, exec, env = process.env, timeoutMs = 120000, log = () => {} } = {}) {
  const assets = latest && latest.tarball;
  if (!assets) throw new Error('Release ' + (latest && latest.tag) + ' has no npm tarball with SHA256SUMS.');
  const version = String(latest.tag).replace(/^v/, '');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-update-'));
  try {
    log('Downloading ' + assets.tarball.name + ' and SHA256SUMS from release ' + latest.tag + '...');
    const [sumsText, tarball] = await Promise.all([
      download(assets.sums.url, { fetchImpl, maxBytes: MAX_SUMS_BYTES, timeoutMs }).then((buffer) => buffer.toString('utf8')),
      download(assets.tarball.url, { fetchImpl, maxBytes: MAX_TARBALL_BYTES, timeoutMs })
    ]);
    const expected = parseSha256Sums(sumsText).get(assets.tarball.name);
    if (!expected) throw new Error('SHA256SUMS for ' + latest.tag + ' does not list ' + assets.tarball.name + '.');
    const actual = sha256Hex(tarball);
    if (actual !== expected) throw new Error(assets.tarball.name + ' does not match SHA256SUMS (expected ' + expected + ', got ' + actual + '). Nothing was installed.');
    const pkg = tarballPackageJson(tarball);
    if (!pkg) throw new Error(assets.tarball.name + ' is not a readable npm package. Nothing was installed.');
    if (pkg.name !== 'oasis-oss' || pkg.version !== version) throw new Error(assets.tarball.name + ' contains ' + pkg.name + '@' + pkg.version + ', not oasis-oss@' + version + '. Nothing was installed.');
    const file = path.join(dir, assets.tarball.name);
    await writeFile(file, tarball, { mode: 0o600 });
    const provenance = await verifyProvenance(file, { tag: latest.tag, commit: latest.sha, exec, env });
    if (provenance.status === 'failed') throw new Error('Provenance check failed for ' + assets.tarball.name + ': ' + provenance.detail + '. Nothing was installed.');
    if (provenance.status !== 'verified' && requireProvenance(env)) throw new Error('OASIS_UPDATE_REQUIRE_PROVENANCE is set and the provenance could not be verified (' + provenance.detail + '). Nothing was installed.');
    const notes = ['Checksum: sha256 ' + actual + ' matches SHA256SUMS.', 'Package: oasis-oss@' + version + '.'];
    notes.push(provenance.status === 'verified' ? 'Provenance: verified, ' + provenance.detail + '.' : 'Provenance: not verified, ' + provenance.detail + '.');
    return { file, dir, sha256: actual, provenance, notes };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readInstalledPackageVersion(appRoot) {
  try { return String(JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}
