// File watching for FileChanged and ConfigChange hooks, plus live settings reload.
//
// FileChanged: literal filenames in a FileChanged matcher ("\.envrc|.env" style segments
// without regex characters) are watched relative to the workspace, together with the
// dynamic watchPaths returned by SessionStart, CwdChanged and FileChanged hooks.
// ConfigChange: user, project and local settings files and skill directories. Unless a
// ConfigChange hook blocks it, a changed settings file is reloaded into the running session.

import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runHooks, hasHooks } from './hooks.mjs';
import { userSettingsPath, projectSettingsPaths } from './settings.mjs';

const DEBOUNCE_MS = 150;
const LITERAL = /^[^*?[\]()^$+{}\\|]+$/;

/** Literal file names from FileChanged matchers ("a|b"); regex segments do not add watches. */
export function fileChangedMatcherPaths(hooks, root) {
  const groups = hooks && Array.isArray(hooks.FileChanged) ? hooks.FileChanged : [];
  const paths = [];
  for (const group of groups) {
    for (const segment of String(group.matcher || '').split('|').map((item) => item.trim()).filter(Boolean)) {
      if (segment === '*' || !LITERAL.test(segment)) continue;
      paths.push(path.resolve(root, segment));
    }
  }
  return [...new Set(paths)];
}

/** Settings and skill locations whose changes fire ConfigChange, with their source names. */
export function configWatchTargets(root, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const targets = [{ file: userSettingsPath(env), source: 'user_settings' }, { file: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'), source: 'user_settings' }];
  for (const entry of projectSettingsPaths(root)) targets.push({ file: entry.file, source: entry.scope === 'local' ? 'local_settings' : 'project_settings' });
  for (const dir of [path.join(root, '.claude', 'skills'), path.join(root, '.oasis', 'skills'), path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills')]) targets.push({ dir, source: 'skills' });
  return targets;
}

/**
 * Starts the watchers for a session. Returns { stop, refresh, setDynamicPaths, paths }.
 * options: { env, liveReload (re-read settings on change), notify(message), reload(session) }.
 */
export function startHookWatchers(session, options = {}) {
  const env = options.env || process.env;
  const notify = typeof options.notify === 'function' ? options.notify : (message) => session.hookMessages && session.hookMessages.push(message);
  const hookOpts = () => (typeof options.hookOptions === 'function' ? options.hookOptions() : { hooks: session.hooks, root: session.root, env });
  const dirWatchers = new Map(); // dir -> { watcher, names: Map(basename -> handler) }
  const timers = new Map();
  let dynamic = Array.isArray(session.hookWatchPaths) ? session.hookWatchPaths.slice() : [];
  let stopped = false;

  const watchFile = (file, handler) => {
    const dir = path.dirname(file);
    const name = path.basename(file);
    let entry = dirWatchers.get(dir);
    if (!entry) {
      if (!existsSync(dir)) return false;
      let watcher;
      try {
        watcher = watch(dir, { persistent: false }, (_type, changed) => {
          const names = entry.names;
          const key = changed ? String(changed) : null;
          for (const [watched, fn] of names) if (!key || key === watched || watched === '*') fn(key);
        });
      } catch { return false; }
      watcher.on('error', () => {});
      entry = { watcher, names: new Map() };
      dirWatchers.set(dir, entry);
    }
    entry.names.set(name, handler);
    return true;
  };

  const debounce = (key, fn) => {
    clearTimeout(timers.get(key));
    const timer = setTimeout(() => { timers.delete(key); if (!stopped) fn(); }, DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    timers.set(key, timer);
  };

  const fileChanged = (file, existedBefore) => {
    const exists = existsSync(file);
    const event = existedBefore && exists ? 'change' : !existedBefore && exists ? 'add' : existedBefore && !exists ? 'unlink' : null;
    return { event, exists };
  };

  const states = new Map(); // file -> existed
  const watchForHooks = (file) => {
    states.set(file, existsSync(file));
    watchFile(file, () => debounce('file:' + file, async () => {
      const { event, exists } = fileChanged(file, states.get(file));
      states.set(file, exists);
      if (!event || !hasHooks(session.hooks, 'FileChanged')) return;
      const result = await runHooks('FileChanged', { session_id: session.sessionId || 'unsaved', file_path: file, event }, hookOpts()).catch(() => null);
      if (!result) return;
      for (const message of result.messages) notify(message);
      if (Array.isArray(result.watchPaths)) setDynamicPaths(result.watchPaths);
    }));
  };

  const configChanged = (target, file) => debounce('config:' + file, async () => {
    if (hasHooks(session.hooks, 'ConfigChange')) {
      const result = await runHooks('ConfigChange', { session_id: session.sessionId || 'unsaved', source: target.source, file_path: file }, hookOpts()).catch(() => null);
      // A blocked change is not applied (Claude Code only records it in its debug log).
      if (result && result.blocked && target.source !== 'policy_settings') return;
    }
    if (options.liveReload && target.source !== 'skills' && typeof options.reload === 'function') {
      try { await options.reload(session); } catch (error) { notify('Settings reload failed: ' + (error.message || error)); }
    }
  });

  const refresh = () => {
    for (const entry of dirWatchers.values()) { try { entry.watcher.close(); } catch {} }
    dirWatchers.clear();
    const files = new Set([...fileChangedMatcherPaths(session.hooks, session.root), ...dynamic.filter((item) => path.isAbsolute(item))]);
    for (const file of files) watchForHooks(file);
    if (options.liveReload || hasHooks(session.hooks, 'ConfigChange')) {
      for (const target of configWatchTargets(session.root, env)) {
        if (target.file) {
          if (files.has(target.file)) continue;
          watchFile(target.file, () => configChanged(target, target.file));
        } else if (target.dir) {
          // Any entry in a skills directory (new skill folder, edited SKILL.md at the top level).
          const marker = path.join(target.dir, '*');
          watchFile(marker, (changed) => configChanged(target, changed ? path.join(target.dir, changed) : target.dir));
        }
      }
    }
    api.paths = [...files];
  };

  const setDynamicPaths = (paths) => {
    dynamic = paths.filter((item) => typeof item === 'string' && path.isAbsolute(item));
    session.hookWatchPaths = dynamic.slice();
    if (!stopped) refresh();
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const entry of dirWatchers.values()) { try { entry.watcher.close(); } catch {} }
    dirWatchers.clear();
  };

  const api = { stop, refresh, setDynamicPaths, paths: [] };
  refresh();
  return api;
}

/** Whether a session needs watchers at all. */
export function needsHookWatchers(hooks, liveReload) {
  return Boolean(liveReload || hasHooks(hooks, 'FileChanged') || hasHooks(hooks, 'ConfigChange'));
}
