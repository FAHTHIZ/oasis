// Protected configuration paths.
//
// Workspace edits normally apply without a prompt (they are snapshotted and
// can be undone). A few files are different: they change what OASIS, Claude
// Code or git will run later without asking — permission rules, hooks, MCP
// servers, plugins, git hooks and git config. A prompt-injected model that
// writes one of these can grant itself future permissions that no undo will
// catch, because the damage happens on the next run.
//
// Edits to these paths always ask, with a warning, even under broad allow
// rules, --yes, acceptEdits or auto mode. Only bypassPermissions, an allow rule
// that names a protected path explicitly, or OASIS_ALLOW_CONFIG_EDITS=1
// skip the prompt.

import path from 'node:path';

const PROTECTED = [
  // Permission rules, hooks, env and model settings.
  /^\.(?:oasis|claude)\/settings(?:\.local)?\.json$/,
  // Hook scripts and plugin bundles that load automatically.
  /^\.(?:oasis|claude)\/hooks\//,
  /^\.(?:oasis|claude)\/plugins\//,
  // MCP servers start processes on the next run.
  /^\.mcp\.json$/,
  /^\.(?:oasis|claude)\/mcp\.json$/,
  // LSP servers start processes too.
  /^\.lsp\.json$/,
  // Git hooks run on commit/checkout; git config can set core.hooksPath,
  // core.fsmonitor, core.sshCommand and similar command hooks.
  /^\.git(?:\/|$)/
];

const REASONS = [
  [/settings(?:\.local)?\.json$/, 'it holds permission rules, hooks and environment settings'],
  [/^\.git\/hooks\//, 'git runs these hooks automatically on commit and checkout'],
  [/^\.git\//, 'git config can make git run commands (core.hooksPath, core.fsmonitor, core.sshCommand)'],
  [/mcp\.json$/, 'MCP servers listed here start as processes on the next run'],
  [/\.lsp\.json$/, 'language servers listed here start as processes on the next run'],
  [/hooks\//, 'hook scripts run automatically on tool and session events'],
  [/plugins\//, 'plugins can add hooks, MCP servers and commands that load automatically']
];

/** Workspace-relative, forward-slash, lower-case form of a path (or null if outside the root). */
export function normalizeWorkspaceRelative(root, rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return null;
  const absolute = path.resolve(root || process.cwd(), text);
  const relative = path.relative(path.resolve(root || process.cwd()), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/').replace(/\\/g, '/').toLowerCase();
}

/** Returns { path, reason } when rawPath is a protected config path, else null. */
export function protectedConfigPath(root, rawPath) {
  const relative = normalizeWorkspaceRelative(root, rawPath);
  if (relative === null) return null;
  if (!PROTECTED.some((pattern) => pattern.test(relative))) return null;
  const reason = (REASONS.find(([pattern]) => pattern.test(relative)) || [null, 'it changes what runs without approval'])[1];
  return { path: relative, reason };
}

/** True when an allow rule names a protected path explicitly (for example Edit(.oasis/settings.json)). */
export function ruleNamesProtectedPath(rule) {
  const match = String(rule || '').match(/^[A-Za-z0-9_.-]+\((.+)\)$/s);
  if (!match) return false;
  const target = match[1].trim().replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();
  return /^\.(?:oasis|claude|git)\b|^\.mcp\.json|^\.lsp\.json/.test(target);
}

export function protectedEditsAllowed(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.OASIS_ALLOW_CONFIG_EDITS || ''));
}

export function protectedEditMessage(toolName, hit) {
  return 'Warning: ' + toolName + ' wants to change ' + hit.path + ', a protected configuration file — ' + hit.reason +
    '. A prompt-injected model could use this to grant itself permissions that apply on the next run. Allow this edit?';
}
