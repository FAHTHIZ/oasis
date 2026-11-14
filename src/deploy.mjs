// `oasis deploy`: publish a static site to GitHub Pages from the terminal.
// Builds the project when it has a build script, picks the output folder,
// commits it to the gh-pages branch from a scratch index (the working tree,
// staging area and current branch are left alone), pushes, and turns Pages on.
import { execFile, spawn } from 'node:child_process';
import { readFile, readdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { endChildInput } from './node-process.mjs';

const OUTPUT_DIRS = ['dist', 'build', 'out', '_site', 'public', 'site'];
const SKIP_DIRS = new Set(['.git', '.oasis', 'node_modules', '.github', '.vscode', '.idea']);
const SECRET = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.netrc|credentials(\.json)?)$/i;
const MAX_FILES = 20000;

function run(command, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || '').trim().split('\n').slice(-3).join(' ');
        reject(Object.assign(new Error(message || command + ' failed'), { code: error.code }));
      } else resolve(String(stdout).trim());
    });
    endChildInput(child, input);
  });
}

async function exists(file) { try { await lstat(file); return true; } catch { return false; } }

/** The folder to publish: an explicit one, a build output with index.html, or the project root. */
export async function findSiteDir(root, explicit = '') {
  if (explicit) {
    const dir = path.resolve(root, explicit);
    if (!(await exists(dir))) throw new Error('No folder ' + explicit + ' to deploy.');
    return dir;
  }
  for (const name of OUTPUT_DIRS) if (await exists(path.join(root, name, 'index.html'))) return path.join(root, name);
  if (await exists(path.join(root, 'index.html'))) return root;
  throw new Error('Found no index.html in ' + OUTPUT_DIRS.join(', ') + ' or the project root. Build the site first or pass the folder: oasis deploy DIR');
}

/**
 * Files to publish, relative to the site folder. Secrets, VCS and tool folders are
 * always left out; when the site is the project root, Git-ignored files are too.
 */
export async function siteFiles(dir, { gitIgnored = null } = {}) {
  const files = [];
  const skipped = [];
  async function walk(rel) {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(child); continue; }
      if (!entry.isFile()) continue;
      if (SECRET.test(entry.name)) { skipped.push(child); continue; }
      if (gitIgnored && gitIgnored.has(child)) continue;
      files.push(child);
      if (files.length > MAX_FILES) throw new Error('More than ' + MAX_FILES + ' files to deploy; pass the build output folder.');
    }
  }
  await walk('');
  return { files: files.sort(), skipped };
}

function parseRemote(url) {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(String(url || '').trim());
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** The address GitHub Pages serves a repository from. */
export function pagesUrl(owner, repo) {
  const user = owner.toLowerCase();
  return repo.toLowerCase() === user + '.github.io' ? 'https://' + user + '.github.io/' : 'https://' + user + '.github.io/' + repo + '/';
}

export function createDeployer({ cwd = process.cwd(), env = process.env, exec = run, log = (line) => process.stdout.write(line + '\n') } = {}) {
  const git = (args, options = {}) => exec('git', args, { cwd, env: options.env ? { ...env, ...options.env } : env, input: options.input });
  const gh = (args) => exec('gh', args, { cwd, env }).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('Turning on GitHub Pages uses the GitHub CLI. Install it from https://cli.github.com and run `gh auth login`, or enable Pages for the gh-pages branch in the repository settings.');
    throw error;
  });

  async function build(root) {
    let scripts = {};
    try { scripts = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).scripts || {}; } catch { return false; }
    if (!scripts.build) return false;
    log('Building with npm run build…');
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', 'build'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('npm run build exited with ' + code + '; fix the build or deploy an existing folder with --no-build.')));
    });
    return true;
  }

  async function deploy({ dir = '', branch = 'gh-pages', remote = 'origin', noBuild = false, dryRun = false, message = '', enablePages = true, now = new Date() } = {}) {
    const root = await git(['rev-parse', '--show-toplevel']).catch(() => { throw new Error('oasis deploy publishes through Git; run it inside a Git repository with a GitHub remote.'); });
    if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Invalid branch name ' + branch + '.');
    const remoteUrl = await git(['remote', 'get-url', remote]).catch(() => '');
    if (!remoteUrl) throw new Error('This repository has no ' + remote + ' remote. Add one with `gh repo create --source . --push` (private by default) or `git remote add origin URL`.');
    if (!dir && !noBuild && !dryRun) await build(root);
    const siteDir = await findSiteDir(root, dir);
    const relDir = path.relative(root, siteDir) || '.';
    let gitIgnored = null;
    if (siteDir === root) {
      const ignored = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory']).catch(() => '');
      gitIgnored = new Set();
      const ignoredDirs = [];
      for (const line of ignored.split('\n').filter(Boolean)) line.endsWith('/') ? ignoredDirs.push(line) : gitIgnored.add(line);
      gitIgnored.has = ((base) => (file) => base(file) || ignoredDirs.some((prefix) => file.startsWith(prefix)))(gitIgnored.has.bind(gitIgnored));
    }
    const { files, skipped } = await siteFiles(siteDir, { gitIgnored });
    if (!files.length) throw new Error('Nothing to deploy in ' + relDir + '.');
    if (skipped.length) log('Left out ' + skipped.length + ' secret-looking file' + (skipped.length === 1 ? '' : 's') + ': ' + skipped.slice(0, 5).join(', '));
    const target = parseRemote(remoteUrl);
    const url = target ? pagesUrl(target.owner, target.repo) : '';
    if (dryRun) return { dryRun: true, dir: relDir, files, skipped, branch, url };

    const gitDir = await git(['rev-parse', '--absolute-git-dir']);
    const scratch = { GIT_INDEX_FILE: path.join(gitDir, 'oasis-deploy-index-' + process.pid) };
    try {
      await rm(scratch.GIT_INDEX_FILE, { force: true });
      // Hash every file into the object store, then describe the tree in one batch.
      const absolute = files.map((file) => path.join(siteDir, file));
      const hashes = (await git(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: absolute.join('\n') + '\n' })).split('\n');
      const empty = await git(['hash-object', '-w', '--stdin'], { input: '' });
      const entries = files.map((file, index) => '100644 ' + hashes[index] + '\t' + file);
      if (!files.includes('.nojekyll')) entries.push('100644 ' + empty + '\t.nojekyll');
      await git(['update-index', '--add', '--index-info'], { env: scratch, input: entries.join('\n') + '\n' });
      const tree = await git(['write-tree'], { env: scratch });
      await git(['fetch', '-q', remote, '+refs/heads/' + branch + ':refs/remotes/' + remote + '/' + branch]).catch(() => '');
      const parent = await git(['rev-parse', '--verify', '-q', 'refs/remotes/' + remote + '/' + branch]).catch(() => '');
      if (parent && (await git(['rev-parse', parent + '^{tree}'])) === tree) {
        log('Already deployed: ' + branch + ' has these exact files.');
        return { unchanged: true, dir: relDir, files, branch, url, commit: parent };
      }
      const source = await git(['rev-parse', '--short', 'HEAD']).catch(() => '');
      const text = message || 'Deploy ' + relDir + (source ? ' from ' + source : '') + ' (' + now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC)';
      const commit = await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', text]);
      await git(['push', '-q', remote, commit + ':refs/heads/' + branch]);
      log('Pushed ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' from ' + relDir + ' to ' + branch + '.');
      let pages = url;
      if (enablePages && target) pages = await turnOnPages(target, branch).catch((error) => { log('Could not turn on GitHub Pages automatically: ' + error.message + '\nEnable it under Settings → Pages → Deploy from a branch → ' + branch + '.'); return url; });
      return { dir: relDir, files, skipped, branch, commit, url: pages };
    } finally {
      await rm(scratch.GIT_INDEX_FILE, { force: true });
    }
  }

  async function turnOnPages({ owner, repo }, branch) {
    const endpoint = 'repos/' + owner + '/' + repo + '/pages';
    let info = null;
    try { info = JSON.parse(await gh(['api', endpoint])); } catch {}
    if (!info) {
      try { info = JSON.parse(await gh(['api', '-X', 'POST', endpoint, '-f', 'source[branch]=' + branch, '-f', 'source[path]=/'])); }
      catch (error) {
        if (/plan|private|upgrade/i.test(error.message)) throw new Error('GitHub Pages for private repositories needs a paid plan; make the repository public or deploy elsewhere.');
        throw error;
      }
      log('Turned on GitHub Pages for the ' + branch + ' branch. The first build takes a minute or two.');
    } else if (info.source && info.source.branch && info.source.branch !== branch) {
      await gh(['api', '-X', 'PUT', endpoint, '-f', 'source[branch]=' + branch, '-f', 'source[path]=/']);
      log('Pointed GitHub Pages at the ' + branch + ' branch.');
    }
    return (info && info.html_url) || pagesUrl(owner, repo);
  }

  return { deploy, turnOnPages };
}

export async function deployCommand(args, { cwd = process.cwd(), env = process.env, stdout = process.stdout, deployer = createDeployer({ cwd, env, log: (line) => stdout.write(line + '\n') }) } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write([
      'Usage: oasis deploy [DIR] [--no-build] [--dry-run] [--branch NAME] [--message TEXT]',
      '',
      'Publish a static site to GitHub Pages. Runs `npm run build` when package.json has one, then',
      'publishes DIR (or the first of ' + OUTPUT_DIRS.join(', ') + ' with an index.html, or the project',
      'root) to the gh-pages branch and turns Pages on with the GitHub CLI. Your branch, working tree',
      'and staging area are not touched. Secret-looking files (.env, keys) are never published.',
      ''
    ].join('\n'));
    return 0;
  }
  const options = { dir: '' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-build') options.noBuild = true;
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--no-pages') options.enablePages = false;
    else if (arg === '--branch') options.branch = args[++i];
    else if (arg.startsWith('--branch=')) options.branch = arg.slice(9);
    else if (arg === '--message' || arg === '-m') options.message = args[++i];
    else if (arg.startsWith('-')) throw new Error('Unknown option ' + arg + '. See oasis deploy --help.');
    else options.dir = arg;
  }
  const result = await deployer.deploy(options);
  if (result.dryRun) {
    stdout.write('Would publish ' + result.files.length + ' file' + (result.files.length === 1 ? '' : 's') + ' from ' + result.dir + ' to ' + result.branch + (result.url ? ', served at ' + result.url : '') + ':\n' + result.files.slice(0, 40).map((file) => '  ' + file).join('\n') + (result.files.length > 40 ? '\n  … ' + (result.files.length - 40) + ' more' : '') + '\n');
    return 0;
  }
  if (result.url) stdout.write('Live at ' + result.url + (result.unchanged ? '' : ' (GitHub Pages can take a minute to update)') + '\n');
  return 0;
}
