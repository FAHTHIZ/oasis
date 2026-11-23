// Effect contracts for commands (docs/EFFECTS.md).
//
// Edits made through write_file / edit_file are captured before they happen,
// so /rewind can undo them and the evidence ledger knows which files changed.
// A shell command was a blind spot: `sed -i`, `npm install`, a formatter or a
// code generator could change any number of files and the runtime only knew
// "this command may have written something". This module closes that gap.
//
// Around every command that is not provably read-only, the runtime:
//
//   1. predicts its effects from the parsed command line (the shadow: which
//      paths a redirection, `sed -i`, `rm`, `mv`, `cp`, `tee`, a formatter or
//      a package manager will touch; `broad` when it cannot be bounded);
//   2. snapshots the working tree as a Git tree object, written through a
//      private index into a private object store (the repository's objects
//      are read as alternates), so the user's index, HEAD, refs, stash and
//      object database are never written;
//   3. after the command, snapshots again and diffs the two trees: the
//      observed effects, exact to the file and independent of what the
//      command or the model says it did;
//   4. checks the observed effects against the prediction. Changes nobody
//      predicted are `unexpected` and are named to the agent;
//   5. records the pre-command content of every changed file in the turn's
//      checkpoint, so /rewind undoes shell changes as well as tool edits, and
//      `restorePaths` can compensate a single command.
//
// Snapshots respect .gitignore (ignored build output is not tracked) and are
// skipped outside a Git work tree, for background commands, and when a
// snapshot exceeds its time budget (the session then stops trying). Nothing
// here grants or denies anything: permissions decide as before.

import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseShellCommands } from './shell-ast.mjs';
import { splitShell } from './shell-risk.mjs';
import { atomicWriteFile } from './atomic-write.mjs';

export const EFFECT_SNAPSHOT_BUDGET_MS = 4000;
const MAX_LISTED_EFFECTS = 200;
const MAX_CAPTURE_FILE = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const MAX_UNTRACKED_BYTES = 200 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 50_000;

export function effectContractsEnabled(env = process.env, settings = {}) {
  const raw = String(env.OASIS_EFFECT_CONTRACTS ?? '').trim();
  if (/^(0|false|off|no)$/i.test(raw)) return false;
  if (settings && settings.effectContracts === false) return false;
  return true;
}

function git(args, { cwd, env = {}, input, timeoutMs = GIT_TIMEOUT_MS, binary = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) { resolve({ code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: String(error && error.message || error) }); return; }
    const out = [];
    const err = [];
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: String(error && error.message || error) }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      resolve({ code: signal ? -1 : code, stdout: binary ? stdout : stdout.toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

const repoCache = new Map();

// The work tree that contains `root`, its index and object folder, and the
// workspace's path inside it. Cached per root; null outside a Git work tree.
export async function workTreeOf(root) {
  const key = path.resolve(root);
  if (repoCache.has(key)) return repoCache.get(key);
  const top = await git(['rev-parse', '--show-toplevel', '--git-path', 'index', '--git-path', 'objects'], { cwd: key });
  let info = null;
  if (top.code === 0) {
    const [toplevel, indexPath, objectsPath] = top.stdout.split('\n').map((line) => line.trim());
    if (toplevel) {
      info = {
        toplevel: path.resolve(toplevel),
        index: path.resolve(key, indexPath || '.git/index'),
        objects: path.resolve(key, objectsPath || '.git/objects'),
        prefix: path.relative(path.resolve(toplevel), key).split(path.sep).join('/')
      };
    }
  }
  repoCache.set(key, info);
  return info;
}

export function clearEffectRepoCache() { repoCache.clear(); }

// A private object store. Snapshot blobs are written here, never into the
// user's repository: the repository's own objects are read through Git's
// alternates mechanism, so tracked content is not copied. (Codex's removed
// ghost commits wrote into the user's object database; that is what bloated
// repositories and broke other Git clients.) Dispose it when done.
export async function createEffectStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-effects-'));
  await mkdir(path.join(dir, 'objects'), { recursive: true, mode: 0o700 });
  return { dir, objects: path.join(dir, 'objects'), index: path.join(dir, 'index') };
}

export async function disposeEffectStore(store) {
  if (store && store.dir) await rm(store.dir, { recursive: true, force: true }).catch(() => {});
}

function storeEnv(snapshotOrRepo, store) {
  return { GIT_OBJECT_DIRECTORY: store.objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: snapshotOrRepo.objects };
}

// Untracked files too large to snapshot (and how much they hold), so a model
// checkpoint or a dataset someone forgot to ignore is excluded, not hashed.
async function oversizedUntracked(repo, limit) {
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repo.toplevel });
  if (listed.code !== 0) return { excluded: [], total: 0, count: 0 };
  const excluded = [];
  let total = 0;
  let count = 0;
  for (const file of listed.stdout.split('\0')) {
    if (!file) continue;
    count++;
    const info = await lstat(path.join(repo.toplevel, file)).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (info.size > limit) excluded.push(file);
    else total += info.size;
  }
  return { excluded, total, count };
}

// A snapshot of every non-ignored file in the work tree, as a Git tree id in
// `store`. Never touches the user's index, HEAD, refs, stash or objects.
export async function snapshotWorkTree(root, { store, budgetMs = EFFECT_SNAPSHOT_BUDGET_MS, maxUntrackedBytes = MAX_UNTRACKED_BYTES, maxFileBytes = MAX_CAPTURE_FILE } = {}) {
  const started = Date.now();
  const repo = await workTreeOf(root);
  if (!repo) return { ok: false, reason: 'not a git work tree' };
  const owned = !store;
  if (owned) store = await createEffectStore();
  try {
    const big = await oversizedUntracked(repo, maxFileBytes);
    if (big.total > maxUntrackedBytes || big.count > MAX_UNTRACKED_FILES) return { ok: false, reason: 'untracked files are too large to snapshot (' + big.count + ' files, ' + Math.round(big.total / 1048576) + ' MB); add them to .gitignore', tooLarge: true };
    if (big.excluded.length > 200) return { ok: false, reason: 'too many large untracked files', tooLarge: true };
    // Seeding with the real index lets Git reuse its stat cache: only files
    // whose size or time changed are hashed again.
    await copyFile(repo.index, store.index).catch(() => {});
    const env = { GIT_INDEX_FILE: store.index, ...storeEnv(repo, store) };
    const pathspec = ['.', ...big.excluded.map((file) => ':(exclude,literal)' + file)];
    const add = await git(['add', '-A', '--ignore-errors', '--', ...pathspec], { cwd: repo.toplevel, env, timeoutMs: Math.max(budgetMs * 3, 5000) });
    if (add.code !== 0 && !/warning|error: open/i.test(add.stderr)) return { ok: false, reason: 'git add failed: ' + add.stderr.trim().slice(0, 200) };
    const tree = await git(['write-tree'], { cwd: repo.toplevel, env });
    const id = tree.stdout.trim();
    if (tree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(id)) return { ok: false, reason: 'git write-tree failed: ' + tree.stderr.trim().slice(0, 200) };
    const ms = Date.now() - started;
    return { ok: true, tree: id, toplevel: repo.toplevel, prefix: repo.prefix, objects: repo.objects, store: owned ? null : store, ownedStore: owned ? store : null, excluded: big.excluded, ms, overBudget: ms > budgetMs };
  } finally {
    await rm(store.index, { force: true }).catch(() => {});
  }
}

function snapshotEnv(...snapshots) {
  const stores = [...new Set(snapshots.filter(Boolean).map((snapshot) => snapshot.store || snapshot.ownedStore).filter(Boolean).map((store) => store.objects))];
  if (!stores.length) return {};
  return { GIT_OBJECT_DIRECTORY: stores[0], GIT_ALTERNATE_OBJECT_DIRECTORIES: [snapshots[0].objects, ...stores.slice(1)].join(path.delimiter) };
}

// Frees the private objects of a snapshot taken without an explicit store.
export async function disposeSnapshot(snapshot) {
  if (snapshot && snapshot.ownedStore) await disposeEffectStore(snapshot.ownedStore);
}

// Files that differ between two snapshots: [{ path, status }] with status
// added, modified, deleted or type_changed. Paths are relative to the
// workspace root when the root is a subfolder of the work tree.
export async function diffSnapshots(before, after) {
  if (!before || !after || !before.ok || !after.ok) return null;
  if (before.tree === after.tree) return [];
  const result = await git(['diff-tree', '-r', '--no-renames', '--name-status', '-z', before.tree, after.tree], { cwd: before.toplevel, env: snapshotEnv(after, before) });
  if (result.code !== 0) return null;
  const parts = result.stdout.split('\0').filter((part, index, all) => part !== '' || index < all.length - 1);
  const names = { A: 'added', M: 'modified', D: 'deleted', T: 'type_changed' };
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = names[parts[i][0]] || 'modified';
    let file = parts[i + 1];
    if (before.prefix) {
      if (!file.startsWith(before.prefix + '/')) { out.push({ path: path.posix.relative(before.prefix, file), status, outside: true }); continue; }
      file = file.slice(before.prefix.length + 1);
    }
    out.push({ path: file, status });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The shadow: what a command line says it will touch, before it runs.

const FORMATTERS = /^(?:prettier|eslint|black|ruff|isort|gofmt|goimports|rustfmt|clang-format|biome|dprint|stylua|shfmt|autopep8|yapf|standard|rubocop|swiftformat|ktlint)$/;
const FORMATTER_WRITE = /^(?:--write|-w|--fix|-i|--in-place|format|fmt|-a|--autocorrect|-A)$/;
const PACKAGE_MANAGERS = { npm: ['package.json', 'package-lock.json', 'node_modules/'], pnpm: ['package.json', 'pnpm-lock.yaml', 'node_modules/'], yarn: ['package.json', 'yarn.lock', 'node_modules/', '.yarn/'], bun: ['package.json', 'bun.lockb', 'bun.lock', 'node_modules/'], pip: [], pip3: [], uv: ['uv.lock', 'pyproject.toml', '.venv/'], poetry: ['poetry.lock', 'pyproject.toml'], cargo: ['Cargo.lock', 'Cargo.toml', 'target/'], go: ['go.mod', 'go.sum'], bundle: ['Gemfile.lock'], composer: ['composer.json', 'composer.lock', 'vendor/'] };
const PM_WRITES = /^(?:install|i|add|remove|rm|uninstall|update|upgrade|up|ci|sync|lock|get|tidy|mod|dedupe|prune|audit)$/;
const GIT_WRITES = /^(?:checkout|switch|restore|reset|stash|apply|am|merge|rebase|pull|cherry-pick|revert|clean|mv|rm|commit|init|clone|worktree|submodule)$/;
const PACKAGE_SCRIPT = /^(?:run|run-script|rum|urn|test|tst|t|start|restart|stop|rebuild|pack|prepare|exec|x|dlx|create|init)$/;
const PM_READS = /^(?:info|list|ls|why|outdated|view|show|config|bin|root|whoami|help|-v|--version|-h|--help|licenses|explain|audit|search|cache|store|env|dir)$/;
const BUILDERS = /^(?:make|cmake|ninja|tsc|webpack|vite|rollup|esbuild|gradle|gradlew|mvn|bazel|cargo|go|dotnet|swift|xcodebuild|next|nuxt)$/;

function unquote(word) { return String(word || '').replace(/^(['"])(.*)\1$/, '$2'); }
function operands(tokens) { return tokens.slice(1).filter((token) => !/^-/.test(token)).map(unquote); }

function redirectionTargets(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^(?:\d?>>?|&>>?|>\|)$/.test(token)) {
      if (tokens[i + 1] && !/^&\d$/.test(tokens[i + 1])) out.push(unquote(tokens[i + 1]));
      i++;
      continue;
    }
    const joined = /^(?:\d?>>?|&>>?|>\|)([^>|].*)$/.exec(token);
    if (joined && !/^&\d$/.test(joined[1])) out.push(unquote(joined[1]));
  }
  return out.filter((target) => target && !/^\/dev\//.test(target));
}

function stripRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (/^(?:\d?>>?|&>>?|>\||\d?<|<<<?)$/.test(tokens[i])) { i++; continue; }
    if (/^(?:\d?>>?|&>>?|>\||\d?<)./.test(tokens[i])) continue;
    out.push(tokens[i]);
  }
  return out;
}

// Prefix commands that run the rest of the line as another command.
function unwrap(tokens) {
  let rest = tokens;
  for (let guard = 0; guard < 6 && rest.length; guard++) {
    const head = path.basename(rest[0]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) { rest = rest.slice(1); continue; }
    if (['sudo', 'nice', 'nohup', 'time', 'command', 'exec', 'env', 'stdbuf', 'ionice'].includes(head)) { rest = rest.slice(1).filter((token, index) => index > 0 || !/^-/.test(token)); continue; }
    if (head === 'timeout') { rest = rest.slice(1).filter((token) => !/^-/.test(token)).slice(1); continue; }
    if (head === 'npx' || head === 'bunx' || (head === 'pnpm' && rest[1] === 'exec') || (head === 'yarn' && rest[1] === 'exec') || (head === 'uv' && rest[1] === 'run') || (head === 'poetry' && rest[1] === 'run')) {
      rest = rest.slice(head === 'npx' || head === 'bunx' ? 1 : 2).filter((token, index) => index > 0 || !/^-/.test(token));
      continue;
    }
    break;
  }
  return rest;
}

// Effects one simple command predicts: { paths, broad, reasons }.
export function predictCommandEffects(rawTokens) {
  const paths = new Set();
  const reasons = [];
  let broad = false;
  for (const target of redirectionTargets(rawTokens)) paths.add(target);
  const tokens = unwrap(stripRedirections(rawTokens.map(String)));
  if (!tokens.length) return { paths: [...paths], broad, reasons };
  const name = path.basename(tokens[0]);
  const args = operands(tokens);
  const flags = tokens.slice(1).filter((token) => /^-/.test(token));
  const add = (...items) => { for (const item of items) if (item) paths.add(item); };
  switch (name) {
    case 'rm': case 'rmdir': case 'unlink': case 'touch': case 'mkdir': case 'shred': case 'truncate':
      add(...args.filter((arg, index) => !(name === 'truncate' && index === 0 && flags.some((flag) => /^-s/.test(flag)))));
      break;
    case 'chmod': case 'chown': case 'chgrp':
      add(...args.slice(1));
      break;
    case 'mv':
      add(...args);
      break;
    case 'cp': case 'install': case 'ln': case 'rsync': {
      const target = flags.some((flag) => /^(?:-t|--target-directory)/.test(flag)) ? null : args.at(-1);
      add(target);
      if (args.length > 2 && target) add(target.replace(/\/?$/, '/'));
      break;
    }
    case 'tee':
      add(...args);
      break;
    case 'sed': case 'perl': case 'gsed':
      if (flags.some((flag) => /^-[a-zA-Z]*i|^--in-place/.test(flag))) add(...args.slice(1));
      else if (name === 'perl') { broad = true; reasons.push('perl runs a program that can write anywhere'); }
      break;
    case 'find': {
      // Start points come before the first expression word; -delete stays inside them,
      // -exec and friends run another program on every match.
      const expression = tokens.findIndex((token, index) => index > 0 && (/^-/.test(token) || ['(', '!', '\\('].includes(token)));
      const starts = (expression < 0 ? tokens.slice(1) : tokens.slice(1, expression)).map(unquote);
      const rest = expression < 0 ? [] : tokens.slice(expression);
      if (rest.some((token) => /^-(?:exec|execdir|ok|okdir)$/.test(token))) { broad = true; reasons.push('find -exec runs a command on every file it matches'); }
      else if (rest.some((token) => /^-(?:delete|fprint0?|fprintf|fls)$/.test(token))) add(...(starts.length ? starts : ['.']));
      break;
    }
    case 'xargs': {
      // The inner command's operands arrive on stdin, so its targets are unknown here.
      const inner = tokens.slice(1);
      while (inner.length && /^-/.test(inner[0])) inner.splice(0, /^-(?:[aEdILnPs]|-(?:arg-file|eof|delimiter|max-args|max-procs|max-chars|replace))$/.test(inner[0]) ? 2 : 1);
      if (inner.length) {
        const effect = predictCommandEffects(inner);
        if (effect.broad || effect.paths.length || /^(?:sed|gsed|perl|rm|mv|cp|chmod|chown|touch|truncate|tee|ln|install)$/.test(path.basename(inner[0]))) { broad = true; reasons.push('xargs runs ' + path.basename(inner[0]) + ' on files known only at run time'); }
      }
      break;
    }
    case 'patch': case 'git-apply':
      broad = true; reasons.push(name + ' changes the files named in the patch');
      break;
    case 'tar': case 'unzip': case 'gunzip': case 'bunzip2': case 'xz': case 'gzip': case '7z':
      broad = true; reasons.push(name + ' can write any number of files');
      break;
    case 'git': {
      const sub = tokens.slice(1).find((token) => !/^-/.test(token)) || '';
      if (GIT_WRITES.test(sub)) {
        const pathspec = tokens.indexOf('--');
        if (['checkout', 'restore', 'rm', 'mv'].includes(sub) && pathspec > 0) add(...tokens.slice(pathspec + 1).map(unquote));
        else if (sub !== 'commit') { broad = true; reasons.push('git ' + sub + ' can change any tracked file'); }
      }
      break;
    }
    default:
      if (FORMATTERS.test(name) && (flags.some((flag) => FORMATTER_WRITE.test(flag)) || args.some((arg) => FORMATTER_WRITE.test(arg)) || ['gofmt', 'goimports', 'rustfmt', 'shfmt'].includes(name) && flags.some((flag) => flag === '-w'))) {
        const files = args.filter((arg) => !FORMATTER_WRITE.test(arg));
        if (files.length && files.every((arg) => !/[*?]/.test(arg) && arg !== '.')) add(...files);
        else { broad = true; reasons.push(name + ' rewrites files in place'); }
      } else if (/^(?:npm|pnpm|yarn|bun)$/.test(name) && PACKAGE_SCRIPT.test(args[0] || '') || (/^(?:yarn|pnpm)$/.test(name) && args[0] && !PM_WRITES.test(args[0]) && !PM_READS.test(args[0]))) {
        broad = true; reasons.push(name + ' ' + (args[0] || '') + ' runs a package script');
      } else if (PACKAGE_MANAGERS[name] && args.some((arg) => PM_WRITES.test(arg))) {
        add(...PACKAGE_MANAGERS[name]);
        if (!PACKAGE_MANAGERS[name].length) { broad = true; reasons.push(name + ' installs packages'); }
      } else if (BUILDERS.test(name)) {
        broad = true; reasons.push(name + ' builds and may write output files');
      } else if (/^(?:python\d?(?:\.\d+)?|node|deno|bun|ruby|php|bash|sh|zsh|dash|fish|pwsh|powershell)$/.test(name) && !(name === 'bun' && PM_WRITES.test(args[0] || ''))) {
        broad = true; reasons.push(name + ' runs a program that can write anywhere');
      }
  }
  return { paths: [...paths], broad, reasons };
}

// Effects a whole shell line predicts. Unparsable or dynamic lines are broad.
export function predictShellEffects(line) {
  const parsed = parseShellCommands(String(line || ''));
  let commands;
  let broad = false;
  const reasons = [];
  if (parsed && !parsed.tooLarge) {
    commands = parsed.commands.map((command) => command.tokens);
    if (parsed.unparsable) { broad = true; reasons.push('the command line could not be fully parsed'); }
    if (parsed.commands.some((command) => command.computedName)) { broad = true; reasons.push('a command name is computed at run time'); }
  } else {
    try { commands = splitShell(String(line || '')).map((part) => part.tokens || []); } catch { commands = []; }
    if (!commands.length) { broad = true; reasons.push('the command line could not be parsed'); }
  }
  const paths = new Set();
  for (const tokens of commands) {
    const effect = predictCommandEffects(tokens);
    for (const item of effect.paths) paths.add(item);
    if (effect.broad) { broad = true; reasons.push(...effect.reasons); }
  }
  return { paths: [...paths], broad, reasons: [...new Set(reasons)] };
}

export function predictArgvEffects(command, args = []) {
  return predictCommandEffects([String(command || ''), ...(Array.isArray(args) ? args.map(String) : [])]);
}

// ---------------------------------------------------------------------------
// The contract: prediction against observation.

function normalizePredicted(item, cwdRel) {
  let value = String(item || '').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || value.startsWith('~') || value.includes('$')) return null;
  if (cwdRel) value = path.posix.join(cwdRel, value);
  return path.posix.normalize(value);
}

function covers(prediction, file) {
  if (prediction === '.' || prediction === '') return true;
  const dir = prediction.replace(/\/+$/, '');
  return file === dir || file.startsWith(dir + '/');
}

// observed: diffSnapshots() output. predicted: predict*Effects() output.
// Returns the contract record: what changed, what was predicted, what was not.
export function evaluateEffectContract({ predicted, observed, cwd = '', command = '', snapshot = null, ms = 0 }) {
  const cwdRel = String(cwd || '').replace(/^\.\/?/, '').replace(/\/+$/, '');
  const targets = (predicted && predicted.paths || []).map((item) => normalizePredicted(item, cwdRel)).filter(Boolean);
  const changed = Array.isArray(observed) ? observed : [];
  const unexpected = predicted && predicted.broad ? [] : changed.filter((entry) => !targets.some((target) => covers(target, entry.path)));
  const missing = targets.filter((target) => !/\/$/.test(target) && !changed.some((entry) => covers(target, entry.path)));
  const record = {
    command: String(command || '').slice(0, 300),
    predicted: { paths: targets.slice(0, MAX_LISTED_EFFECTS), broad: Boolean(predicted && predicted.broad), reasons: (predicted && predicted.reasons || []).slice(0, 8) },
    observed: changed.slice(0, MAX_LISTED_EFFECTS),
    observedCount: changed.length,
    unexpected: unexpected.slice(0, MAX_LISTED_EFFECTS),
    unexpectedCount: unexpected.length,
    missing: missing.slice(0, 50),
    held: unexpected.length === 0,
    snapshot: snapshot ? { before: snapshot.before, after: snapshot.after } : null,
    ms
  };
  return record;
}

// The short note the model reads with the command result.
export function effectNote(record) {
  if (!record) return '';
  if (!record.observedCount) return 'No workspace files changed.';
  const list = (items) => items.slice(0, 12).map((entry) => entry.path + ' (' + entry.status + ')').join(', ') + (items.length > 12 ? ', and ' + (items.length - 12) + ' more' : '');
  let text = 'Changed ' + record.observedCount + ' workspace file' + (record.observedCount === 1 ? '' : 's') + ': ' + list(record.observed) + '.';
  if (record.unexpectedCount) text += ' Not predicted from the command line: ' + list(record.unexpected) + '. Check these were intended.';
  text += ' /rewind can undo them.';
  return text;
}

// ---------------------------------------------------------------------------
// Recovery: content of a path in a snapshot, and compensation of one command.

export async function readFromSnapshot(snapshot, relative) {
  if (!snapshot || !snapshot.ok) return null;
  const full = snapshot.prefix ? snapshot.prefix + '/' + relative : relative;
  const spec = snapshot.tree + ':' + full;
  const type = await git(['cat-file', '-t', spec], { cwd: snapshot.toplevel, env: snapshotEnv(snapshot) });
  if (type.code !== 0) return { existed: false };
  if (type.stdout.trim() !== 'blob') return { existed: true, skipped: true };
  const size = await git(['cat-file', '-s', spec], { cwd: snapshot.toplevel, env: snapshotEnv(snapshot) });
  if (Number(size.stdout.trim()) > MAX_CAPTURE_FILE) return { existed: true, skipped: true };
  const mode = await git(['ls-tree', snapshot.tree, '--', full], { cwd: snapshot.toplevel, env: snapshotEnv(snapshot) });
  const content = await git(['cat-file', 'blob', spec], { cwd: snapshot.toplevel, env: snapshotEnv(snapshot), binary: true });
  if (content.code !== 0) return { existed: true, skipped: true };
  const octal = /^(\d{6})\s/.exec(mode.stdout);
  return { existed: true, content: content.stdout, mode: octal && octal[1] === '100755' ? 0o755 : 0o644, symlink: Boolean(octal && octal[1] === '120000') };
}

// Put the listed paths back as they were in `snapshot`. Added files are
// removed. Returns { restored, deleted, skipped }.
export async function restorePaths(root, snapshot, paths) {
  const restored = [];
  const deleted = [];
  const skipped = [];
  const base = path.resolve(root);
  for (const relative of paths) {
    const absolute = path.resolve(base, relative);
    if (absolute !== base && !absolute.startsWith(base + path.sep)) { skipped.push(relative); continue; }
    const before = await readFromSnapshot(snapshot, relative);
    if (!before || before.skipped || before.symlink) { skipped.push(relative); continue; }
    if (!before.existed) {
      try { await unlink(absolute); deleted.push(relative); } catch (error) { if (error.code === 'ENOENT') deleted.push(relative); else skipped.push(relative); }
      continue;
    }
    const info = await lstat(absolute).catch(() => null);
    if (info && info.isSymbolicLink()) { skipped.push(relative); continue; }
    await mkdir(path.dirname(absolute), { recursive: true });
    await atomicWriteFile(absolute, before.content, { encoding: null, mode: before.mode });
    restored.push(relative);
  }
  return { restored, deleted, skipped };
}

// ---------------------------------------------------------------------------
// Session-level observer used by the agent loop.

const activeByTree = new Map();

export function effectState(session) {
  if (!session.effectContracts) session.effectContracts = { disabled: false, reason: '', records: [], slow: 0 };
  return session.effectContracts;
}

// Called after authorization, before a command starts. Returns a handle for
// finishEffectObservation, or null when effects are not observed.
export async function beginEffectObservation(session, { name, args = {}, env = process.env } = {}) {
  if (!session || !session.root || !effectContractsEnabled(env, session.settings || {})) return null;
  if (args.run_in_background || args.interactive) return null;
  const state = effectState(session);
  if (state.disabled) return null;
  const store = await createEffectStore().catch(() => null);
  if (!store) return null;
  const before = await snapshotWorkTree(session.root, { store }).catch((error) => ({ ok: false, reason: String(error && error.message || error) }));
  if (!before.ok) {
    await disposeEffectStore(store);
    if (/not a git work tree/.test(before.reason)) { state.disabled = true; state.reason = before.reason; }
    else if (before.tooLarge) { state.disabled = true; state.reason = before.reason; }
    return null;
  }
  if (before.overBudget && ++state.slow >= 2) { state.disabled = true; state.reason = 'workspace snapshots took ' + before.ms + ' ms'; }
  const predicted = name === 'run_command' ? predictArgvEffects(args.command, args.args) : predictShellEffects(args.command);
  const key = before.toplevel;
  activeByTree.set(key, (activeByTree.get(key) || 0) + 1);
  return { name, args, before, store, predicted, key, started: Date.now(), concurrent: activeByTree.get(key) > 1 };
}

// Snapshots again, diffs, checks the contract and reads the pre-command
// content of every changed file (record.preimages), then frees the store.
export async function finishEffectObservation(session, handle) {
  if (!handle) return null;
  try {
    const after = await snapshotWorkTree(session.root, { store: handle.store }).catch(() => ({ ok: false }));
    const concurrent = handle.concurrent || (activeByTree.get(handle.key) || 0) > 1;
    const observed = await diffSnapshots(handle.before, after);
    if (observed === null) return null;
    const cwd = typeof handle.args.cwd === 'string' ? handle.args.cwd : '';
    const command = handle.name === 'run_command' ? [handle.args.command, ...(handle.args.args || [])].join(' ') : String(handle.args.command || '');
    const record = evaluateEffectContract({ predicted: handle.predicted, observed, cwd, command, snapshot: { before: handle.before.tree, after: after.tree }, ms: handle.before.ms + (after.ms || 0) });
    // Another command running in the same tree at the same time may have made
    // some of these changes; they are still real, but not attributable.
    if (concurrent) { record.concurrent = true; record.unexpected = []; record.unexpectedCount = 0; record.held = true; }
    record.preimages = [];
    for (const entry of observed) {
      if (entry.outside) continue;
      const before = await readFromSnapshot(handle.before, entry.path).catch(() => null);
      if (before) record.preimages.push({ path: entry.path, ...before });
    }
    const state = effectState(session);
    state.records.push({ at: new Date().toISOString(), command: record.command, observedCount: record.observedCount, unexpectedCount: record.unexpectedCount, before: handle.before.tree, after: after.tree });
    if (state.records.length > 100) state.records.splice(0, state.records.length - 100);
    return record;
  } finally {
    const count = (activeByTree.get(handle.key) || 1) - 1;
    if (count <= 0) activeByTree.delete(handle.key); else activeByTree.set(handle.key, count);
    await disposeEffectStore(handle.store);
  }
}

// Pre-command content of each changed file, for the turn's checkpoint.
export async function preimagesFor(record) {
  return record && Array.isArray(record.preimages) ? record.preimages : [];
}

// What the model and the result carry: compact, with the snapshot ids so a
// later step (or a person) can diff or restore against them.
export function publicEffects(record) {
  if (!record) return null;
  if (!record.observedCount) return { changed: 0, held: true };
  const label = (entry) => entry.path + ' (' + entry.status + ')';
  return {
    changed: record.observedCount,
    files: record.observed.slice(0, 30).map(label),
    ...(record.unexpectedCount ? { unexpected: record.unexpected.slice(0, 30).map(label) } : {}),
    held: record.held,
    ...(record.concurrent ? { concurrent: true } : {}),
    snapshot: record.snapshot,
    note: effectNote(record)
  };
}
