// oasis plugin adopt: bring in the plugins you already installed in other
// agents, so switching to OASIS does not mean reinstalling everything.
//
// Claude Code plugins need no adopting: OASIS reads Claude Code's own install
// record. This looks where the others keep theirs:
//   Gemini CLI   ~/.gemini/extensions/NAME/gemini-extension.json
//   Codex        ~/.codex/plugins/cache/MARKETPLACE/PLUGIN/VERSION/.codex-plugin/plugin.json
//   Copilot CLI  ~/.copilot/installed-plugins/MARKETPLACE/PLUGIN (and _direct/ID)
//   Cursor       ~/.cursor/plugins/... (.cursor-plugin/plugin.json)
// Each one found is installed through `oasis add` (converted, audited, with
// the usual approval), from a copy, so the other agent's files are untouched.
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SOURCES = Object.freeze({
  gemini: { label: 'Gemini CLI', roots: (home, env) => [path.join(env.GEMINI_HOME || path.join(home, '.gemini'), 'extensions')] },
  codex: { label: 'Codex', roots: (home, env) => [path.join(env.CODEX_HOME || path.join(home, '.codex'), 'plugins')] },
  copilot: { label: 'Copilot CLI', roots: (home, env) => [path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'installed-plugins')] },
  cursor: { label: 'Cursor', roots: (home) => [path.join(home, '.cursor', 'plugins')] }
});
export const ADOPT_SOURCES = Object.freeze(Object.keys(SOURCES));
const MAX_DEPTH = 5;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);

// Plugin folders under a root: a folder whose manifest detectForeignPlugin
// recognises is a plugin, and its insides are not searched further.
async function findPlugins(dir, depth, detect, out) {
  if (depth > MAX_DEPTH || out.length > 500) return;
  const info = depth > 0 ? await detect(dir).catch(() => null) : null;
  if (info) { out.push({ dir, info }); return; }
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP.has(entry.name) || (entry.name.startsWith('.') && depth > 0)) continue;
    await findPlugins(path.join(dir, entry.name), depth + 1, detect, out);
  }
}

/**
 * Plugins installed in other agents. One entry per agent and plugin name; when
 * Codex keeps several cached versions, the newest folder wins.
 */
export async function findAdoptable({ from = ADOPT_SOURCES, env = process.env, home = env.HOME || os.homedir() } = {}) {
  const { detectForeignPlugin } = await import('./plugin-convert.mjs');
  const found = [];
  for (const source of from) {
    if (!SOURCES[source]) throw new Error('Unknown agent "' + source + '". Use ' + ADOPT_SOURCES.join(', ') + '.');
    const hits = [];
    for (const root of SOURCES[source].roots(home, env)) await findPlugins(root, 0, detectForeignPlugin, hits);
    const newest = new Map();
    for (const hit of hits) {
      const name = String(hit.info.name || path.basename(hit.dir)).toLowerCase();
      const mtime = (await stat(hit.dir).catch(() => ({ mtimeMs: 0 }))).mtimeMs;
      const prev = newest.get(name);
      if (!prev || mtime > prev.mtime) newest.set(name, { source, agent: SOURCES[source].label, name, dir: hit.dir, format: hit.info.label, version: hit.info.version || '', description: String(hit.info.description || '').slice(0, 160), mtime });
    }
    found.push(...[...newest.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }
  return found.map(({ mtime, ...rest }) => rest);
}

export async function adoptCli(root, params, { write, approve, env = process.env, home = env.HOME || os.homedir() } = {}) {
  const take = (flag) => { const i = params.indexOf(flag); if (i < 0) return null; const value = params[i + 1]; params.splice(i, 2); return value; };
  const fromText = take('--from');
  const yes = params.includes('--yes') || params.includes('-y');
  const list = params.includes('--list') || params.includes('--dry-run');
  const names = params.filter((p) => !p.startsWith('-')).map((p) => p.toLowerCase());
  const from = fromText ? fromText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : ADOPT_SOURCES;
  const found = await findAdoptable({ from, home, env });
  const chosen = names.length ? found.filter((p) => names.includes(p.name) || names.includes(p.source + ':' + p.name)) : found;
  if (!found.length) { write('No plugins from ' + from.map((s) => SOURCES[s].label).join(', ') + ' were found. (Claude Code plugins are read directly; see oasis plugin list.)\n'); return { found, installed: [] }; }
  write('Plugins installed in other agents:\n' + found.map((p) => '  ' + (chosen.includes(p) ? '*' : ' ') + ' ' + (p.source + ':' + p.name).padEnd(30) + ' ' + p.format + (p.version ? ' ' + p.version : '') + (p.description ? ' — ' + p.description : '')).join('\n') + '\n');
  if (names.length && !chosen.length) throw new Error('None of ' + names.join(', ') + ' was found.');
  if (list) return { found, installed: [] };
  if (!yes && !approve) { write('Run oasis plugin adopt --yes to install the marked plugins (each is converted and audited first), or name the ones you want.\n'); return { found, installed: [] }; }
  const { addAnything } = await import('./add-anything.mjs');
  const installed = [];
  const failed = [];
  for (const plugin of chosen) {
    try {
      const result = await addAnything(plugin.dir, { root, env, approve: yes ? async () => true : (approve || (async () => false)) });
      if (result.approved && result.installed && result.installed.length) { installed.push(...result.installed); write('Adopted ' + plugin.source + ':' + plugin.name + ' as ' + result.installed.join(', ') + '\n'); }
      else write('Skipped ' + plugin.source + ':' + plugin.name + (result.message ? ': ' + result.message : '') + '\n');
    } catch (error) {
      failed.push(plugin.name);
      write('Could not adopt ' + plugin.source + ':' + plugin.name + ': ' + (error.message || error) + '\n');
    }
  }
  if (failed.length) process.exitCode = 1;
  return { found, installed, failed };
}
