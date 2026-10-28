// Layered Oasis settings: user, project (shared), and project-local files.
//
// Settings files use the same shape as Claude Code's settings.json so teams can
// reuse existing configuration:
//   { "permissions": { "allow": [], "ask": [], "deny": [], "defaultMode": "default" },
//     "hooks": { "PreToolUse": [ { "matcher": "edit_file", "hooks": [ { "type": "command", "command": "..." } ] } ] },
//     "sandbox": { "enabled": false, "network": false } }
//
// Trust model: a cloned repository can contain any file, so project-scoped
// settings are split by effect. Rules that only make Oasis stricter (deny / ask)
// always apply. Rules that loosen policy (allow, hooks that run commands,
// defaultMode, sandbox opt-outs) apply only after the user trusts the workspace
// with `oasis trust` or `/trust`. User-level settings always apply.
import { readFile, writeFile, mkdir, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const MAX_SETTINGS_BYTES = 256 * 1024;
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export function userSettingsPath(env = process.env) {
  return path.join(getConfigDirectory(env), 'settings.json');
}

export function projectSettingsPaths(root) {
  return [
    { scope: 'project', file: path.join(root, '.claude', 'settings.json') },
    { scope: 'project', file: path.join(root, '.oasis', 'settings.json') },
    { scope: 'local', file: path.join(root, '.claude', 'settings.local.json') },
    { scope: 'local', file: path.join(root, '.oasis', 'settings.local.json') }
  ];
}

async function readJsonFile(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SETTINGS_BYTES) throw new Error('Settings file is too large: ' + file);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    throw new Error('Invalid JSON in settings file ' + file + ': ' + error.message);
  }
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 500) : [];
}

export async function workspaceIdentity(root) {
  try { return await realpath(root); } catch { return path.resolve(root); }
}

export async function isWorkspaceTrusted(root, env = process.env) {
  if (env.OASIS_TRUST_WORKSPACE === '1') return true;
  const user = await readJsonFile(userSettingsPath(env)).catch(() => null);
  const trusted = stringList(user && user.trustedWorkspaces);
  const id = await workspaceIdentity(root);
  return trusted.includes(id);
}

export async function updateUserSettings(mutator, env = process.env) {
  const file = userSettingsPath(env);
  const current = (await readJsonFile(file)) || {};
  const next = mutator(structuredClone(current)) || current;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { await chmod(file, 0o600); } catch {}
  return next;
}

export async function setWorkspaceTrust(root, trusted, env = process.env) {
  const id = await workspaceIdentity(root);
  await updateUserSettings((settings) => {
    const list = new Set(stringList(settings.trustedWorkspaces));
    if (trusted) list.add(id); else list.delete(id);
    settings.trustedWorkspaces = [...list];
    return settings;
  }, env);
  return id;
}

export async function addPermissionRule(scope, kind, rule, root, env = process.env) {
  if (!['allow', 'ask', 'deny'].includes(kind)) throw new Error('Permission kind must be allow, ask, or deny.');
  if (typeof rule !== 'string' || !rule.trim() || rule.length > 500) throw new Error('Provide a permission rule such as run_command(npm test:*).');
  const write = async (file) => {
    const current = (await readJsonFile(file)) || {};
    current.permissions = current.permissions && typeof current.permissions === 'object' ? current.permissions : {};
    const list = new Set(stringList(current.permissions[kind]));
    list.add(rule.trim());
    current.permissions[kind] = [...list];
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return file;
  };
  if (scope === 'user') return await write(userSettingsPath(env));
  if (scope === 'local') return await write(path.join(root, '.oasis', 'settings.local.json'));
  if (scope === 'project') return await write(path.join(root, '.oasis', 'settings.json'));
  throw new Error('Scope must be user, project, or local.');
}

function normalizeHooks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [event, groups] of Object.entries(raw)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups.slice(0, 50)) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const matcher = typeof group.matcher === 'string' ? group.matcher : '';
      const hooks = group.hooks
        .filter((hook) => hook && hook.type === 'command' && typeof hook.command === 'string' && hook.command.trim())
        .map((hook) => ({ type: 'command', command: hook.command, timeout: Number(hook.timeout) || 60 }));
      if (!hooks.length) continue;
      (out[event] ||= []).push({ matcher, hooks });
    }
  }
  return out;
}

function mergeHooks(target, extra, source) {
  for (const [event, groups] of Object.entries(extra)) {
    for (const group of groups) (target[event] ||= []).push({ ...group, source });
  }
}

export async function loadSettings(root, options = {}) {
  const env = options.env || process.env;
  const result = {
    permissions: { allow: [], ask: [], deny: [], defaultMode: 'default', additionalDirectories: [] },
    hooks: {},
    sandbox: { enabled: false, network: false, autoAllowCommands: true },
    shell: { enabled: false },
    model: null,
    outputStyle: null,
    trusted: false,
    sources: [],
    ignoredUntrusted: []
  };
  const apply = (settings, scope, file, trusted) => {
    if (!settings) return;
    result.sources.push({ scope, file });
    const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
    result.permissions.deny.push(...stringList(permissions.deny));
    result.permissions.ask.push(...stringList(permissions.ask));
    if (typeof settings.outputStyle === 'string' && settings.outputStyle.trim()) result.outputStyle = settings.outputStyle.trim().toLowerCase();
    if (!trusted) {
      const loosening = stringList(permissions.allow).length || settings.hooks || permissions.defaultMode || settings.sandbox || settings.shell;
      if (loosening) result.ignoredUntrusted.push(file);
      return;
    }
    result.permissions.allow.push(...stringList(permissions.allow));
    result.permissions.additionalDirectories.push(...stringList(permissions.additionalDirectories));
    if (PERMISSION_MODES.includes(permissions.defaultMode)) result.permissions.defaultMode = permissions.defaultMode;
    mergeHooks(result.hooks, normalizeHooks(settings.hooks), scope);
    if (settings.sandbox && typeof settings.sandbox === 'object') {
      if (typeof settings.sandbox.enabled === 'boolean') result.sandbox.enabled = settings.sandbox.enabled;
      if (typeof settings.sandbox.network === 'boolean') result.sandbox.network = settings.sandbox.network;
      if (typeof settings.sandbox.autoAllowCommands === 'boolean') result.sandbox.autoAllowCommands = settings.sandbox.autoAllowCommands;
    }
    if (settings.shell && typeof settings.shell === 'object' && typeof settings.shell.enabled === 'boolean') result.shell.enabled = settings.shell.enabled;
    if (typeof settings.model === 'string' && settings.model.trim()) result.model = settings.model.trim();
  };

  const userFile = userSettingsPath(env);
  apply(await readJsonFile(userFile), 'user', userFile, true);
  result.trusted = await isWorkspaceTrusted(root, env);
  if (root) {
    for (const { scope, file } of projectSettingsPaths(root)) {
      apply(await readJsonFile(file), scope, file, result.trusted);
    }
  }
  if (env.OASIS_SANDBOX === '1') result.sandbox.enabled = true;
  if (env.OASIS_SANDBOX === '0') result.sandbox.enabled = false;
  return result;
}
