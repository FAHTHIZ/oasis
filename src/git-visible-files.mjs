// Lists the files git considers part of the project: tracked files plus
// untracked files that are not ignored. This honours every ignore source git
// knows (nested .gitignore files, .git/info/exclude, core.excludesFile), so
// glob, list_files, the repo map, completion and the built-in grep fallback
// skip ignored build output the same way ripgrep does.
//
// Returns null whenever git can't answer (not a repository, git missing, the
// directory itself is ignored, timeout); callers then fall back to a plain walk.
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

const GIT_ARGS = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];

function git(cwd, args, env) {
  return new Promise((resolve) => {
    execFile('git', [...GIT_ARGS, ...args], {
      cwd,
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 128 * 1024 * 1024,
      timeout: 15000,
      windowsHide: true
    }, (error, stdout) => resolve(error ? { code: typeof error.code === 'number' ? error.code : -1, stdout: String(stdout || '') } : { code: 0, stdout: String(stdout || '') }));
  });
}

export function gitignoreRespected(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.OASIS_RESPECT_GITIGNORE || '').trim());
}

function compareSegments(a, b) {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i].localeCompare(right[i]);
  }
  return left.length - right.length;
}

/**
 * @param {string} dir absolute directory to list
 * `filter` (forward-slash relative path => boolean) runs before `maxFiles` is
 * applied, so a glob or name filter sees every listed file, not just the first
 * few thousand. Without it a 40,000-file repository hid most of its files from
 * glob_files and the search fallback.
 * @param {{ maxFiles?: number, maxDepth?: number, includeHidden?: boolean, skipDirs?: Set<string>, skip?: (rel: string) => boolean, filter?: (posixRel: string) => boolean, env?: object }} options
 * @returns {Promise<Array<{absolute: string, relative: string}> | null>}
 */
export async function gitVisibleFiles(dir, options = {}) {
  const env = options.env || process.env;
  if (!gitignoreRespected(env)) return null;
  // An explicitly targeted ignored folder (say `dist`) should still be searchable.
  const ignored = await git(dir, ['check-ignore', '-q', '--no-index', '.'], env);
  if (ignored.code === 0) return null;
  const listed = await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--', '.'], env);
  if (listed.code !== 0) return null;
  const maxFiles = options.maxFiles || 1200;
  const maxDepth = options.maxDepth || 9;
  const skipDirs = options.skipDirs || new Set();
  const names = listed.stdout.split('\0').filter((name) => {
    if (!name || name.endsWith('/')) return false; // untracked nested repositories
    const parts = name.split('/');
    if (parts.length - 1 > maxDepth) return false;
    for (let i = 0; i < parts.length; i++) {
      if (!options.includeHidden && parts[i].startsWith('.')) return false;
      if (i < parts.length - 1 && skipDirs.has(parts[i])) return false;
    }
    return !options.filter || options.filter(name);
  });
  names.sort(compareSegments);
  const output = [];
  for (let start = 0; start < names.length && output.length < maxFiles; start += 64) {
    const batch = names.slice(start, start + 64);
    const checked = await Promise.all(batch.map(async (name) => {
      const relative = name.split('/').join(path.sep);
      if (options.skip && options.skip(relative)) return null;
      const absolute = path.join(dir, relative);
      try {
        const info = await lstat(absolute); // tracked-but-deleted files and symlinks drop out here
        return info.isFile() ? { absolute, relative } : null;
      } catch { return null; }
    }));
    for (const item of checked) {
      if (item && output.length < maxFiles) output.push(item);
    }
  }
  return output;
}
