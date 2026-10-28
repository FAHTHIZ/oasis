// `oasis purge [path]` (Claude Code's `claude purge`): delete all local Oasis state for a
// project — saved transcripts (with their checkpoints / file-edit history), debug logs for
// those sessions, background-session entries and logs, prompt-history lines, and the
// project's workspace-trust entry. Auto memory is kept unless --memory is passed.
//
//   oasis purge [path] [--dry-run] [-y|--yes] [-i|--interactive] [--all] [--memory]
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { getSessionDirectory } from './sessions.mjs';
import { historyPath } from './input-history.mjs';
import { backgroundDirectory } from './background-sessions.mjs';
import { memoryRoots } from './auto-memory.mjs';

export function parsePurgeArgs(rest = []) {
  const options = { path: null, dryRun: false, yes: false, interactive: false, all: false, memory: false };
  for (const arg of rest) {
    if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '-y' || arg === '--yes') options.yes = true;
    else if (arg === '-i' || arg === '--interactive') options.interactive = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--memory') options.memory = true;
    else if (arg.startsWith('-')) throw new Error('Unknown purge option ' + arg + '. Usage: oasis purge [path] [--dry-run] [-y] [-i] [--all] [--memory]');
    else if (!options.path) options.path = arg;
    else throw new Error('oasis purge takes one project path.');
  }
  return options;
}

async function exists(file) { try { await stat(file); return true; } catch { return false; } }

/** Every project that has saved Oasis sessions, with its session count. */
export async function knownProjects(env = process.env) {
  const base = path.join(getConfigDirectory(env), 'sessions');
  const projects = [];
  let keys = [];
  try { keys = await readdir(base); } catch { return []; }
  for (const key of keys) {
    let files = [];
    try { files = (await readdir(path.join(base, key))).filter((name) => name.endsWith('.json')); } catch { continue; }
    for (const name of files) {
      try {
        const data = JSON.parse(await readFile(path.join(base, key, name), 'utf8'));
        if (data.workspaceRoot) { projects.push({ root: path.resolve(data.workspaceRoot), sessions: files.length }); break; }
      } catch {}
    }
  }
  return projects.sort((a, b) => a.root.localeCompare(b.root));
}

/** Lists what purging `root` would delete. Nothing is touched. */
export async function planPurge(root, { env = process.env, memory = false } = {}) {
  const project = path.resolve(root);
  const items = [];
  const sessionDir = getSessionDirectory(project, env);
  let sessionIds = [];
  try { sessionIds = (await readdir(sessionDir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)); } catch {}
  if (sessionIds.length) items.push({ kind: 'transcripts', label: sessionIds.length + ' saved session' + (sessionIds.length === 1 ? '' : 's') + ' (transcripts, task lists, checkpoints)', path: sessionDir });
  const debugDir = path.join(getConfigDirectory(env), 'debug');
  try {
    for (const name of await readdir(debugDir)) if (sessionIds.some((id) => name.startsWith(id))) items.push({ kind: 'debug', label: 'debug log ' + name, path: path.join(debugDir, name) });
  } catch {}
  try {
    const dir = backgroundDirectory(env);
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
        if (entry.root && path.resolve(entry.root) === project) items.push({ kind: 'background', label: 'background ' + (entry.kind === 'exec' ? 'job ' : 'session ') + entry.id + (entry.status === 'running' ? ' (running — skipped)' : ''), path: path.join(dir, name), log: entry.logFile, skip: entry.status === 'running' });
      } catch {}
    }
  } catch {}
  try {
    const lines = (await readFile(historyPath(env), 'utf8')).split('\n').filter(Boolean);
    const mine = lines.filter((line) => { try { const entry = JSON.parse(line); return entry.root && path.resolve(entry.root) === project; } catch { return false; } });
    if (mine.length) items.push({ kind: 'history', label: mine.length + ' prompt-history line' + (mine.length === 1 ? '' : 's'), path: historyPath(env), count: mine.length });
  } catch {}
  try {
    const { workspaceIdentity, userSettingsPath } = await import('./settings.mjs');
    const id = await workspaceIdentity(project).catch(() => project);
    const settings = JSON.parse(await readFile(userSettingsPath(env), 'utf8'));
    if (Array.isArray(settings && settings.trustedWorkspaces) && settings.trustedWorkspaces.some((entry) => entry === id || entry === project)) items.push({ kind: 'trust', label: 'workspace trust entry', path: id });
  } catch {}
  if (memory) {
    const dir = memoryRoots(project, env).project;
    if (await exists(dir)) items.push({ kind: 'memory', label: 'project auto memory', path: dir });
  }
  return { root: project, items };
}

/** Deletes the planned items. `confirm(item)` can veto individual items (-i). */
export async function applyPurge(plan, { env = process.env, confirm = null } = {}) {
  const done = [];
  for (const item of plan.items) {
    if (item.skip) continue;
    if (confirm && !(await confirm(item))) continue;
    if (item.kind === 'transcripts' || item.kind === 'debug' || item.kind === 'memory') await rm(item.path, { recursive: true, force: true });
    else if (item.kind === 'background') { await rm(item.path, { force: true }); if (item.log) await rm(item.log, { force: true }); }
    else if (item.kind === 'history') {
      const lines = (await readFile(item.path, 'utf8')).split('\n').filter(Boolean);
      const keep = lines.filter((line) => { try { const entry = JSON.parse(line); return !(entry.root && path.resolve(entry.root) === plan.root); } catch { return true; } });
      await writeFile(item.path, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
    } else if (item.kind === 'trust') {
      const { setWorkspaceTrust } = await import('./settings.mjs');
      await setWorkspaceTrust(plan.root, false, env);
    }
    done.push(item);
  }
  return done;
}

export function describePurge(plan) {
  if (!plan.items.length) return 'Nothing to purge for ' + plan.root + '.';
  return 'Local Oasis state for ' + plan.root + ':\n' + plan.items.map((item) => '  - ' + item.label).join('\n');
}
