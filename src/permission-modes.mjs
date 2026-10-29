// Canonical permission-mode names and accepted CLI/user-facing aliases.
// Aliases must map to an existing mode; they never add a less restrictive mode.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];

const MODE_ALIASES = new Map([
  ['manual', 'default'],
  ['accept-edits', 'acceptEdits'],
  ['accept_edits', 'acceptEdits']
]);

export function normalizePermissionMode(value) {
  if (typeof value !== 'string') return null;
  const requested = value.trim();
  if (PERMISSION_MODES.includes(requested)) return requested;
  return MODE_ALIASES.get(requested.toLowerCase()) || null;
}

export function describePermissionModeAlias(value) {
  const requested = typeof value === 'string' ? value.trim() : '';
  const normalized = normalizePermissionMode(requested);
  return normalized && normalized !== requested
    ? { requested, canonical: normalized }
    : null;
}
