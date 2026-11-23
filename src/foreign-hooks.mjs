// Hooks other agents already run in this project, run by OASIS too.
//
// A team that uses Cursor or GitHub Copilot keeps hooks next to the code:
// .cursor/hooks.json (Cursor), .github/hooks/*.json (Copilot CLI and the
// Copilot coding agent) and the "hooks" of .gemini/settings.json (Gemini CLI).
// User hooks live in ~/.cursor/hooks.json and ~/.gemini/settings.json.
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

/**
 * Hook groups (Claude Code format, tagged for the bridge) from other agents'
 * hook files. Returns [{ scope, file, protocol, hooks, dropped }].
 */
export async function loadForeignHooks(root, { env = process.env, home = env.HOME || os.homedir(), trusted = false } = {}) {
  if (env.OASIS_OTHER_AGENT_RULES === '0') return [];
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
  const out = [];
  for (const source of sources) {
    const doc = await readJson(source.file);
    if (!doc || !doc.hooks) continue;
    const { hooks, dropped } = bridgeHookDoc(source.protocol, doc, rooted(source.base));
    if (Object.keys(hooks).length || dropped.length) out.push({ scope: source.scope, file: source.file, protocol: source.protocol, hooks, dropped });
  }
  return out;
}
