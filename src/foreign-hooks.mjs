// Hooks other agents already run in this project, run by OASIS too.
//
// A team that uses Cursor or GitHub Copilot keeps hooks next to the code:
// .cursor/hooks.json (Cursor), .github/hooks/*.json (Copilot CLI and the
// Copilot coding agent) and the "hooks" of .gemini/settings.json (Gemini CLI).
// User hooks live in ~/.cursor/hooks.json and ~/.gemini/settings.json.
// Codex hooks (.codex/hooks.json and [hooks] in .codex/config.toml, and the
// same under ~/.codex) already use Claude Code's events and replies, so they
// load as they are, with Codex's apply_patch matcher read as the edit tools.
// OpenCode plugins (.opencode/plugins/*.{js,ts}, ~/.config/opencode/plugins,
// and npm plugins listed under "plugin" in opencode.json) are JavaScript modules; each runs through opencode-plugin-host.mjs on the
// events it handles.
// They are read in place and run through the protocol bridge
// (hook-bridges.mjs): each hook is filed under the Claude Code event that
// fires at the same moment, gets the stdin fields its own tool sends, and its
// reply is read the way that tool reads it.
//
// Hooks run commands, so the project files load only in a trusted workspace
// (like .claude/settings.json hooks); the user file is yours and always loads.
// OASIS_OTHER_AGENT_RULES=0, or "otherAgentHooks": false in settings, turns
// this off.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { bridgeHookDoc } from './hook-bridges.mjs';
import { splitHookEvents } from './plugin-convert.mjs';

const MAX_FILE = 256 * 1024;

async function readJson(file) {
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > MAX_FILE) return null;
    // Gemini settings may carry comments.
    const errors = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length) return null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// A relative script at the start of a command (or a cwd) becomes an absolute,
// quoted path under `base`, the folder that tool resolves it against.
function rooted(base) {
  const quote = (value) => '"' + value.replace(/"/g, '\\"') + '"';
  return (text, { path: isPath } = {}) => {
    const value = String(text);
    if (isPath) return value.startsWith('$') || path.isAbsolute(value) ? quote(value) : quote(path.resolve(base, value));
    const match = /^(\S+)([\s\S]*)$/.exec(value.trim());
    if (!match) return value;
    const [, head, rest] = match;
    if (head.startsWith('$') || path.isAbsolute(head) || !/[\\/]/.test(head)) return value;
    const full = path.resolve(base, head);
    return existsSync(full) ? quote(full) + rest : value;
  };
}

async function readToml(file) {
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > MAX_FILE) return null;
    const { parseToml } = await import('./importers.mjs');
    return parseToml(text);
  } catch { return null; }
}

// Codex calls file edits apply_patch; OASIS shows them as Edit, Write, MultiEdit.
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'];
export function codexMatcher(matcher) {
  if (typeof matcher !== 'string' || !/apply_patch/.test(matcher)) return matcher;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return [...new Set(matcher.split(/[|,]/).map((item) => item.trim()).filter(Boolean).flatMap((item) => item === 'apply_patch' ? [...EDIT_TOOLS, item] : [item]))].join('|');
  return matcher.replace(/\bapply_patch\b/g, '(?:' + EDIT_TOOLS.join('|') + '|apply_patch)');
}

export function codexHooks(doc, platform = process.platform) {
  const { kept, dropped } = splitHookEvents(doc);
  if (!kept) return { hooks: {}, dropped };
  const hooks = {};
  for (const [event, groups] of Object.entries(kept)) {
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const handlers = group.hooks.filter((hook) => hook && typeof hook === 'object').map((hook) => {
        const command = platform === 'win32' && typeof hook.commandWindows === 'string' ? hook.commandWindows : hook.command;
        return { ...hook, ...(typeof command === 'string' ? { command } : {}) };
      });
      (hooks[event] ||= []).push({ ...group, ...(group.matcher !== undefined ? { matcher: codexMatcher(group.matcher) } : {}), hooks: handlers });
    }
  }
  return { hooks, dropped };
}

async function codexLayer(dir, scope, platform) {
  const config = await readToml(path.join(dir, 'config.toml'));
  const features = config && config.features && typeof config.features === 'object' ? config.features : {};
  if (features.hooks === false || features.codex_hooks === false) return [];
  const out = [];
  const json = await readJson(path.join(dir, 'hooks.json'));
  if (json && json.hooks) out.push({ scope, file: path.join(dir, 'hooks.json'), protocol: 'codex', ...codexHooks(json, platform) });
  if (config && config.hooks && typeof config.hooks === 'object') out.push({ scope, file: path.join(dir, 'config.toml'), protocol: 'codex', ...codexHooks({ hooks: config.hooks }, platform) });
  return out.filter((item) => Object.keys(item.hooks).length || item.dropped.length);
}

// Plugin files in an OpenCode plugin folder: direct .js/.mjs/.ts files and
// package folders (their package.json main, or index.*).
async function openCodePluginFiles(dir) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && /\.(?:m?js|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path.join(dir, entry.name));
    else if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      const pkg = await readJson(path.join(dir, entry.name, 'package.json'));
      const candidates = [...(pkg && typeof pkg.main === 'string' ? [pkg.main] : []), 'index.ts', 'index.js', 'index.mjs', 'src/index.ts', 'src/index.js'];
      const found = candidates.map((rel) => path.resolve(dir, entry.name, rel)).find((file) => file.startsWith(path.join(dir, entry.name) + path.sep) && existsSync(file));
      if (found) files.push(found);
    }
  }
  return files;
}

/**
 * The hook that runs one OpenCode plugin on one OASIS event, in argument form
 * so no shell quoting is involved. `pluginPath` may use ${CLAUDE_PLUGIN_ROOT}.
 */
export function openCodeHook(pluginPath, event, label) {
  return { type: 'command', command: '${OASIS_NODE}', args: ['${OASIS_OPENCODE_HOST}', pluginPath, event], timeout: 30, statusMessage: 'OpenCode plugin ' + label };
}

/** OASIS events an OpenCode plugin's source handles. */
export function openCodeEvents(text) {
  const events = new Set();
  if (text.includes('tool.execute.before')) events.add('PreToolUse');
  if (text.includes('tool.execute.after') || text.includes('file.edited')) events.add('PostToolUse');
  if (text.includes('session.idle')) events.add('Stop');
  if (text.includes('session.created')) events.add('SessionStart');
  if (text.includes('session.deleted')) events.add('SessionEnd');
  return events;
}

/** Hook groups that run an OpenCode plugin wherever its source has work. */
export function openCodePluginHooks(text, pluginPath, label) {
  const hooks = {};
  for (const event of openCodeEvents(text)) (hooks[event] ||= []).push({ ...(event === 'PostToolUse' && !text.includes('tool.execute.after') ? { matcher: 'Edit|Write|MultiEdit' } : {}), hooks: [openCodeHook(pluginPath, event, label)] });
  return hooks;
}

/** Why an OpenCode plugin cannot run here, or ''. */
export function openCodeUnsupported(file, text) {
  if (/\.ts$/.test(file) && !process.features.typescript) return 'TypeScript plugins need Node.js 22.18 or later';
  // OpenCode V2 plugins (Plugin.define) need OpenCode's own runtime.
  if (/Plugin\.define\s*\(/.test(text)) return 'OpenCode V2 plugin (Plugin.define)';
  return '';
}

// npm plugins named in opencode.json's "plugin" list. OpenCode installs them
// under its cache (~/.cache/opencode/node_modules/NAME); local paths and
// file: URLs are read in place. Returns plugin entry files.
export function openCodePackageName(spec) {
  const text = String(spec || '').trim();
  if (!text || /^(?:file:|\.|\/|[A-Za-z]:[\\/])/.test(text)) return '';
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  const name = at > 0 ? text.slice(0, at) : text;
  return /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name) ? name : '';
}

async function packageEntry(dir) {
  const pkg = await readJson(path.join(dir, 'package.json'));
  const exp = pkg && pkg.exports;
  const dot = exp && typeof exp === 'object' && !Array.isArray(exp) && exp['.'] !== undefined ? exp['.'] : exp;
  const fromExports = typeof dot === 'string' ? dot : dot && typeof dot === 'object' ? [dot.import, dot.default, dot.node].find((v) => typeof v === 'string') : null;
  const candidates = [fromExports, pkg && pkg.module, pkg && pkg.main, 'index.js', 'index.mjs', 'dist/index.js', 'index.ts', 'src/index.ts'].filter((v) => typeof v === 'string');
  return candidates.map((rel) => path.resolve(dir, rel)).find((file) => file.startsWith(dir + path.sep) && existsSync(file)) || null;
}

export async function openCodeConfigPlugins({ openCodeHome, cacheHome, root, trusted }) {
  const configs = [['user', openCodeHome], ...(root && trusted ? [['project', path.resolve(root)], ['project', path.join(path.resolve(root), '.opencode')]] : [])];
  const out = [];
  const seen = new Set();
  for (const [scope, dir] of configs) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const doc = await readJson(path.join(dir, name));
      const list = doc && (Array.isArray(doc.plugin) ? doc.plugin : Array.isArray(doc.plugins) ? doc.plugins : []);
      for (const raw of list || []) {
        const spec = Array.isArray(raw) ? raw[0] : raw;
        if (typeof spec !== 'string') continue;
        let file = null;
        const pkg = openCodePackageName(spec);
        if (pkg) {
          for (const base of [path.join(cacheHome, 'node_modules', pkg), path.join(dir, 'node_modules', pkg)]) { if (existsSync(base)) { file = await packageEntry(base); if (file) break; } }
        } else {
          const local = spec.startsWith('file:') ? decodeURIComponent(spec.replace(/^file:(?:\/\/)?/, '')) : path.resolve(dir, spec);
          file = existsSync(local) && !/\.(?:m?js|ts)$/.test(local) ? await packageEntry(local) : existsSync(local) ? local : null;
        }
        if (file && !seen.has(file)) { seen.add(file); out.push({ scope, file, spec }); }
      }
    }
  }
  return out;
}

// The source text a plugin's events are read from: its entry file and, for a
// package, the other scripts beside it (bundles split into chunks).
async function pluginText(file, packaged) {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { return null; }
  if (!packaged || openCodeEvents(text).size) return text;
  const dir = path.dirname(file);
  let names = [];
  try { names = (await readdir(dir)).filter((name) => /\.(?:m?js|ts)$/.test(name)).slice(0, 40); } catch {}
  for (const name of names) { try { const more = await readFile(path.join(dir, name), 'utf8'); if (more.length < 2 * 1024 * 1024) text += '\n' + more; } catch {} }
  return text;
}

// Which OASIS events a plugin needs, read from its source so the host only runs
// where the plugin has something to do.
async function openCodePlugin(file, scope, packaged = false) {
  const text = await pluginText(file, packaged);
  if (text === null) return null;
  const why = openCodeUnsupported(file, text);
  if (why) return { scope, file, protocol: 'opencode', hooks: {}, dropped: [why] };
  return { scope, file, protocol: 'opencode', hooks: openCodePluginHooks(text, file, path.basename(file)), dropped: [] };
}

/**
 * Hook groups (Claude Code format, tagged for the bridge) from other agents'
 * hook files. Returns [{ scope, file, protocol, hooks, dropped }].
 */
export async function loadForeignHooks(root, { env = process.env, home = env.HOME || os.homedir(), trusted = false, platform = process.platform } = {}) {
  if (env.OASIS_OTHER_AGENT_RULES === '0') return [];
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const sources = [
    { scope: 'user', protocol: 'cursor', file: path.join(home, '.cursor', 'hooks.json'), base: path.join(home, '.cursor') },
    { scope: 'user', protocol: 'gemini', file: path.join(home, '.gemini', 'settings.json'), base: root ? path.resolve(root) : home }
  ];
  if (root && trusted) {
    const workspace = path.resolve(root);
    // The user file and the project file are different places only when the
    // project is not the home folder itself.
    if (path.resolve(workspace, '.cursor', 'hooks.json') !== sources[0].file) sources.push({ scope: 'project', protocol: 'cursor', file: path.join(workspace, '.cursor', 'hooks.json'), base: workspace });
    if (path.resolve(workspace, '.gemini', 'settings.json') !== sources[1].file) sources.push({ scope: 'project', protocol: 'gemini', file: path.join(workspace, '.gemini', 'settings.json'), base: workspace });
    let names = [];
    try { names = (await readdir(path.join(workspace, '.github', 'hooks'))).filter((name) => name.endsWith('.json')).sort(); } catch { /* none */ }
    for (const name of names) sources.push({ scope: 'project', protocol: 'copilot', file: path.join(workspace, '.github', 'hooks', name), base: workspace });
  }
  const out = [...await codexLayer(codexHome, 'user', platform)];
  if (root && trusted && path.resolve(root, '.codex') !== codexHome) out.push(...await codexLayer(path.resolve(root, '.codex'), 'project', platform));
  const openCodeHome = path.join(env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config'), 'opencode');
  const pluginDirs = [...['plugins', 'plugin'].map((name) => ({ scope: 'user', dir: path.join(openCodeHome, name) })),
    ...(root && trusted ? ['plugins', 'plugin'].map((name) => ({ scope: 'project', dir: path.join(path.resolve(root), '.opencode', name) })) : [])];
  const seenDirs = new Set();
  for (const { scope, dir } of pluginDirs) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const file of await openCodePluginFiles(dir)) {
      const item = await openCodePlugin(file, scope);
      if (item && (Object.keys(item.hooks).length || item.dropped.length)) out.push(item);
    }
  }
  const cacheHome = path.join(env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(home, '.cache'), 'opencode');
  for (const { scope, file } of await openCodeConfigPlugins({ openCodeHome, cacheHome, root, trusted })) {
    if (out.some((item) => item.file === file)) continue;
    const item = await openCodePlugin(file, scope, true);
    if (item && (Object.keys(item.hooks).length || item.dropped.length)) out.push(item);
  }
  for (const source of sources) {
    const doc = await readJson(source.file);
    if (!doc || !doc.hooks) continue;
    const { hooks, dropped } = bridgeHookDoc(source.protocol, doc, rooted(source.base));
    if (Object.keys(hooks).length || dropped.length) out.push({ scope: source.scope, file: source.file, protocol: source.protocol, hooks, dropped });
  }
  return out;
}
