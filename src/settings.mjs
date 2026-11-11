// Layered Oasis settings: user, project (shared), and project-local files.
//
// Settings files use the same shape as Claude Code's settings.json so teams can
// reuse existing configuration:
//   { "permissions": { "allow": [], "ask": [], "deny": [], "defaultMode": "default" },
//     "hooks": { "PreToolUse": [ { "matcher": "edit_file", "hooks": [ { "type": "command", "command": "..." } ] } ] },
//     "sandbox": { "enabled": false, "network": false, "autoAllowCommands": true, "autoAllowShellCommands": false } }
//
// Trust model: a cloned repository can contain any file, so project-scoped
// settings are split by effect. Rules that only make Oasis stricter (deny / ask)
// always apply. Rules that loosen policy (allow, hooks that run commands,
// defaultMode, sandbox opt-outs) apply only after the user trusts the workspace
// with `oasis trust` or `/trust`. User-level settings always apply.
import { normalizePhrases, normalizeCommentMode } from './style-rules.mjs';
import { writeFile, mkdir, realpath, chmod, rename, unlink } from 'node:fs/promises';
import { readBoundedRegularFile } from './safe-storage.mjs';
import { sanitizeModelRouting } from './model-routing.mjs';
import { normalizeAutoTestSetting } from './auto-test.mjs';
import { collectMcpPolicy } from './mcp-policy.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { getConfigDirectory } from './config.mjs';
import { useProviderSettings } from './provider-registry.mjs';
import { normalizePermissionMode } from './permission-modes.mjs';
export { PERMISSION_MODES, normalizePermissionMode } from './permission-modes.mjs';

const MAX_SETTINGS_BYTES = 256 * 1024;

/** A plain language name ("Bengali", "Português (Brasil)") or null. Blocks prompt-like text. */
export function normalizeLanguage(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > 40) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M} ()'-]*$/u.test(text) ? text : null;
}

export function userSettingsPath(env = process.env) {
  return path.join(getConfigDirectory(env), 'settings.json');
}

// Claude Code's user settings (~/.claude/settings.json); Oasis user settings load after it and win.
export function claudeUserSettingsPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
}

// Enterprise managed settings (Claude Code's managed-settings.json). They load last and win.
export function managedSettingsPaths(env = process.env, platform = process.platform) {
  if (env.OASIS_MANAGED_SETTINGS !== undefined) return env.OASIS_MANAGED_SETTINGS ? [env.OASIS_MANAGED_SETTINGS] : [];
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json', '/Library/Application Support/Oasis/managed-settings.json'];
  if (platform === 'win32') return ['C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\Program Files\\Oasis\\managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json', '/etc/oasis/managed-settings.json'];
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
  try {
    raw = await readBoundedRegularFile(file, MAX_SETTINGS_BYTES, {
      label: 'Settings file',
      tooLargeMessage: 'Settings file is too large: ' + file
    });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
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

const settingsMutationQueues = new Map();

function mutateSettingsFile(file, mutator, mode = 0o600) {
  const previous = settingsMutationQueues.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = (await readJsonFile(file)) || {};
    const next = mutator(structuredClone(current)) || current;
    await mkdir(path.dirname(file), { recursive: true, mode: mode === 0o600 ? 0o700 : 0o755 });
    const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode, flag: 'wx' });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => {});
    }
    if (mode === 0o600) { try { await chmod(file, 0o600); } catch {} }
    return next;
  });
  let queued;
  queued = operation.finally(() => {
    if (settingsMutationQueues.get(file) === queued) settingsMutationQueues.delete(file);
  });
  settingsMutationQueues.set(file, queued);
  return queued;
}

export async function updateUserSettings(mutator, env = process.env) {
  return await mutateSettingsFile(userSettingsPath(env), mutator, 0o600);
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
  const write = async (file, mode) => {
    await mutateSettingsFile(file, (current) => {
      current.permissions = current.permissions && typeof current.permissions === 'object' && !Array.isArray(current.permissions) ? current.permissions : {};
      const list = new Set(stringList(current.permissions[kind]));
      list.add(rule.trim());
      current.permissions[kind] = [...list];
      return current;
    }, mode);
    return file;
  };
  if (scope === 'user') return await write(userSettingsPath(env), 0o600);
  if (scope === 'local') return await write(path.join(root, '.oasis', 'settings.local.json'), 0o600);
  if (scope === 'project') return await write(path.join(root, '.oasis', 'settings.json'), 0o644);
  throw new Error('Scope must be user, project, or local.');
}

function normalizeHook(hook) {
  if (!hook || typeof hook !== 'object') return null;
  const timeout = Number(hook.timeout) || 0;
  const type = hook.type || 'command';
  // Fields shared by every handler type (timeouts default per type and event in hooks.mjs).
  const common = {
    ...(timeout ? { timeout } : {}),
    ...(typeof hook.if === 'string' && hook.if.trim() ? { if: hook.if.trim() } : {}),
    ...(typeof hook.statusMessage === 'string' ? { statusMessage: hook.statusMessage.slice(0, 200) } : {}),
    ...(hook.onFailure === 'block' || hook.onFailure === 'continue' ? { onFailure: hook.onFailure } : {})
  };
  if (type === 'command' && typeof hook.command === 'string' && hook.command.trim()) {
    return {
      type, command: hook.command, ...common,
      ...(Array.isArray(hook.args) ? { args: hook.args.map(String) } : {}),
      ...(hook.async === true ? { async: true } : {}),
      ...(hook.asyncRewake === true ? { asyncRewake: true } : {}),
      ...(hook.shell === 'powershell' || hook.shell === 'bash' ? { shell: hook.shell } : {})
    };
  }
  if (type === 'http' && typeof hook.url === 'string' && /^https?:\/\//i.test(hook.url)) {
    const headers = {};
    if (hook.headers && typeof hook.headers === 'object') for (const [key, value] of Object.entries(hook.headers)) if (typeof value === 'string') headers[key] = value;
    const allowedEnvVars = Array.isArray(hook.allowedEnvVars) ? hook.allowedEnvVars.filter((name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) : [];
    return { type, url: hook.url, headers, allowedEnvVars, ...common };
  }
  if ((type === 'prompt' || type === 'agent') && typeof hook.prompt === 'string' && hook.prompt.trim()) {
    return { type, prompt: hook.prompt, model: typeof hook.model === 'string' ? hook.model : undefined, ...common, ...(type === 'prompt' && hook.continueOnBlock === true ? { continueOnBlock: true } : {}) };
  }
  if (type === 'mcp_tool' && typeof hook.server === 'string' && hook.server.trim() && typeof hook.tool === 'string' && hook.tool.trim()) {
    return { type, server: hook.server.trim(), tool: hook.tool.trim(), input: hook.input && typeof hook.input === 'object' && !Array.isArray(hook.input) ? hook.input : {}, ...common };
  }
  return null;
}

export function normalizeHooks(raw) {
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

// Claude Code's disableAllHooks and allowManagedHooksOnly. disableAllHooks in
// managed settings turns every hook and the status line off. Anywhere else, and
// with allowManagedHooksOnly (managed only), only managed hooks and a managed
// status line remain; user, project, local and plugin hooks stop, and agent
// front-matter hooks are refused (see subagent-support.mjs).
export function applyHookPolicy(result) {
  const policy = result.hookPolicy || {};
  if (policy.disableAllManaged) {
    result.hooks = {};
    result.statusLine = null;
    result.hooksDisabled = 'managed';
    return result;
  }
  if (policy.disableAll || result.allowManagedHooksOnly) {
    const kept = {};
    for (const [event, groups] of Object.entries(result.hooks || {})) {
      const managed = groups.filter((group) => group.source === 'managed');
      if (managed.length) kept[event] = managed;
    }
    result.hooks = kept;
    if (result.statusLine && result.statusLineSource !== 'managed') result.statusLine = null;
    result.hooksDisabled = policy.disableAll ? 'settings' : 'managed-only';
  }
  return result;
}

export function mergeHooks(target, extra, source, sourceFile = '') {
  for (const [event, groups] of Object.entries(extra)) {
    for (const group of groups) (target[event] ||= []).push({ ...group, source, ...(sourceFile ? { sourceFile } : {}) });
  }
}

// Claude Code sandbox path prefixes: "/" or "//" absolute, "~/" home, anything else relative to
// the project root (project, local, --settings and managed files) or ~/.claude (user files).
// A trailing "/**" or "/" is dropped; entries with other wildcards are skipped, as on Linux.
export function resolveSandboxSettingPath(entry, scope, root, env = process.env) {
  if (typeof entry !== 'string') return null;
  let value = entry.trim().replace(/\/\*\*$/, '');
  if (value.length > 1) value = value.replace(/[\\/]+$/, '');
  if (!value || /[*?]/.test(value)) return null;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (value.startsWith('//')) value = value.slice(1);
  if (value === '~') return path.resolve(home);
  if (value.startsWith('~/')) return path.resolve(home, value.slice(2));
  if (path.isAbsolute(value)) return path.resolve(value);
  const base = scope === 'user' ? (env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')) : root;
  return path.resolve(base, value);
}

export async function loadSettings(root, options = {}) {
  const env = options.env || process.env;
  const result = {
    permissions: { allow: [], ask: [], deny: [], defaultMode: 'default', additionalDirectories: [] },
    hooks: {},
    sandbox: { enabled: false, network: false, autoAllowCommands: true, maskSensitivePaths: true },
    // The agent's run_shell (pipes, &&, redirects) is on by default on macOS
    // and Linux, as in Claude Code and Codex: every line is still split into
    // its simple commands for blocking, risk checks and approval. Windows uses
    // the powershell tool. shell.enabled: false or OASIS_SHELL=0 turns it off.
    // shell.explicit records a user choice; the app's terminal box only takes
    // shell syntax when the user turned it on (see web.mjs).
    shell: { enabled: process.platform !== 'win32' && !['0', 'false', 'off'].includes(String(env.OASIS_SHELL || '').toLowerCase()), explicit: ['1', 'true', 'on'].includes(String(env.OASIS_SHELL || '').toLowerCase()) },
    model: null,
    outputStyle: null,
    agent: null,
    pluginBinDirs: [],
    editorMode: null,
    theme: null,
    statusLine: null,
    lspServers: {},
    modelRouting: { enabled: false, easyModel: '', strongModel: '' },
    trusted: false,
    hookPolicy: { disableAll: false, disableAllManaged: false },
    // MCP server policy (allowedMcpServers, deniedMcpServers, .mcp.json approvals); see mcp-policy.mjs.
    mcpPolicy: null,
    sources: [],
    ignoredUntrusted: []
  };
  const apply = (settings, scope, file, trusted) => {
    if (!settings) return;
    result.sources.push({ scope, file });
    const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
    result.permissions.deny.push(...stringList(permissions.deny));
    result.permissions.ask.push(...stringList(permissions.ask));
    // "denyInsteadOfPrompting" only tightens (a prompt becomes a denial), so any scope may set it.
    if (permissions.denyInsteadOfPrompting === true) result.permissions.denyInsteadOfPrompting = true;
    // Claude Code's block keys only tighten, so a true in any file applies (OASIS file tools already
    // stay inside the working directories; see agent.mjs for what else they change).
    for (const key of ['blockReadsOutsideWorkingDirectories', 'blockWritesOutsideWorkingDirectories']) if (permissions[key] === true) result.permissions[key] = true;
    if (typeof settings.outputStyle === 'string' && settings.outputStyle.trim()) result.outputStyle = settings.outputStyle.trim().toLowerCase();
    if (settings.editorMode === 'vim' || settings.editorMode === 'normal') result.editorMode = settings.editorMode;
    // Reply language (Claude Code's "language" setting). Only plain language names are accepted.
    if (typeof settings.language === 'string' && normalizeLanguage(settings.language)) result.language = normalizeLanguage(settings.language);
    if (settings.worktree && typeof settings.worktree === 'object' && typeof settings.worktree.branchPrefix === 'string') result.worktree = { ...(result.worktree || {}), branchPrefix: settings.worktree.branchPrefix.trim().slice(0, 40) };
    // Writing rules: phrases accumulate across scopes; the most specific codeComments wins.
    if (settings.avoidPhrases !== undefined) result.avoidPhrases = normalizePhrases([...(result.avoidPhrases || []), ...normalizePhrases(settings.avoidPhrases)]);
    if (normalizeCommentMode(settings.codeComments)) result.codeComments = normalizeCommentMode(settings.codeComments);
    if (typeof settings.theme === 'string' && settings.theme.trim()) result.theme = settings.theme.trim().slice(0, 120);
    if (typeof settings.agent === 'string' && settings.agent.trim()) { result.agent = settings.agent.trim().toLowerCase(); result.agentSource = scope; }
    // Disabling channels only tightens, so any scope may do it (Claude Code's channelsEnabled policy).
    if (settings.channelsEnabled === false) result.channelsEnabled = false;
    // Voice dictation sends microphone audio somewhere, so only your own user settings,
    // --settings and managed policy may turn it on or pick the endpoint; a repository's
    // settings cannot (managed policy can also force it off).
    if (scope === 'user' || scope === 'flag' || scope === 'managed') {
      if (typeof settings.voiceEnabled === 'boolean') result.voiceEnabled = settings.voiceEnabled;
      if (settings.voice && typeof settings.voice === 'object' && !Array.isArray(settings.voice)) {
        const voice = { ...(result.voice || {}) };
        if (typeof settings.voice.enabled === 'boolean') voice.enabled = settings.voice.enabled;
        for (const key of ['transcriptionUrl', 'model', 'language']) if (typeof settings.voice[key] === 'string' && settings.voice[key].trim()) voice[key] = settings.voice[key].trim().slice(0, 500);
        if (Array.isArray(settings.voice.keyterms)) voice.keyterms = settings.voice.keyterms.filter((term) => typeof term === 'string').map((term) => term.trim().slice(0, 60)).filter(Boolean).slice(0, 50);
        result.voice = voice;
      }
      if (scope === 'managed' && (settings.voiceEnabled === false || (settings.voice && settings.voice.enabled === false))) result.voiceDisabledByPolicy = true;
    }
    // Custom or re-pointed model providers decide where API keys are sent, so
    // only user settings, --settings and managed policy may define them; a
    // repository's .oasis/settings.json cannot (see provider-registry.mjs).
    if ((scope === 'user' || scope === 'flag' || scope === 'managed') && settings.providers && typeof settings.providers === 'object' && !Array.isArray(settings.providers)) {
      result.providers = { ...(result.providers || {}), ...settings.providers };
    }
    // Turning auto memory off is allowed even in untrusted workspaces; it never loosens anything.
    if (settings.autoMemory === false) result.autoMemory = false;
    if (settings.autoLearning === false) result.autoLearning = false;
    // Memory write approval only tightens, so it applies before trust too.
    const writeApproval = String(settings.memoryWriteApproval || (settings.memory && settings.memory.writeApproval) || '').toLowerCase();
    if (['ask', 'queue'].includes(writeApproval)) result.memoryWriteApproval = writeApproval;
    if (writeApproval === 'off' && trusted) result.memoryWriteApproval = 'off';
    // Turning optional tools off never loosens anything either.
    for (const key of ['executeCode', 'sessionSearch']) if (settings[key] === false) result[key] = false;
    if (settings.imageGeneration === false) result.imageGeneration = false;
    if (settings.textToSpeech === false) result.textToSpeech = false;
    // Not running tool calls written as text only tightens.
    if (settings.textToolCalls === false) result.textToolCalls = false;
    // Sound effects only affect this terminal, so any scope may set them.
    if (typeof settings.sounds === 'boolean') result.sounds = settings.sounds;
    if (settings.idleCompactMinutes === false || (Number.isFinite(settings.idleCompactMinutes) && settings.idleCompactMinutes >= 0)) result.idleCompactMinutes = settings.idleCompactMinutes === false ? 0 : Math.min(1440, settings.idleCompactMinutes);
    if (Number.isFinite(settings.soundVolume)) result.soundVolume = Math.max(0, Math.min(100, Math.round(settings.soundVolume)));
    // Denials and .mcp.json rejections count from any file; allowlists and approvals need trust.
    collectMcpPolicy(result, settings, scope, trusted);
    // "includeGitInstructions": false leaves the git snapshot out of the prompt (removing context only, so any file).
    if (typeof settings.includeGitInstructions === 'boolean') result.includeGitInstructions = settings.includeGitInstructions;
    // "claudeMdExcludes": instruction files to skip. Arrays merge from every file (skipping only tightens).
    if (Array.isArray(settings.claudeMdExcludes)) result.claudeMdExcludes = [...(result.claudeMdExcludes || []), ...settings.claudeMdExcludes.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 1000)).slice(0, 200)];
    if (!trusted) {
      const routingEnabled = settings.modelRouting && typeof settings.modelRouting === 'object' && (settings.modelRouting.enabled === true || Boolean(String(settings.modelRouting.easyModel || '').trim()) || Boolean(String(settings.modelRouting.strongModel || '').trim()));
      const loosening = stringList(permissions.allow).length || settings.hooks || permissions.defaultMode || settings.sandbox || settings.shell || settings.statusLine || settings.lspServers || settings.autoMode || routingEnabled || settings.env || settings.apiKeyHelper || settings.customHeadersHelper || settings.autoTest;
      // Any other key is also skipped until trust; say so instead of dropping it silently.
      const untrustedSafe = new Set(['$schema', 'permissions', 'outputStyle', 'editorMode', 'language', 'worktree', 'avoidPhrases', 'codeComments', 'theme', 'agent', 'channelsEnabled', 'autoMemory', 'autoLearning', 'memoryWriteApproval', 'memory', 'executeCode', 'sessionSearch', 'textToolCalls', 'sounds', 'soundVolume', 'idleCompactMinutes', 'deniedMcpServers', 'disabledMcpjsonServers', 'claudeMdExcludes', 'includeGitInstructions']);
      const skipped = Object.keys(settings).filter((key) => !untrustedSafe.has(key));
      if (loosening || skipped.length) result.ignoredUntrusted.push(file);
      return;
    }
    // "attribution": the commit trailer and pull request text the agent adds (Claude Code key). The text
    // reaches the prompt, so only trusted scopes may set it; managed text beats the user's own instructions.
    if (settings.attribution === false) result.attribution = { commit: '', pr: '', managed: scope === 'managed' };
    else if (settings.attribution && typeof settings.attribution === 'object' && !Array.isArray(settings.attribution)) {
      const attribution = { ...(result.attribution || {}) };
      for (const key of ['commit', 'pr']) if (typeof settings.attribution[key] === 'string') attribution[key] = settings.attribution[key].slice(0, 2000);
      if (scope === 'managed' && (typeof settings.attribution.commit === 'string' || typeof settings.attribution.pr === 'string')) attribution.managed = true;
      result.attribution = attribution;
    }
    // "disableBypassPermissionsMode": "disable" only tightens; honor it from any trusted scope.
    if (permissions.disableBypassPermissionsMode === 'disable') result.permissions.disableBypassPermissionsMode = true;
    // "apiKeyHelper": a command that prints the model API key (runs a command, so trusted scopes only).
    if (typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim()) result.apiKeyHelper = settings.apiKeyHelper.trim().slice(0, 4000);
    // "customHeadersHelper": a command printing "Name: value" lines (or JSON) added to model requests.
    if (typeof settings.customHeadersHelper === 'string' && settings.customHeadersHelper.trim()) result.customHeadersHelper = settings.customHeadersHelper.trim().slice(0, 4000);
    // "env": variables applied to every session (Claude Code settings key).
    if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
      result.env ||= {};
      for (const [key, value] of Object.entries(settings.env)) {
        if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value)) result.env[key] = String(value).slice(0, 32768);
      }
    }
    result.permissions.allow.push(...stringList(permissions.allow));
    result.permissions.additionalDirectories.push(...stringList(permissions.additionalDirectories));
    // Folders a repository's own settings add do not count as working directories under the block keys.
    if (scope === 'project') (result.permissions.repoAdditionalDirectories ||= []).push(...stringList(permissions.additionalDirectories));
    const configuredMode = normalizePermissionMode(permissions.defaultMode);
    if (configuredMode) result.permissions.defaultMode = configuredMode;
    mergeHooks(result.hooks, normalizeHooks(settings.hooks), scope, file);
    // Claude Code hook policy keys (applied once every scope has loaded, see applyHookPolicy).
    if (typeof settings.disableAllHooks === 'boolean') {
      if (scope === 'managed') result.hookPolicy.disableAllManaged = result.hookPolicy.disableAllManaged || settings.disableAllHooks;
      else result.hookPolicy.disableAll = settings.disableAllHooks;
    }
    if (scope === 'managed' && settings.allowManagedHooksOnly === true) result.allowManagedHooksOnly = true;
    // HTTP hook allowlists merge across scopes; once defined, an empty list allows nothing.
    if (Array.isArray(settings.allowedHttpHookUrls)) result.allowedHttpHookUrls = [...(result.allowedHttpHookUrls || []), ...stringList(settings.allowedHttpHookUrls).map((item) => item.slice(0, 2000))].slice(0, 500);
    if (Array.isArray(settings.httpHookAllowedEnvVars)) result.httpHookAllowedEnvVars = [...(result.httpHookAllowedEnvVars || []), ...stringList(settings.httpHookAllowedEnvVars)].slice(0, 500);
    if (settings.sandbox && typeof settings.sandbox === 'object') {
      if (typeof settings.sandbox.enabled === 'boolean') result.sandbox.enabled = settings.sandbox.enabled;
      if (typeof settings.sandbox.network === 'boolean') result.sandbox.network = settings.sandbox.network;
      if (Array.isArray(settings.sandbox.allowedDomains)) result.sandbox.allowedDomains = settings.sandbox.allowedDomains.filter((item) => typeof item === 'string').slice(0, 500);
      if (Array.isArray(settings.sandbox.deniedDomains)) result.sandbox.deniedDomains = settings.sandbox.deniedDomains.filter((item) => typeof item === 'string').slice(0, 500);
      // Claude Code's layout: sandbox.network.{allowedDomains,deniedDomains} merge across scopes;
      // allowManagedDomainsOnly (managed) keeps only the managed allowed domains.
      const network = settings.sandbox.network && typeof settings.sandbox.network === 'object' && !Array.isArray(settings.sandbox.network) ? settings.sandbox.network : null;
      if (network) {
        const domains = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
        if (Array.isArray(network.allowedDomains)) {
          result.sandbox.allowedDomains = [...(result.sandbox.allowedDomains || []), ...domains(network.allowedDomains)].slice(0, 500);
          if (scope === 'managed') result.sandbox.managedAllowedDomains = [...(result.sandbox.managedAllowedDomains || []), ...domains(network.allowedDomains)].slice(0, 500);
        }
        if (Array.isArray(network.deniedDomains)) result.sandbox.deniedDomains = [...(result.sandbox.deniedDomains || []), ...domains(network.deniedDomains)].slice(0, 500);
        if (scope === 'managed' && network.allowManagedDomainsOnly === true) result.sandbox.allowManagedDomainsOnly = true;
      }
      // Claude Code's name for autoAllowCommands.
      if (typeof settings.sandbox.autoAllowBashIfSandboxed === 'boolean') result.sandbox.autoAllowCommands = settings.sandbox.autoAllowBashIfSandboxed;
      // failIfUnavailable: refuse to start when the sandbox is enabled but cannot run; managed wins.
      if (typeof settings.sandbox.failIfUnavailable === 'boolean' && !result.sandbox.failIfUnavailableManaged) {
        result.sandbox.failIfUnavailable = settings.sandbox.failIfUnavailable;
        if (scope === 'managed') result.sandbox.failIfUnavailableManaged = true;
      }
      // sandbox.filesystem.{allowWrite,denyWrite,denyRead}: path lists merged across scopes.
      const filesystem = settings.sandbox.filesystem && typeof settings.sandbox.filesystem === 'object' && !Array.isArray(settings.sandbox.filesystem) ? settings.sandbox.filesystem : null;
      if (filesystem) {
        for (const key of ['allowWrite', 'denyWrite', 'denyRead']) {
          if (!Array.isArray(filesystem[key])) continue;
          const resolved = filesystem[key].slice(0, 200).map((entry) => resolveSandboxSettingPath(entry, scope, path.resolve(root), env)).filter(Boolean);
          result.sandbox[key] = [...new Set([...(result.sandbox[key] || []), ...resolved])].slice(0, 500);
        }
      }
      if (typeof settings.sandbox.autoAllowCommands === 'boolean') result.sandbox.autoAllowCommands = settings.sandbox.autoAllowCommands;
      if (typeof settings.sandbox.maskSensitivePaths === 'boolean') result.sandbox.maskSensitivePaths = settings.sandbox.maskSensitivePaths;
      if (typeof settings.sandbox.autoAllowShellCommands === 'boolean') result.sandbox.autoAllowShellCommands = settings.sandbox.autoAllowShellCommands;
      if (typeof settings.sandbox.writableCaches === 'boolean') result.sandbox.writableCaches = settings.sandbox.writableCaches;
      // Turning the protection off is only taken from your own settings, --settings or policy;
      // a repository's settings cannot unlock writes to its own hooks and config.
      if (typeof settings.sandbox.protectProjectConfig === 'boolean' && (settings.sandbox.protectProjectConfig || ['user', 'flag', 'managed'].includes(scope))) result.sandbox.protectProjectConfig = settings.sandbox.protectProjectConfig;
      if (['os', 'docker', 'podman', 'ssh'].includes(settings.sandbox.backend)) result.sandbox.backend = settings.sandbox.backend;
      if (settings.sandbox.ssh && typeof settings.sandbox.ssh === 'object' && !Array.isArray(settings.sandbox.ssh)) result.sandbox.ssh = { ...(result.sandbox.ssh || {}), ...settings.sandbox.ssh };
      if (typeof settings.sandbox.image === 'string' && /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,254}$/.test(settings.sandbox.image)) result.sandbox.image = settings.sandbox.image;
      if (typeof settings.sandbox.memory === 'string' && /^\d+(?:\.\d+)?[bkmg]?$/i.test(settings.sandbox.memory)) result.sandbox.memory = settings.sandbox.memory;
      if ((typeof settings.sandbox.cpus === 'string' || typeof settings.sandbox.cpus === 'number') && /^\d+(?:\.\d+)?$/.test(String(settings.sandbox.cpus))) result.sandbox.cpus = String(settings.sandbox.cpus);
    }
    if (settings.shell && typeof settings.shell === 'object' && typeof settings.shell.enabled === 'boolean') { result.shell.enabled = settings.shell.enabled; result.shell.explicit = settings.shell.enabled; }
    if (typeof settings.model === 'string' && settings.model.trim()) result.model = settings.model.trim();
    if (Array.isArray(settings.availableModels)) result.availableModels = settings.availableModels.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 100);
    if (typeof settings.chrome === 'boolean') result.chrome = settings.chrome;
    if (settings.defaultShell === 'powershell' || settings.defaultShell === 'bash') result.defaultShell = settings.defaultShell;
    if (typeof settings.advisorModel === 'string' && settings.advisorModel.trim()) result.advisorModel = settings.advisorModel.trim().slice(0, 200);
    if (settings.autoMemory === true) result.autoMemory = true;
    for (const key of ['executeCode', 'sessionSearch']) if (settings[key] === true) result[key] = true;
    // "autoCommit": true commits each turn's changed files (documented; previously dropped here).
    if (typeof settings.autoCommit === 'boolean') result.autoCommit = settings.autoCommit;
    // Documented keys that agent.mjs and git-intent.mjs read from session settings.
    if (settings.allowUnrequestedGitWrites === true || settings.allowUnrequestedGitWrites === false) result.allowUnrequestedGitWrites = settings.allowUnrequestedGitWrites;
    if (typeof settings.assistedVerification === 'boolean') result.assistedVerification = settings.assistedVerification;
    if (settings.untrustedContentGuard === false) result.untrustedContentGuard = false;
    if (settings.textToolCalls === true) result.textToolCalls = true;
    // Minutes a background run waits for `oasis bg approve|deny` before denying (1 to 1440).
    if (Number.isFinite(settings.backgroundApprovalTimeoutMinutes) && settings.backgroundApprovalTimeoutMinutes >= 1) result.backgroundApprovalTimeoutMinutes = Math.min(1440, settings.backgroundApprovalTimeoutMinutes);
    // "imageGeneration": { "model", "baseUrl", "size" } for the generate_image tool (the key itself comes from the environment).
    if (settings.imageGeneration && typeof settings.imageGeneration === 'object' && !Array.isArray(settings.imageGeneration)) {
      const image = {};
      for (const key of ['model', 'size']) if (typeof settings.imageGeneration[key] === 'string' && settings.imageGeneration[key].trim()) image[key] = settings.imageGeneration[key].trim().slice(0, 200);
      if (typeof settings.imageGeneration.baseUrl === 'string' && /^https?:\/\/[^\s]+$/.test(settings.imageGeneration.baseUrl.trim())) image.baseUrl = settings.imageGeneration.baseUrl.trim().slice(0, 500);
      result.imageGeneration = image;
    }
    // "textToSpeech": { "model", "baseUrl", "voice", "format" } for the text_to_speech tool (the key comes from the environment).
    if (settings.textToSpeech && typeof settings.textToSpeech === 'object' && !Array.isArray(settings.textToSpeech)) {
      const speech = { ...(result.textToSpeech && typeof result.textToSpeech === 'object' ? result.textToSpeech : {}) };
      for (const key of ['model', 'voice', 'format']) if (typeof settings.textToSpeech[key] === 'string' && settings.textToSpeech[key].trim()) speech[key] = settings.textToSpeech[key].trim().slice(0, 200);
      if (typeof settings.textToSpeech.baseUrl === 'string' && /^https?:\/\/[^\s]+$/.test(settings.textToSpeech.baseUrl.trim())) speech.baseUrl = settings.textToSpeech.baseUrl.trim().slice(0, 500);
      result.textToSpeech = speech;
    }
    if (typeof settings.verbose === 'boolean') result.verbose = settings.verbose;
    // Session behavior switches read by createSession (previously dropped here, so they never applied).
    for (const key of ['fastMode', 'ultracode', 'mcpNonBlocking', 'workflowsEnabled', 'leanTools']) if (typeof settings[key] === 'boolean') result[key] = settings[key];
    if (['low', 'medium', 'high', 'max'].includes(String(settings.subagentEffort || '').toLowerCase())) result.subagentEffort = String(settings.subagentEffort).toLowerCase();
    if (['on', 'off'].includes(String(settings.systemPromptSnapshot || '').toLowerCase())) result.systemPromptSnapshot = String(settings.systemPromptSnapshot).toLowerCase();
    if (['auto', 'tmux', 'in-process'].includes(String(settings.teammateMode || '').toLowerCase())) result.teammateMode = String(settings.teammateMode).toLowerCase();
    if (Number.isInteger(settings.subagentAutoCompactPercent) && settings.subagentAutoCompactPercent >= 0 && settings.subagentAutoCompactPercent <= 100) result.subagentAutoCompactPercent = settings.subagentAutoCompactPercent;
    if (Number.isInteger(settings.subagentStallSeconds) && settings.subagentStallSeconds >= 0 && settings.subagentStallSeconds <= 86400) result.subagentStallSeconds = settings.subagentStallSeconds;
    if (Number.isInteger(settings.subagentMaxDepth) && settings.subagentMaxDepth >= 1 && settings.subagentMaxDepth <= 5) result.subagentMaxDepth = settings.subagentMaxDepth;
    if (Number.isInteger(settings.cleanupPeriodDays) && settings.cleanupPeriodDays >= 1 && settings.cleanupPeriodDays <= 3650) result.cleanupPeriodDays = settings.cleanupPeriodDays;
    if (Number.isInteger(settings.toolSearchThreshold) && settings.toolSearchThreshold >= 1 && settings.toolSearchThreshold <= 1000) result.toolSearchThreshold = settings.toolSearchThreshold;
    // Claude Code's autoCompactEnabled: false turns automatic compaction off.
    if (typeof settings.autoCompactEnabled === 'boolean') result.autoCompactEnabled = settings.autoCompactEnabled;
    // Auto mode classifier. Claude Code's schema { environment, allow, soft_deny, hard_deny } (each
    // replaces the defaults unless it lists "$defaults"), plus Oasis's { model, rules, classifyAllShell }.
    // Like Claude Code, shared project settings cannot loosen the classifier: from project/local scopes
    // only extra soft_deny/hard_deny entries and rules are used.
    if (settings.autoMode && typeof settings.autoMode === 'object') {
      result.autoMode ||= { model: null, rules: [] };
      const personal = scope === 'user' || scope === 'managed' || scope === 'flag';
      if (personal && typeof settings.autoMode.model === 'string' && settings.autoMode.model.trim()) result.autoMode.model = settings.autoMode.model.trim();
      result.autoMode.rules.push(...stringList(settings.autoMode.rules).map((rule) => rule.slice(0, 500)));
      // A longer wait only changes how long a check may take, not what it allows.
      if (personal && Number.isFinite(Number(settings.autoMode.timeoutSeconds)) && Number(settings.autoMode.timeoutSeconds) > 0) result.autoMode.timeoutSeconds = Math.min(600, Number(settings.autoMode.timeoutSeconds));
      if (typeof settings.autoMode.classifyAllShell === 'boolean' && (personal || settings.autoMode.classifyAllShell)) result.autoMode.classifyAllShell = settings.autoMode.classifyAllShell;
      for (const section of ['environment', 'allow', 'soft_deny', 'hard_deny']) {
        const list = settings.autoMode[section];
        if (!Array.isArray(list)) continue;
        const clean = list.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 1000)).slice(0, 200);
        if (personal) { result.autoMode[section] = clean; (result.autoMode.sources ||= {})[section] = file; }
        else if (section === 'soft_deny' || section === 'hard_deny') { result.autoMode.project ||= {}; (result.autoMode.project[section] ||= []).push(...clean.filter((item) => item !== '$defaults')); }
      }
    }
    if (settings.lspServers && typeof settings.lspServers === 'object' && !Array.isArray(settings.lspServers)) {
      for (const [name, spec] of Object.entries(settings.lspServers)) {
        if (/^[\w.-]{1,40}$/.test(name) && spec && typeof spec.command === 'string' && spec.command.trim() && Array.isArray(spec.extensions)) {
          result.lspServers[name] = { command: spec.command.trim(), args: stringList(spec.args), extensions: stringList(spec.extensions).map((ext) => ext.startsWith('.') ? ext : '.' + ext), ...(typeof spec.languageId === 'string' ? { languageId: spec.languageId } : {}) };
        }
      }
    }
    if (settings.pricing && typeof settings.pricing === 'object' && !Array.isArray(settings.pricing)) result.pricing = { ...(result.pricing || {}), ...settings.pricing };
    if (settings.modelRouting && typeof settings.modelRouting === 'object' && !Array.isArray(settings.modelRouting)) {
      const routing = sanitizeModelRouting(settings.modelRouting);
      result.modelRouting = {
        enabled: typeof settings.modelRouting.enabled === 'boolean' ? routing.enabled : result.modelRouting.enabled,
        easyModel: routing.easyModel || result.modelRouting.easyModel,
        strongModel: routing.strongModel || result.modelRouting.strongModel
      };
      if (!result.modelRouting.easyModel) result.modelRouting.enabled = false;
    }
    if (typeof settings.fallbackModel === 'string' && settings.fallbackModel.trim()) result.fallbackModel = settings.fallbackModel.trim();
    else if (Array.isArray(settings.fallbackModel)) { const list = settings.fallbackModel.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()); if (list.length) result.fallbackModel = list.join(','); }
    // repoMap: true | false | { maxChars } — add a ranked repository outline to the first turn.
    if (typeof settings.repoMap === 'boolean') result.repoMap = settings.repoMap;
    else if (settings.repoMap && typeof settings.repoMap === 'object' && !Array.isArray(settings.repoMap)) result.repoMap = { maxChars: Math.max(1000, Math.min(30000, Number.parseInt(settings.repoMap.maxChars, 10) || 6000)) };
    // autoTest: "npm test" | { command, maxAttempts, timeoutSeconds } — Oasis runs it after edits (trusted scopes only).
    if (settings.autoTest === false) result.autoTest = null;
    else if (settings.autoTest) { const autoTest = normalizeAutoTestSetting(settings.autoTest); if (autoTest) result.autoTest = autoTest; }
    if (settings.statusLine && typeof settings.statusLine === 'object' && settings.statusLine.type === 'command' && typeof settings.statusLine.command === 'string' && settings.statusLine.command.trim()) { result.statusLine = { type: 'command', command: settings.statusLine.command.trim() }; result.statusLineSource = scope; }
  };

  // --setting-sources user,project,local limits which files load; --settings adds a file or JSON on top.
  const sources = Array.isArray(options.settingSources) && options.settingSources.length ? new Set(options.settingSources) : null;
  const userFile = userSettingsPath(env);
  if (!sources || sources.has('user')) {
    const claudeFile = claudeUserSettingsPath(env);
    if (env.OASIS_IGNORE_CLAUDE_SETTINGS !== '1' && path.resolve(claudeFile) !== path.resolve(userFile)) apply(await readJsonFile(claudeFile).catch(() => null), 'user', claudeFile, true);
    apply(await readJsonFile(userFile), 'user', userFile, true);
  }
  result.trusted = await isWorkspaceTrusted(root, env);
  if (root) {
    for (const { scope, file } of projectSettingsPaths(root)) {
      if (sources && !sources.has(scope)) continue;
      apply(await readJsonFile(file), scope, file, result.trusted);
    }
  }
  for (const extra of options.extraSettings || []) {
    if (extra && extra.settings && typeof extra.settings === 'object') apply(extra.settings, 'flag', extra.file || '--settings', true);
  }
  for (const file of managedSettingsPaths(env)) apply(await readJsonFile(file).catch(() => null), 'managed', file, true);
  if (result.permissions.disableBypassPermissionsMode && result.permissions.defaultMode === 'bypassPermissions') result.permissions.defaultMode = 'default';
  // Hooks from enabled Claude Code plugins run with CLAUDE_PLUGIN_ROOT in their environment.
  if (!options.skipPlugins) {
    try {
      const { loadEnabledPlugins, pluginHooks, pluginLspServers, pluginBinDirs, pluginDefaultSettings, pluginMonitors } = await import('./claude-plugins.mjs');
      const plugins = await loadEnabledPlugins(root, { env });
      result.plugins = plugins.map((plugin) => ({ id: plugin.id, name: plugin.name, root: plugin.root, origin: plugin.origin }));
      // Plugin LSP servers come after user/project ones, so explicit settings win for an extension.
      for (const [name, spec] of Object.entries(await pluginLspServers(plugins, { env, root }))) if (!result.lspServers[name]) result.lspServers[name] = spec;
      result.pluginBinDirs = await pluginBinDirs(plugins);
      result.pluginThemeSources = plugins.map((plugin) => ({ name: plugin.name, root: plugin.root, manifest: { themes: plugin.manifest && plugin.manifest.themes, experimental: plugin.manifest && plugin.manifest.experimental ? { themes: plugin.manifest.experimental.themes } : undefined } }));
      result.pluginMonitorErrors = [];
      result.pluginMonitors = await pluginMonitors(plugins, { env, root, errors: result.pluginMonitorErrors });
      const defaults = await pluginDefaultSettings(plugins);
      if (defaults.agent && !result.agent) { result.agent = defaults.agent; result.agentSource = 'plugin:' + defaults.agentPlugin; }
      for (const item of await pluginHooks(plugins, { env, root })) {
        const normalized = normalizeHooks(item.hooks);
        for (const groups of Object.values(normalized)) for (const group of groups) for (const hook of group.hooks) if (hook.type === 'command' || hook.command) hook.pluginEnv = item.env;
        mergeHooks(result.hooks, normalized, 'plugin:' + item.plugin, item.root ? path.join(item.root, 'hooks', 'hooks.json') : '');
      }
    } catch { /* Plugins are optional; `oasis plugin list` reports problems. */ }
  }
  applyHookPolicy(result);
  if (env.OASIS_SANDBOX === '1') result.sandbox.enabled = true;
  if (env.OASIS_SANDBOX === '0') result.sandbox.enabled = false;
  if (['os', 'docker', 'podman', 'ssh'].includes(env.OASIS_SANDBOX_BACKEND)) result.sandbox.backend = env.OASIS_SANDBOX_BACKEND;
  if (env.OASIS_SANDBOX_IMAGE && /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,254}$/.test(env.OASIS_SANDBOX_IMAGE)) result.sandbox.image = env.OASIS_SANDBOX_IMAGE;
  // Fallback chains and configure_provider resolve names without a settings
  // object in hand, so the registry keeps the last loaded user providers.
  if (options.applyProviders !== false) useProviderSettings(result.providers || {});
  return result;
}
