// Version lineage: OASIS was renumbered from 1.x to 0.x (docs/RELEASES.md#version-numbers).
//
// Releases 1.0.0 through 1.8.0 were published before the project settled on a
// pre-1.0 line while its interfaces still change from release to release. They
// map one to one onto the 0.x line by shifting the minor number:
//
//   1.0.0 -> 0.1.0   1.1.0 -> 0.2.0   1.1.1 -> 0.2.1   ...   1.8.0 -> 0.9.0
//
// so the first release under the new numbers is 0.10.0. Without this, an
// install that still reports 1.8.0 would read every 0.x release as a
// downgrade and never update, and installers that pick the highest tag would
// keep choosing the old one.
//
// The 1.x major is retired for good: the release after the 0.x line is 2.0.0,
// so a version starting with 1 is always one of the old numbers.

import semverParse from 'semver/functions/parse.js';
import semverCompare from 'semver/functions/compare.js';

export const RETIRED_MAJOR = 1;
export const NEXT_MAJOR_AFTER_ZERO = 2;

/** The 0.x equivalent of a retired 1.x version string, or the version unchanged. */
export function canonicalVersion(value) {
  const raw = String(value ?? '').trim();
  const prefix = /^v/i.test(raw) ? raw[0] : '';
  const parsed = semverParse(raw.replace(/^v/i, ''));
  if (!parsed || parsed.major !== RETIRED_MAJOR) return raw;
  const pre = parsed.prerelease.length ? '-' + parsed.prerelease.join('.') : '';
  const build = parsed.build.length ? '+' + parsed.build.join('.') : '';
  return prefix + '0.' + (parsed.minor + 1) + '.' + parsed.patch + pre + build;
}

/** Whether a version uses the retired 1.x numbers. */
export function isRetiredVersion(value) {
  const parsed = semverParse(String(value ?? '').trim().replace(/^v/i, ''));
  return Boolean(parsed && parsed.major === RETIRED_MAJOR);
}

/** semver.parse of the canonical form (leading "v" allowed), or null. */
export function parseCanonical(value) {
  return semverParse(canonicalVersion(value).replace(/^v/i, ''));
}

/**
 * Compare two versions in lineage order: -1, 0 or 1. Returns null when either
 * is not a version, so a malformed tag never looks newer.
 */
export function compareLineage(a, b) {
  const left = parseCanonical(a);
  const right = parseCanonical(b);
  if (!left || !right) return null;
  return semverCompare(left, right);
}

/** "v1.8.0 (now numbered 0.9.0)" for messages; plain for current numbers. */
export function describeVersion(value) {
  const raw = String(value ?? '').trim();
  if (!isRetiredVersion(raw)) return raw;
  return raw + ' (now numbered ' + canonicalVersion(raw).replace(/^v/i, '') + ')';
}
