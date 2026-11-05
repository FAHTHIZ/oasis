// Native skill installer: fetch a skill source (GitHub owner/repo, Git URL or a
// local folder), find SKILL.md packages in it, and copy the selected ones into
// an OASIS skill directory. Nothing from the source is executed: Git runs with
// hooks, submodules and credential prompts disabled, symlinks are skipped, and
// only regular files under a size budget are copied. Installed skills are
// treated as untrusted instructions by the rest of OASIS.

import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, copyFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { frontMatterValue } from './frontmatter.mjs';

const MAX_DEPTH = 6;
const MAX_FILES_PER_SKILL = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_MD_BYTES = 96 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);
const NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,63}$/;

/** Classify a source string; throws on anything unsafe. */
export function parseSkillSource(raw) {
  const source = String(raw || '').trim();
  if (!source || source.length > 600 || /[\r\n\0]/.test(source) || source.startsWith('-')) {
    throw new Error('Provide a valid skill source (GitHub owner/repo, HTTPS or SSH Git URL, or a local folder).');
  }
  const shorthand = source.match(/^([a-z0-9_.-]+)\/([a-z0-9_.-]+)(?:#([A-Za-z0-9_./-]{1,200}))?$/i);
  if (shorthand && !source.startsWith('.')) return { kind: 'git', url: 'https://github.com/' + shorthand[1] + '/' + shorthand[2].replace(/\.git$/i, '') + '.git', ref: shorthand[3] || '', display: source };
  if (/^(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[a-z]:[\\/])/i.test(source)) return { kind: 'local', path: source.replace(/^~(?=[\\/])/, os.homedir()), display: source };
  if (/^(?:git@[^\s:]+:|ssh:\/\/)/i.test(source)) return { kind: 'git', url: source, ref: '', display: source };
  if (/^https:\/\//i.test(source)) {
    let url;
    try { url = new URL(source); } catch { throw new Error('The skill source URL is invalid.'); }
    if (url.username || url.password || url.hash || url.search) throw new Error('Skill source URLs must not contain credentials, query strings or fragments.');
    // https://github.com/owner/repo/tree/<ref>/<subdir> points at one folder in a repository.
    const tree = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/);
    if (tree) return { kind: 'git', url: 'https://github.com/' + tree[1] + '/' + tree[2] + '.git', ref: tree[3], subdir: tree[4] || '', display: source };
    return { kind: 'git', url: source, ref: '', display: source };
  }
  throw new Error('Unsupported skill source. Use owner/repo, an HTTPS or SSH Git URL, or a local folder.');
}

function runGit(args, { cwd, env, signal, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('git', args, {
      cwd,
      env: { PATH: env.PATH || process.env.PATH || '', HOME: env.HOME || os.homedir(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1', ...(env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}), ...(env.HTTPS_PROXY ? { HTTPS_PROXY: env.HTTPS_PROXY } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const append = (chunk) => { output = (output + chunk).slice(-8000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, output: String(error.message || error) }); });
    child.once('close', (code) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve({ code, output }); });
  });
}

/** Clone a Git source shallowly into a temporary folder without running anything from it. */
async function cloneSource(spec, env, signal) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-src-'));
  const target = path.join(dir, 'repo');
  const hardening = ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'protocol.file.allow=never', '-c', 'core.symlinks=false', '-c', 'core.fsmonitor=false'];
  const args = [...hardening, 'clone', '--depth', '1', '--no-recurse-submodules', '--quiet', ...(spec.ref ? ['--branch', spec.ref] : []), '--', spec.url, target];
  const result = await runGit(args, { cwd: dir, env, signal });
  if (result.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error('Could not download the skill source (' + spec.display + '): ' + (result.output.trim().split('\n').pop() || 'git clone failed'));
  }
  return { root: spec.subdir ? path.join(target, spec.subdir) : target, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function skillMeta(content, fallback) {
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = front ? front[1] : '';
  const name = (frontMatterValue(metadata, 'name') || fallback || '').trim();
  const description = (frontMatterValue(metadata, 'description') || '').trim().replace(/\s+/g, ' ').slice(0, 400);
  return { name, description };
}

/** Every SKILL.md package under a folder, without following symlinks. */
export async function findSkillPackages(root) {
  const found = [];
  async function walk(directory, depth) {
    if (depth > MAX_DEPTH || found.length >= 500) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    const skillFile = entries.find((entry) => entry.isFile() && entry.name === 'SKILL.md');
    if (skillFile) {
      const file = path.join(directory, 'SKILL.md');
      const info = await lstat(file).catch(() => null);
      if (info && info.isFile() && info.size <= MAX_SKILL_MD_BYTES) {
        const content = await readFile(file, 'utf8').catch(() => '');
        const meta = skillMeta(content, path.basename(directory));
        if (!content.includes('\0') && NAME.test(meta.name)) found.push({ ...meta, directory });
      }
      return; // A skill's own subfolders (references/, assets/) are part of it.
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name)) await walk(path.join(directory, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

async function copySkill(from, to) {
  let files = 0;
  let bytes = 0;
  const skipped = [];
  async function walk(source, destination) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const src = path.join(source, entry.name);
      const dst = path.join(destination, entry.name);
      const info = await lstat(src);
      if (info.isSymbolicLink()) { skipped.push(path.relative(from, src) + ' (symlink)'); continue; }
      if (info.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(src, dst); continue; }
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_BYTES) { skipped.push(path.relative(from, src) + ' (too large)'); continue; }
      if (++files > MAX_FILES_PER_SKILL) throw new Error('The skill has more than ' + MAX_FILES_PER_SKILL + ' files; refusing to copy it.');
      bytes += info.size;
      if (bytes > MAX_SKILL_BYTES) throw new Error('The skill is larger than ' + (MAX_SKILL_BYTES >> 20) + ' MB; refusing to copy it.');
      await copyFile(src, dst);
    }
  }
  await walk(from, to);
  return { files, bytes, skipped };
}

/**
 * List or install skills from a source.
 * options: { skill?: name, all?: boolean, list?: boolean, targetDir: string, env, signal }
 */
export async function installSkillsFromSource(rawSource, options = {}) {
  const env = options.env || process.env;
  const spec = parseSkillSource(rawSource);
  let fetched = null;
  try {
    let root;
    if (spec.kind === 'local') {
      root = path.resolve(spec.path);
      const info = await lstat(root).catch(() => null);
      if (!info || !info.isDirectory()) throw new Error('The local skill folder does not exist: ' + spec.display);
    } else {
      fetched = await cloneSource(spec, env, options.signal);
      root = fetched.root;
    }
    const packages = await findSkillPackages(root);
    if (options.list) return { source: spec.display, available: packages.map(({ name, description }) => ({ name, description })) };
    if (!packages.length) return { installed: [], source: spec.display, message: 'No SKILL.md packages were found in ' + spec.display + '.' };
    const wanted = options.all ? packages : packages.filter((item) => item.name.toLowerCase() === String(options.skill || '').toLowerCase());
    if (!wanted.length) {
      return { installed: [], source: spec.display, available: packages.map((item) => item.name), message: 'No skill named "' + options.skill + '" in ' + spec.display + '. Available: ' + packages.map((item) => item.name).join(', ') + '.' };
    }
    const targetDir = path.resolve(options.targetDir);
    await mkdir(targetDir, { recursive: true });
    const installed = [];
    for (const item of wanted) {
      const destination = path.join(targetDir, item.name);
      const staging = destination + '.oasis-installing-' + process.pid;
      await rm(staging, { recursive: true, force: true });
      const stats = await copySkill(item.directory, staging);
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
      installed.push({ name: item.name, description: item.description, path: destination, files: stats.files, skipped: stats.skipped });
    }
    return { installed, source: spec.display, message: 'Installed ' + installed.map((item) => item.name).join(', ') + ' into ' + targetDir + '. Review the instructions before relying on them.' };
  } finally {
    if (fetched) await fetched.cleanup().catch(() => {});
  }
}
