// `oasis profile`: separate, isolated OASIS agents on one machine (like Hermes profiles).
// Each profile has its own config and keys, settings, OASIS.md instructions, memories,
// sessions, skills, commands, agents, MCP servers, hooks and cron jobs, stored under
// <oasis config>/profiles/NAME. Pick one per run with --profile NAME (or OASIS_PROFILE),
// or make one the default with `oasis profile use NAME`.
//
//   oasis profile list
//   oasis profile create NAME [--from PROFILE] [--with-memory]
//   oasis profile use NAME|default
//   oasis profile show [NAME]
//   oasis profile delete NAME --yes
import { cp, lstat, mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PROFILE_NAME_PATTERN, activeProfile, getBaseConfigDirectory } from './config.mjs';

// What a new profile copies from its source. Sessions, logs and caches never move.
export const PROFILE_COPY = ['config.json', 'settings.json', 'OASIS.md', 'mcp.json', 'keybindings.json', 'commands', 'agents', 'skills', 'output-styles', 'hooks', 'themes', 'statusline.sh'];
export const PROFILE_MEMORY = ['memory'];

const exists = (file) => lstat(file).then(() => true, () => false);

export function profileDirectory(name, env = process.env, home = os.homedir()) {
  const base = getBaseConfigDirectory(env, home);
  if (!name || name === 'default') return base;
  if (!PROFILE_NAME_PATTERN.test(name)) throw new Error('Invalid profile name "' + name + '": use letters, digits, - and _ (up to 40).');
  return path.join(base, 'profiles', name);
}

async function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function sessionCount(dir) {
  let count = 0;
  let projects = [];
  try { projects = await readdir(path.join(dir, 'sessions'), { withFileTypes: true }); } catch { return 0; }
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    try { count += (await readdir(path.join(dir, 'sessions', project.name))).filter((name) => name.endsWith('.json')).length; } catch {}
  }
  return count;
}

export async function listProfiles(env = process.env, home = os.homedir()) {
  const base = getBaseConfigDirectory(env, home);
  const names = ['default'];
  try {
    for (const entry of await readdir(path.join(base, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory() && PROFILE_NAME_PATTERN.test(entry.name)) names.push(entry.name);
    }
  } catch {}
  let active = null;
  try { active = activeProfile(env, home); } catch {}
  const out = [];
  for (const name of names.sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))) {
    const dir = profileDirectory(name, env, home);
    out.push({ name, dir, active: (active || 'default') === name, configured: await exists(path.join(dir, 'config.json')), sessions: await sessionCount(dir) });
  }
  return out;
}

export async function createProfile(name, { from = 'default', withMemory = false, env = process.env, home = os.homedir() } = {}) {
  if (!name || name === 'default') throw new Error('Pick a profile name other than "default".');
  const target = profileDirectory(name, env, home);
  if (await exists(target)) throw new Error('Profile ' + name + ' already exists at ' + target + '.');
  const source = profileDirectory(from, env, home);
  if (from !== 'default' && !await exists(source)) throw new Error('No profile named ' + from + '.');
  await mkdir(target, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const item of [...PROFILE_COPY, ...(withMemory ? PROFILE_MEMORY : [])]) {
    const src = path.join(source, item);
    if (!await exists(src)) continue;
    if (from === 'default' && item === 'profiles') continue;
    await cp(src, path.join(target, item), { recursive: true, errorOnExist: false, force: false, filter: async (file) => { try { return !(await lstat(file)).isSymbolicLink(); } catch { return false; } } });
    copied.push(item);
  }
  return { name, dir: target, from, copied };
}

export async function useProfile(name, { env = process.env, home = os.homedir() } = {}) {
  const base = getBaseConfigDirectory(env, home);
  const file = path.join(base, 'active-profile');
  if (!name || name === 'default') { await unlink(file).catch(() => {}); return { name: 'default', dir: base }; }
  const dir = profileDirectory(name, env, home);
  if (!await exists(dir)) throw new Error('No profile named ' + name + '. Create it with `oasis profile create ' + name + '`.');
  await mkdir(base, { recursive: true, mode: 0o700 });
  await writeFile(file, name + '\n', { mode: 0o600 });
  return { name, dir };
}

export async function deleteProfile(name, { env = process.env, home = os.homedir() } = {}) {
  if (!name || name === 'default') throw new Error('The default profile cannot be deleted.');
  const dir = profileDirectory(name, env, home);
  if (!await exists(dir)) throw new Error('No profile named ' + name + '.');
  let active = null;
  try { active = activeProfile(env, home); } catch {}
  if (active === name) throw new Error('Profile ' + name + ' is active. Switch with `oasis profile use default` (and unset OASIS_PROFILE) first.');
  await rm(dir, { recursive: true, force: true });
  return { name, dir };
}

export async function profileCommand(args = [], { env = process.env, home = os.homedir(), stdout = process.stdout } = {}) {
  const [action = 'list', name] = args.filter((arg) => !arg.startsWith('--'));
  const flag = (f) => args.includes(f);
  const option = (f) => { const at = args.indexOf(f); return at >= 0 ? args[at + 1] : null; };
  if (action === 'list' || action === 'ls') {
    const profiles = await listProfiles(env, home);
    if (flag('--json')) { stdout.write(JSON.stringify(profiles, null, 2) + '\n'); return profiles; }
    for (const p of profiles) stdout.write((p.active ? '* ' : '  ') + p.name.padEnd(20) + (p.configured ? 'configured' : 'not set up').padEnd(12) + String(p.sessions).padStart(5) + ' sessions  ' + p.dir + '\n');
    stdout.write('\nUse one with `oasis --profile NAME`, or make it the default with `oasis profile use NAME`.\n');
    return profiles;
  }
  if (action === 'create' || action === 'new') {
    const from = option('--from') || 'default';
    const result = await createProfile(name, { from, withMemory: flag('--with-memory'), env, home });
    stdout.write('Created profile ' + result.name + ' at ' + result.dir + (result.copied.length ? ' (copied ' + result.copied.join(', ') + ' from ' + from + ')' : '') + '.\nStart it with `oasis --profile ' + result.name + '`' + (result.copied.includes('config.json') ? '' : ' and run `oasis --profile ' + result.name + ' setup` to choose its model') + '.\n');
    return result;
  }
  if (action === 'use' || action === 'switch') {
    const result = await useProfile(name, { env, home });
    stdout.write('Default profile is now ' + result.name + ' (' + result.dir + ').' + (env.OASIS_PROFILE ? ' OASIS_PROFILE=' + env.OASIS_PROFILE + ' still overrides it in this shell.' : '') + '\n');
    return result;
  }
  if (action === 'show' || action === 'current' || action === 'path') {
    let current = name;
    if (!current) { try { current = activeProfile(env, home) || 'default'; } catch (error) { throw error; } }
    const dir = profileDirectory(current, env, home);
    if (action === 'path') { stdout.write(dir + '\n'); return { name: current, dir }; }
    const size = await dirSize(dir);
    stdout.write('Profile: ' + current + '\nDirectory: ' + dir + '\nConfigured: ' + (await exists(path.join(dir, 'config.json')) ? 'yes' : 'no') + '\nSessions: ' + await sessionCount(dir) + '\nSize: ' + Math.round(size / 1024) + ' KB\n');
    return { name: current, dir, size };
  }
  if (action === 'delete' || action === 'rm' || action === 'remove') {
    if (!flag('--yes')) throw new Error('This deletes the profile with its sessions and memories. Run `oasis profile delete ' + (name || 'NAME') + ' --yes` to confirm.');
    const result = await deleteProfile(name, { env, home });
    stdout.write('Deleted profile ' + result.name + ' (' + result.dir + ').\n');
    return result;
  }
  throw new Error('Usage: oasis profile list | create NAME [--from PROFILE] [--with-memory] | use NAME|default | show [NAME] | path [NAME] | delete NAME --yes');
}
