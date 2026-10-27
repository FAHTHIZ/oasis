import { readdir, readFile, writeFile, mkdir, unlink, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { snapshotFile } from './backups.mjs';
import { planPackageInstall, normalizePackageName } from './installer.mjs';

const MAX_TEXT_FILE = 256 * 1024;
const MAX_TOOL_OUTPUT = 24 * 1024;
const BUNDLED_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.venv', 'venv', 'vendor', 'target']);
const SHELLS_AND_DANGEROUS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ash', 'cmd', 'powershell', 'pwsh',
  'sudo', 'su', 'rm', 'rmdir', 'del', 'format', 'mkfs', 'dd', 'shutdown',
  'reboot', 'poweroff', 'diskpart', 'mount', 'umount', 'chmod', 'chown'
]);

export const TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'list_files', description: 'List workspace files and folders. Paths are relative to the workspace root. Skips dependencies, build output, Git internals, and secret files.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to the workspace root; default .' }, includeHidden: { type: 'boolean', description: 'Include ordinary hidden files, still excluding secret files' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file inside the workspace. Use offset and limit to inspect line ranges in larger files. Secret files such as .env and private keys are blocked.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path' }, offset: { type: 'integer', description: 'Optional 1-based first line to return' }, limit: { type: 'integer', description: 'Optional maximum lines to return, 1 to 2000' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'glob_files', description: 'Find workspace files by glob pattern such as src/**/*.mjs or **/*.test.js. Supports **, *, and ?. Skips dependencies, Git internals, and sensitive files.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Workspace-relative glob pattern; cannot contain ..' }, limit: { type: 'integer', description: 'Maximum paths to return, 1 to 500; defaults to 200' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'search_files', description: 'Search workspace text files for a literal case-insensitive string. Returns matching lines and paths, excluding secret files and dependency/build directories.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Literal phrase or symbol to search for' }, limit: { type: 'integer', description: 'Maximum matching lines, 1 to 60; defaults to 25' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace a text file inside the workspace. Existing file contents are snapshotted first for later recovery. Never use this for secrets or files outside the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path' }, content: { type: 'string', description: 'Complete new text contents' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete one file inside the workspace. Requires explicit interactive approval even in auto mode. Directories and sensitive files cannot be deleted with this tool.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a single executable with an argv array in the workspace, with no shell expansion. Requires approval unless the user explicitly enabled --yes. Destructive executables and shell interpreters are blocked.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'One executable name or path, such as npm or git' }, args: { type: 'array', items: { type: 'string' }, description: 'Argument array, for example ["test"]' }, timeoutSeconds: { type: 'integer', description: 'Timeout from 5 to 600 seconds; defaults to 120' } }, required: ['command', 'args'] } } },
  { type: 'function', function: { name: 'install_package', description: 'Install one requested package or developer tool using a detected package manager. Accepts auto, npm, npm-global, pip, pipx, system, cargo, or go ecosystems. Installation requires approval unless --yes was explicitly enabled.', parameters: { type: 'object', properties: { packageName: { type: 'string', description: 'A single package identifier, not a URL or shell command' }, ecosystem: { type: 'string', enum: ['auto', 'npm', 'npm-global', 'pip', 'pipx', 'system', 'cargo', 'go'], description: 'Package ecosystem; auto chooses based on known tools and the project' } }, required: ['packageName'] } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch public HTTP or HTTPS documentation as text. Private/local network addresses, credentials, redirects, and large responses are blocked.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Public documentation URL using HTTP or HTTPS' } }, required: ['url'] } } },

  { type: 'function', function: { name: 'edit_file', description: 'Make a precise edit to an existing text file by replacing an exact string. Prefer this over write_file for existing files. old_string must match exactly and be unique unless replace_all is true. The previous contents are snapshotted first.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path of an existing file' }, old_string: { type: 'string', description: 'Exact existing text to replace; must be non-empty' }, new_string: { type: 'string', description: 'Replacement text' }, replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'list_skills', description: 'List available built-in and workspace skill names with one-line descriptions. Skills are loaded on demand to keep the main context compact.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'load_skill', description: 'Load the full instructions for one named built-in or workspace skill. Use this before work that matches the skill description.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name returned by list_skills' } }, required: ['name'] } } }
];

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function sensitivePath(relative) {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    const name = part.toLowerCase();
    if (['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker'].includes(name)) return true;
    if (/^\.env(?:$|\.)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) return true;
    if (['.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml'].includes(name)) return true;
    if (/^(?:id_rsa|id_ed25519|id_ecdsa|known_hosts|authorized_keys)$/i.test(name)) return true;
    if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return true;
  }
  return false;
}

export async function resolveWorkspacePath(root, rawPath, options = {}) {
  const rootReal = await realpath(root);
  const input = String(rawPath || '.');
  if (input.includes('\0')) throw new Error('Invalid path.');
  const target = path.resolve(rootReal, input);
  if (!inside(rootReal, target) || target === path.parse(rootReal).root) throw new Error('That path is outside the workspace.');
  const relative = path.relative(rootReal, target);
  if (!options.allowSensitive && sensitivePath(relative)) throw new Error('That file path looks sensitive. Oasis will not read, overwrite, or delete it.');
  let cursor = target;
  while (true) {
    try {
      const linkInfo = await lstat(cursor);
      if (cursor === target && options.rejectSymlinks && linkInfo.isSymbolicLink()) throw new Error('Oasis will not write to or delete a symbolic link.');
      const resolved = await realpath(cursor);
      if (!inside(rootReal, resolved)) throw new Error('That path resolves outside the workspace through a symbolic link.');
      const resolvedRelative = path.relative(rootReal, resolved);
      if (!options.allowSensitive && sensitivePath(resolvedRelative)) throw new Error('That symbolic link resolves to a sensitive file. Oasis will not access it.');
      if (cursor === target) return { absolute: target, real: resolved, relative: relative || '.', root: rootReal };
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('Could not resolve a safe workspace path.');
      cursor = parent;
    }
  }
  const existingAncestor = await realpath(cursor);
  if (!inside(rootReal, existingAncestor)) throw new Error('That path resolves outside the workspace through a symbolic link.');
  return { absolute: target, real: target, relative: relative || '.', root: rootReal };
}

function shouldSkip(entry, includeHidden) {
  if (entry.isSymbolicLink()) return true;
  if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) return true;
  if (!includeHidden && entry.name.startsWith('.')) return true;
  return false;
}

async function walkFiles(root, options = {}) {
  const includeHidden = Boolean(options.includeHidden);
  const maxFiles = options.maxFiles || 1200;
  const maxDepth = options.maxDepth || 9;
  const output = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || output.length >= maxFiles) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= maxFiles) break;
      if (shouldSkip(entry, includeHidden)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (sensitivePath(rel)) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) output.push({ absolute: full, relative: rel });
    }
  }
  await walk(root, 0);
  return output;
}

export async function listWorkspaceFiles(root, options = {}) {
  const target = await resolveWorkspacePath(root, options.path || '.', { allowSensitive: false });
  const info = await stat(target.absolute);
  if (!info.isDirectory()) return { path: target.relative, files: [target.relative] };
  const files = await walkFiles(target.absolute, { includeHidden: options.includeHidden, maxFiles: 500, maxDepth: 8 });
  const rel = files.map((item) => path.posix.join(target.relative === '.' ? '' : target.relative.split(path.sep).join('/'), item.relative.split(path.sep).join('/'))).filter(Boolean);
  return { path: target.relative, files: rel, truncated: files.length >= 500 };
}

const MAX_RANGED_FILE = 4 * 1024 * 1024;

export async function readWorkspaceFile(root, rawPath, options = {}) {
  const target = await resolveWorkspacePath(root, rawPath);
  const info = await stat(target.absolute);
  if (!info.isFile()) throw new Error('That path is not a file.');
  const ranged = options.offset !== undefined || options.limit !== undefined;
  if (!ranged && info.size > MAX_TEXT_FILE) throw new Error('File is larger than the 256 KiB text limit. Pass offset and limit to read part of it, or use a narrower search.');
  if (ranged && info.size > MAX_RANGED_FILE) throw new Error('File is larger than the 4 MiB limit even for ranged reads.');
  const content = await readFile(target.absolute, 'utf8');
  if (content.includes('\0')) throw new Error('This looks like a binary file and is not supported by read_file.');
  const relativePath = target.relative.split(path.sep).join('/');
  if (!ranged) return { path: relativePath, content };
  const lines = content.split('\n');
  const startLine = Math.max(1, Number.parseInt(options.offset, 10) || 1);
  const count = Math.max(1, Math.min(2000, Number.parseInt(options.limit, 10) || 2000));
  const slice = lines.slice(startLine - 1, startLine - 1 + count);
  let text = slice.join('\n');
  let truncated = false;
  if (text.length > MAX_TEXT_FILE) { text = text.slice(0, MAX_TEXT_FILE); truncated = true; }
  return {
    path: relativePath,
    content: text,
    startLine,
    endLine: startLine + slice.length - 1,
    totalLines: lines.length,
    truncated: truncated || startLine - 1 + count < lines.length
  };
}


function globToRegExp(pattern) {
  let source = '';
  const text = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '*') {
      if (text[i + 1] === '*') {
        i++;
        if (text[i + 1] === '/') { i++; source += '(?:.*/)?'; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (".+^$(){}|[]\\".includes(char)) source += "\\" + char;
    else source += char;
  }
  return new RegExp('^' + source + '
  const needle = String(query || '');
  if (!needle.trim()) throw new Error('Search query cannot be empty.');
  if (needle.length > 500) throw new Error('Search query is too long.');
  const maxResults = Math.max(1, Math.min(60, Number.parseInt(limit, 10) || 25));
  const files = await walkFiles(await realpath(root), { includeHidden: true, maxFiles: 1800, maxDepth: 10 });
  const matches = [];
  for (const file of files) {
    let info;
    try { info = await stat(file.absolute); } catch { continue; }
    if (info.size > 256 * 1024) continue;
    let content;
    try { content = await readFile(file.absolute, 'utf8'); } catch { continue; }
    if (content.includes('\0')) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle.toLowerCase())) {
        matches.push({ path: file.relative.split(path.sep).join('/'), line: i + 1, text: lines[i].slice(0, 400) });
        if (matches.length >= maxResults) return { query: needle, matches, truncated: true };
      }
    }
  }
  return { query: needle, matches, truncated: false };
}

function scrubEnvironment(source = process.env) {
  const allow = new Set(String(source.OASIS_COMMAND_ENV_ALLOWLIST || '').split(',').map((item) => item.trim()).filter(Boolean));
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION|GITHUB_TOKEN|GH_TOKEN)/i.test(key) && !allow.has(key)) continue;
    if (key === 'OASIS_COMMAND_ENV_ALLOWLIST') continue;
    env[key] = value;
  }
  return env;
}

function commandSafety(command, args) {
  const base = path.basename(String(command)).toLowerCase().replace(/\.exe$/, '').replace(/\.cmd$/, '');
  if (!/^[a-zA-Z0-9_./:\\-]+$/.test(String(command))) return 'Command must be one executable path; shell syntax is not accepted.';
  if (SHELLS_AND_DANGEROUS.has(base)) return 'This executable is blocked by Oasis safety policy: ' + base + '. Use a narrow supported tool instead.';
  const joined = args.join(' ').toLowerCase();
  const destructiveGit = base === 'git' && ((args[0] === 'reset' && args.includes('--hard')) || (args[0] === 'clean' && args.some((a) => a.startsWith('-') && a.includes('f'))) || (args[0] === 'push' && args.some((a) => a.includes('force'))));
  if (destructiveGit) return 'This destructive Git command is blocked by default.';
  if ((base === 'npm' && args[0] === 'publish') || (base === 'gh' && args[0] === 'repo' && args[1] === 'delete')) return 'Publishing or deleting a remote repository is blocked by default.';
  if (joined.includes('rm -rf') || joined.includes('format c:')) return 'The command contains a destructive operation and is blocked.';
  if (base === 'apt' || base === 'apt-get' || base === 'dnf' || base === 'pacman' || base === 'brew' || base === 'winget') {
    if (/\b(remove|purge|uninstall)\b/.test(joined)) return 'Package removal through the general command tool is blocked. Use an explicit package-manager action and review it first.';
  }
  return null;
}

export async function runWorkspaceCommand(root, command, args = [], options = {}) {
  if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || arg.length > 5000 || arg.includes('\0'))) {
    throw new Error('Command arguments must be an array of short strings.');
  }
  const denied = commandSafety(command, args);
  if (denied) throw new Error(denied);
  const timeoutSeconds = Math.max(5, Math.min(600, Number.parseInt(options.timeoutSeconds, 10) || 120));
  const approval = options.approval;
  if (!options.autoApprove) {
    const ok = approval && await approval('Run this command in the workspace?\n  ' + command + ' ' + args.map((arg) => JSON.stringify(arg)).join(' ') + '\nCommands can change project files or execute project scripts. Oasis strips common secret environment variables from the child process.');
    if (!ok) return { approved: false, command, args, message: 'Command was not approved. No process was started.' };
  }
  const env = scrubEnvironment(options.env || process.env);
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (target, chunk) => {
      if (target === 'stdout') stdout = (stdout + chunk.toString()).slice(-MAX_TOOL_OUTPUT);
      else stderr = (stderr + chunk.toString()).slice(-MAX_TOOL_OUTPUT);
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ command, exitCode: null, stdout, stderr, error: error.message, timedOut });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ command, exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}

async function runInstallPlan(plan, options) {
  if (!options.autoApprove) {
    const ok = options.approval && await options.approval(
      'Install package ' + plan.packageName + ' using ' + plan.command + ' ' + plan.args.map((arg) => JSON.stringify(arg)).join(' ') +
      '\n' + plan.note + '\nThis changes your environment and may execute third-party installer scripts.'
    );
    if (!ok) return { approved: false, plan, message: 'Installation was not approved. Nothing was installed.' };
  }
  const env = scrubEnvironment(options.env || process.env);
  return await new Promise((resolve) => {
    let settled = false;
    const child = spawn(plan.command, plan.args, { cwd: options.root, env, shell: false, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 20 * 60 * 1000);
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ approved: true, plan, exitCode: null, error: error.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ approved: true, plan, exitCode: code, signal });
    });
  });
}

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] >= 224) || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
}
function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.');
  }
  return true;
}
async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Provide a valid public URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links can be fetched.');
  if (url.username || url.password) throw new Error('URLs containing credentials are blocked.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') throw new Error('Local and metadata URLs are blocked.');
  const ip = isIP(host);
  if (ip && isPrivateAddress(host)) throw new Error('Private-network addresses are blocked.');
  if (!ip) {
    let records;
    try { records = await lookup(host, { all: true, verbatim: true }); } catch { throw new Error('Could not resolve this public hostname.'); }
    if (!records.length || records.some((record) => isPrivateAddress(record.address))) throw new Error('This hostname resolves to a private or reserved address and is blocked.');
  }
  return url;
}

async function fetchPublicUrl(raw) {
  const url = await validatePublicUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'OasisOSS/0.2 (+https://github.com/gtxnrg-ship-it/Oasis)', accept: 'text/plain,text/html,application/json,text/markdown,*/*;q=0.2' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      return { url: url.toString(), status: response.status, redirect: location ? new URL(location, url).toString() : null, message: 'Redirects are not followed automatically. Validate and fetch the destination separately if appropriate.' };
    }
    const type = response.headers.get('content-type') || '';
    if (!response.ok) return { url: url.toString(), status: response.status, error: 'The server returned an unsuccessful status.' };
    if (!/(text\/|application\/json|application\/xml|application\/xhtml\+xml)/i.test(type)) return { url: url.toString(), status: response.status, contentType: type, error: 'The response is not an accepted text content type.' };
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > 1024 * 1024) return { url: url.toString(), error: 'Response exceeds the 1 MiB limit.' };
    const text = await response.text();
    if (text.length > 1024 * 1024) return { url: url.toString(), error: 'Response exceeds the 1 MiB limit.' };
    let content = text;
    if (/text\/html|application\/xhtml\+xml/i.test(type)) {
      content = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
    }
    return { url: url.toString(), status: response.status, contentType: type, content: content.slice(0, MAX_TOOL_OUTPUT), truncated: content.length > MAX_TOOL_OUTPUT };
  } finally { clearTimeout(timer); }
}


function parseSkillMetadata(content, fallbackName) {
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = front ? front[1] : '';
  const read = (key) => {
    const match = metadata.match(new RegExp('^' + key + ':\\s*(.+)$', 'mi'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const rawName = read('name') || fallbackName;
  const name = /^[a-z][a-z0-9-]{0,63}$/i.test(rawName) ? rawName : fallbackName;
  const description = (read('description') || 'Workflow instructions for ' + name + '.').slice(0, 320);
  return { name, description };
}

export async function listAvailableSkills(root) {
  const byName = new Map();
  async function scan(directory, source, relativePrefix = '') {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink()).slice(0, 80)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name, 'SKILL.md');
      try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) continue;
        const content = await readFile(filePath, 'utf8');
        if (content.includes('\0')) continue;
        const meta = parseSkillMetadata(content, entry.name);
        const skill = {
          name: meta.name,
          description: meta.description,
          source,
          relativePath: source === 'workspace' ? path.posix.join('.oasis', 'skills', entry.name, 'SKILL.md') : entry.name
        };
        byName.set(meta.name.toLowerCase(), skill);
      } catch { /* Ignore incomplete or unsafe skill files. */ }
    }
  }
  await scan(BUNDLED_SKILLS_DIR, 'built-in');
  await scan(path.join(root, '.oasis', 'skills'), 'workspace');
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
}

export async function loadSkillText(root, rawName) {
  const name = String(rawName || '');
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(name)) throw new Error('Skill names must be a short identifier.');
  const skills = await listAvailableSkills(root);
  const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!skill) throw new Error('No skill named "' + name + '" is available. Call list_skills to inspect valid names.');
  let content;
  if (skill.source === 'workspace') {
    content = (await readWorkspaceFile(root, skill.relativePath)).content;
  } else {
    const target = path.resolve(BUNDLED_SKILLS_DIR, skill.relativePath, 'SKILL.md');
    if (!inside(BUNDLED_SKILLS_DIR, target)) throw new Error('Skill path is outside the bundled skill directory.');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw new Error('Bundled skill file is not a safe regular text file.');
    content = await readFile(target, 'utf8');
  }
  if (content.includes('\0')) throw new Error('Skill content is not valid text.');
  return { name: skill.name, source: skill.source, content: content.slice(0, 24000), truncated: content.length > 24000 };
}

export async function loadSkillDescriptions(root) {
  const skills = await listAvailableSkills(root);
  if (!skills.length) return '';
  return skills.map((item) => '- ' + item.name + ' [' + item.source + ']: ' + item.description).join('\n').slice(0, 12000);
}

export async function executeTool(name, args = {}, context = {}) {
  const root = path.resolve(context.root || process.cwd());
  switch (name) {
    case 'list_files':
      return await listWorkspaceFiles(root, { path: args.path || '.', includeHidden: Boolean(args.includeHidden) });
    case 'read_file':
      return await readWorkspaceFile(root, args.path, { offset: args.offset, limit: args.limit });
    case 'glob_files':
      return await globWorkspaceFiles(root, args.pattern, args.limit);
    case 'search_files':
      return await searchWorkspaceFiles(root, args.query, args.limit);
    case 'list_skills':
      return { skills: await listAvailableSkills(root) };
    case 'load_skill':
      return await loadSkillText(root, args.name);
    case 'edit_file': {
      if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') throw new Error('old_string and new_string must be strings.');
      if (!args.old_string.length) throw new Error('old_string must not be empty. To create a new file, use write_file.');
      if (args.old_string === args.new_string) throw new Error('old_string and new_string are identical; nothing to change.');
      if (Buffer.byteLength(args.old_string, 'utf8') > MAX_TEXT_FILE || Buffer.byteLength(args.new_string, 'utf8') > MAX_TEXT_FILE) throw new Error('The edit exceeds the 256 KiB text limit.');
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      let info;
      try { info = await lstat(target.absolute); } catch (error) {
        if (error.code === 'ENOENT') throw new Error('That file does not exist. Use write_file to create it.');
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('That path is not a regular file.');
      if (info.size > MAX_TEXT_FILE) throw new Error('File is larger than the 256 KiB text limit for edits.');
      const current = await readFile(target.absolute, 'utf8');
      if (current.includes('\0')) throw new Error('This looks like a binary file; edit_file only supports text.');
      let matches = 0, offset = 0;
      while ((offset = current.indexOf(args.old_string, offset)) >= 0) { matches++; offset += args.old_string.length; }
      if (!matches) throw new Error('old_string was not found. It must match the file exactly, including whitespace and indentation. Re-read the file and try again.');
      if (matches > 1 && args.replace_all !== true) throw new Error('old_string appears ' + matches + ' times. Add more surrounding context to make it unique, or set replace_all=true.');
      const next = args.replace_all === true ? current.split(args.old_string).join(args.new_string) : current.replace(args.old_string, () => args.new_string);
      if (Buffer.byteLength(next, 'utf8') > MAX_TEXT_FILE) throw new Error('The edited file would exceed the 256 KiB limit.');
      if (next === current) return { path: target.relative.split(path.sep).join('/'), changed: false, message: 'The replacement produced no changes.' };
      await snapshotFile(root, target.absolute, 'before-agent-edit');
      await writeFile(target.absolute, next, { encoding: 'utf8' });
      return { path: target.relative.split(path.sep).join('/'), changed: true, replacements: args.replace_all === true ? matches : 1, beforeBytes: Buffer.byteLength(current, 'utf8'), afterBytes: Buffer.byteLength(next, 'utf8'), backupCreated: true };
    }
    case 'write_file': {
      if (typeof args.content !== 'string') throw new Error('File contents must be a string.');
      if (Buffer.byteLength(args.content, 'utf8') > MAX_TEXT_FILE) throw new Error('New file content exceeds the 256 KiB limit.');
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      let backedUpExistingFile = false;
      try {
        const old = await lstat(target.absolute);
        if (old.isDirectory()) throw new Error('Refusing to replace a directory with a file.');
        await snapshotFile(root, target.absolute, 'before-agent-write');
        backedUpExistingFile = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, args.content, { encoding: 'utf8', mode: 0o600 });
      return { path: target.relative.split(path.sep).join('/'), writtenBytes: Buffer.byteLength(args.content, 'utf8'), backedUpExistingFile };
    }
    case 'delete_file': {
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      const info = await lstat(target.absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only regular files can be deleted with this tool.');
      if (!context.approval || !(await context.approval('Delete the workspace file ' + target.relative + '? Its current contents will be backed up first.'))) {
        return { approved: false, path: target.relative, message: 'Deletion was not approved. No file was removed.' };
      }
      await snapshotFile(root, target.absolute, 'before-agent-delete');
      await unlink(target.absolute);
      return { path: target.relative, deleted: true, backupCreated: true };
    }
    case 'run_command':
      return await runWorkspaceCommand(root, args.command, args.args || [], {
        approval: context.approval,
        autoApprove: Boolean(context.autoApprove),
        timeoutSeconds: Math.min(args.timeoutSeconds || context.maxCommandSeconds || 120, context.maxCommandSeconds || 600),
        env: context.env || process.env
      });
    case 'install_package': {
      const name = normalizePackageName(args.packageName);
      const plan = planPackageInstall({ packageName: name, ecosystem: args.ecosystem || 'auto', workspaceRoot: root, env: context.env || process.env });
      return await runInstallPlan(plan, { root, approval: context.approval, autoApprove: Boolean(context.autoApprove), env: context.env || process.env });
    }
    case 'fetch_url':
      return await fetchPublicUrl(args.url);
    default:
      throw new Error('Unknown or unavailable tool: ' + name);
  }
}

export async function loadProjectInstructions(root) {
  const names = ['OASIS.md', 'AGENTS.md', 'CLAUDE.md', 'README.md'];
  const parts = [];
  for (const name of names) {
    try {
      const result = await readWorkspaceFile(root, name);
      if (result.content.trim()) parts.push('--- Project context: ' + name + ' ---\n' + result.content.slice(0, 9000));
    } catch {}
  }
  // Skill instructions are deliberately not loaded here. The model receives only a
  // compact name/description catalogue and calls load_skill when one is relevant.
  return parts.join('\n\n').slice(0, 26000);
}

export function toolCount() {
  return TOOL_DEFINITIONS.length;
}
);
}

export async function globWorkspaceFiles(root, pattern, limit = 200) {
  const text = String(pattern || '').trim();
  if (!text) throw new Error('Glob pattern cannot be empty.');
  if (text.length > 300) throw new Error('Glob pattern is too long.');
  if (text.includes('\0') || path.isAbsolute(text) || text.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob patterns must be relative to the workspace and cannot contain "..".');
  }
  const maxResults = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 200));
  const matcher = globToRegExp(text);
  const files = await walkFiles(await realpath(root), { includeHidden: true, maxFiles: 5000, maxDepth: 12 });
  const matches = [];
  for (const file of files) {
    const relative = file.relative.split(path.sep).join('/');
    if (!matcher.test(relative)) continue;
    matches.push(relative);
    if (matches.length >= maxResults) return { pattern: text, matches, truncated: true };
  }
  return { pattern: text, matches, truncated: files.length >= 5000 };
}

export async function searchWorkspaceFiles(root, query, limit = 25) {
  const needle = String(query || '');
  if (!needle.trim()) throw new Error('Search query cannot be empty.');
  if (needle.length > 500) throw new Error('Search query is too long.');
  const maxResults = Math.max(1, Math.min(60, Number.parseInt(limit, 10) || 25));
  const files = await walkFiles(await realpath(root), { includeHidden: true, maxFiles: 1800, maxDepth: 10 });
  const matches = [];
  for (const file of files) {
    let info;
    try { info = await stat(file.absolute); } catch { continue; }
    if (info.size > 256 * 1024) continue;
    let content;
    try { content = await readFile(file.absolute, 'utf8'); } catch { continue; }
    if (content.includes('\0')) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle.toLowerCase())) {
        matches.push({ path: file.relative.split(path.sep).join('/'), line: i + 1, text: lines[i].slice(0, 400) });
        if (matches.length >= maxResults) return { query: needle, matches, truncated: true };
      }
    }
  }
  return { query: needle, matches, truncated: false };
}

function scrubEnvironment(source = process.env) {
  const allow = new Set(String(source.OASIS_COMMAND_ENV_ALLOWLIST || '').split(',').map((item) => item.trim()).filter(Boolean));
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION|GITHUB_TOKEN|GH_TOKEN)/i.test(key) && !allow.has(key)) continue;
    if (key === 'OASIS_COMMAND_ENV_ALLOWLIST') continue;
    env[key] = value;
  }
  return env;
}

function commandSafety(command, args) {
  const base = path.basename(String(command)).toLowerCase().replace(/\.exe$/, '').replace(/\.cmd$/, '');
  if (!/^[a-zA-Z0-9_./:\\-]+$/.test(String(command))) return 'Command must be one executable path; shell syntax is not accepted.';
  if (SHELLS_AND_DANGEROUS.has(base)) return 'This executable is blocked by Oasis safety policy: ' + base + '. Use a narrow supported tool instead.';
  const joined = args.join(' ').toLowerCase();
  const destructiveGit = base === 'git' && ((args[0] === 'reset' && args.includes('--hard')) || (args[0] === 'clean' && args.some((a) => a.startsWith('-') && a.includes('f'))) || (args[0] === 'push' && args.some((a) => a.includes('force'))));
  if (destructiveGit) return 'This destructive Git command is blocked by default.';
  if ((base === 'npm' && args[0] === 'publish') || (base === 'gh' && args[0] === 'repo' && args[1] === 'delete')) return 'Publishing or deleting a remote repository is blocked by default.';
  if (joined.includes('rm -rf') || joined.includes('format c:')) return 'The command contains a destructive operation and is blocked.';
  if (base === 'apt' || base === 'apt-get' || base === 'dnf' || base === 'pacman' || base === 'brew' || base === 'winget') {
    if (/\b(remove|purge|uninstall)\b/.test(joined)) return 'Package removal through the general command tool is blocked. Use an explicit package-manager action and review it first.';
  }
  return null;
}

export async function runWorkspaceCommand(root, command, args = [], options = {}) {
  if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || arg.length > 5000 || arg.includes('\0'))) {
    throw new Error('Command arguments must be an array of short strings.');
  }
  const denied = commandSafety(command, args);
  if (denied) throw new Error(denied);
  const timeoutSeconds = Math.max(5, Math.min(600, Number.parseInt(options.timeoutSeconds, 10) || 120));
  const approval = options.approval;
  if (!options.autoApprove) {
    const ok = approval && await approval('Run this command in the workspace?\n  ' + command + ' ' + args.map((arg) => JSON.stringify(arg)).join(' ') + '\nCommands can change project files or execute project scripts. Oasis strips common secret environment variables from the child process.');
    if (!ok) return { approved: false, command, args, message: 'Command was not approved. No process was started.' };
  }
  const env = scrubEnvironment(options.env || process.env);
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (target, chunk) => {
      if (target === 'stdout') stdout = (stdout + chunk.toString()).slice(-MAX_TOOL_OUTPUT);
      else stderr = (stderr + chunk.toString()).slice(-MAX_TOOL_OUTPUT);
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ command, exitCode: null, stdout, stderr, error: error.message, timedOut });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ command, exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}

async function runInstallPlan(plan, options) {
  if (!options.autoApprove) {
    const ok = options.approval && await options.approval(
      'Install package ' + plan.packageName + ' using ' + plan.command + ' ' + plan.args.map((arg) => JSON.stringify(arg)).join(' ') +
      '\n' + plan.note + '\nThis changes your environment and may execute third-party installer scripts.'
    );
    if (!ok) return { approved: false, plan, message: 'Installation was not approved. Nothing was installed.' };
  }
  const env = scrubEnvironment(options.env || process.env);
  return await new Promise((resolve) => {
    let settled = false;
    const child = spawn(plan.command, plan.args, { cwd: options.root, env, shell: false, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 20 * 60 * 1000);
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ approved: true, plan, exitCode: null, error: error.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ approved: true, plan, exitCode: code, signal });
    });
  });
}

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] >= 224) || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
}
function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.');
  }
  return true;
}
async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Provide a valid public URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links can be fetched.');
  if (url.username || url.password) throw new Error('URLs containing credentials are blocked.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') throw new Error('Local and metadata URLs are blocked.');
  const ip = isIP(host);
  if (ip && isPrivateAddress(host)) throw new Error('Private-network addresses are blocked.');
  if (!ip) {
    let records;
    try { records = await lookup(host, { all: true, verbatim: true }); } catch { throw new Error('Could not resolve this public hostname.'); }
    if (!records.length || records.some((record) => isPrivateAddress(record.address))) throw new Error('This hostname resolves to a private or reserved address and is blocked.');
  }
  return url;
}

async function fetchPublicUrl(raw) {
  const url = await validatePublicUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'OasisOSS/0.2 (+https://github.com/gtxnrg-ship-it/Oasis)', accept: 'text/plain,text/html,application/json,text/markdown,*/*;q=0.2' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      return { url: url.toString(), status: response.status, redirect: location ? new URL(location, url).toString() : null, message: 'Redirects are not followed automatically. Validate and fetch the destination separately if appropriate.' };
    }
    const type = response.headers.get('content-type') || '';
    if (!response.ok) return { url: url.toString(), status: response.status, error: 'The server returned an unsuccessful status.' };
    if (!/(text\/|application\/json|application\/xml|application\/xhtml\+xml)/i.test(type)) return { url: url.toString(), status: response.status, contentType: type, error: 'The response is not an accepted text content type.' };
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > 1024 * 1024) return { url: url.toString(), error: 'Response exceeds the 1 MiB limit.' };
    const text = await response.text();
    if (text.length > 1024 * 1024) return { url: url.toString(), error: 'Response exceeds the 1 MiB limit.' };
    let content = text;
    if (/text\/html|application\/xhtml\+xml/i.test(type)) {
      content = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
    }
    return { url: url.toString(), status: response.status, contentType: type, content: content.slice(0, MAX_TOOL_OUTPUT), truncated: content.length > MAX_TOOL_OUTPUT };
  } finally { clearTimeout(timer); }
}


function parseSkillMetadata(content, fallbackName) {
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = front ? front[1] : '';
  const read = (key) => {
    const match = metadata.match(new RegExp('^' + key + ':\\s*(.+)$', 'mi'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const rawName = read('name') || fallbackName;
  const name = /^[a-z][a-z0-9-]{0,63}$/i.test(rawName) ? rawName : fallbackName;
  const description = (read('description') || 'Workflow instructions for ' + name + '.').slice(0, 320);
  return { name, description };
}

export async function listAvailableSkills(root) {
  const byName = new Map();
  async function scan(directory, source, relativePrefix = '') {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink()).slice(0, 80)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name, 'SKILL.md');
      try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) continue;
        const content = await readFile(filePath, 'utf8');
        if (content.includes('\0')) continue;
        const meta = parseSkillMetadata(content, entry.name);
        const skill = {
          name: meta.name,
          description: meta.description,
          source,
          relativePath: source === 'workspace' ? path.posix.join('.oasis', 'skills', entry.name, 'SKILL.md') : entry.name
        };
        byName.set(meta.name.toLowerCase(), skill);
      } catch { /* Ignore incomplete or unsafe skill files. */ }
    }
  }
  await scan(BUNDLED_SKILLS_DIR, 'built-in');
  await scan(path.join(root, '.oasis', 'skills'), 'workspace');
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
}

export async function loadSkillText(root, rawName) {
  const name = String(rawName || '');
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(name)) throw new Error('Skill names must be a short identifier.');
  const skills = await listAvailableSkills(root);
  const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!skill) throw new Error('No skill named "' + name + '" is available. Call list_skills to inspect valid names.');
  let content;
  if (skill.source === 'workspace') {
    content = (await readWorkspaceFile(root, skill.relativePath)).content;
  } else {
    const target = path.resolve(BUNDLED_SKILLS_DIR, skill.relativePath, 'SKILL.md');
    if (!inside(BUNDLED_SKILLS_DIR, target)) throw new Error('Skill path is outside the bundled skill directory.');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw new Error('Bundled skill file is not a safe regular text file.');
    content = await readFile(target, 'utf8');
  }
  if (content.includes('\0')) throw new Error('Skill content is not valid text.');
  return { name: skill.name, source: skill.source, content: content.slice(0, 24000), truncated: content.length > 24000 };
}

export async function loadSkillDescriptions(root) {
  const skills = await listAvailableSkills(root);
  if (!skills.length) return '';
  return skills.map((item) => '- ' + item.name + ' [' + item.source + ']: ' + item.description).join('\n').slice(0, 12000);
}

export async function executeTool(name, args = {}, context = {}) {
  const root = path.resolve(context.root || process.cwd());
  switch (name) {
    case 'list_files':
      return await listWorkspaceFiles(root, { path: args.path || '.', includeHidden: Boolean(args.includeHidden) });
    case 'read_file':
      return await readWorkspaceFile(root, args.path);
    case 'search_files':
      return await searchWorkspaceFiles(root, args.query, args.limit);
    case 'list_skills':
      return { skills: await listAvailableSkills(root) };
    case 'load_skill':
      return await loadSkillText(root, args.name);
    case 'edit_file': {
      if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') throw new Error('oldText and newText must both be strings.');
      if (!args.oldText.length) throw new Error('oldText cannot be empty.');
      if (Buffer.byteLength(args.oldText, 'utf8') > MAX_TEXT_FILE || Buffer.byteLength(args.newText, 'utf8') > MAX_TEXT_FILE) throw new Error('The edit exceeds the 256 KiB text limit.');
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      const info = await lstat(target.absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('edit_file can only change a regular existing file.');
      if (info.size > MAX_TEXT_FILE) throw new Error('File is larger than the 256 KiB edit limit.');
      const current = await readFile(target.absolute, 'utf8');
      if (current.includes('\0')) throw new Error('This looks like a binary file; edit_file only supports text.');
      let matches = 0, offset = 0;
      while ((offset = current.indexOf(args.oldText, offset)) >= 0) { matches++; offset += args.oldText.length; }
      if (!matches) throw new Error('The exact oldText was not found. Read the current file and retry with exact context.');
      if (matches > 1 && args.replaceAll !== true) throw new Error('oldText matches ' + matches + ' places. Include more context or explicitly set replaceAll=true.');
      const next = args.replaceAll === true ? current.split(args.oldText).join(args.newText) : current.replace(args.oldText, args.newText);
      if (Buffer.byteLength(next, 'utf8') > MAX_TEXT_FILE) throw new Error('Edited file would exceed the 256 KiB text limit.');
      if (next === current) return { path: target.relative.split(path.sep).join('/'), changed: false, message: 'The replacement produced no changes.' };
      await snapshotFile(root, target.absolute, 'before-agent-edit');
      await writeFile(target.absolute, next, { encoding: 'utf8' });
      return { path: target.relative.split(path.sep).join('/'), changed: true, replacements: args.replaceAll === true ? matches : 1, beforeBytes: Buffer.byteLength(current, 'utf8'), afterBytes: Buffer.byteLength(next, 'utf8'), backupCreated: true };
    }
    case 'write_file': {
      if (typeof args.content !== 'string') throw new Error('File contents must be a string.');
      if (Buffer.byteLength(args.content, 'utf8') > MAX_TEXT_FILE) throw new Error('New file content exceeds the 256 KiB limit.');
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      let backedUpExistingFile = false;
      try {
        const old = await lstat(target.absolute);
        if (old.isDirectory()) throw new Error('Refusing to replace a directory with a file.');
        await snapshotFile(root, target.absolute, 'before-agent-write');
        backedUpExistingFile = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, args.content, { encoding: 'utf8', mode: 0o600 });
      return { path: target.relative.split(path.sep).join('/'), writtenBytes: Buffer.byteLength(args.content, 'utf8'), backedUpExistingFile };
    }
    case 'delete_file': {
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      const info = await lstat(target.absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only regular files can be deleted with this tool.');
      if (!context.approval || !(await context.approval('Delete the workspace file ' + target.relative + '? Its current contents will be backed up first.'))) {
        return { approved: false, path: target.relative, message: 'Deletion was not approved. No file was removed.' };
      }
      await snapshotFile(root, target.absolute, 'before-agent-delete');
      await unlink(target.absolute);
      return { path: target.relative, deleted: true, backupCreated: true };
    }
    case 'run_command':
      return await runWorkspaceCommand(root, args.command, args.args || [], {
        approval: context.approval,
        autoApprove: Boolean(context.autoApprove),
        timeoutSeconds: Math.min(args.timeoutSeconds || context.maxCommandSeconds || 120, context.maxCommandSeconds || 600),
        env: context.env || process.env
      });
    case 'install_package': {
      const name = normalizePackageName(args.packageName);
      const plan = planPackageInstall({ packageName: name, ecosystem: args.ecosystem || 'auto', workspaceRoot: root, env: context.env || process.env });
      return await runInstallPlan(plan, { root, approval: context.approval, autoApprove: Boolean(context.autoApprove), env: context.env || process.env });
    }
    case 'fetch_url':
      return await fetchPublicUrl(args.url);
    default:
      throw new Error('Unknown or unavailable tool: ' + name);
  }
}

export async function loadProjectInstructions(root) {
  const names = ['OASIS.md', 'AGENTS.md', 'CLAUDE.md', 'README.md'];
  const parts = [];
  for (const name of names) {
    try {
      const result = await readWorkspaceFile(root, name);
      if (result.content.trim()) parts.push('--- Project context: ' + name + ' ---\n' + result.content.slice(0, 9000));
    } catch {}
  }
  // Skill instructions are deliberately not loaded here. The model receives only a
  // compact name/description catalogue and calls load_skill when one is relevant.
  return parts.join('\n\n').slice(0, 26000);
}

export function toolCount() {
  return TOOL_DEFINITIONS.length;
}
