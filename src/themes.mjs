// Terminal color themes, compatible with Claude Code's /theme.
//
// Built-in presets: dark, light, dark-daltonized, light-daltonized, dark-ansi,
// light-ansi, plus "auto" (light or dark from COLORFGBG / OASIS_TERMINAL_BACKGROUND).
// Custom themes are JSON files { name?, base?, overrides? } in ~/.claude/themes/
// or <OASIS config>/themes/ (preference "custom:<slug>"); plugins contribute
// themes from themes/ or experimental.themes (preference "plugin:<plugin>:<slug>").
// Colors: #rrggbb, #rgb, rgb(r,g,b), ansi256(n) or ansi:<name>; invalid values
// and unknown tokens are ignored so a typo cannot break rendering.

import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ANSI } from './markdown.mjs';

export const BASE_THEMES = ['dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'];

export const THEME_TOKENS = [
  'claude', 'claudeShimmer', 'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'permission', 'remember',
  'success', 'error', 'warning', 'merged', 'promptBorder', 'planMode', 'autoAccept', 'bashBorder', 'ide', 'fastMode',
  'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord',
  'userMessageBackground', 'bashMessageBackgroundColor', 'memoryBackgroundColor', 'code', 'link', 'keyword', 'number'
];

// Tokens Claude Code themes may carry that Oasis accepts but does not paint yet.
export const KNOWN_TOKENS = new Set([...THEME_TOKENS,
  'effortUltra', 'userMessageBackgroundHover', 'selectionBg', 'composerSidebarBackground', 'rate_limit_fill', 'rate_limit_empty', 'briefLabelYou', 'briefLabelClaude',
  'warningShimmer', 'permissionShimmer', 'promptBorderShimmer', 'inactiveShimmer', 'fastModeShimmer',
  ...['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'].map((c) => c + '_FOR_SUBAGENTS_ONLY'),
  ...['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'].flatMap((c) => ['rainbow_' + c, 'rainbow_' + c + '_shimmer'])
]);

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

const DARK = {
  claude: '#2dd4bf', claudeShimmer: '#f97316', text: 'ansi:default', inverseText: '#000000', inactive: 'ansi:blackBright', subtle: 'ansi:blackBright',
  suggestion: 'ansi:blue', permission: 'ansi:cyan', remember: 'ansi:blue', success: 'ansi:green', error: 'ansi:red', warning: 'ansi:yellow',
  merged: 'ansi:magenta', promptBorder: 'ansi:blackBright', planMode: 'ansi:cyan', autoAccept: 'ansi:magenta', bashBorder: '#fbbf24', ide: 'ansi:blue',
  fastMode: '#f97316', diffAdded: 'ansi256(22)', diffRemoved: 'ansi256(52)', diffAddedDimmed: '#1f2f23', diffRemovedDimmed: '#2f1f1f',
  diffAddedWord: '#2f7a3f', diffRemovedWord: '#8a2f2f', userMessageBackground: null, bashMessageBackgroundColor: null, memoryBackgroundColor: null,
  code: 'ansi:cyan', link: 'ansi:blue', keyword: 'ansi:magenta', number: 'ansi:yellow'
};

const PRESETS = {
  dark: DARK,
  light: { ...DARK, claude: '#0f766e', claudeShimmer: '#c2410c', inverseText: '#ffffff', inactive: 'ansi256(244)', subtle: 'ansi256(250)', bashBorder: '#b45309',
    diffAdded: '#dafbe1', diffRemoved: '#ffebe9', diffAddedDimmed: '#eef7f0', diffRemovedDimmed: '#fbf1f0', diffAddedWord: '#aceebb', diffRemovedWord: '#ffcecb',
    success: '#1a7f37', error: '#cf222e', warning: '#9a6700', code: '#0550ae', link: '#0969da', keyword: '#8250df', number: '#953800', planMode: '#0e7490', autoAccept: '#8250df' },
  'dark-daltonized': { ...DARK, claude: '#38bdf8', claudeShimmer: '#fb923c', success: '#3b9eff', error: '#ff9f43', warning: '#ffd166',
    diffAdded: '#0b3a5c', diffRemoved: '#5c3a0b', diffAddedWord: '#1f6aa5', diffRemovedWord: '#a5651f' },
  'light-daltonized': { ...DARK, claude: '#0369a1', claudeShimmer: '#c2410c', inverseText: '#ffffff', inactive: 'ansi256(244)', subtle: 'ansi256(250)',
    success: '#005fb8', error: '#b35900', warning: '#8a6d00', diffAdded: '#dbeeff', diffRemoved: '#ffe9d6', diffAddedWord: '#a9d4ff', diffRemovedWord: '#ffc999',
    code: '#0550ae', link: '#0969da', keyword: '#8250df', number: '#8a6d00' },
  'dark-ansi': { ...DARK, claude: 'ansi:cyan', claudeShimmer: 'ansi:cyanBright', bashBorder: 'ansi:yellow', fastMode: 'ansi:yellow', inverseText: 'ansi:black',
    diffAdded: null, diffRemoved: null, diffAddedDimmed: null, diffRemovedDimmed: null, diffAddedWord: 'ansi:green', diffRemovedWord: 'ansi:red' },
  'light-ansi': { ...DARK, claude: 'ansi:cyan', claudeShimmer: 'ansi:blue', bashBorder: 'ansi:yellow', fastMode: 'ansi:yellow', inverseText: 'ansi:white', inactive: 'ansi:blackBright',
    diffAdded: null, diffRemoved: null, diffAddedDimmed: null, diffRemovedDimmed: null, diffAddedWord: 'ansi:green', diffRemovedWord: 'ansi:red' }
};

/** Parse one color value to { fg, bg, rgb? } escape sequences, or null if invalid. `null` means "no color". */
export function parseColor(value) {
  if (value === null) return { fg: '', bg: '', none: true };
  const text = String(value || '').trim();
  let m;
  const truecolor = (r, g, b) => ({ fg: '\x1b[38;2;' + r + ';' + g + ';' + b + 'm', bg: '\x1b[48;2;' + r + ';' + g + ';' + b + 'm', rgb: [r, g, b] });
  if ((m = /^#([0-9a-f]{6})$/i.exec(text))) return truecolor(parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16));
  if ((m = /^#([0-9a-f]{3})$/i.exec(text))) return truecolor(...[...m[1]].map((c) => parseInt(c + c, 16)));
  if ((m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(text))) {
    const parts = m.slice(1, 4).map(Number);
    return parts.every((n) => n <= 255) ? truecolor(...parts) : null;
  }
  if ((m = /^ansi256\(\s*(\d{1,3})\s*\)$/i.exec(text))) {
    const n = Number(m[1]);
    return n <= 255 ? { fg: '\x1b[38;5;' + n + 'm', bg: '\x1b[48;5;' + n + 'm' } : null;
  }
  if ((m = /^ansi:([a-z]+?)(Bright)?$/i.exec(text))) {
    const name = m[1].toLowerCase();
    if (name === 'default') return { fg: '\x1b[39m', bg: '\x1b[49m' };
    if (name === 'gray' || name === 'grey') return { fg: '\x1b[90m', bg: '\x1b[100m' };
    const index = ANSI_NAMES.indexOf(name);
    if (index < 0) return null;
    return m[2] ? { fg: '\x1b[' + (90 + index) + 'm', bg: '\x1b[' + (100 + index) + 'm' } : { fg: '\x1b[' + (30 + index) + 'm', bg: '\x1b[' + (40 + index) + 'm' };
  }
  return null;
}

/** Light or dark terminal background, from OASIS_TERMINAL_BACKGROUND or COLORFGBG ("fg;bg"). */
export function detectBackground(env = process.env) {
  const forced = String(env.OASIS_TERMINAL_BACKGROUND || '').toLowerCase();
  if (forced === 'light' || forced === 'dark') return forced;
  const parts = String(env.COLORFGBG || '').split(';');
  const bg = Number(parts[parts.length - 1]);
  if (Number.isInteger(bg) && parts.length > 1) return (bg === 7 || bg === 15 || (bg >= 9 && bg <= 14 && bg !== 12) || bg >= 250) ? 'light' : 'dark';
  return 'dark';
}

function readThemeFile(file) {
  try {
    if (statSync(file).size > 64 * 1024) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch { return null; }
}

function themeDirs(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const oasis = env.OASIS_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'oasis');
  return [path.join(claude, 'themes'), path.join(oasis, 'themes')];
}

function jsonFiles(target) {
  try {
    const info = statSync(target);
    if (info.isFile()) return target.endsWith('.json') ? [target] : [];
    if (!info.isDirectory()) return [];
    return readdirSync(target).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(target, name));
  } catch { return []; }
}

/** Every selectable theme: built-ins, custom files and plugin themes. */
export function listThemes({ env = process.env, plugins = [] } = {}) {
  const out = [{ id: 'auto', name: 'Auto (match terminal)', source: 'built-in' }, ...BASE_THEMES.map((id) => ({ id, name: id, source: 'built-in' }))];
  const seen = new Set();
  for (const dir of themeDirs(env)) {
    for (const file of jsonFiles(dir)) {
      const slug = path.basename(file, '.json');
      if (!/^[\w.-]+$/.test(slug) || seen.has(slug)) continue;
      const raw = readThemeFile(file);
      if (!raw) continue;
      seen.add(slug);
      out.push({ id: 'custom:' + slug, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : slug, source: file, raw });
    }
  }
  for (const plugin of plugins || []) {
    const manifest = plugin.manifest || {};
    const declared = manifest.experimental && manifest.experimental.themes !== undefined ? manifest.experimental.themes : manifest.themes !== undefined ? manifest.themes : 'themes';
    const entries = Array.isArray(declared) ? declared : [declared];
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      const target = path.resolve(plugin.root, entry);
      if (path.relative(plugin.root, target).startsWith('..')) continue;
      for (const file of jsonFiles(target)) {
        const slug = path.basename(file, '.json');
        const raw = readThemeFile(file);
        if (!raw || !/^[\w.-]+$/.test(slug)) continue;
        out.push({ id: 'plugin:' + plugin.name + ':' + slug, name: (typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : slug) + ' (' + plugin.name + ')', source: file, raw });
      }
    }
  }
  return out;
}

/** Resolve a preference ("dark", "auto", "custom:x", "plugin:p:x") to a full theme. Unknown ids fall back to dark. */
export function resolveTheme(preference, { env = process.env, plugins = [] } = {}) {
  let id = String(preference || 'dark').trim() || 'dark';
  if (id === 'auto') id = detectBackground(env);
  let base = id;
  let overrides = {};
  let name = id;
  let found = PRESETS[id] ? { id } : null;
  if (!found && (id.startsWith('custom:') || id.startsWith('plugin:'))) {
    found = listThemes({ env, plugins }).find((theme) => theme.id === id) || null;
    if (found) {
      base = BASE_THEMES.includes(found.raw.base) ? found.raw.base : 'dark';
      overrides = found.raw.overrides && typeof found.raw.overrides === 'object' && !Array.isArray(found.raw.overrides) ? found.raw.overrides : {};
      name = found.name;
    }
  }
  if (!found) { base = 'dark'; name = 'dark'; id = 'dark'; }
  const values = { ...PRESETS[base] };
  for (const [token, value] of Object.entries(overrides)) {
    if (!THEME_TOKENS.includes(token)) continue;
    if (value === null || parseColor(value)) values[token] = value;
  }
  const colors = {};
  for (const token of THEME_TOKENS) colors[token] = parseColor(values[token] === undefined ? null : values[token]) || parseColor(DARK[token] ?? null);
  return { id, name, base, ansiOnly: base.endsWith('-ansi'), colors };
}

let active = resolveTheme('dark', { env: {} });
const DEFAULT_ANSI = { ...ANSI };

/** The theme in effect for this process. */
export function currentTheme() { return active; }

/** Apply a theme: rewires the shared markdown/diff palette and the prompt accents. */
export function applyTheme(theme) {
  active = theme;
  const c = theme.colors;
  const fg = (token, fallback) => (c[token] && !c[token].none ? c[token].fg : fallback);
  const bg = (token) => (c[token] && !c[token].none ? c[token].bg : '');
  Object.assign(ANSI, DEFAULT_ANSI, {
    red: fg('error', DEFAULT_ANSI.red), green: fg('success', DEFAULT_ANSI.green), yellow: fg('number', DEFAULT_ANSI.yellow),
    blue: fg('link', DEFAULT_ANSI.blue), magenta: fg('keyword', DEFAULT_ANSI.magenta), cyan: fg('code', DEFAULT_ANSI.cyan), gray: fg('inactive', DEFAULT_ANSI.gray),
    bgRed: bg('diffRemoved'), bgGreen: bg('diffAdded')
  });
  return theme;
}

/** Foreground escape for a token ('' when the token has no color). */
export function themeFg(token) {
  const color = active.colors[token];
  return color && !color.none ? color.fg : '';
}

/** Theme preference from settings, OASIS_THEME, or Claude Code's ~/.claude.json "theme". */
export function themePreference({ env = process.env, settings = null } = {}) {
  if (env.OASIS_THEME) return env.OASIS_THEME;
  if (settings && typeof settings.theme === 'string' && settings.theme.trim()) return settings.theme.trim();
  try {
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const raw = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'));
    if (raw && typeof raw.theme === 'string' && raw.theme.trim()) return raw.theme.trim();
  } catch {}
  return 'dark';
}

/** A one-screen preview of a theme: accent, statuses and a diff. */
export function themePreview(theme) {
  const c = theme.colors;
  const f = (token) => (c[token] && !c[token].none ? c[token].fg : '');
  const b = (token) => (c[token] && !c[token].none ? c[token].bg : '');
  return [
    f('claude') + '⏺ Oasis' + '\x1b[39m  ' + f('success') + '✓ success\x1b[39m  ' + f('error') + '✗ error\x1b[39m  ' + f('warning') + '! warning\x1b[39m  ' + f('planMode') + '⏸ plan\x1b[39m  ' + f('autoAccept') + '⏵⏵ auto\x1b[39m',
    '    ' + b('diffAdded') + f('success') + '+ const answer = 42;' + '\x1b[39m\x1b[49m',
    '    ' + b('diffRemoved') + f('error') + '- const answer = 41;' + '\x1b[39m\x1b[49m',
    '    ' + f('keyword') + 'return' + '\x1b[39m ' + f('code') + '`code`' + '\x1b[39m ' + f('link') + 'link' + '\x1b[39m ' + f('inactive') + '// hint' + '\x1b[39m'
  ].join('\n');
}

/**
 * Hot reload (Claude Code reloads custom themes when the file changes): watches the theme
 * directories and plugin theme folders, and re-applies the active custom or plugin theme
 * after an edit. Built-in themes never change, so nothing is watched for them.
 * Returns a function that stops watching.
 */
export function watchThemes({ env = process.env, plugins = [], onReload = null, debounceMs = 150 } = {}) {
  const watchers = [];
  let timer = null;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const id = active.id;
      if (!id.startsWith('custom:') && !id.startsWith('plugin:')) return;
      const next = resolveTheme(id, { env, plugins });
      if (next.id !== id) return; // the file was removed or broken; keep the current colors
      if (JSON.stringify(next.colors) === JSON.stringify(active.colors) && next.name === active.name) return;
      applyTheme(next);
      if (onReload) onReload(next);
    }, debounceMs);
    if (timer.unref) timer.unref();
  };
  const targets = new Set(themeDirs(env));
  for (const plugin of plugins || []) targets.add(path.join(plugin.root, 'themes'));
  for (const dir of targets) {
    try {
      const watcher = watch(dir, { persistent: false }, reload);
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {}
  }
  return () => { clearTimeout(timer); for (const watcher of watchers) { try { watcher.close(); } catch {} } };
}
