import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, unlink, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { snapshotFile } from './backups.mjs';
import { planPackageInstall, normalizePackageName } from './installer.mjs';
import { managePlugins } from './plugins.mjs';
import { getConfigDirectory, loadConfig, saveConfig, DEFAULT_BASE_URL, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_MODEL, validateBaseUrl, isLoopbackUrl } from './config.mjs';
import { testProviderConnection } from './agent.mjs';
import { installGitHubExtension, inspectGitHubExtension, listInstalledExtensions } from './extensions.mjs';

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
  { type: 'function', function: { name: 'git_status', description: 'Read the current Git branch and working-tree status without modifying the repository. This is a read-only local Git operation.', parameters: { type: 'object', properties: {} }, required: [] } },
  { type: 'function', function: { name: 'git_diff', description: 'Read a bounded Git diff without invoking external diff drivers or text-conversion filters. Scope may be unstaged, staged, or all changes relative to HEAD. Optionally restrict to one workspace-relative, non-sensitive path.', parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['unstaged', 'staged', 'all'], description: 'Which changes to inspect; defaults to all changes relative to HEAD' }, path: { type: 'string', description: 'Optional workspace-relative path' } }, required: [] } } },
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
  { type: 'function', function: { name: 'load_skill', description: 'Load the full instructions for one named built-in or workspace skill. Use this before work that matches the skill description.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name returned by list_skills' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'read_skill_resource', description: 'Read a text reference or asset shipped with an installed portable Agent Skill. Only integrity-verified files under that skill’s references/ or assets/ folders can be read; scripts are not exposed by this tool.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Installed skill name returned by list_skills or load_skill' }, path: { type: 'string', description: 'Relative path under references/ or assets/, such as references/checklist.md' } }, required: ['name', 'path'] } } },
  { type: 'function', function: { name: 'run_specialist_review', description: 'Run one bounded specialist review in a separate read-only model session. Available roles: code-review, security-review, architecture, and test-strategy. The reviewer can inspect workspace files and Git diffs, but cannot edit files, run commands, install packages, access MCP tools, or perform external side effects. Up to two reviews are allowed per task; use for an independent second opinion, not for changes.', parameters: { type: 'object', properties: { specialist: { type: 'string', enum: ['code-review', 'security-review', 'architecture', 'test-strategy'], description: 'Focus of the independent review' }, task: { type: 'string', description: 'A bounded review request; include relevant files or the question to investigate' } }, required: ['specialist', 'task'], additionalProperties: false } } },
  { type: 'function', function: { name: 'install_extension', description: 'Inspect and import a public GitHub repository containing Markdown specialist-agent or skill prompts. Import only the selected Markdown prompts; do not execute scripts, install dependencies, or enable MCP servers. Scope self installs into Oasis user configuration, project installs into the current workspace, and both installs to both locations. Always obtain approval before importing an external repository.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Public GitHub repository URL, for example https://github.com/msitarzewski/agency-agents' }, scope: { type: 'string', enum: ['self', 'project', 'both'], description: 'Install into Oasis itself, the current project, or both' } }, required: ['url', 'scope'] } } },
  { type: 'function', function: { name: 'setup_omniroute', description: 'Install OmniRoute globally with npm if it is missing, start its local gateway if needed, verify real model tool calling without executing the probe, and switch Oasis to the gateway only after verification succeeds. Use when the user asks to install, set up, or connect OmniRoute. Installation, background startup, and configuration each require approval. Never assume a hosted provider or free quota is guaranteed.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'configure_provider', description: 'Connect Oasis to an existing supported provider preset and switch the current chat to it only after an inert tool-call probe succeeds. Presets: openai, anthropic, openrouter, gemini, ollama, omniroute. This tool never accepts API keys; it may use only the matching saved credential or provider-specific environment variable. For OmniRoute that is not running, use setup_omniroute.', parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['openai', 'anthropic', 'openrouter', 'gemini', 'ollama', 'omniroute'] }, model: { type: 'string', maxLength: 200, description: 'Optional exact model ID; Ollama/OpenRouter-compatible models may require an account- or server-specific ID.' } }, required: ['provider'], additionalProperties: false } } },
  { type: 'function', function: { name: 'install_external_skill', description: 'Install a selected external Agent Skill from a repository using the pinned Vercel Skills CLI. Copies only the universal Agent Skills package; does not activate hooks, run skill scripts, or configure MCP. Requires approval and imports the instructions as untrusted content. Choose one exact skill or set all=true.', parameters: { type: 'object', properties: { source: { type: 'string', maxLength: 600, description: 'Public GitHub shorthand owner/repo, HTTPS source URL, SSH/Git URL, or a local path.' }, skill: { type: 'string', maxLength: 128, description: 'Exact skill name to install; mutually exclusive with all=true.' }, all: { type: 'boolean', description: 'Install all skills from this source into the universal Agent Skills directory.' }, scope: { type: 'string', enum: ['project', 'global'], description: 'Project .agents/skills or user-level universal skills directory.' } }, required: ['source', 'scope'], additionalProperties: false } } },
  { type: 'function', function: { name: 'install_plugin', description: 'Install one reviewed Oasis built-in capability bundle into this workspace. Bundles copy skill instruction files only; external servers, package installs, and credentials are not enabled automatically. Requires user approval unless auto-approval is explicitly enabled.', parameters: { type: 'object', properties: { name: { type: 'string', enum: ['code-quality', 'project-onboarding', 'debugging', 'ship-feature', 'mobile-development', 'web-app-development', 'api-development', 'security-review'], description: 'Name of the built-in plugin bundle from oasis plugins list' } }, required: ['name'] } } }
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
  return { path: relativePath, content: text, startLine, endLine: startLine + slice.length - 1, totalLines: lines.length, truncated: truncated || startLine - 1 + count < lines.length };
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
    else if ('.+^$(){}|[]\\'.includes(char)) source += '\\' + char;
    else source += char;
  }
  return new RegExp('^' + source + '$');
}

export async function globWorkspaceFiles(root, pattern, limit = 200) {
  const text = String(pattern || '').trim();
  if (!text) throw new Error('Glob pattern cannot be empty.');
  if (text.length > 300) throw new Error('Glob pattern is too long.');
  if (text.includes('\0') || path.isAbsolute(text) || text.split(/[\\/]+/).includes('..')) throw new Error('Glob patterns must be relative to the workspace and cannot contain "..".');
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
  if (options.signal && options.signal.aborted) return { command, args, approved: false, cancelled: true, message: 'Task was cancelled before approval or execution.' };
  const timeoutSeconds = Math.max(5, Math.min(600, Number.parseInt(options.timeoutSeconds, 10) || 120));
  const approval = options.approval;
  if (!options.autoApprove) {
    const ok = approval && await approval('Run this command in the workspace?\n  ' + command + ' ' + args.map((arg) => JSON.stringify(arg)).join(' ') + '\nCommands can change project files or execute project scripts. Oasis strips common secret environment variables from the child process.');
    if (!ok) return { approved: false, command, args, message: 'Command was not approved. No process was started.' };
  }
  if (options.signal && options.signal.aborted) return { command, args, approved: false, cancelled: true, message: 'Task was cancelled before the command started.' };
  const env = scrubEnvironment(options.env || process.env);
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer = null;
    const child = spawn(command, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (target, chunk) => {
      if (target === 'stdout') stdout = (stdout + chunk.toString()).slice(-MAX_TOOL_OUTPUT);
      else stderr = (stderr + chunk.toString()).slice(-MAX_TOOL_OUTPUT);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1500);
      killTimer.unref?.();
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutSeconds * 1000);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ command, approved: true, exitCode: null, stdout, stderr, error: error.message, timedOut, cancelled });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ command, approved: true, exitCode: code, signal, stdout, stderr, timedOut, cancelled });
    });
  });
}

async function runInstallPlan(plan, options) {
  if (options.signal && options.signal.aborted) return { approved: false, cancelled: true, plan, message: 'Task was cancelled before installation started.' };
  if (!options.autoApprove) {
    const ok = options.approval && await options.approval(
      'Install package ' + plan.packageName + ' using ' + plan.command + ' ' + plan.args.map((arg) => JSON.stringify(arg)).join(' ') +
      '\n' + plan.note + '\nThis changes your environment and may execute third-party installer scripts.'
    );
    if (!ok) return { approved: false, plan, message: 'Installation was not approved. Nothing was installed.' };
  }
  if (options.signal && options.signal.aborted) return { approved: false, cancelled: true, plan, message: 'Task was cancelled before the package manager started.' };
  const env = scrubEnvironment(options.env || process.env);
  return await new Promise((resolve) => {
    let settled = false;
    let cancelled = false;
    let killTimer = null;
    const child = spawn(plan.command, plan.args, { cwd: options.root, env, shell: false, windowsHide: true, stdio: 'inherit' });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1500);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 20 * 60 * 1000);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ approved: true, cancelled, plan, exitCode: null, error: error.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ approved: true, cancelled, plan, exitCode: code, signal });
    });
  });
}



const OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1';
const OMNIROUTE_DASHBOARD_URL = 'http://127.0.0.1:20128/';
const VERCEL_SKILLS_PACKAGE = 'skills@1.7.4';

function providerEnvironmentOverridesActive(env) {
  return Boolean(env && (env.OASIS_BASE_URL || env.OASIS_PROTOCOL || env.OASIS_MODEL));
}

function getProviderPreset(provider) {
  const presets = {
    openai: { protocol: 'openai-responses', baseURL: DEFAULT_BASE_URL, model: DEFAULT_MODEL },
    anthropic: { protocol: 'anthropic', baseURL: DEFAULT_ANTHROPIC_BASE_URL, model: 'claude-sonnet-5' },
    openrouter: { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: '' },
    gemini: { protocol: 'openai-compatible', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash' },
    ollama: { protocol: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: '' },
    omniroute: { protocol: 'openai-compatible', baseURL: OMNIROUTE_BASE_URL, model: 'auto' }
  };
  return presets[String(provider || '').toLowerCase()] || null;
}

function getMatchingProviderKey(provider, env) {
  if (provider === 'openai') return env.OPENAI_API_KEY || '';
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY || '';
  if (provider === 'openrouter') return env.OPENROUTER_API_KEY || '';
  if (provider === 'gemini') return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  if (provider === 'ollama') return env.OLLAMA_API_KEY || '';
  if (provider === 'omniroute') return env.OASIS_LOCAL_API_KEY || '';
  return '';
}

function commandExists(command, env = process.env, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const checker = process.platform === 'win32' ? 'where.exe' : 'which';
    let child;
    let settled = false;
    const finish = (exists) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Boolean(exists));
    };
    const timer = setTimeout(() => { try { child?.kill(); } catch {} finish(false); }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn(checker, [command], { env: scrubEnvironment(env), shell: false, windowsHide: true, stdio: 'ignore' });
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

async function checkOmniRouteEndpoint(apiKey = '', timeoutMs = 1200) {
  try {
    const headers = apiKey ? { authorization: 'Bearer ' + apiKey } : {};
    const response = await fetch(OMNIROUTE_BASE_URL + '/models', {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return {
      reachable: response.status === 200 || response.status === 401 || response.status === 403,
      status: response.status
    };
  } catch {
    return { reachable: false, status: null };
  }
}

async function waitForOmniRoute(apiKey = '', timeoutMs = 20000, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return { reachable: false, cancelled: true, status: lastStatus };
    const result = await checkOmniRouteEndpoint(apiKey, 1000);
    lastStatus = result.status;
    if (result.reachable) return result;
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  return { reachable: false, status: lastStatus };
}

async function startOmniRouteBackground(root, env) {
  return await new Promise((resolve, reject) => {
    let child;
    try {
      if (process.platform === 'win32') {
        // Fixed command only; no user input is interpolated into this command string.
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start "" /b omniroute'], {
          cwd: root, env: scrubEnvironment(env), detached: true, windowsHide: true, shell: false, stdio: 'ignore'
        });
      } else {
        child = spawn('omniroute', [], {
          cwd: root, env: scrubEnvironment(env), detached: true, windowsHide: true, shell: false, stdio: 'ignore'
        });
      }
    } catch (error) {
      reject(new Error('Could not start OmniRoute: ' + String(error && error.message || error)));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error('Timed out while launching the OmniRoute process.'));
    }, 5000);
    timer.unref?.();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Could not start OmniRoute: ' + String(error && error.message || error)));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolve();
    });
  });
}

async function saveVerifiedProvider(provider, config, context) {
  const env = context.env || process.env;
  let probe;
  try {
    probe = await testProviderConnection(config, { timeoutMs: 30000, signal: context.signal });
  } catch (error) {
    const message = String(error && error.message || error).slice(0, 1000);
    if (provider === 'omniroute') {
      return {
        connected: false,
        needsLocalApiKey: /(?:401|403|unauthorized|authentication|api key|token)/i.test(message),
        provider,
        message: 'OmniRoute is reachable, but model/tool-call verification did not pass. No provider settings were changed. Open ' +
          OMNIROUTE_DASHBOARD_URL + ' to confirm a provider route is available; some OmniRoute setups also require a local endpoint key. ' +
          'Enter that key only in Oasis’s local provider form or the hidden terminal prompt, not in chat. Details: ' + message
      };
    }
    return { connected: false, provider, message: 'Provider verification failed; the existing configuration was left unchanged. ' + message };
  }
  if (!context.autoApprove && (!context.approval || !(await context.approval(
    'Save the verified model provider "' + provider + '" (' + config.model + ' at ' + config.baseURL + ') as the local Oasis provider? ' +
    'This updates the user-level provider configuration. The API key is never shown in this prompt.'
  )))) {
    return { connected: false, approved: false, provider, message: 'Provider configuration was not changed because approval was denied.' };
  }
  const configPath = await saveConfig({
    protocol: config.protocol, baseURL: config.baseURL, model: config.model, apiKey: config.apiKey || ''
  }, { env });
  const loaded = await loadConfig({ env });
  if (context.config && typeof context.config === 'object') Object.assign(context.config, loaded);
  return {
    connected: true,
    provider,
    model: probe.model,
    protocol: probe.protocol,
    baseURL: config.baseURL,
    configPath,
    message: 'Provider tool-calling verification passed and the local Oasis configuration was updated. The inert probe tool was never executed.'
  };
}

async function configureProviderFromChat(args, context) {
  const env = context.env || process.env;
  if (providerEnvironmentOverridesActive(env)) {
    return {
      connected: false,
      provider: String(args.provider || ''),
      message: 'OASIS_BASE_URL, OASIS_PROTOCOL, or OASIS_MODEL is set in the environment and takes precedence over the config file. Update those host environment variables before changing providers from chat.'
    };
  }
  const provider = String(args.provider || '').trim().toLowerCase();
  const preset = getProviderPreset(provider);
  if (!preset) throw new Error('Choose one supported provider preset: openai, anthropic, openrouter, gemini, ollama, or omniroute.');
  const model = String(args.model || preset.model || '').trim();
  if (!model || model.length > 200) throw new Error('This provider needs an exact model ID. Supply the model name from the provider or local server.');
  const baseURL = validateBaseUrl(preset.baseURL);
  const current = await loadConfig({ env }).catch(() => context.config || null);
  const sameTarget = Boolean(current && current.baseURL === baseURL && current.protocol === preset.protocol);
  const apiKey = String((sameTarget && current.apiKey) || getMatchingProviderKey(provider, env) || '');
  if (!isLoopbackUrl(baseURL) && !apiKey) {
    return {
      connected: false,
      provider,
      message: 'No matching saved credential or provider-specific environment key is available for ' + provider + '. Use /setup in the terminal or the local Model provider form to enter the credential privately; Oasis will verify tool calling before saving.'
    };
  }
  return await saveVerifiedProvider(provider, {
    protocol: preset.protocol, baseURL, model, apiKey
  }, context);
}

async function setupOmniRoute(args, context, root) {
  const env = context.env || process.env;
  if (providerEnvironmentOverridesActive(env)) {
    return {
      connected: false,
      provider: 'omniroute',
      message: 'OASIS_BASE_URL, OASIS_PROTOCOL, or OASIS_MODEL is pinned in the environment. Unset or update those host variables first; Oasis will not claim a saved provider change while they override it.'
    };
  }
  const baseURL = OMNIROUTE_BASE_URL;
  const current = await loadConfig({ env }).catch(() => context.config || null);
  const apiKey = String(args && args.localApiKey || env.OASIS_LOCAL_API_KEY ||
    (current && current.baseURL === baseURL && current.protocol === 'openai-compatible' ? current.apiKey : '') || '');
  let endpoint = await checkOmniRouteEndpoint(apiKey);
  let installed = false;
  let started = false;

  if (!endpoint.reachable) {
    if (!await commandExists('npm', env)) {
      return { connected: false, provider: 'omniroute', message: 'npm was not found. Install Node.js with npm, then ask Oasis to set up OmniRoute again.' };
    }
    if (!await commandExists('omniroute', env)) {
      const plan = planPackageInstall({ packageName: 'omniroute', ecosystem: 'npm-global', workspaceRoot: root, env });
      const result = await runInstallPlan(plan, {
        root, env, signal: context.signal, autoApprove: Boolean(context.autoApprove), approval: context.approval
      });
      if (!result || result.approved === false) return { connected: false, approved: false, provider: 'omniroute', message: result?.message || 'OmniRoute installation was not approved; nothing was installed.' };
      if (result.exitCode !== 0) return { connected: false, provider: 'omniroute', installed: false, message: 'OmniRoute installation did not complete successfully. Exit code: ' + result.exitCode + (result.error ? ': ' + result.error : '') };
      installed = true;
    }
    if (!context.autoApprove && (!context.approval || !(await context.approval(
      'Start the local OmniRoute gateway as a detached background process on port 20128? It will expose the local API and dashboard on this machine. You can stop it using your operating-system process controls.'
    )))) {
      return { connected: false, approved: false, installed, provider: 'omniroute', message: 'OmniRoute was not started because approval was denied. No provider configuration was changed.' };
    }
    if (context.signal && context.signal.aborted) return { connected: false, cancelled: true, installed, provider: 'omniroute', message: 'Setup was cancelled before OmniRoute started.' };
    try {
      await startOmniRouteBackground(root, env);
      started = true;
    } catch (error) {
      return { connected: false, installed, provider: 'omniroute', message: String(error && error.message || error) };
    }
    endpoint = await waitForOmniRoute(apiKey, 20000, context.signal);
    if (!endpoint.reachable) {
      return {
        connected: false, installed, started, provider: 'omniroute',
        message: 'The OmniRoute process was launched, but its /v1/models endpoint did not become ready. Inspect ' + OMNIROUTE_DASHBOARD_URL + ' or start "omniroute" in a terminal and retry. Your previous provider configuration remains unchanged.'
      };
    }
  }

  return await saveVerifiedProvider('omniroute', {
    protocol: 'openai-compatible', baseURL, model: 'auto', apiKey
  }, context).then((result) => ({ ...result, installed, started, dashboard: OMNIROUTE_DASHBOARD_URL }));
}

function validExternalSkillSource(raw) {
  const source = String(raw || '').trim();
  if (!source || source.length > 600 || /[\r\n\0]/.test(source) || source.startsWith('-')) {
    throw new Error('Provide a valid skill source (GitHub owner/repo, HTTPS source URL, SSH/Git URL, or local path).');
  }
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(source)) return source;
  if (/^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/i.test(source)) return source;
  if (/^(?:git@|ssh:\/\/|git:\/\/)/i.test(source)) return source;
  if (/^https:\/\//i.test(source)) {
    let url;
    try { url = new URL(source); } catch { throw new Error('The skill source URL is invalid.'); }
    if (url.username || url.password || url.hash) throw new Error('Skill source URLs must not contain credentials or fragments.');
    return source;
  }
  throw new Error('Unsupported skill source. Use owner/repo, an HTTPS URL, an SSH/Git URL, or a local path.');
}

function quoteSkillsWindowsArgument(raw) {
  const value = String(raw);
  if (/[\r\n%!"&|<>^]/.test(value)) throw new Error('This value contains shell metacharacters that cannot safely be passed through the Windows command launcher.');
  return '"' + value.replace(/"/g, '""') + '"';
}

function runExternalSkillsCommand(root, cliArgs, env, signal) {
  const npxArgs = ['--yes', VERCEL_SKILLS_PACKAGE, ...cliArgs];
  const cleanEnv = { ...scrubEnvironment(env), DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
  let command = 'npx';
  let childArgs = npxArgs;
  if (process.platform === 'win32') {
    const commandLine = ['npx.cmd', ...npxArgs].map(quoteSkillsWindowsArgument).join(' ');
    command = process.env.ComSpec || 'cmd.exe';
    childArgs = ['/d', '/v:off', '/s', '/c', '"' + commandLine + '"'];
  }
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let timer;
    let child;
    const append = (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-16000);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      try { child?.kill('SIGTERM'); } catch {}
    };
    try {
      child = spawn(command, childArgs, { cwd: root, env: cleanEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', append);
      child.stderr.on('data', append);
    } catch (error) {
      finish({ exitCode: null, error: String(error && error.message || error), output });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, 8 * 60 * 1000);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.once('error', (error) => finish({ exitCode: null, error: String(error && error.message || error), output, timedOut }));
    child.once('close', (code) => finish({ exitCode: code, output, timedOut, cancelled: Boolean(signal && signal.aborted) }));
  });
}

async function installExternalSkill(args, context, root) {
  const env = context.env || process.env;
  const source = validExternalSkillSource(args.source);
  const skill = String(args.skill || '').trim();
  const all = args.all === true;
  const scope = String(args.scope || 'project');
  if (!['project', 'global'].includes(scope)) throw new Error('Choose project or global skill installation scope.');
  if (Boolean(skill) === all) throw new Error('Choose exactly one of skill="EXACT_NAME" or all=true.');
  if (skill && (skill.length > 128 || /[\r\n\0"]/.test(skill) || /^-/.test(skill))) throw new Error('Skill names must be 1–128 characters and cannot contain quotes, line breaks, NUL, or start with a flag.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 20))) {
    return { installed: false, message: 'The Vercel Skills CLI requires Node.js 22.20 or newer. Upgrade Node.js before importing external skills.' };
  }
  if (!await commandExists('npx', env)) throw new Error('npx was not found; install Node.js with npm and rerun this request.');
  const selection = all ? ['--skill', '*'] : ['--skill', skill];
  const cliArgs = ['add', source, ...selection, '--agent', 'universal', '--copy', ...(scope === 'global' ? ['--global'] : []), '--yes'];
  if (!context.autoApprove && (!context.approval || !(await context.approval(
    'Install ' + (all ? 'all skills' : 'the skill "' + skill + '"') + ' from "' + source + '" into the ' + scope +
    ' universal Agent Skills directory using ' + VERCEL_SKILLS_PACKAGE + '? The command downloads external instructions; it does not run their scripts, but imported instructions will be treated as untrusted context by Oasis.'
  )))) {
    return { installed: false, approved: false, message: 'External skill installation was denied; no skill source was installed.' };
  }
  const result = await runExternalSkillsCommand(root, cliArgs, env, context.signal);
  if (result.cancelled) return { installed: false, cancelled: true, output: result.output, message: 'Skill installation was cancelled. Inspect the output for any partial installation before retrying.' };
  if (result.error || result.exitCode !== 0 || result.timedOut) {
    return { installed: false, output: result.output, error: result.error || null, exitCode: result.exitCode, timedOut: Boolean(result.timedOut), message: 'The Vercel Skills CLI did not report a successful install. Review the output; Oasis does not assume the skill was installed.' };
  }
  const skills = await listAvailableSkills(root, { env });
  const installed = all ? skills.filter((item) => scope === 'global' ? item.source === 'global-portable' : item.source === 'portable-workspace')
    : skills.filter((item) => item.name.toLowerCase() === skill.toLowerCase());
  return {
    installed: installed.length > 0,
    source, scope, skill: all ? '*' : skill,
    discovered: installed.map((item) => ({ name: item.name, description: item.description, source: item.source })),
    output: result.output,
    message: installed.length
      ? 'The skill installation command succeeded. Oasis can discover the copied universal SKILL.md files; review their instructions as untrusted content before relying on them.'
      : 'The installer exited successfully, but Oasis did not discover a matching SKILL.md in its standard universal skill directories. Inspect the output and directory layout before assuming the skill is active.'
  };
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

function getUniversalGlobalSkillsDirectory(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, 'agents', 'skills');
}

export async function listAvailableSkills(root, options = {}) {
  const env = options.env || process.env;
  const byName = new Map();
  async function scan(directory, source, relativePrefix = '') {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink()).slice(0, 80)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name, 'SKILL.md');
      try {
        const info = await lstat(filePath);
        const maxSkillBytes = ['portable-workspace', 'global-portable'].includes(source) ? 96 * 1024 : 32 * 1024;
        if (!info.isFile() || info.isSymbolicLink() || info.size > maxSkillBytes) continue;
        const content = await readFile(filePath, 'utf8');
        if (content.includes('\0')) continue;
        const meta = parseSkillMetadata(content, entry.name);
        const localSource = ['workspace', 'portable-workspace'].includes(source);
        const skill = {
          name: meta.name,
          description: meta.description,
          source,
          directoryName: entry.name,
          relativePath: localSource ? path.posix.join(relativePrefix, entry.name, 'SKILL.md') : entry.name,
          relativeSkillDirectory: localSource ? path.posix.join(relativePrefix, entry.name) : undefined,
          absolutePath: source === 'global-portable' ? filePath : undefined,
          absoluteSkillDirectory: source === 'global-portable' ? path.join(directory, entry.name) : undefined
        };
        byName.set(meta.name.toLowerCase(), skill);
      } catch { /* Ignore incomplete or unsafe skill files. */ }
    }
  }
  async function scanImportedExtensions(extensionRoot, source, workspaceRelative = '') {
    let extensions;
    try { extensions = await readdir(extensionRoot, { withFileTypes: true }); } catch { return; }
    for (const extension of extensions.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).slice(0, 100)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(extension.name)) continue;
      const extensionDirectory = path.join(extensionRoot, extension.name);
      try {
        const extensionInfo = await lstat(extensionDirectory);
        if (!extensionInfo.isDirectory() || extensionInfo.isSymbolicLink()) continue;
        const manifest = JSON.parse(await readFile(path.join(extensionDirectory, 'extension.json'), 'utf8'));
        if (manifest.schemaVersion !== 1 || manifest.name !== extension.name || !Array.isArray(manifest.files)) continue;
      } catch { continue; }
      const skillsDirectory = path.join(extensionDirectory, 'skills');
      let skillDirs;
      try { skillDirs = await readdir(skillsDirectory, { withFileTypes: true }); } catch { continue; }
      for (const skillDir of skillDirs.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).slice(0, 240)) {
        if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(skillDir.name)) continue;
        const filePath = path.join(skillsDirectory, skillDir.name, 'SKILL.md');
        try {
          const info = await lstat(filePath);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024) continue;
          const content = await readFile(filePath, 'utf8');
          if (content.includes('\0')) continue;
          const meta = parseSkillMetadata(content, skillDir.name);
          const relativePath = source === 'project-extension'
            ? path.posix.join('.oasis', 'extensions', extension.name, 'skills', skillDir.name, 'SKILL.md')
            : '';
          byName.set(meta.name.toLowerCase(), {
            name: meta.name,
            description: meta.description,
            source,
            relativePath,
            absolutePath: source === 'global-extension' ? filePath : undefined,
            extensionName: extension.name,
            absoluteExtensionDirectory: source === 'global-extension' ? extensionDirectory : undefined,
            relativeExtensionDirectory: source === 'project-extension'
              ? path.posix.join('.oasis', 'extensions', extension.name, 'skills', skillDir.name)
              : undefined
          });
        } catch { /* Ignore untrusted or malformed prompt files. */ }
      }
    }
  }
  await scan(BUNDLED_SKILLS_DIR, 'built-in');
  await scanImportedExtensions(path.join(getConfigDirectory(env), 'extensions'), 'global-extension');
  await scan(getUniversalGlobalSkillsDirectory(env), 'global-portable');
  await scan(path.join(root, '.agents', 'skills'), 'portable-workspace', '.agents/skills');
  await scan(path.join(root, '.oasis', 'skills'), 'workspace', '.oasis/skills');
  await scanImportedExtensions(path.join(root, '.oasis', 'extensions'), 'project-extension', '.oasis/extensions');
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 240);
}

export async function loadSkillText(root, rawName, options = {}) {
  const name = String(rawName || '');
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(name)) throw new Error('Skill names must be a short identifier.');
  const skills = await listAvailableSkills(root, options);
  const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!skill) throw new Error('No skill named "' + name + '" is available. Call list_skills to inspect valid names.');
  let content;
  if (skill.source === 'workspace' || skill.source === 'portable-workspace' || skill.source === 'project-extension') {
    content = (await readWorkspaceFile(root, skill.relativePath)).content;
  } else if (skill.source === 'global-portable') {
    const globalSkillsRoot = path.resolve(getUniversalGlobalSkillsDirectory(options.env || process.env));
    const rootReal = await realpath(globalSkillsRoot);
    const target = path.resolve(skill.absolutePath || '');
    if (!inside(rootReal, target)) throw new Error('Portable global skill path is outside the universal skills directory.');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024) throw new Error('Portable global skill is not a safe regular Markdown file.');
    const targetReal = await realpath(target);
    if (!inside(rootReal, targetReal)) throw new Error('Portable global skill resolves outside the universal skills directory.');
    content = await readFile(targetReal, 'utf8');
  } else if (skill.source === 'global-extension') {
    const globalExtensionsRoot = path.resolve(getConfigDirectory(options.env || process.env), 'extensions');
    const rootReal = await realpath(globalExtensionsRoot);
    const target = path.resolve(skill.absolutePath || '');
    if (!inside(rootReal, target)) throw new Error('Imported skill path is outside the managed global extension directory.');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024) throw new Error('Imported skill is not a safe regular Markdown file.');
    const targetReal = await realpath(target);
    if (!inside(rootReal, targetReal)) throw new Error('Imported skill resolves outside the managed extension directory.');
    content = await readFile(targetReal, 'utf8');
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


export async function loadSkillResource(root, rawName, rawRelativePath, options = {}) {
  const name = String(rawName || '');
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(name)) throw new Error('Skill names must be a short identifier.');
  const relativePath = String(rawRelativePath || '').replace(/\\/g, '/');
  const parts = relativePath.split('/');
  if (relativePath.startsWith('/') || parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..') ||
      !['references', 'assets'].includes(parts[0]) || !/\.(?:md|txt|json|ya?ml|toml|csv|xml)$/i.test(relativePath)) {
    throw new Error('Skill resources must be text files inside references/ or assets/. Scripts and executable resources are not exposed.');
  }
  const workspaceRoot = path.resolve(root || process.cwd());
  const skills = await listAvailableSkills(workspaceRoot, options);
  const skill = skills.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!skill) throw new Error('No installed external skill named "' + name + '" was found.');
  if (['portable-workspace', 'global-portable'].includes(skill.source)) {
    const safetyRoot = skill.source === 'global-portable'
      ? path.resolve(getUniversalGlobalSkillsDirectory(options.env || process.env))
      : workspaceRoot;
    const skillDirectory = skill.source === 'global-portable'
      ? path.resolve(skill.absoluteSkillDirectory || '')
      : path.resolve(workspaceRoot, ...(String(skill.relativeSkillDirectory || '').split('/')));
    if (!inside(safetyRoot, skillDirectory)) throw new Error('Portable skill resource directory is outside its permitted root.');
    const safetyRootReal = await realpath(safetyRoot);
    const skillInfo = await lstat(skillDirectory);
    if (skillInfo.isSymbolicLink() || !skillInfo.isDirectory()) throw new Error('Portable skill directory is not a regular directory.');
    const skillRootReal = await realpath(skillDirectory);
    if (!inside(safetyRootReal, skillRootReal)) throw new Error('Portable skill directory resolves outside its permitted root.');
    let target = skillDirectory;
    for (const part of parts) {
      target = path.join(target, part);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('Portable skill resources cannot resolve through symbolic links.');
    }
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.size > MAX_TEXT_FILE) throw new Error('The resource is not a regular text file within the allowed size.');
    const targetReal = await realpath(target);
    if (!inside(skillRootReal, targetReal)) throw new Error('Portable skill resource resolves outside its skill directory.');
    const content = await readFile(targetReal, 'utf8');
    if (content.includes('\0')) throw new Error('Skill resource is not valid text.');
    return { name: skill.name, path: relativePath, content: content.slice(0, MAX_TOOL_OUTPUT), truncated: content.length > MAX_TOOL_OUTPUT, trust: 'external-untrusted-text' };
  }
  if (!['global-extension', 'project-extension'].includes(skill.source)) throw new Error('This skill does not expose managed portable resources.');
  let extensionDirectory;
  let safetyRoot;
  if (skill.source === 'global-extension') {
    extensionDirectory = path.resolve(skill.absoluteExtensionDirectory || '');
    safetyRoot = path.resolve(getConfigDirectory(options.env || process.env), 'extensions');
  } else {
    extensionDirectory = path.resolve(workspaceRoot, ...(String(skill.relativeExtensionDirectory || '').split('/')));
    safetyRoot = workspaceRoot;
  }
  if (!inside(safetyRoot, extensionDirectory)) throw new Error('Imported skill resource directory is outside its permitted extension root.');
  const extensionDirectoryReal = await realpath(extensionDirectory);
  const extensionInfo = await lstat(extensionDirectory);
  if (extensionInfo.isSymbolicLink() || !extensionInfo.isDirectory()) throw new Error('Imported skill directory is not a regular directory.');
  const extensionRoot = path.resolve(extensionDirectory, '..', '..');
  const manifestPath = path.join(extensionRoot, 'extension.json');
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error('The managed extension manifest is missing or unsafe.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const relativeToExtension = path.posix.join('skills', path.basename(extensionDirectory), relativePath);
  const record = Array.isArray(manifest.files) ? manifest.files.find((item) => item.path === relativeToExtension) : null;
  if (!record || !/^[a-f0-9]{64}$/i.test(String(record.sha256 || ''))) throw new Error('That resource is not in the verified manifest for this skill.');
  let target = extensionDirectory;
  for (const part of parts) {
    target = path.join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('Skill resources cannot resolve through symbolic links.');
  }
  const targetInfo = await lstat(target);
  if (!targetInfo.isFile() || targetInfo.size > MAX_TEXT_FILE) throw new Error('The resource is not a regular text file within the allowed size.');
  const targetReal = await realpath(target);
  if (!inside(extensionDirectoryReal, targetReal)) throw new Error('Skill resource resolved outside its extension package.');
  const content = await readFile(targetReal, 'utf8');
  if (content.includes('\0')) throw new Error('Skill resource is not valid text.');
  const hash = createHash('sha256').update(content).digest('hex');
  if (hash !== record.sha256) throw new Error('Skill resource integrity verification failed; inspect the extension before using it.');
  return { name: skill.name, path: relativePath, content: content.slice(0, MAX_TOOL_OUTPUT), truncated: content.length > MAX_TOOL_OUTPUT, trust: 'external-untrusted-text' };
}

export async function loadSkillDescriptions(root, options = {}) {
  const skills = await listAvailableSkills(root, options);
  if (!skills.length) return '';
  return skills.map((item) => '- ' + item.name + ' [' + (['global-extension', 'project-extension', 'portable-workspace', 'global-portable'].includes(item.source) ? 'EXTERNAL UNTRUSTED PROMPT' : item.source) + ']: ' + item.description).join('\n').slice(0, 16000);
}

async function runReadOnlyGit(root, args) {
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let timedOut = false;
    const env = {
      ...scrubEnvironment(),
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_CONFIG_NOSYSTEM: '1'
    };
    const safeArgs = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', ...args];
    let child;
    const append = (target, chunk) => {
      const current = target === 'stdout' ? stdout : stderr;
      const next = current + chunk.toString('utf8');
      if (next.length > MAX_TOOL_OUTPUT) truncated = true;
      const clipped = next.slice(-MAX_TOOL_OUTPUT);
      if (target === 'stdout') stdout = clipped;
      else stderr = clipped;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: 'git ' + args.join(' '),
        ...result,
        stdout,
        stderr,
        output: (stdout + (stderr ? '\\n' + stderr : '')).slice(-MAX_TOOL_OUTPUT),
        truncated
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 500);
      killTimer.unref?.();
    }, 15000);
    try {
      child = spawn('git', safeArgs, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      child.on('error', (error) => finish({ exitCode: 127, error: error.message, timedOut }));
      child.on('close', (code, signal) => finish({ exitCode: timedOut ? 124 : (code ?? 1), signal, timedOut }));
    } catch (error) {
      finish({ exitCode: 127, error: error.message, timedOut });
    }
  });
}

async function readGitStatus(root) {
  return await runReadOnlyGit(root, ['status', '--short', '--branch', '--untracked-files=normal', '--no-ahead-behind']);
}

async function readGitDiff(root, args = {}) {
  const scope = ['unstaged', 'staged', 'all'].includes(args.scope) ? args.scope : 'all';
  const commandArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3'];
  if (scope === 'staged') commandArgs.push('--cached');
  else if (scope === 'all') commandArgs.push('HEAD');
  let relativePath = '';
  if (args.path !== undefined && args.path !== null && String(args.path).trim()) {
    const resolved = await resolveWorkspacePath(root, String(args.path), { rejectSymlinks: true });
    relativePath = resolved.relative === '.' ? '' : resolved.relative;
  }
  commandArgs.push('--');
  if (relativePath) {
    commandArgs.push(relativePath);
  } else {
    // Never expose common secret-bearing paths in a whole-worktree diff.
    commandArgs.push(
      ':(exclude).env', ':(exclude)**/.env', ':(exclude).env.*', ':(exclude)**/.env.*',
      ':(exclude).ssh/**', ':(exclude)**/.ssh/**', ':(exclude).aws/**', ':(exclude)**/.aws/**',
      ':(exclude).gnupg/**', ':(exclude)**/.gnupg/**', ':(exclude).azure/**', ':(exclude)**/.azure/**',
      ':(exclude).kube/**', ':(exclude)**/.kube/**', ':(exclude).docker/**', ':(exclude)**/.docker/**',
      ':(exclude).npmrc', ':(exclude)**/.npmrc', ':(exclude).pypirc', ':(exclude)**/.pypirc',
      ':(exclude).netrc', ':(exclude)**/.netrc', ':(exclude).git-credentials', ':(exclude)**/.git-credentials',
      ':(exclude)credentials.json', ':(exclude)**/credentials.json', ':(exclude)secrets.json', ':(exclude)**/secrets.json',
      ':(exclude)**/*.pem', ':(exclude)**/*.key', ':(exclude)**/*.p12', ':(exclude)**/*.pfx', ':(exclude)**/*.keystore',
      ':(exclude)**/id_rsa', ':(exclude)**/id_ed25519', ':(exclude)**/id_ecdsa'
    );
  }
  return await runReadOnlyGit(root, commandArgs);
}

export async function executeTool(name, args = {}, context = {}) {
  const root = path.resolve(context.root || process.cwd());
  switch (name) {
    case 'git_status':
      return await readGitStatus(root);
    case 'git_diff':
      return await readGitDiff(root, args);
    case 'list_files':
      return await listWorkspaceFiles(root, { path: args.path || '.', includeHidden: Boolean(args.includeHidden) });
    case 'read_file':
      return await readWorkspaceFile(root, args.path, { offset: args.offset, limit: args.limit });
    case 'glob_files':
      return await globWorkspaceFiles(root, args.pattern, args.limit);
    case 'search_files':
      return await searchWorkspaceFiles(root, args.query, args.limit);
    case 'list_skills':
      return { skills: await listAvailableSkills(root, { env: context.env || process.env }) };
    case 'load_skill':
      return await loadSkillText(root, args.name, { env: context.env || process.env });
    case 'read_skill_resource':
      return await loadSkillResource(root, args.name, args.path, { env: context.env || process.env });
    case 'setup_omniroute':
      return await setupOmniRoute(args, context, root);
    case 'configure_provider':
      return await configureProviderFromChat(args, context);
    case 'install_external_skill':
      return await installExternalSkill(args, context, root);
    case 'install_extension': {
      const url = String(args.url || '').trim();
      const scope = String(args.scope || 'project');
      if (!url || url.length > 800) throw new Error('Provide a GitHub repository URL no longer than 800 characters.');
      if (!['self', 'project', 'both'].includes(scope)) throw new Error('Choose a valid extension installation scope.');
      const inspected = await inspectGitHubExtension(url, { env: context.env || process.env });
      if (!context.autoApprove && (!context.approval || !(await context.approval(
        'Import ' + inspected.importCount + ' Markdown specialist prompt(s) from ' + inspected.repository.fullName +
        ' at commit ' + inspected.repository.commitSha.slice(0, 12) + ' into scope "' + scope + '"? License: ' +
        inspected.repository.license + '. ' + inspected.executableFilesDetected +
        ' executable/source files were detected but will NOT be imported or run. No packages or MCP servers will be enabled.'
      )))) {
        return { installed: false, approved: false, repository: inspected.repository.fullName, message: 'Extension import was denied; no files were installed.' };
      }
      const result = await installGitHubExtension(url, { root, env: context.env || process.env, scope, expectedCommit: inspected.repository.commitSha });
      return { ...result, message: 'Imported Markdown prompts only. Scripts were not executed, packages were not installed, and external services were not enabled.' };
    }
    case 'install_plugin': {
      const name = String(args.name || '');
      if (!['code-quality', 'project-onboarding', 'debugging', 'ship-feature', 'mobile-development', 'web-app-development', 'api-development', 'security-review'].includes(name)) throw new Error('Choose a built-in bundle from oasis plugins list.');
      if (!context.autoApprove && (!context.approval || !(await context.approval('Install the reviewed Oasis plugin bundle "' + name + '" and copy its workflow skill files into this workspace?')))) {
        return { approved: false, name, message: 'Plugin installation was not approved. No files were installed.' };
      }
      await managePlugins(root, ['install', name], { quiet: true });
      return { installed: true, name, message: 'Installed the bundled workflow instructions. External integrations still require separate setup and approval.' };
    }
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
        env: context.env || process.env,
        signal: context.signal
      });
    case 'install_package': {
      const name = normalizePackageName(args.packageName);
      const plan = planPackageInstall({ packageName: name, ecosystem: args.ecosystem || 'auto', workspaceRoot: root, env: context.env || process.env });
      return await runInstallPlan(plan, { root, approval: context.approval, autoApprove: Boolean(context.autoApprove), env: context.env || process.env, signal: context.signal });
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
