// Project profile for the system prompt: detected languages, manifests,
// key scripts and a compact top-level file layout.
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { NPM_PLACEHOLDER_TEST, detectProjectTestCommand } from './turn-guards.mjs';

const PROJECT_MANIFESTS = [
  ['package.json', 'JavaScript/TypeScript', 'node'], ['pyproject.toml', 'Python', 'python3'], ['requirements.txt', 'Python', 'python3'],
  ['Cargo.toml', 'Rust', 'cargo'], ['go.mod', 'Go', 'go'], ['Gemfile', 'Ruby', 'ruby'], ['pom.xml', 'Java (Maven)', 'mvn'],
  ['build.gradle', 'Java/Kotlin (Gradle)', null], ['build.gradle.kts', 'Kotlin (Gradle)', null], ['composer.json', 'PHP', 'php'],
  ['mix.exs', 'Elixir', 'mix'], ['Package.swift', 'Swift', 'swift'], ['CMakeLists.txt', 'C/C++ (CMake)', 'cmake'], ['Makefile', 'Make', 'make']
];
const KEY_SCRIPTS = ['test', 'lint', 'typecheck', 'check', 'build', 'format', 'dev', 'start'];

async function onPath(program, env) {
  const dirs = String(env.PATH || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [program + '.exe', program + '.cmd', program] : [program];
  for (const dir of dirs) for (const name of names) {
    try { if ((await stat(path.join(dir, name))).isFile()) return true; } catch { /* keep looking */ }
  }
  return false;
}

// Environment discovery, as Factory's Droid does at the start of a run: what
// the project is built with, how to test it, and which needed toolchains are
// missing. Saves the model several exploratory calls on every task.
export async function describeProject(root, env = process.env) {
  const exists = async (name) => { try { await stat(path.join(root, name)); return true; } catch { return false; } };
  const found = [];
  for (const entry of PROJECT_MANIFESTS) if (await exists(entry[0])) found.push(entry);
  if (!found.length) return '';
  const parts = ['Project: ' + [...new Set(found.map((entry) => entry[1]))].join(', ') + ' (' + found.map((entry) => entry[0]).join(', ') + ')'];
  if (found.some((entry) => entry[0] === 'package.json')) {
    try {
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      const manager = await exists('pnpm-lock.yaml') ? 'pnpm' : await exists('yarn.lock') ? 'yarn' : await exists('bun.lockb') || await exists('bun.lock') ? 'bun' : 'npm';
      const scripts = KEY_SCRIPTS.filter((name) => pkg && pkg.scripts && typeof pkg.scripts[name] === 'string' && !(name === 'test' && NPM_PLACEHOLDER_TEST.test(pkg.scripts[name])));
      parts.push('Package manager: ' + manager + (scripts.length ? '; scripts: ' + scripts.join(', ') : '') + (await exists('node_modules') ? '' : '; dependencies not installed'));
    } catch { /* unreadable package.json */ }
  }
  const test = await detectProjectTestCommand(root).catch(() => null);
  if (test) parts.push('Test command: ' + [test.command, ...test.args].join(' '));
  const missing = [];
  for (const program of [...new Set(found.map((entry) => entry[2]).filter(Boolean))]) if (!(await onPath(program, env))) missing.push(program);
  if (missing.length) parts.push('Not on PATH: ' + missing.join(', '));
  return parts.join('\n');
}

// A short snapshot of the environment, like Claude Code's <env> block: platform,
// date, and (for Git repositories) the branch, status summary, and recent commits.
// A few dozen tokens that save the model its first glob/list round trips:
// every path in a small repo, else top-level entries with file counts.
export function fileLayout(paths, { maxFiles = 40, maxEntries = 30 } = {}) {
  const list = paths.map((item) => String(item || '').trim()).filter((item) => item && !item.startsWith('.oasis/'));
  if (!list.length) return '';
  if (list.length <= maxFiles) return 'Files (' + list.length + '): ' + list.sort().join(', ');
  const counts = new Map();
  for (const item of list) {
    const slash = item.indexOf('/');
    const key = slash === -1 ? item : item.slice(0, slash + 1);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const shown = entries.slice(0, maxEntries).map(([key, count]) => key.endsWith('/') ? key + ' (' + count + ')' : key);
  return 'Top-level layout (' + list.length + ' files): ' + shown.join(', ') + (entries.length > maxEntries ? ', +' + (entries.length - maxEntries) + ' more' : '');
}
