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
  /^\.git(?:\/|$)/,
  // Configuration that other coding agents load automatically.
  /^\.cursor\/(?:mcp\.json|hooks\.json|rules\/|environment\.json)/,
  /^\.gemini\/(?:settings\.json|extensions\/)/,
  /^\.codex\/config\.toml$/,
  /^\.continue\/config\.(?:json|ya?ml|ts)$/,
  /^\.aider\.conf\.ya?ml$/,
  // Editor settings and tasks: VS Code runs folderOpen tasks automatically and
  // settings can name executables or auto-approve agent tools (the
  // CVE-2025-53773 pattern).
  /^\.vscode\/(?:settings|tasks|launch|extensions|mcp)\.json$/,
  /^[^/]+\.code-workspace$/,
  /^\.devcontainer\//,
  /^\.devcontainer\.json$/,
  // Files other tools execute automatically: direnv, commit hooks, package
  // manager hooks.
  /^\.envrc$/,
  /^\.husky\//,
  /^\.pre-commit-config\.ya?ml$/,
  /^lefthook(?:-local)?\.ya?ml$/,
  /^\.yarnrc\.yml$/,
  /^\.pnpmfile\.c?js$/,
  /^\.npmrc$/
];

const REASONS = [
  [/^\.(?:cursor|gemini|codex|continue)\/|^\.aider\.conf/, 'another coding agent loads this configuration (MCP servers, hooks, rules) automatically'],
  [/^\.vscode\/|\.code-workspace$/, 'the editor can run tasks on folder open and use settings that name executables or auto-approve agent tools'],
  [/^\.devcontainer/, 'dev containers run lifecycle commands (postCreateCommand) automatically'],
  [/^\.envrc$/, 'direnv executes this file when you enter the directory'],
  [/^(?:\.husky\/|\.pre-commit-config|lefthook)/, 'commit hooks run automatically on git commit'],
  [/^(?:\.yarnrc\.yml|\.pnpmfile|\.npmrc)/, 'the package manager reads this on install and it can run code or redirect the registry'],
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
  return /^\.(?:oasis|claude|git|vscode|cursor|gemini|codex|continue|husky|devcontainer)\b|^\.mcp\.json|^\.lsp\.json|^\.envrc|^\.pre-commit-config|^\.npmrc|^\.yarnrc|^\.pnpmfile|^lefthook/.test(target);
}

export function protectedEditsAllowed(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.OASIS_ALLOW_CONFIG_EDITS || ''));
}

export function protectedEditMessage(toolName, hit) {
  return 'Warning: ' + toolName + ' wants to change ' + hit.path + ', a protected configuration file — ' + hit.reason +
    '. A prompt-injected model could use this to grant itself permissions that apply on the next run. Allow this edit?';
}

// Shell commands that write protected paths (`echo ... > .git/hooks/pre-commit`,
// `cp x .oasis/settings.json`) or set git config keys that run commands.
// Returns a reason string or null. Reading these files (cat, grep) is fine.
const SHELL_PROTECTED_PATH = /(?:^|[\s'"=:/\\(])\.?(?:\.git[\\/](?:hooks[\\/]|config\b)|\.(?:oasis|claude)[\\/](?:settings(?:\.local)?\.json|hooks[\\/]|plugins[\\/])|\.mcp\.json|\.lsp\.json|\.vscode[\\/](?:settings|tasks|launch|mcp)\.json|\.envrc\b|\.husky[\\/]|\.devcontainer[\\/]|\.(?:cursor|gemini|codex)[\\/](?:mcp\.json|hooks\.json|settings\.json|config\.toml)|\.pre-commit-config\.ya?ml|\.pnpmfile\.c?js|\.yarnrc\.yml)/i;
const SHELL_WRITE = /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bln\b|\binstall\b|\bsed\s+(?:-[a-z]*i|--in-place)|\bperl\s+-[a-z]*i|\bchmod\b|\btruncate\b|\btouch\b|\bdd\b|\brsync\b|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item|WriteAllText|writeFile)/i;
const GIT_CONFIG_EXEC = /\bgit\s+(?:-c\s+\S+\s+)*config\b(?![^;&|]*\s--(?:get|list|unset)\b)[^;&|]*\b(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass)|alias\.|filter\.|diff\.\S+\.textconv|credential\.helper|include\.path|includeif\.)/i;

export function protectedShellWrite(command) {
  const text = String(command || '');
  if (GIT_CONFIG_EXEC.test(text)) return 'it sets a git config key that makes git run a command';
  if (SHELL_PROTECTED_PATH.test(text) && SHELL_WRITE.test(text)) return 'it appears to write a protected configuration file (settings, hooks, plugins, MCP/LSP servers or git hooks/config), which could grant permissions or run commands on the next run';
  return null;
}
