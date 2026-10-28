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
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];

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

function normalizeHook(hook) {
  if (!hook || typeof hook !== 'object') return null;
  const timeout = Number(hook.timeout) || 0;
  const type = hook.type || 'command';
  if (type === 'command' && typeof hook.command === 'string' && hook.command.trim()) return { type, command: hook.command, timeout: timeout || 60 };
  if (type === 'http' && typeof hook.url === 'string' && /^https?:\/\//i.test(hook.url)) {
    const headers = {};
    if (hook.headers && typeof hook.headers === 'object') for (const [key, value] of Object.entries(hook.headers)) if (typeof value === 'string') headers[key] = value;
    const allowedEnvVars = Array.isArray(hook.allowedEnvVars) ? hook.allowedEnvVars.filter((name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) : [];
    return { type, url: hook.url, headers, allowedEnvVars, timeout: timeout || 30 };
  }
  if (type === 'prompt' && typeof hook.prompt === 'string' && hook.prompt.trim()) return { type, prompt: hook.prompt, model: typeof hook.model === 'string' ? hook.model : undefined, timeout: timeout || 30 };
  return null;
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
        .map(normalizeHook)
        .filter(Boolean);
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
    statusLine: null,
    lspServers: {},
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
    // Turning auto memory off is allowed even in untrusted workspaces; it never loosens anything.
    if (settings.autoMemory === false) result.autoMemory = false;
    if (!trusted) {
      const loosening = stringList(permissions.allow).length || settings.hooks || permissions.defaultMode || settings.sandbox || settings.shell || settings.statusLine || settings.lspServers || settings.autoMode;
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
    if (settings.autoMemory === true) result.autoMemory = true;
    // Auto mode classifier: { "model": "cheap-model", "rules": ["Never touch infra/"] }
    if (settings.autoMode && typeof settings.autoMode === 'object') {
      result.autoMode ||= { model: null, rules: [] };
      if (typeof settings.autoMode.model === 'string' && settings.autoMode.model.trim()) result.autoMode.model = settings.autoMode.model.trim();
      result.autoMode.rules.push(...stringList(settings.autoMode.rules).map((rule) => rule.slice(0, 500)));
    }
    if (settings.lspServers && typeof settings.lspServers === 'object' && !Array.isArray(settings.lspServers)) {
      for (const [name, spec] of Object.entries(settings.lspServers)) {
        if (/^[\w.-]{1,40}$/.test(name) && spec && typeof spec.command === 'string' && spec.command.trim() && Array.isArray(spec.extensions)) {
          result.lspServers[name] = { command: spec.command.trim(), args: stringList(spec.args), extensions: stringList(spec.extensions).map((ext) => ext.startsWith('.') ? ext : '.' + ext), ...(typeof spec.languageId === 'string' ? { languageId: spec.languageId } : {}) };
        }
      }
    }
    if (settings.statusLine && typeof settings.statusLine === 'object' && settings.statusLine.type === 'command' && typeof settings.statusLine.command === 'string' && settings.statusLine.command.trim()) result.statusLine = { type: 'command', command: settings.statusLine.command.trim() };
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
