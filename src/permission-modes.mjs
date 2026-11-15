// Canonical permission-mode names and accepted CLI/user-facing aliases.
// Aliases must map to an existing mode; they never add a less restrictive mode.
// dontAsk: never prompt. Calls an allow rule (or the mode default) permits run;
// anything that would wait on an approval prompt is denied and the turn goes on.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

const MODE_ALIASES = new Map([
  ['manual', 'default'],
  ['accept-edits', 'acceptEdits'],
  ['accept_edits', 'acceptEdits'],
  ['dont-ask', 'dontAsk'],
  ['dont_ask', 'dontAsk'],
  ['dontask', 'dontAsk']
]);

export function normalizePermissionMode(value) {
  if (typeof value !== 'string') return null;
  const requested = value.trim();
  if (PERMISSION_MODES.includes(requested)) return requested;
  return MODE_ALIASES.get(requested.toLowerCase()) || null;
}

// The user-facing spelling of a mode, as --permission-mode and the help write it.
const MODE_NAMES = { default: 'manual', acceptEdits: 'accept-edits', dontAsk: 'dont-ask', bypassPermissions: 'bypass-permissions' };
export function permissionModeName(mode) {
  const canonical = normalizePermissionMode(String(mode || '')) || String(mode || '');
  return MODE_NAMES[canonical] || canonical;
}
