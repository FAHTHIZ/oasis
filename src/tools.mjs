import { readOnlyArgv, readOnlyCommandsEnabled, readOnlyGitEnv, repoFilterOverrides } from './read-only-commands.mjs';
import { credentialEnvName } from './credential-env.mjs';
import { installSkillsFromSource, parseSkillSource } from './skill-install.mjs';
import { securityWarning } from './security-patterns.mjs';
import { argvSleepSeconds, longSleepError } from './sleep-guard.mjs';
import { atomicWriteFile } from './atomic-write.mjs';
import { injectionHoldReason } from './untrusted-content.mjs';
import * as gitSafety from './git-safety.mjs';
import { frontMatterValue, splitFrontMatter } from './frontmatter.mjs';
import { commandFlagWarning } from './command-hints.mjs';
import { condenseOutputEnabled, createOutputCondenser } from './output-condense.mjs';
import { isScratchPath } from './scratch.mjs';
import { protectedShellWrite, protectedEditsAllowed, protectedConfigPath } from './protected-paths.mjs';
import { assertFileFresh, recordFileState, forgetFileState } from './file-state.mjs';
import { relaxedReplace, closestMatchHint, typographyWarning, preserveFileConventions, matchLineEndings } from './edit-match.mjs';
import { assertNoNewElision, shrinkWarning, recordAndDetectCircling, testTamperWarning, combineWarnings } from './change-guard.mjs';
import { commentWarning } from './style-rules.mjs';
import { loadMemory } from './memory.mjs';
import { WEB_SEARCH_TOOL_DEFINITION, webSearch } from './web-search.mjs';
import { fetchPublicUrl } from './public-fetch.mjs';
import { gitVisibleFiles } from './git-visible-files.mjs';
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, unlink, lstat, realpath, stat, open as openFile } from 'node:fs/promises';
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import { PtySessionManager } from './pty-sessions.mjs';
import { snapshotFile } from './backups.mjs';
import { planPackageInstall, normalizePackageName } from './installer.mjs';
import { managePlugins } from './plugins.mjs';
import { getConfigDirectory, loadConfig, saveConfig, validateBaseUrl, isLoopbackUrl } from './config.mjs';
import { testProviderConnection } from './agent.mjs';
import { installGitHubExtension, inspectGitHubExtension } from './extensions.mjs';
import { analyzeCommand } from './permissions.mjs';
import { assertSandboxAvailable, launchCommand, sandboxLocalhostNote } from './sandbox.mjs';
import { fileGlobMatcher } from './glob.mjs';
import { isNotebookPath, readNotebook } from './notebook.mjs';
import { imageMediaType, readImageFile } from './images.mjs';
import { POWER_TOOL_DEFINITIONS, POWER_TOOL_NAMES } from './power-tool-definitions.mjs';
import { executePowerTool, startBackgroundProcess, commandLineText, timeoutToBackground, grepWorkspace } from './power-tools.mjs';
import { resolveRipgrep } from './ripgrep.mjs';
import { readTextFile, encodeText, detectTextEncoding } from './text-encoding.mjs';
import { BUILTIN_PROVIDERS, getProvider, providerApiKey, providerRegistry, sameBaseURL } from './provider-registry.mjs';
import { DIAGNOSTICS_TOOL_DEFINITION, runDiagnostics } from './diagnostics.mjs';
import { SECURITY_SCAN_TOOL_DEFINITION } from './security-scan.mjs';
import { MONITOR_TOOL_DEFINITION } from './monitor-definition.mjs';
import { assertNotAgentIgnored, filterAgentIgnored } from './agent-ignore.mjs';
import { startCommandMonitor, startWsMonitor, backgroundExitNotifier, backgroundStuckNotifier } from './monitors.mjs';
import { LSP_TOOL_DEFINITION, runLsp } from './lsp.mjs';
import { isPdfPath, readPdf } from './pdf.mjs';
import { GIT_TOOL_DEFINITIONS, runGitTool } from './git-tools.mjs';
import { loadMcpServers, saveMcpServers, validateMcpServerConfig, McpServerClient, refreshSessionMcpTools } from './mcp.mjs';
import { createCommandOutputLog } from './command-output-log.mjs';

const MAX_TEXT_FILE = 256 * 1024;
// Exact-string edits only rewrite the matched span, so they can safely handle files far
// larger than a single read (generated code, big bundles, long data files).
const MAX_EDIT_FILE = 64 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 24 * 1024;

function createBoundedOutput(maxChars = MAX_TOOL_OUTPUT) {
  const headLimit = Math.floor(maxChars / 3);
  const tailLimit = Math.floor(maxChars / 3);
  const maxErrorLines = 25;
  const maxErrorLineChars = 220;
  const maxErrorChars = Math.floor(maxChars / 4);
  const errorPattern = /\b(?:error|failed|failure|exception|fatal|traceback|panic|segmentation fault|not found|timed out)\b|npm\s+ERR!|TS\d{3,5}:/i;
  let complete = '';
  let head = '';
  let tail = '';
  let totalChars = 0;
  let truncated = false;
  let lineBuffer = '';
  let errorChars = 0;
  const firstErrors = [];
  const recentErrors = [];

  function rememberError(line) {
    if (!errorPattern.test(line)) return;
    const text = String(line).trim().slice(0, maxErrorLineChars);
    if (!text || firstErrors.includes(text) || recentErrors.includes(text)) return;
    if (firstErrors.length < 5) {
      firstErrors.push(text);
      errorChars += text.length;
      return;
    }
    recentErrors.push(text);
    errorChars += text.length;
    while (recentErrors.length > maxErrorLines - firstErrors.length || errorChars > maxErrorChars) {
      const removed = recentErrors.shift();
      if (!removed) break;
      errorChars -= removed.length;
    }
  }

  function scanErrors(text) {
    lineBuffer += text;
    let newline = lineBuffer.indexOf('\n');
    while (newline >= 0) {
      rememberError(lineBuffer.slice(0, newline).replace(/\r$/, ''));
      lineBuffer = lineBuffer.slice(newline + 1);
      newline = lineBuffer.indexOf('\n');
    }
    if (lineBuffer.length > 16 * 1024) {
      // Keep only a small bounded preview of a pathological unbroken line.
      rememberError(lineBuffer.slice(0, maxErrorLineChars));
      lineBuffer = lineBuffer.slice(-maxErrorLineChars);
    }
  }

  function errorSection() {
    if (lineBuffer) rememberError(lineBuffer);
    const lines = [...firstErrors, ...recentErrors];
    return lines.length
      ? '\n\n[Error/failure lines retained from command output]\n' + lines.join('\n') + '\n'
      : '';
  }

  return {
    append(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      totalChars += text.length;
      scanErrors(text);
      if (!truncated) {
        complete += text;
        if (complete.length <= maxChars) return;
        truncated = true;
        head = complete.slice(0, headLimit);
        tail = complete.slice(-tailLimit);
        complete = '';
        return;
      }
      tail = (tail + text).slice(-tailLimit);
    },
    text(logPath = null, logTruncated = false) {
      if (!truncated) return complete;
      const omitted = Math.max(0, totalChars - head.length - tail.length);
      const errors = errorSection();
      const saved = logPath
        ? 'Full redacted output saved to ' + logPath + (logTruncated ? ' (file capped at 32 MiB).' : '.')
        : 'The full output could not be saved to a local log file.';
      return head + errors + '\n[OASIS omitted ' + omitted + ' characters from the middle of command output. ' + saved + ']\n' + tail;
    },
    get truncated() { return truncated; }
  };
}

const BUNDLED_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.venv', 'venv', 'vendor', 'target']);
const SKIP_DIRS_RE = new RegExp('(^|/)(' + [...SKIP_DIRS].map((d) => d.replace(/[.]/g, '\\.')).join('|') + ')/');

export const TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'git_status', description: 'Show the Git branch and working-tree status (read-only).', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'git_diff', description: 'Show the Git diff (read-only, size-bounded): unstaged, staged or all changes against HEAD, optionally for one path.', parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['unstaged', 'staged', 'all'], description: 'Default all' }, path: { type: 'string', description: 'Workspace-relative path' } }, required: [] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files and folders in a workspace directory. Skips dependencies, build output, .git and secret files.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative directory; default .' }, includeHidden: { type: 'boolean', description: 'Include hidden files (never secret files)' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a workspace file; use offset and limit for line ranges of large files. Images (png, jpg, gif, webp) are shown visually, notebooks cell by cell, PDFs as text. Secret files (.env, keys) are blocked.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' }, offset: { type: 'integer', description: '1-based first line' }, limit: { type: 'integer', description: 'Max lines, 1-2000' }, pages: { type: 'string', description: 'PDF pages, e.g. "3" or "1-10" (max 50)' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'repo_map', description: 'Get a compact, ranked map of the repository: source files with their top-level functions, classes and types (with line numbers). Most-referenced files come first. Use it first in an unfamiliar codebase, or with focus to find where something lives, before reading whole files.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative directory to map; defaults to the whole workspace' }, focus: { type: 'array', items: { type: 'string' }, description: 'Files, directories or symbol names to rank first' }, max_chars: { type: 'integer', description: 'Output budget in characters, 1000 to 60000; defaults to 12000' } } } } },
  { type: 'function', function: { name: 'glob_files', description: 'Find files by glob (**, *, ?), e.g. src/**/*.mjs. Skips dependencies, .git and secret files.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Workspace-relative glob, no ..' }, path: { type: 'string', description: 'Folder; default the root' }, limit: { type: 'integer', description: '1-500; default 200' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'search_files', description: 'Search workspace text files for a literal case-insensitive string. Returns matching lines and paths, excluding secret files and dependency/build directories.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Literal phrase or symbol to search for' }, path: { type: 'string', description: 'Folder or file to search in; default the whole workspace' }, limit: { type: 'integer', description: 'Maximum matching lines, 1 to 60; defaults to 25' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a workspace text file (old contents are checkpointed). Use edit_file to change part of an existing file. For a long new file (over ~300 lines), write it in parts: the first part normally, then each next part with append: true.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' }, content: { type: 'string', description: 'Complete file contents, or the next part when append is true' }, append: { type: 'boolean', description: 'Add content to the end of the file instead of replacing it' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'todo_write', description: 'Replace the task checklist; send the COMPLETE list each time. Mark an item completed only after verifying it. Session state only; edits no files.', parameters: { type: 'object', properties: { todos: { type: 'array', maxItems: 50, items: { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 200 }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'], additionalProperties: false } } }, required: ['todos'], additionalProperties: false } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete one file inside the workspace. Requires explicit interactive approval even in auto mode. Directories and sensitive files cannot be deleted with this tool.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run one program with an argument list in the workspace (no shell syntax). Read-only commands run at once; others need approval unless --yes. Destructive programs and shell interpreters are blocked unless allowed.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Executable, e.g. npm or git' }, args: { type: 'array', items: { type: 'string' }, description: 'Arguments, e.g. ["test"]' }, timeoutSeconds: { type: 'integer', description: '5-600; default 120. On timeout it keeps running in the background (command_output).' }, run_in_background: { type: 'boolean', description: 'For servers and watchers: returns an id; read with command_output, stop with kill_command.' }, max_seconds: { type: 'integer', description: 'With run_in_background: stop after this many seconds.' }, interactive: { type: 'boolean', description: 'Real terminal for REPLs and prompts, driven with terminal_* tools. Not with run_in_background.' } }, required: ['command', 'args'] } } },
  { type: 'function', function: { name: 'install_package', description: 'Install one requested package or developer tool using a detected package manager. Accepts auto, npm, npm-global, pip, pipx, system, cargo, or go ecosystems. Installation requires approval unless --yes was explicitly enabled.', parameters: { type: 'object', properties: { packageName: { type: 'string', description: 'A single package identifier, not a URL or shell command' }, ecosystem: { type: 'string', enum: ['auto', 'npm', 'npm-global', 'pip', 'pipx', 'system', 'cargo', 'go'], description: 'Package ecosystem; auto chooses based on known tools and the project' } }, required: ['packageName'] } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch a public http(s) page; HTML becomes Markdown of the main content. If truncated, call again with start_index = nextStartIndex. Private addresses and credentials are blocked.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Public http(s) URL' }, start_index: { type: 'integer', description: 'nextStartIndex to continue from' }, max_length: { type: 'integer', description: '500-24576 characters (default 24576)' }, raw: { type: 'boolean', description: 'Raw HTML instead of Markdown' }, full_page: { type: 'boolean', description: 'Whole page, not only the main content' } }, required: ['url'] } } },

  { type: 'function', function: { name: 'edit_file', description: 'Edit an existing file by replacing an exact string (preferred over write_file). old_string must match exactly and be unique unless replace_all. Contents are checkpointed first.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' }, old_string: { type: 'string', description: 'Exact current text, non-empty' }, new_string: { type: 'string', description: 'Replacement' }, replace_all: { type: 'boolean', description: 'Replace every occurrence' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'list_skills', description: 'List available built-in and workspace skill names with one-line descriptions. Skills are loaded on demand to keep the main context compact.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'load_skill', description: 'Load a skill\'s full instructions before work that matches its description.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name' }, arguments: { type: 'string', description: 'Task details; a context: fork skill runs in a subagent with them and returns its report' }, offset: { type: 'integer', minimum: 0, description: 'Character offset to continue a long skill from (the nextOffset of the previous result)' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'read_skill_resource', description: 'Read a text reference or asset shipped with an installed portable Agent Skill. Only integrity-verified files under that skill’s references/ or assets/ folders can be read; scripts are not exposed by this tool.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Installed skill name returned by list_skills or load_skill' }, path: { type: 'string', description: 'Relative path under references/ or assets/, such as references/checklist.md' }, offset: { type: 'integer', minimum: 0, description: 'Character offset to continue a long file from (the nextOffset of the previous result)' } }, required: ['name', 'path'] } } },
  { type: 'function', function: { name: 'run_specialist_review', description: 'Run one bounded specialist review in a separate read-only model session. Available roles: code-review, security-review, architecture, and test-strategy. The reviewer can inspect workspace files and Git diffs, but cannot edit files, run commands, install packages, access MCP tools, or perform external side effects. Up to two reviews are allowed per task; use for an independent second opinion, not for changes.', parameters: { type: 'object', properties: { specialist: { type: 'string', enum: ['code-review', 'security-review', 'architecture', 'test-strategy'], description: 'Focus of the independent review' }, task: { type: 'string', description: 'A bounded review request; include relevant files or the question to investigate' } }, required: ['specialist', 'task'], additionalProperties: false } } },
  { type: 'function', function: { name: 'install_extension', description: 'Inspect and import a public GitHub repository containing Markdown specialist-agent or skill prompts. Import only the selected Markdown prompts; do not execute scripts, install dependencies, or enable MCP servers. Scope self installs into Oasis user configuration, project installs into the current workspace, and both installs to both locations. Always obtain approval before importing an external repository.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Public GitHub repository URL, for example https://github.com/msitarzewski/agency-agents' }, scope: { type: 'string', enum: ['self', 'project', 'both'], description: 'Install into Oasis itself, the current project, or both' } }, required: ['url', 'scope'] } } },
  { type: 'function', function: { name: 'configure_provider', description: 'Connect Oasis to a known model provider and switch the current chat to it only after an inert tool-call probe succeeds. Providers: ' + Object.keys(BUILTIN_PROVIDERS).join(', ') + ', plus any defined under "providers" in user settings. This tool never accepts API keys; it may use only the matching saved credential or provider-specific environment variable.', parameters: { type: 'object', properties: { provider: { type: 'string', maxLength: 40, description: 'Provider id, e.g. openai, anthropic, openrouter, gemini, groq, ollama' }, model: { type: 'string', maxLength: 200, description: 'Optional exact model ID; Ollama/OpenRouter-compatible models may require an account- or server-specific ID.' } }, required: ['provider'], additionalProperties: false } } },
  { type: 'function', function: { name: 'install_external_skill', description: 'Install a selected Agent Skill (a SKILL.md package) from a GitHub repository, Git URL or local folder. OASIS downloads and copies the files itself; it does not run skill scripts, activate hooks, or configure MCP. Requires approval and imports the instructions as untrusted content. Choose one exact skill or set all=true.', parameters: { type: 'object', properties: { source: { type: 'string', maxLength: 600, description: 'Public GitHub shorthand owner/repo, HTTPS source URL, SSH/Git URL, or a local path.' }, skill: { type: 'string', maxLength: 128, description: 'Exact skill name to install; mutually exclusive with all=true.' }, all: { type: 'boolean', description: 'Install all skills from this source into the universal Agent Skills directory.' }, scope: { type: 'string', enum: ['project', 'global'], description: 'Project .agents/skills or user-level universal skills directory.' } }, required: ['source', 'scope'], additionalProperties: false } } },
  { type: 'function', function: { name: 'configure_mcp_server', description: 'Configure and start a local stdio MCP server, then expose its tools in the current chat session. Requires manual approval even when --yes is active. The command, arguments, and environment-variable names are shown for review; never pass secret values in arguments.', parameters: { type: 'object', properties: { name: { type: 'string', maxLength: 40, description: 'Unique lowercase server name using letters, digits, hyphens, or underscores.' }, command: { type: 'string', maxLength: 500, description: 'Single executable, such as npx or a locally installed executable; no shell syntax.' }, args: { type: 'array', maxItems: 80, items: { type: 'string', maxLength: 5000 }, description: 'Argument vector passed directly without shell expansion.' }, passEnv: { type: 'array', maxItems: 50, items: { type: 'string' }, description: 'Explicit environment variable names to expose to this server; values must be configured locally, never supplied in chat.' } }, required: ['name', 'command'], additionalProperties: false } } },
  { type: 'function', function: { name: 'add_extension', description: 'Install and set up an add-on from whatever the user gave: a GitHub link or owner/repo (Claude Code, Codex and Gemini CLI plugins and marketplaces, OASIS plugins, Agent Skills, MCP servers, agent prompts), plugin@marketplace, an MCP server URL, an npm/PyPI package page, an MCP Registry name, or an install command copied from a README (npx/uvx/docker, claude|codex|gemini mcp add, /plugin install, npx skills add). OASIS detects the kind, asks the user once and configures it; MCP servers start in this chat. Use #name to pick one plugin, skill or server from a repository.', parameters: { type: 'object', properties: { source: { type: 'string', description: 'Exactly what the user gave, e.g. https://github.com/obra/superpowers, anthropics/skills#pdf, commit-commands@claude-code-plugins, https://mcp.context7.com/mcp, @playwright/mcp or github.' }, name: { type: 'string', description: 'Optional local name for an MCP server.' }, scope: { type: 'string', enum: ['user', 'project'], description: 'user (default, every project) or project.' }, env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values it needs, such as an API key the user gave you: {"GITHUB_TOKEN": "..."}. With the name of something already installed as source, this only saves the values; for a remote server a token becomes its Authorization header.' } }, required: ['source'], additionalProperties: false } } },
  { type: 'function', function: { name: 'install_plugin', description: 'Install one reviewed Oasis built-in capability bundle into this workspace. Bundles copy skill instruction files only; external servers, package installs, and credentials are not enabled automatically. Requires user approval unless auto-approval is explicitly enabled.', parameters: { type: 'object', properties: { name: { type: 'string', enum: ['code-quality', 'project-onboarding', 'debugging', 'ship-feature', 'mobile-development', 'web-app-development', 'api-development', 'security-review'], description: 'Name of the built-in plugin bundle from oasis plugins list' } }, required: ['name'] } } }
];

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function sensitivePath(relative) {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    const name = part.toLowerCase();
    if (['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker'].includes(name)) return true;
    if (/^\.env(?:$|\.)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) return true;
    // .envrc (direnv exports), .pgpass, .my.cnf, .htpasswd and .dockercfg hold passwords or tokens too.
    if (['.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml', '.envrc', '.pgpass', '.my.cnf', '.htpasswd', '.dockercfg'].includes(name)) return true;
    // Google service-account keys and Terraform state (which stores provider secrets in plain text).
    if (/^(?:service[-_]account(?:[-_][^/]*)?\.json|terraform\.tfstate(?:\.backup)?)$/.test(name)) return true;
    if (/^(?:id_rsa|id_ed25519|id_ecdsa|known_hosts|authorized_keys)$/i.test(name)) return true;
    if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return true;
  }
  return false;
}

// Extra directories (--add-dir / permissions.additionalDirectories) that tools may
// use besides the workspace, keyed by the workspace's real path.
const ADDITIONAL_DIRECTORIES = new Map();

export async function setAdditionalDirectories(root, dirs = []) {
  const rootReal = await realpath(root);
  const accepted = [];
  const rejected = [];
  for (const dir of dirs) {
    const input = String(dir || '').trim();
    if (!input) continue;
    try {
      const real = await realpath(path.resolve(rootReal, input.replace(/^~(?=$|[\\/])/, os.homedir())));
      const info = await lstat(real);
      if (!info.isDirectory()) throw new Error('not a directory');
      if (real === path.parse(real).root || real === os.homedir()) throw new Error('too broad; choose a project folder');
      // ~/.aws, ~/.ssh and the like: files inside have plain names (credentials, config).
      if (sensitivePath(real)) throw new Error('holds credentials; Oasis will not open it');
      if (inside(rootReal, real) || accepted.includes(real)) continue;
      accepted.push(real);
    } catch (error) {
      rejected.push({ dir: input, error: error.code === 'ENOENT' ? 'does not exist' : error.message });
    }
  }
  if (accepted.length) ADDITIONAL_DIRECTORIES.set(rootReal, accepted);
  else ADDITIONAL_DIRECTORIES.delete(rootReal);
  return { accepted, rejected };
}

export function additionalDirectories(rootReal) {
  return ADDITIONAL_DIRECTORIES.get(rootReal) || [];
}

export async function resolveWorkspacePath(root, rawPath, options = {}) {
  const rootReal = await realpath(root);
  const input = String(rawPath || '.');
  if (input.includes('\0')) throw new Error('Invalid path.');
  const target = path.resolve(rootReal, input);
  let base = rootReal;
  if (!inside(rootReal, target) && !options.workspaceOnly) {
    const extra = additionalDirectories(rootReal).find((dir) => inside(dir, target));
    if (extra) base = extra;
  }
  if (!inside(base, target) || target === path.parse(base).root) throw new Error('That path is outside the workspace.');
  // Paths in extra directories are reported relative to the workspace (../other/file).
  const relative = path.relative(rootReal, target);
  const baseRelative = path.relative(base, target);
  // In an extra directory the folder names above it count too (a grant of ~/work/.aws).
  const checkedRelative = base === rootReal ? baseRelative : target;
  if (!options.allowSensitive && sensitivePath(checkedRelative)) throw new Error('That file path looks sensitive. Oasis will not read, overwrite, or delete it.');
  let cursor = target;
  while (true) {
    try {
      const linkInfo = await lstat(cursor);
      if (cursor === target && options.rejectSymlinks && linkInfo.isSymbolicLink()) throw new Error('Oasis will not write to or delete a symbolic link.');
      const resolved = await realpath(cursor);
      if (!inside(base, resolved)) throw new Error('That path resolves outside the workspace through a symbolic link.');
      const resolvedRelative = base === rootReal ? path.relative(base, resolved) : resolved;
      if (!options.allowSensitive && sensitivePath(resolvedRelative)) throw new Error('That symbolic link resolves to a sensitive file. Oasis will not access it.');
      if (cursor === target) {
        if (!options.allowIgnored && relative) {
          const ignoreOptions = { env: options.env, isDir: linkInfo.isDirectory(), shown: relative.split(path.sep).join('/') };
          await assertNotAgentIgnored(target, ignoreOptions);
          if (resolved !== target) await assertNotAgentIgnored(resolved, { ...ignoreOptions, isDir: (await stat(resolved).catch(() => null))?.isDirectory() });
        }
        return { absolute: target, real: resolved, relative: relative || '.', root: base, external: base !== rootReal };
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('Could not resolve a safe workspace path.');
      cursor = parent;
    }
  }
  const existingAncestor = await realpath(cursor);
  if (!inside(base, existingAncestor)) throw new Error('That path resolves outside the workspace through a symbolic link.');
  // A new file is refused too when an ignore file covers it (Devin Desktop: no creating files there).
  if (!options.allowIgnored && relative) await assertNotAgentIgnored(target, { env: options.env, shown: relative.split(path.sep).join('/') });
  return { absolute: target, real: target, relative: relative || '.', root: base, external: base !== rootReal };
}

function shouldSkip(entry, includeHidden) {
  if (entry.isSymbolicLink()) return true;
  if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) return true;
  if (!includeHidden && entry.name.startsWith('.')) return true;
  return false;
}

// maxFiles caps the files returned. options.filter (forward-slash relative
// path => boolean) is applied before that cap, so callers looking for specific
// files see the whole tree; the plain walk still stops after maxScan entries.
export async function walkFiles(root, options = {}) {
  const includeHidden = Boolean(options.includeHidden);
  const maxFiles = options.maxFiles || 1200;
  const maxDepth = options.maxDepth || 9;
  const maxScan = options.maxScan || 250000;
  const filter = typeof options.filter === 'function' ? options.filter : null;
  if (options.respectGitignore !== false) {
    const visible = await gitVisibleFiles(root, { maxFiles, maxDepth, includeHidden, skipDirs: SKIP_DIRS, skip: (rel) => sensitivePath(rel), filter, env: options.env }).catch(() => null);
    if (visible) return options.allowIgnored ? visible : filterAgentIgnored(visible, (item) => item.absolute, { env: options.env });
  }
  const output = [];
  let scanned = 0;
  async function walk(dir, depth) {
    if (depth > maxDepth || output.length >= maxFiles || scanned >= maxScan) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= maxFiles || ++scanned > maxScan) break;
      if (shouldSkip(entry, includeHidden)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (sensitivePath(rel)) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && (!filter || filter(rel.split(path.sep).join('/')))) output.push({ absolute: full, relative: rel });
    }
  }
  await walk(root, 0);
  return options.allowIgnored ? output : filterAgentIgnored(output, (item) => item.absolute, { env: options.env });
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

// ACP editors (Zed and others) can serve file contents from open, unsaved buffers and
// apply writes to them; everything falls back to the disk when no client fs is present.
async function clientReadText(context, absolute) {
  const clientFs = context && context.session && context.session.clientFs;
  if (!clientFs || typeof clientFs.readTextFile !== 'function') return null;
  try { const text = await clientFs.readTextFile(absolute); return typeof text === 'string' ? text : null; } catch { return null; }
}

async function clientMirrorWrite(context, absolute, content) {
  const clientFs = context && context.session && context.session.clientFs;
  if (!clientFs || typeof clientFs.writeTextFile !== 'function') return;
  try { await clientFs.writeTextFile(absolute, content); } catch {}
}

export async function readWorkspaceFile(root, rawPath, options = {}) {
  const target = await resolveWorkspacePath(root, rawPath);
  const info = await stat(target.absolute);
  if (!info.isFile()) throw new Error('That path is not a file.');
  let ranged = options.offset !== undefined || options.limit !== undefined;
  // A big file without a range: show its start, as Claude Code's Read does,
  // instead of an error that costs the model a round trip.
  const implicit = !ranged && info.size > MAX_TEXT_FILE;
  if (implicit) ranged = true;
  if (info.size > MAX_RANGED_FILE) return streamFileSlice(target, info, options, implicit);
  const fromClient = options.context ? await clientReadText(options.context, target.absolute) : null;
  const decoded = fromClient !== null ? { text: fromClient, encoding: 'utf8' } : await readTextFile(target.absolute);
  const content = decoded.text;
  if (content.includes('\0')) throw new Error('This looks like a binary file and is not supported by read_file.');
  const relativePath = target.relative.split(path.sep).join('/');
  // Non-UTF-8 text is reported so the model knows edits keep that encoding.
  const encodingNote = decoded.encoding === 'utf8' ? {} : { encoding: decoded.encoding };
  if (!ranged) return { path: relativePath, content, ...encodingNote };
  const lines = content.split('\n');
  const startLine = Math.max(1, Number.parseInt(options.offset, 10) || 1);
  const count = Math.max(1, Math.min(2000, Number.parseInt(options.limit, 10) || 2000));
  let slice = lines.slice(startLine - 1, startLine - 1 + count);
  let clipped = false;
  if (implicit) slice = slice.map((line) => { if (line.length <= MAX_LINE_CHARS) return line; clipped = true; return line.slice(0, MAX_LINE_CHARS) + ' …[line truncated]'; });
  let text = slice.join('\n');
  let truncated = false;
  if (text.length > MAX_TEXT_FILE) { text = text.slice(0, MAX_TEXT_FILE); truncated = true; }
  const endLine = startLine + slice.length - 1;
  return { path: relativePath, content: text, startLine, endLine, totalLines: lines.length, truncated: truncated || clipped || startLine - 1 + count < lines.length, ...(implicit ? { note: bigFileNote(info.size, startLine, endLine, lines.length, clipped) } : {}) };
}

const MAX_LINE_CHARS = 2000;
// edit_file arguments in other shapes: old_str/new_str, oldString/newString,
// search/replace, or a small unified diff in changes/diff/patch ("-old\n+new").
// The edit still has to match the file exactly, so nothing is guessed.
export function editFileArgs(args = {}) {
  if (typeof args.old_string === 'string' && typeof args.new_string === 'string') return args;
  const next = { ...args };
  for (const [from, to] of [['old_str', 'old_string'], ['oldString', 'old_string'], ['old_text', 'old_string'], ['search', 'old_string'], ['new_str', 'new_string'], ['newString', 'new_string'], ['new_text', 'new_string'], ['replace', 'new_string']]) {
    if (typeof next[to] !== 'string' && typeof next[from] === 'string') next[to] = next[from];
  }
  const diff = [next.changes, next.diff, next.patch].find((value) => typeof value === 'string');
  if ((typeof next.old_string !== 'string' || typeof next.new_string !== 'string') && diff) {
    const lines = diff.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').filter((line) => !/^(?:@@.*|--- .*|\+\+\+ .*)$/.test(line));
    if (lines.some((line) => /^[-+]/.test(line)) && lines.every((line) => /^[-+ ]/.test(line) || line === '')) {
      next.old_string = lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1)).join('\n');
      next.new_string = lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1)).join('\n');
    }
  }
  if (typeof next.old_string !== 'string' || typeof next.new_string !== 'string') {
    throw new Error('edit_file needs old_string (exact text copied from read_file) and new_string' + (Object.keys(args).length ? '; got ' + Object.keys(args).join(', ') : '') + '. To rewrite a whole file use write_file.');
  }
  return next;
}

// Models often send line ranges in other shapes (line_start/line_end,
// start_line/end_line, startLine/endLine). Ignoring them returned the whole
// file, wasting context; map them onto offset/limit instead.
export function readRangeArgs(args = {}) {
  const pick = (...keys) => { for (const key of keys) { const value = Number.parseInt(args[key], 10); if (Number.isFinite(value)) return value; } return undefined; };
  let offset = args.offset;
  let limit = args.limit;
  const start = pick('line_start', 'start_line', 'startLine', 'lineStart', 'from_line', 'start');
  const end = pick('line_end', 'end_line', 'endLine', 'lineEnd', 'to_line', 'end');
  if (offset === undefined && start !== undefined) offset = Math.max(1, start);
  if (limit === undefined && end !== undefined) limit = Math.max(1, end - (Number.parseInt(offset, 10) || 1) + 1);
  if (limit === undefined) { const count = pick('lines', 'num_lines', 'count', 'max_lines'); if (count !== undefined) limit = Math.max(1, count); }
  return { offset, limit };
}

function bigFileNote(size, startLine, endLine, totalLines, clipped) {
  return 'File is ' + (size / 1048576).toFixed(1) + ' MB; showing lines ' + startLine + '-' + endLine + (totalLines ? ' of ' + totalLines : '') + (clipped ? ', long lines cut at ' + MAX_LINE_CHARS + ' characters' : '') + '. Pass offset and limit to read other parts, or grep for what you need.';
}

// Files over 4 MiB: read only the requested lines from a stream.
async function streamFileSlice(target, info, options, implicit) {
  const handle = await openFile(target.absolute, 'r');
  try {
    const probe = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (detectTextEncoding(probe.subarray(0, bytesRead)) !== 'utf8') throw new Error('This UTF-16 file is over 4 MiB; read_file reads UTF-16 files up to that size. Use run_command (for example iconv) to inspect it.');
    if (probe.subarray(0, bytesRead).includes(0)) throw new Error('This looks like a binary file and is not supported by read_file.');
  } finally { await handle.close(); }
  const startLine = Math.max(1, Number.parseInt(options.offset, 10) || 1);
  const count = Math.max(1, Math.min(2000, Number.parseInt(options.limit, 10) || 2000));
  const stream = createReadStream(target.absolute, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const slice = [];
  let lineNumber = 0;
  let clipped = false;
  let more = false;
  let bytes = 0;
  for await (const line of reader) {
    lineNumber++;
    if (lineNumber < startLine) continue;
    if (slice.length >= count || bytes > MAX_TEXT_FILE) { more = true; break; }
    const shown = line.length > MAX_LINE_CHARS ? (clipped = true, line.slice(0, MAX_LINE_CHARS) + ' …[line truncated]') : line;
    slice.push(shown);
    bytes += shown.length + 1;
  }
  reader.close(); stream.destroy();
  const relativePath = target.relative.split(path.sep).join('/');
  const endLine = startLine + slice.length - 1;
  return { path: relativePath, content: slice.join('\n'), startLine, endLine, ...(more ? {} : { totalLines: lineNumber }), truncated: more || clipped, note: bigFileNote(info.size, startLine, endLine, more ? 0 : lineNumber, clipped) };
}

// Models trained on Claude Code send { path: "src", pattern: "*.mjs" }. The
// folder used to be ignored, so the search ran at the root and found nothing.
export function globPatternWithPath(pattern, folder) {
  const text = String(pattern || '').trim();
  const base = String(folder || '').trim().replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '');
  if (!base || base === '.' || !text) return text;
  if (text === base || text.startsWith(base + '/')) return text;
  return base + '/' + text.replace(/^\.\//, '');
}

export async function globWorkspaceFiles(root, pattern, limit = 200) {
  const text = String(pattern || '').trim();
  if (!text) throw new Error('Glob pattern cannot be empty.');
  if (text.length > 300) throw new Error('Glob pattern is too long.');
  if (text.includes('\0') || path.isAbsolute(text) || text.split(/[\\/]+/).includes('..')) throw new Error('Glob patterns must be relative to the workspace and cannot contain "..".');
  const maxResults = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 200));
  const matcher = fileGlobMatcher(text);
  const base = await realpath(root);
  // The matcher runs while listing, so the cap counts matches, not files seen.
  const files = await walkFiles(base, { includeHidden: true, maxFiles: maxResults + 1, maxDepth: 24, filter: matcher });
  const matches = files.slice(0, maxResults).map((file) => file.relative.split(path.sep).join('/'));
  const result = { pattern: text, matches, truncated: files.length > maxResults };
  // "*.mjs" only covers the project root. Models often mean "anywhere" and
  // then conclude the files do not exist, so say where they are.
  if (!matches.length && !text.includes('/') && !text.startsWith('**')) {
    const nested = (await walkFiles(base, { includeHidden: true, maxFiles: 6, maxDepth: 24, filter: fileGlobMatcher('**/' + text) }))
      .map((file) => file.relative.split(path.sep).join('/'));
    if (nested.length) {
      result.hint = 'No file at the project root matches "' + text + '", but ' + (nested.length > 5 ? 'more than 5 files' : nested.length + ' file' + (nested.length === 1 ? '' : 's')) + ' in subfolders match "**/' + text + '", for example: ' + nested.slice(0, 5).join(', ') + '.';
    }
  }
  return result;
}
// Long lines (minified CSS/JS) are cut to a window around the first match so
// one hit does not cost hundreds of characters of unrelated text.
function matchSnippet(line, lowerNeedle) {
  if (line.length <= 240) return line;
  const at = Math.max(0, line.toLowerCase().indexOf(lowerNeedle));
  const start = Math.max(0, at - 80);
  return (start > 0 ? '…' : '') + line.slice(start, start + 200) + (start + 200 < line.length ? '…' : '');
}

const REGEX_LOOKING = /\||\.\*|\.\+|\\[bdswBDSW]|^\^|\$$|\[[^\]]+\]|\(\?/;

// An empty result says why, so a model does not keep re-searching blind
// (seen live: five empty search_files calls in a row on a small task).
function emptySearchHint(needle, prefix) {
  const words = needle.trim().split(/\s+/);
  return 'No matches' + (prefix ? ' under ' + prefix : '') + '. search_files matches one literal, case-insensitive string' +
    (words.length > 2 ? '; this query has ' + words.length + ' words, so try one distinctive word or symbol' : '') +
    '. Use grep for a regex, glob_files to find files by name, or list_files to see what exists. If the code does not exist yet, stop searching and create it.';
}

// The per-call hint did not stop gpt-oss-120b from running ~20 differently
// worded empty searches in a row (live head-to-head, 14 Nov 2026, ~200k
// tokens). After three misses in a row the hint names them and says plainly
// what to do next. Any search with a match resets the count.
const SEARCH_MISS_ESCALATE = 3;
export function trackSearchMisses(session, result) {
  if (!session || !result || !Array.isArray(result.matches)) return result;
  if (result.matches.length) { session.searchMisses = []; return result; }
  const misses = (session.searchMisses = [...(session.searchMisses || []), String(result.query || '')].slice(-8));
  if (misses.length < SEARCH_MISS_ESCALATE) return result;
  return {
    ...result,
    hint: misses.length + ' searches in a row found nothing (' + misses.slice(-5).map((q) => JSON.stringify(q.slice(0, 40))).join(', ') + '). ' +
      'What you are looking for most likely does not exist in this workspace yet. Stop searching: create it where the task says, ' +
      'or run list_files once on the folder you expect it in.'
  };
}

// Large single-file sources (TypeScript's checker.ts is 2.8 MB, sqlite3.c 9 MB)
// must be searchable; at 256 KiB they returned no matches without a word.
const SEARCH_MAX_BYTES = 16 * 1024 * 1024;
const SEARCH_MAX_FILESIZE = '16M';

export async function searchWorkspaceFiles(root, query, limit = 25, scope) {
  const needle = String(query || '');
  if (!needle.trim()) throw new Error('Search query cannot be empty.');
  if (needle.length > 500) throw new Error('Search query is too long.');
  const maxResults = Math.max(1, Math.min(60, Number.parseInt(limit, 10) || 25));
  let prefix = '';
  if (scope && !/^\.?\/?$/.test(String(scope))) {
    const target = await resolveWorkspacePath(root, scope, { workspaceOnly: true });
    prefix = target.relative.split(path.sep).join('/');
  }
  const lowerNeedle = needle.toLowerCase();
  // ripgrep searches the whole tree (honouring .gitignore) in parallel; the
  // JavaScript scan below is the fallback when no rg binary is available.
  if (resolveRipgrep(process.env)) {
    const found = await grepWorkspace(root, { pattern: needle, ignore_case: true, path: prefix || '.', limit: maxResults }, { fixedStrings: true, maxFilesize: SEARCH_MAX_FILESIZE, fullLines: true });
    const matches = [];
    for (const line of found.results) {
      const m = line.match(/^(.*?):(\d+):(.*)$/s);
      if (!m || SKIP_DIRS_RE.test(m[1])) continue;
      matches.push({ path: m[1], line: Number(m[2]), text: matchSnippet(m[3], lowerNeedle) });
    }
    if (!matches.length && REGEX_LOOKING.test(needle)) {
      // Models often send `a|b` or `foo.*bar` here. Retry once as a regex.
      try {
        const retry = await grepWorkspace(root, { pattern: needle, ignore_case: true, path: prefix || '.', limit: maxResults }, { maxFilesize: SEARCH_MAX_FILESIZE, fullLines: true });
        for (const line of retry.results) {
          const m = line.match(/^(.*?):(\d+):(.*)$/s);
          if (!m || SKIP_DIRS_RE.test(m[1])) continue;
          matches.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 200) });
        }
        if (matches.length) return { query: needle, matches, truncated: retry.truncated, note: 'No literal match, so the query was searched as a regular expression.' };
      } catch {}
    }
    return matches.length ? { query: needle, matches, truncated: found.truncated } : { query: needle, matches, truncated: false, hint: emptySearchHint(needle, prefix) };
  }
  const inScope = (rel) => !prefix || prefix === '.' || rel === prefix || rel.startsWith(prefix + '/');
  const files = await walkFiles(await realpath(root), { includeHidden: true, maxFiles: 20000, maxDepth: 24, filter: inScope });
  const matches = [];
  for (const file of files) {
    let info;
    try { info = await stat(file.absolute); } catch { continue; }
    if (info.size > SEARCH_MAX_BYTES) continue;
    let content;
    try { content = await readFile(file.absolute, 'utf8'); } catch { continue; }
    if (content.includes('\0')) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerNeedle)) {
        matches.push({ path: file.relative.split(path.sep).join('/'), line: i + 1, text: matchSnippet(lines[i], lowerNeedle) });
        if (matches.length >= maxResults) return { query: needle, matches, truncated: true };
      }
    }
  }
  return matches.length ? { query: needle, matches, truncated: false } : { query: needle, matches, truncated: false, hint: emptySearchHint(needle, prefix) };
}

export function scrubEnvironment(source = process.env) {
  const allow = new Set(String(source.OASIS_COMMAND_ENV_ALLOWLIST || '').split(',').map((item) => item.trim()).filter(Boolean));
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (credentialEnvName(key) && !allow.has(key)) continue;
    if (key === 'OASIS_COMMAND_ENV_ALLOWLIST') continue;
    env[key] = value;
  }
  return env;
}

// Agent commands have no usable terminal: stdin is closed and nobody is watching
// a pager or editor. Without these, `git log` / `git commit` (no -m) / a git clone
// that wants a password can open /dev/tty and hang until the timeout. Applied to
// non-interactive run_command / run_shell children; OASIS_NONINTERACTIVE_ENV=0 opts out.
export function nonInteractiveEnvironment(env, source = process.env) {
  if (String(source.OASIS_NONINTERACTIVE_ENV || '').trim() === '0') return env;
  const next = { ...env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never', DEBIAN_FRONTEND: 'noninteractive', PIP_NO_INPUT: '1', HOMEBREW_NO_AUTO_UPDATE: '1' };
  if (process.platform !== 'win32') { next.EDITOR = 'true'; next.VISUAL = 'true'; }
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) next.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return next;
}

// Agents love to drop FINAL_SUMMARY.md / IMPLEMENTATION_NOTES.md files nobody asked for.
const SUMMARY_DOC = /^(?:[A-Z0-9]+[_-])*(?:SUMMARY|REPORT|NOTES|CHANGES|CHANGELOG_SUMMARY|IMPLEMENTATION|FIXES|PROGRESS|STATUS|ANALYSIS|COMPLETION|WALKTHROUGH|OVERVIEW)(?:[_-][A-Z0-9]+)*\.md$/;
// Seen live (glob-match eval): a model wrote `require.main === module` into
// an ES module; tests passed because nothing imported it, and the file threw
// "require is not defined" on first use. Flag mixed module systems at write time.
export function moduleSystemIssues(displayPath, content, packageType = '') {
  const ext = path.posix.extname(String(displayPath || '')).toLowerCase();
  const esm = ext === '.mjs' || (ext === '.js' && packageType === 'module');
  const code = String(content || '').split(/\r?\n/).filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n')
    .replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
  const issues = [];
  if (esm) {
    const definesRequire = /createRequire|\b(?:const|let|var|function)\s+require\b/.test(code);
    if (!definesRequire && /(?<![.\w$])require\s*\(/.test(code)) issues.push('require()');
    if (!definesRequire && /(?<![.\w$])require\.main\b/.test(code)) issues.push('require.main');
    if (/(?<![.\w$])module\.exports\b|(?<![.\w$])exports\.[A-Za-z_$][\w$]*\s*=/.test(code)) issues.push('module.exports');
    for (const name of ['__dirname', '__filename']) {
      if (new RegExp('(?<![.\\w$])' + name + '\\b').test(code) && !new RegExp('\\b(?:const|let|var)\\s+' + name + '\\b').test(code)) issues.push(name);
    }
    // Live run (gpt-oss-20b, "todo CLI with tests"): the unit tests passed
    // but `node todo.mjs add x` printed nothing, because the main guard
    // compared a string with a URL object and was always false.
    const brokenGuard = /import\.meta\.url\s*[!=]==?\s*(?:new\s+URL\s*\(|process\.argv\s*\[\s*1\s*\](?![\w.$]))|(?:new\s+URL\s*\([^()]*(?:\([^()]*\)[^()]*)*\)|process\.argv\s*\[\s*1\s*\])\s*[!=]==?\s*import\.meta\.url/;
    const guard = brokenGuard.test(code) ? displayPath + ' checks "run when executed directly" with a comparison that is always false (import.meta.url is a string; compare it to a string URL), so running the file does nothing. Use `import.meta.url === pathToFileURL(process.argv[1]).href` (import { pathToFileURL } from \'node:url\'), then run the program once as a user would.' : '';
    if (!issues.length) return guard;
    return (guard ? guard + ' ' : '') + displayPath + ' is an ES module' + (ext === '.js' ? ' (package.json has "type": "module")' : '') + ' but uses CommonJS ' + [...new Set(issues)].join(', ') +
      ', which throws when the file is loaded. Use import/export; for "run when executed directly" use `import.meta.url === pathToFileURL(process.argv[1]).href`, and for paths use `fileURLToPath(new URL(\'.\', import.meta.url))`.';
  }
  if (ext === '.cjs' && /(?:^|\n)\s*(?:export\s+(?:default\b|const\b|function\b|class\b|let\b|\{)|import\s+[\w*{][^;\n]*\bfrom\s)/.test(code)) {
    return displayPath + ' is a CommonJS file (.cjs) but uses import/export syntax, which throws when it is loaded. Use require() and module.exports, or rename it to .mjs.';
  }
  return '';
}

async function packageTypeFor(root, absolute) {
  let dir = path.dirname(absolute);
  const top = path.resolve(root);
  for (let i = 0; i < 12; i++) {
    try { return String(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).type || ''); } catch {}
    if (dir === top || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return '';
}

async function moduleSystemWarning(root, absolute, displayPath, previous, next) {
  const ext = path.extname(displayPath).toLowerCase();
  if (!['.mjs', '.cjs', '.js'].includes(ext)) return '';
  const type = ext === '.js' ? await packageTypeFor(root, absolute) : '';
  const now = moduleSystemIssues(displayPath, next, type);
  return now && (previous == null || !moduleSystemIssues(displayPath, previous, type)) ? now : '';
}

export function unrequestedDocWarning(displayPath, request) {
  const base = path.posix.basename(String(displayPath || ''));
  if (isScratchPath(displayPath)) return '';
  if (!SUMMARY_DOC.test(base) || /^(?:README|CHANGELOG|CONTRIBUTING|LICENSE)\.md$/i.test(base)) return '';
  if (typeof request !== 'string') return '';
  const stem = base.replace(/\.md$/i, '').toLowerCase();
  const words = stem.split(/[_-]+/).filter((word) => word.length > 2);
  const asked = new RegExp('\\.md\\b|markdown|\\bdoc(?:s|ument|umentation)?\\b|\\bwrite[- ]?up\\b|\\bfile\\b.*\\b(?:' + words.join('|') + ')|\\b(?:' + words.join('|') + ')\\b.*\\bfile\\b', 'i');
  if (request.toLowerCase().includes(stem) || asked.test(request)) return '';
  return 'Unrequested document: ' + displayPath + ' looks like a summary/report file the user did not ask for. Put summaries in your reply instead; ' +
    'delete this file with delete_file unless the user requested it.';
}

export async function runWorkspaceCommand(root, command, args = [], options = {}) {
  if (!Array.isArray(args) || args.length > 80 || args.some((arg) => typeof arg !== 'string' || arg.length > 5000 || arg.includes('\0'))) {
    throw new Error('Command arguments must be an array of short strings.');
  }
  const analysis = analyzeCommand(command, args);
  if (analysis.blocked) throw new Error(analysis.blocked);
  if (options.signal && options.signal.aborted) return { command, args, approved: false, cancelled: true, message: 'Task was cancelled before approval or execution.' };
  const timeoutSeconds = Math.max(5, Math.min(600, Number.parseInt(options.timeoutSeconds, 10) || 120));
  const approval = options.approval;
  const requestedSandbox = options.sandbox && options.sandbox.enabled ? options.sandbox : null;
  assertSandboxAvailable(requestedSandbox);
  // sandbox.excludedCommands (see sandbox-exclusions.mjs): run outside the sandbox, with approval.
  const sandbox = requestedSandbox && requestedSandbox.backend === 'os' && (requestedSandbox.excludedCommands || []).length
    && (await import('./sandbox-exclusions.mjs')).argvExcluded(command, args, requestedSandbox.excludedCommands) ? null : requestedSandbox;
  // An explicit allow rule is the user's own decision. Otherwise high-risk commands
  // (inline code, wrappers, find -exec, ...) always need an interactive answer.
  const configRisk = options.bypassPermissions || protectedEditsAllowed(options.env || process.env) ? null
    : protectedShellWrite([command].concat(args).join(' '));
  const highRisk = configRisk || (analysis.highRisk && !options.ruleAllowed ? analysis.highRisk : null) || (options.injectionHold ? 'needs a person because ' + options.injectionHold : null);
  const sandboxAutoAllowed = sandbox && sandbox.available && sandbox.autoAllowCommands !== false && !highRisk;
  // ls, cat, grep, git status/diff/log and friends: read-only, inside the workspace.
  // A command that leaves the sandbox (sandbox.excludedCommands) always asks, read-only or not.
  const leftSandbox = Boolean(requestedSandbox) && !sandbox;
  const readOnly = !leftSandbox && !highRisk && !options.interactive && options.readOnlyCommands !== false && readOnlyCommandsEnabled(options.env || process.env) && readOnlyArgv(command, args, { root: path.resolve(root) });
  if (readOnly && command === 'git') options = { ...options, env: readOnlyGitEnv(options.env || process.env) };
  const needsApproval = highRisk ? true : !(options.autoApprove || options.ruleAllowed || sandboxAutoAllowed || readOnly);
  if (needsApproval) {
    const ok = approval && await approval('Run this command in the workspace?\n  ' + command + ' ' + args.map((arg) => JSON.stringify(arg)).join(' ') +
      (highRisk ? '\nHIGH RISK: ' + (configRisk ? configRisk : 'this command ' + highRisk) + '. Auto-approval does not apply.' : '') +
      '\nCommands can change project files or execute project scripts. ' + (typeof options.clientTerminal === 'function' && !(sandbox && sandbox.available) ? 'It will run in the editor\'s terminal, with the editor\'s environment.' : 'Oasis strips common secret environment variables from the child process.') +
      (sandbox && sandbox.available ? (sandbox.kind === 'ssh' ? '\nIt will run on ' + sandbox.ssh.host + ' over SSH.' : '\nIt will run inside the OS sandbox (' + sandbox.kind + ').') : ''), Boolean(highRisk));
    if (!ok) return { approved: false, command, args, message: 'Command was not approved. No process was started. Do not retry it or ask for approval again this turn; finish what you can without it and tell the user the exact command to run.' };
  }
  if (options.signal && options.signal.aborted) return { command, args, approved: false, cancelled: true, message: 'Task was cancelled before the command started.' };
  const baseEnv = scrubEnvironment(options.env || process.env);
  const env = options.interactive ? baseEnv : nonInteractiveEnvironment(baseEnv, options.env || process.env);
  if (options.interactive) {
    if (options.background) throw new Error('Choose either interactive=true or run_in_background=true, not both.');
    if (!options.ptyManager) throw new Error('Interactive terminal sessions are not available in this context.');
    const launch = await launchCommand(command, args, sandbox, root, { tty: true });
    try {
      return await options.ptyManager.start(launch.command, launch.args, {
        cwd: root, env, cols: options.cols, rows: options.rows, release: launch.release,
        display: String(command).split(/[\\/]/).pop(),
        sandboxed: sandbox && sandbox.available ? sandbox.kind : null
      });
    } catch (error) {
      if (typeof launch.release === 'function') launch.release();
      throw error;
    }
  }
  if (options.background) {
    if (!options.backgroundRegistry) throw new Error('Background commands are not available in this session.');
    const launch = await launchCommand(command, args, sandbox, root);
    return startBackgroundProcess(options.backgroundRegistry, launch, { cwd: root, env, display: commandLineText(command, args), sandboxed: sandbox && sandbox.available ? sandbox.kind : null, onLine: options.onLine, onExit: options.onExit, onStuck: options.onStuck, maxSeconds: options.maxSeconds, monitor: options.monitor });
  }
  // ACP editors with terminal support (opt-in): the command runs in the editor's own
  // terminal so the user can watch it. Every check and approval above still applied.
  if (typeof options.clientTerminal === 'function' && !(sandbox && sandbox.available)) {
    const parentEnv = options.env || process.env;
    const extraEnv = Object.entries(env).filter(([name, value]) => parentEnv[name] !== value).map(([name, value]) => ({ name, value: String(value) }));
    try {
      const result = await options.clientTerminal({ command, args, cwd: root, env: extraEnv, timeoutSeconds, signal: options.signal });
      if (result) return { command, approved: true, ...result };
    } catch (error) {
      if (options.signal && options.signal.aborted) return { command, args, approved: true, exitCode: null, cancelled: true, stdout: '', stderr: '', message: 'Task was cancelled.' };
      // A terminal that never started falls back to a local process; one that did start is not re-run.
      if (error && error.started) return { command, approved: true, exitCode: null, stdout: '', stderr: String(error.message || error), error: String(error.message || error), timedOut: false, cancelled: false };
    }
  }
  let outputLog = null;
  if (options.persistOutputLogs !== false) {
    try { outputLog = await createCommandOutputLog(root); } catch { outputLog = null; }
  }
  const launch = await launchCommand(command, args, sandbox, root);
  const condensers = options.condenseOutput !== false && condenseOutputEnabled(options.env || process.env)
    ? { stdout: createOutputCondenser(), stderr: createOutputCondenser() } : null;
  return await new Promise((resolve) => {
    const stdoutBuffer = createBoundedOutput();
    const stderrBuffer = createBoundedOutput();
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer = null;
    let terminationRequested = false;
    const child = spawn(launch.command, launch.args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...processTreeSpawnOptions() });
    if (typeof launch.release === 'function') { child.once('close', launch.release); child.once('error', launch.release); }
    const live = typeof options.onOutput === 'function' ? options.onOutput : null;
    const append = (target, chunk) => {
      if (live) { try { live(target, String(chunk)); } catch { /* a viewer never breaks a command */ } }
      if (outputLog) outputLog.append(target, chunk);
      const text = condensers ? condensers[target].push(chunk) : chunk;
      if (text.length) (target === 'stdout' ? stdoutBuffer : stderrBuffer).append(text);
    };
    // Condensed output keeps its raw log so nothing is out of reach.
    const finishOutputLog = () => {
      if (condensers) for (const target of ['stdout', 'stderr']) {
        const rest = condensers[target].end();
        if (rest) (target === 'stdout' ? stdoutBuffer : stderrBuffer).append(rest);
      }
      const removed = condensers ? { stdout: condensers.stdout.removed, stderr: condensers.stderr.removed } : { stdout: 0, stderr: 0 };
      const files = outputLog ? outputLog.finish({ stdout: stdoutBuffer.truncated || removed.stdout > 0, stderr: stderrBuffer.truncated || removed.stderr > 0 }) : {};
      const note = condensedOutputNote(removed.stdout + removed.stderr, [removed.stdout && files.stdoutLogPath, removed.stderr && files.stderrLogPath].filter(Boolean));
      return note ? { ...files, outputCondensed: note } : files;
    };
    const cleanup = () => {
      clearTimeout(timer);
      // Keep a scheduled force-kill alive after the leader exits: descendants may
      // ignore SIGTERM or may not inherit the parent's output pipes.
      if (killTimer && !terminationRequested) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };
    const terminateTree = () => {
      terminationRequested = true;
      signalProcessTree(child, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
      if (process.platform === 'win32' || killTimer) return;
      killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 1500);
      killTimer.unref?.();
    };
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      terminateTree();
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    const startedAt = new Date().toISOString();
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // Still running at the timeout: hand it to the background registry so a
      // long build or test run keeps its progress (see run_shell).
      const registry = options.backgroundRegistry && options.timeoutToBackground !== false && timeoutToBackground(options.env || process.env) ? options.backgroundRegistry : null;
      const running = registry ? [...registry.values()].filter((item) => item.status === 'running').length : Infinity;
      if (registry && running < 8 && child.exitCode === null && child.signalCode === null) {
        settled = true; cleanup();
        child.stdout.removeAllListeners('data');
        child.stderr.removeAllListeners('data');
        child.removeAllListeners('close');
        child.removeAllListeners('error');
        const logFiles = finishOutputLog();
        const stdout = stdoutBuffer.text(logFiles.stdoutLogPath, logFiles.stdoutLogTruncated);
        const stderr = stderrBuffer.text(logFiles.stderrLogPath, logFiles.stderrLogTruncated);
        let started;
        try {
          started = startBackgroundProcess(registry, null, { adopt: { child, output: stdout + (stderr ? (stdout ? '\n' : '') + stderr : ''), startedAt }, env: options.env || process.env, display: commandLineText(command, args), sandboxed: sandbox && sandbox.available ? sandbox.kind : null, onExit: options.adoptOnExit, onStuck: options.adoptOnStuck });
        } catch {
          terminateTree();
          resolve({ command, approved: true, exitCode: null, stdout, stderr, ...logFiles, timedOut: true, cancelled: false });
          return;
        }
        resolve({
          command, approved: true, exitCode: null, stdout, stderr,
          stdoutTruncated: stdoutBuffer.truncated, stderrTruncated: stderrBuffer.truncated, ...logFiles,
          timedOut: true, movedToBackground: true, background: true, id: started.id, pid: child.pid,
          message: 'Still running after ' + timeoutSeconds + ' seconds, so it was moved to the background instead of being stopped. Output so far is above; read more with command_output (id ' + started.id + '), stop it with kill_command, or wait for the exit notice.',
          ...(sandbox && sandbox.available ? { sandboxed: sandbox.kind } : {})
        });
        return;
      }
      terminateTree();
    }, timeoutSeconds * 1000);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true; cleanup();
      const logFiles = finishOutputLog();
      resolve({
        command, approved: true, exitCode: null,
        stdout: stdoutBuffer.text(logFiles.stdoutLogPath, logFiles.stdoutLogTruncated),
        stderr: stderrBuffer.text(logFiles.stderrLogPath, logFiles.stderrLogTruncated),
        stdoutTruncated: stdoutBuffer.truncated, stderrTruncated: stderrBuffer.truncated,
        ...logFiles,
        error: spawnErrorText(error, command), timedOut, cancelled
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      const logFiles = finishOutputLog();
      const note = sandboxLocalhostNote(sandbox, [command, ...args].join(' '), code);
      resolve({
        command, approved: true, exitCode: code, signal, ...(note ? { note } : {}),
        stdout: stdoutBuffer.text(logFiles.stdoutLogPath, logFiles.stdoutLogTruncated),
        stderr: stderrBuffer.text(logFiles.stderrLogPath, logFiles.stderrLogTruncated),
        stdoutTruncated: stdoutBuffer.truncated, stderrTruncated: stderrBuffer.truncated,
        ...logFiles,
        timedOut, cancelled, ...(sandbox && sandbox.available ? { sandboxed: sandbox.kind } : {})
      });
    });
  });
}

function condensedOutputNote(lines, logs) {
  if (!lines) return '';
  return 'Left out ' + lines + ' line' + (lines === 1 ? '' : 's') + ' of passing-test timing, repeated test headers or npm update notices' +
    (logs.length ? '; the full output is in ' + logs.join(' and ') : '') + '.';
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
    let timedOut = false;
    let killTimer = null;
    let terminationRequested = false;
    const child = spawn(plan.command, plan.args, { cwd: options.root, env, shell: false, windowsHide: true, stdio: 'inherit', ...processTreeSpawnOptions() });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer && !terminationRequested) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };
    const terminateTree = () => {
      terminationRequested = true;
      signalProcessTree(child, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
      if (process.platform === 'win32' || killTimer) return;
      killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 1500);
      killTimer.unref?.();
    };
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      terminateTree();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminateTree();
    }, 20 * 60 * 1000);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ approved: true, cancelled, timedOut, plan, exitCode: null, error: error.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ approved: true, cancelled, timedOut, plan, exitCode: code, signal });
    });
  });
}




function providerEnvironmentOverridesActive(env) {
  return Boolean(env && (env.OASIS_BASE_URL || env.OASIS_PROTOCOL || env.OASIS_MODEL));
}

// Every provider in provider-registry.mjs (built-ins and user-defined ones),
// not just the five setup shows first.
function getProviderPreset(provider) {
  const entry = getProvider(provider);
  return entry ? { protocol: entry.protocol, baseURL: entry.baseURL, model: entry.model } : null;
}

function getMatchingProviderKey(provider, env) {
  return providerApiKey(getProvider(provider, { env }), env);
}

async function saveVerifiedProvider(provider, config, context) {
  const env = context.env || process.env;
  let probe;
  try {
    probe = await testProviderConnection(config, { timeoutMs: 30000, signal: context.signal });
  } catch (error) {
    const message = String(error && error.message || error).slice(0, 1000);
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
  if (!preset) throw new Error('Choose a known provider: ' + Object.keys(providerRegistry()).join(', ') + '. Others can be added under "providers" in your user settings.');
  const model = String(args.model || preset.model || '').trim();
  if (!model || model.length > 200) throw new Error('This provider needs an exact model ID. Supply the model name from the provider or local server.');
  const baseURL = validateBaseUrl(preset.baseURL);
  const current = await loadConfig({ env }).catch(() => context.config || null);
  const sameTarget = Boolean(current && sameBaseURL(current.baseURL, baseURL) && current.protocol === preset.protocol);
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

// Start MCP servers that add_extension just configured, so their tools are
// usable in this chat without a restart.
export async function activateNewMcpServers(session, installed, { root, env }) {
  let names = [...installed];
  // Installs write <config>/mcp.json (user) or .mcp.json (project, just
  // approved); older setups use mcp-servers.json.
  const { loadUserMcpJson, loadProjectMcpServers } = await import('./mcp-project.mjs');
  const legacy = (await loadMcpServers({ env }).catch(() => ({ servers: [] }))).servers.map((server) => ({ ...server, source: 'user' }));
  const user = await loadUserMcpJson({ env }).catch(() => ({ servers: [], failures: [] }));
  const project = await loadProjectMcpServers(root, { env }).catch(() => ({ servers: [], failures: [] }));
  // Servers bundled with plugins that were just installed (ids are name@marketplace).
  const pluginServers = [];
  const pluginIds = names.filter((name) => name.includes('@'));
  if (pluginIds.length) {
    try {
      const { loadEnabledPlugins, pluginMcpServers } = await import('./claude-plugins.mjs');
      const { parseMcpServerEntries } = await import('./mcp-project.mjs');
      const plugins = (await loadEnabledPlugins(root, { env })).filter((plugin) => pluginIds.includes(plugin.id));
      for (const item of await pluginMcpServers(plugins, { env, root })) {
        const parsed = parseMcpServerEntries({ mcpServers: item.mcpServers }, { ...env, ...item.env }, 'plugin');
        for (const server of parsed.servers) { pluginServers.push({ ...server, plugin: item.plugin }); names = [...names, server.name]; }
      }
    } catch { /* the next session loads them */ }
  }
  const seen = new Set();
  const fresh = [...legacy, ...user.servers, ...project.servers, ...pluginServers].filter((server) => {
    if (!names.includes(server.name) || server.enabled === false || session.mcpClients.has(server.name) || seen.has(server.name)) return false;
    seen.add(server.name);
    return true;
  });
  const unusable = [...(user.failures || []), ...(project.failures || [])].filter((item) => names.includes(item.name)).map((item) => item.name + ': ' + String(item.error).slice(0, 200));
  if (!fresh.length) return unusable.length ? { started: [], failed: unusable } : null;
  const { connectMcpServers } = await import('./mcp.mjs');
  const host = session.mcpHost || { session, onToolsChanged: (target) => refreshSessionMcpTools(target) };
  const { clients, failures } = await connectMcpServers({ root, env, host, policy: session.settings && session.settings.mcpPolicy, skipUser: true, skipProject: true, extraServers: fresh.map((server) => ({ ...server, source: server.source || 'user' })) });
  for (const [name, client] of clients) session.mcpClients.set(name, client);
  refreshSessionMcpTools(session);
  return { started: [...clients.keys()], failed: [...unusable, ...failures.map((item) => item.name + ': ' + String(item.error).slice(0, 200))] };
}

async function configureMcpServer(args, context, root) {
  const env = context.env || process.env;
  const name = String(args.name || '').trim();
  const command = String(args.command || '').trim();
  const candidate = validateMcpServerConfig({
    name,
    command,
    args: args.args === undefined ? [] : args.args,
    passEnv: args.passEnv === undefined ? [] : args.passEnv,
    enabled: true
  });
  const existing = await loadMcpServers({ env });
  if (existing.servers.some((server) => server.name === candidate.name)) {
    return {
      configured: false,
      name: candidate.name,
      message: 'An MCP server named "' + candidate.name + '" is already configured. Choose a new name or remove the existing server first; Oasis did not replace it.'
    };
  }
  if (existing.servers.length >= 40) throw new Error('Oasis already has 40 configured MCP servers; remove one before adding another.');
  if (!context.session || !(context.session.mcpClients instanceof Map)) {
    throw new Error('An active Oasis session is required to add an MCP server from chat.');
  }
  const summary = [
    'Configure and start this stdio MCP server now?',
    'Name: ' + candidate.name,
    'Executable: ' + candidate.command,
    'Arguments: ' + JSON.stringify(candidate.args),
    'Explicit environment passthrough: ' + (candidate.passEnv.join(', ') || 'none'),
    'Oasis will launch this third-party process under your user account, save the configuration outside the repository, and expose its discovered tools in this chat.',
    'The server may read or change data available to your OS account. Secret values are not stored in this configuration and must be set in your local environment.'
  ].join('\n');
  // MCP activation always needs a conscious approval, even when the general
  // command runner was launched with --yes.
  if (!context.approval || !(await context.approval(summary, true))) {
    return { configured: false, approved: false, name: candidate.name, message: 'MCP setup was denied; no process was started and configuration was not changed.' };
  }
  if (context.signal && context.signal.aborted) {
    return { configured: false, cancelled: true, name: candidate.name, message: 'MCP setup was cancelled before the server started.' };
  }

  // Share the session's MCP host so this server's elicitation, roots and
  // tools/list_changed notifications reach the session like startup servers do.
  const host = context.session.mcpHost || { session: context.session, onToolsChanged: (target) => refreshSessionMcpTools(target) };
  const client = new McpServerClient(candidate, { root, env, host });
  let configPath;
  try {
    // Start and validate the MCP handshake before making this configuration
    // persistent. If the server cannot initialize, the old config is untouched.
    await client.start();
    configPath = await saveMcpServers([...existing.servers, candidate], { env });
  } catch (error) {
    client.close();
    throw new Error('MCP server "' + candidate.name + '" was not added because startup or configuration failed: ' +
      String(error && error.message || error).slice(0, 1400) + '. The previous MCP configuration was preserved.');
  }

  context.session.mcpClients.set(candidate.name, client);
  // Only swap the MCP part of the tool list. Rebuilding from TOOL_DEFINITIONS
  // dropped session tools (task, memory, advisor, browser, ...) and brought
  // back tools that --tools or --restricted had removed.
  refreshSessionMcpTools(context.session);
  return {
    configured: true,
    activated: true,
    name: candidate.name,
    command: candidate.command,
    toolCount: client.tools.length,
    tools: client.tools.map((tool) => String(tool.name)).slice(0, 80),
    configPath,
    message: 'The MCP server started successfully and its tools are available in this chat session. It will also start in future sessions until you disable or remove it. Inspect every exposed tool before approving its use.'
  };
}




async function installExternalSkill(args, context, root) {
  const env = context.env || process.env;
  const source = String(args.source || '').trim();
  parseSkillSource(source);
  const skill = String(args.skill || '').trim();
  const all = args.all === true;
  const scope = String(args.scope || 'project');
  if (!['project', 'global'].includes(scope)) throw new Error('Choose project or global skill installation scope.');
  if (Boolean(skill) === all) throw new Error('Choose exactly one of skill="EXACT_NAME" or all=true.');
  if (skill && !/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(skill)) throw new Error('Skill names use letters, numbers and hyphens (up to 64 characters).');
  const targetDir = scope === 'global' ? getUniversalGlobalSkillsDirectory(env) : path.join(root, '.agents', 'skills');
  if (!context.autoApprove && (!context.approval || !(await context.approval(
    'Install ' + (all ? 'all skills' : 'the skill "' + skill + '"') + ' from "' + source + '" into ' + targetDir +
    '? OASIS downloads the files and copies them; nothing from the source is run, and the instructions are treated as untrusted context.'
  )))) {
    return { installed: false, approved: false, message: 'External skill installation was denied; no skill source was installed.' };
  }
  let result;
  try {
    result = await installSkillsFromSource(source, { skill, all, targetDir, env, signal: context.signal });
  } catch (error) {
    return { installed: false, source, error: String(error && error.message || error), message: 'The skill was not installed: ' + String(error && error.message || error) };
  }
  return {
    installed: result.installed.length > 0,
    source, scope, skill: all ? '*' : skill,
    discovered: result.installed.map((item) => ({ name: item.name, description: item.description, path: item.path, files: item.files, skipped: item.skipped })),
    ...(result.available ? { available: result.available } : {}),
    message: result.message
  };
}

// OpenHands AgentSkills: `triggers: [keywords]` in SKILL.md front matter also adds the
// skill to the user message when a keyword appears (memory.mjs keywordRulesFor).
function skillTriggers(content) {
  const data = splitFrontMatter(content).data;
  const key = Object.keys(data).find((name) => name.toLowerCase() === 'triggers');
  const list = key === undefined ? [] : Array.isArray(data[key]) ? data[key] : typeof data[key] === 'string' ? data[key].split(',') : [];
  const triggers = list.map((item) => String(item).trim()).filter(Boolean).slice(0, 40);
  return triggers.length ? { triggers } : {};
}

function parseSkillMetadata(content, fallbackName) {
  const metadata = splitFrontMatter(content).data;
  const read = (key) => frontMatterValue(metadata, key);
  const rawName = read('name') || fallbackName;
  const name = /^[a-z][a-z0-9-]{0,63}$/i.test(rawName) ? rawName : fallbackName;
  const description = (read('description') || 'Workflow instructions for ' + name + '.').slice(0, 320);
  return { name, description };
}

// Claude Code personal skills: ~/.claude/skills (or $CLAUDE_CONFIG_DIR/skills).
function getClaudeUserSkillsDirectory(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills');
}
const PORTABLE_SKILL_SOURCES = ['portable-workspace', 'global-portable', 'claude-project', 'claude-user', 'foreign-user', 'parent-portable'];
// 'foreign-user' skills live in another agent's home folder; each remembers its own root.
// 'parent-portable' skills sit in .agents/skills of a folder above the workspace (up to the git root).
const ABSOLUTE_SKILL_SOURCES = { 'global-portable': getUniversalGlobalSkillsDirectory, 'claude-user': getClaudeUserSkillsDirectory, 'foreign-user': (env, skill) => (skill && skill.skillsRoot) || '', 'parent-portable': (env, skill) => (skill && skill.skillsRoot) || '' };

// Skill folders of other agents, read in place (SKILL.md per folder). Project
// folders are relative to the workspace; home folders are relative to $HOME.
// Sources: Cursor, Devin Desktop (Windsurf), Antigravity, OpenHands and Codex docs.
export const FOREIGN_PROJECT_SKILL_DIRS = ['.cursor/skills', '.codex/skills', '.windsurf/skills', '.devin/skills', '.agent/skills', '.openhands/skills'];
export function foreignUserSkillDirectories(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  return [
    ['~/.agents/skills', path.join(home, '.agents', 'skills')],
    ['~/.cursor/skills', path.join(home, '.cursor', 'skills')],
    ['$CODEX_HOME/skills', path.join(codexHome, 'skills')],
    ['~/.config/devin/skills', path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'devin', 'skills')],
    ['~/.gemini/antigravity/skills', path.join(home, '.gemini', 'antigravity', 'skills')],
    ['~/.gemini/skills', path.join(home, '.gemini', 'skills')],
    ['~/.gemini/antigravity-cli/skills', path.join(home, '.gemini', 'antigravity-cli', 'skills')],
    ['~/.gemini/config/skills', path.join(home, '.gemini', 'config', 'skills')],
    ['~/.openhands/skills', path.join(home, '.openhands', 'skills')],
    // Skills bundled with installed Antigravity / Antigravity CLI plugins.
    ...['config', 'antigravity-cli'].flatMap((base) => {
      const plugins = path.join(home, '.gemini', base, 'plugins');
      let names = [];
      try { names = readdirSync(plugins, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch {}
      return names.map((name) => ['~/.gemini/' + base + '/plugins/' + name + '/skills', path.join(plugins, name, 'skills')]);
    })
  ];
}

export function getUniversalGlobalSkillsDirectory(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, 'agents', 'skills');
}

export async function listAvailableSkills(root, options = {}) {
  const env = options.env || process.env;
  const byName = new Map();
  async function scan(directory, source, relativePrefix = '', origin = '') {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink())) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name, 'SKILL.md');
      try {
        const info = await lstat(filePath);
        const maxSkillBytes = PORTABLE_SKILL_SOURCES.includes(source) ? 96 * 1024 : 32 * 1024;
        if (!info.isFile() || info.isSymbolicLink() || info.size > maxSkillBytes) continue;
        const content = await readFile(filePath, 'utf8');
        if (content.includes('\0')) continue;
        const meta = parseSkillMetadata(content, entry.name);
        const localSource = ['workspace', 'portable-workspace', 'claude-project'].includes(source);
        const skill = {
          name: meta.name,
          description: meta.description,
          // Claude Code's disable-model-invocation: the user can still run it
          // as /name, but it stays out of the model's skill catalogue.
          modelInvocable: frontMatterValue(splitFrontMatter(content).data, 'disable-model-invocation').toLowerCase() !== 'true',
          source,
          directoryName: entry.name,
          relativePath: localSource ? path.posix.join(relativePrefix, entry.name, 'SKILL.md') : entry.name,
          relativeSkillDirectory: localSource ? path.posix.join(relativePrefix, entry.name) : undefined,
          absolutePath: ABSOLUTE_SKILL_SOURCES[source] ? filePath : undefined,
          absoluteSkillDirectory: ABSOLUTE_SKILL_SOURCES[source] ? path.join(directory, entry.name) : undefined,
          ...(origin ? { origin } : {}),
          ...(source === 'foreign-user' || source === 'parent-portable' ? { skillsRoot: directory } : {}),
          ...skillTriggers(content)
        };
        byName.set(meta.name.toLowerCase(), skill);
      } catch { /* Ignore incomplete or unsafe skill files. */ }
    }
  }
  async function scanImportedExtensions(extensionRoot, source, workspaceRelative = '') {
    let extensions;
    try { extensions = await readdir(extensionRoot, { withFileTypes: true }); } catch { return; }
    for (const extension of extensions.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())) {
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
      for (const skillDir of skillDirs.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())) {
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
  // Skills from enabled Claude Code plugins (oasis plugin install NAME@MARKETPLACE).
  try {
    const { loadEnabledPlugins, pluginSkills } = await import('./claude-plugins.mjs');
    for (const item of await pluginSkills(await loadEnabledPlugins(root, { env }))) {
      try {
        const info = await lstat(item.file);
        if (!info.isFile() || info.size > 96 * 1024) continue;
        const content = await readFile(item.file, 'utf8');
        if (content.includes('\0')) continue;
        const meta = parseSkillMetadata(content, item.name);
        if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(meta.name)) continue;
        byName.set(meta.name.toLowerCase(), { name: meta.name, description: meta.description, source: 'plugin', plugin: item.plugin, relativePath: item.name, absolutePath: item.file, absoluteSkillDirectory: item.dir });
      } catch { /* Ignore malformed plugin skills. */ }
    }
  } catch { /* Plugins are optional. */ }
  // Other agents' skill folders; OASIS's own and Claude Code locations below win on a clash.
  if (env.OASIS_OTHER_AGENT_RULES !== '0') {
    const seenDirs = new Set([path.resolve(getUniversalGlobalSkillsDirectory(env)), path.resolve(getClaudeUserSkillsDirectory(env))]);
    for (const [label, dir] of foreignUserSkillDirectories(env).reverse()) {
      if (seenDirs.has(path.resolve(dir))) continue;
      seenDirs.add(path.resolve(dir));
      await scan(dir, 'foreign-user', '', label);
    }
    for (const dir of FOREIGN_PROJECT_SKILL_DIRS) await scan(path.join(root, ...dir.split('/')), 'portable-workspace', dir, dir);
  }
  await scan(getUniversalGlobalSkillsDirectory(env), 'global-portable');
  // Antigravity and Codex also read .agents/skills in the folders above the workspace up to
  // the git root; nearer folders win and the workspace's own folder wins over all of them.
  for (const dir of await parentSkillFolders(root)) await scan(path.join(dir, '.agents', 'skills'), 'parent-portable', '', path.relative(root, path.join(dir, '.agents', 'skills')).split(path.sep).join('/'));
  await scan(path.join(root, '.agents', 'skills'), 'portable-workspace', '.agents/skills');
  // Claude Code skill locations; personal skills win over project ones, as in Claude Code.
  await scan(path.join(root, '.claude', 'skills'), 'claude-project', '.claude/skills');
  await scan(getClaudeUserSkillsDirectory(env), 'claude-user');
  await scan(path.join(root, '.oasis', 'skills'), 'workspace', '.oasis/skills');
  await scanImportedExtensions(path.join(root, '.oasis', 'extensions'), 'project-extension', '.oasis/extensions');
  const policy = options.skillPolicy || await skillPolicyFor(root, env);
  return applySkillPolicy([...byName.values()], policy).sort((a, b) => a.name.localeCompare(b.name));
}

// Folders above the workspace up to its git root, farthest first. Nothing when the
// workspace is itself the git root or no git root is found within 20 levels.
async function parentSkillFolders(root) {
  const workspace = path.resolve(root);
  const chain = [];
  for (let dir = workspace, i = 0; i < 20; i++) {
    try { await lstat(path.join(dir, '.git')); return chain.reverse(); } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    chain.push(dir);
  }
  return [];
}

// Claude Code's disableBundledSkills (or CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1) and skillOverrides.
async function skillPolicyFor(root, env) {
  let settings = {};
  try {
    const { loadSettings } = await import('./settings.mjs');
    settings = await loadSettings(root, { env, skipPlugins: true });
  } catch { settings = {}; }
  return {
    disableBundled: settings.disableBundledSkills === true || env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS === '1' || env.OASIS_DISABLE_BUNDLED_SKILLS === '1',
    overrides: settings.skillOverrides || {}
  };
}

// "off" removes a skill; "user-invocable-only" keeps /name but hides it from the model;
// "name-only" lists it to the model without its description. Plugin skills are exempt.
export function applySkillPolicy(skills, policy = {}) {
  const overrides = policy.overrides || {};
  const lower = Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key.toLowerCase(), value]));
  const out = [];
  for (const skill of skills) {
    if (policy.disableBundled && skill.source === 'built-in') continue;
    const mode = skill.source === 'plugin' ? '' : lower[String(skill.name).toLowerCase()];
    if (mode === 'off') continue;
    if (mode === 'user-invocable-only') out.push({ ...skill, modelInvocable: false });
    else if (mode === 'name-only') out.push({ ...skill, nameOnly: true });
    else out.push(skill);
  }
  return out;
}

// Where a listed skill's SKILL.md lives, and whether it belongs to the
// repository, the user or OASIS itself (Codex skills/list scopes).
const REPO_SKILL_SOURCES = new Set(['workspace', 'portable-workspace', 'claude-project', 'project-extension', 'parent-portable']);
export function skillLocation(root, item) {
  const scope = item.source === 'built-in' ? 'system' : REPO_SKILL_SOURCES.has(item.source) ? 'repo' : 'user';
  let file = item.absolutePath || null;
  if (!file && item.source === 'built-in') file = path.join(BUNDLED_SKILLS_DIR, item.relativePath || item.name, 'SKILL.md');
  else if (!file && REPO_SKILL_SOURCES.has(item.source) && item.relativePath) file = path.join(root, ...String(item.relativePath).split('/'));
  return { scope, path: file };
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
  } else if (skill.source === 'claude-project') {
    const dir = path.resolve(root, ...String(skill.relativeSkillDirectory || '').split('/'));
    const target = path.join(dir, 'SKILL.md');
    const rootReal = await realpath(path.resolve(root));
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024) throw new Error('Project skill is not a safe regular Markdown file.');
    const targetReal = await realpath(target);
    if (!inside(rootReal, targetReal)) throw new Error('Project skill resolves outside the workspace.');
    content = (await readFile(targetReal, 'utf8')).replace(/\$\{CLAUDE_SKILL_DIR\}/g, path.dirname(targetReal));
  } else if (ABSOLUTE_SKILL_SOURCES[skill.source]) {
    const globalSkillsRoot = path.resolve(ABSOLUTE_SKILL_SOURCES[skill.source](options.env || process.env, skill));
    const rootReal = await realpath(globalSkillsRoot);
    const target = path.resolve(skill.absolutePath || '');
    // Compare lexical paths with lexical paths first; macOS /var paths may realpath to /private/var.
    if (!inside(globalSkillsRoot, target) && !inside(rootReal, target)) throw new Error('Portable global skill path is outside the universal skills directory.');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024) throw new Error('Portable global skill is not a safe regular Markdown file.');
    const targetReal = await realpath(target);
    if (!inside(rootReal, targetReal)) throw new Error('Portable global skill resolves outside the universal skills directory.');
    content = (await readFile(targetReal, 'utf8')).replace(/\$\{CLAUDE_SKILL_DIR\}/g, path.dirname(targetReal));
  } else if (skill.source === 'plugin') {
    const dirReal = await realpath(path.resolve(skill.absoluteSkillDirectory || ''));
    const targetReal = await realpath(path.resolve(skill.absolutePath || ''));
    if (!inside(dirReal, targetReal)) throw new Error('Plugin skill resolves outside its plugin directory.');
    const { expandPluginVariables } = await import('./claude-plugins.mjs');
    const pluginRoot = path.resolve(skill.absoluteSkillDirectory, '..', '..');
    content = expandPluginVariables(await readFile(targetReal, 'utf8'), { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_SKILL_DIR: dirReal });
    content = content.replace(/\$\{CLAUDE_SKILL_DIR\}/g, dirReal);
  } else if (skill.source === 'global-extension') {
    const globalExtensionsRoot = path.resolve(getConfigDirectory(options.env || process.env), 'extensions');
    const rootReal = await realpath(globalExtensionsRoot);
    const target = path.resolve(skill.absolutePath || '');
    // Keep lexical and canonical containment checks separate for macOS path aliases.
    if (!inside(globalExtensionsRoot, target) && !inside(rootReal, target)) throw new Error('Imported skill path is outside the managed global extension directory.');
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
  return { name: skill.name, source: skill.source, content };
}

// Skill files reach 96 KiB but one tool result holds about 24k characters,
// so load_skill and read_skill_resource return pages that end on a line
// break, with the offset to continue from. They used to cut at 24k with no
// way to read the rest.
const SKILL_PAGE_CHARS = 20000;
export function pageSkillText(result, rawOffset) {
  const content = String(result.content || '');
  const offset = Math.min(content.length, Math.max(0, Number.isInteger(Number(rawOffset)) ? Number(rawOffset) : 0));
  let end = Math.min(content.length, offset + SKILL_PAGE_CHARS);
  if (end < content.length) {
    const lineEnd = content.lastIndexOf('\n', end - 1);
    if (lineEnd > offset + SKILL_PAGE_CHARS / 2) end = lineEnd + 1;
  }
  const more = end < content.length;
  const page = {
    ...result,
    content: content.slice(offset, end),
    ...(offset ? { offset } : {}),
    ...(more ? { truncated: true, nextOffset: end, totalChars: content.length, note: 'Showing characters ' + offset + '-' + end + ' of ' + content.length + '. Call again with offset=' + end + ' for the rest.' } : {})
  };
  // A context: fork skill hands its whole body to the subagent.
  Object.defineProperty(page, 'fullContent', { value: content, enumerable: false });
  return page;
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
  if (PORTABLE_SKILL_SOURCES.includes(skill.source)) {
    const safetyRoot = ABSOLUTE_SKILL_SOURCES[skill.source]
      ? path.resolve(ABSOLUTE_SKILL_SOURCES[skill.source](options.env || process.env, skill))
      : workspaceRoot;
    const skillDirectory = ABSOLUTE_SKILL_SOURCES[skill.source]
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
    return { name: skill.name, path: relativePath, content, trust: 'external-untrusted-text' };
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
  return { name: skill.name, path: relativePath, content, trust: 'external-untrusted-text' };
}

export async function loadSkillDescriptions(root, options = {}) {
  const skills = (await listAvailableSkills(root, options)).filter((item) => item.modelInvocable !== false);
  if (!skills.length) return '';
  // Built-in skills carry no tag (it would repeat on every line of every request).
  const lines = skills.map((item) => '- ' + item.name + (item.source === 'built-in' ? '' : ' [' + (['global-extension', 'project-extension', 'portable-workspace', 'global-portable', 'foreign-user', 'parent-portable'].includes(item.source) ? 'EXTERNAL UNTRUSTED PROMPT' : item.source) + ']') + (item.nameOnly ? '' : ': ' + skillCatalogueLine(item.description)));
  return fitSkillCatalogue(lines, options.maxChars ?? SKILL_CATALOGUE_CHARS);
}

export const SKILL_CATALOGUE_CHARS = 16000;

// Keep whole lines within the budget. Dropped skills are counted in a last
// line that points at list_skills, instead of ending on half a description
// with the model unaware that more skills exist.
export function fitSkillCatalogue(lines, maxChars = SKILL_CATALOGUE_CHARS) {
  const kept = [];
  let used = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const rest = lines.length - index - 1;
    const note = rest ? ('\n- (' + rest + ' more skill' + (rest === 1 ? '' : 's') + ' not listed; call list_skills to see them all)').length : 0;
    const cost = (kept.length ? 1 : 0) + lines[index].length;
    if (used + cost + note > maxChars) {
      const missing = lines.length - index;
      kept.push('- (' + missing + ' more skill' + (missing === 1 ? '' : 's') + ' not listed; call list_skills to see them all)');
      break;
    }
    kept.push(lines[index]);
    used += cost;
  }
  return kept.join('\n');
}

// One catalogue line per skill: what it does plus its "Use for/when" trigger,
// at most 160 characters. load_skill returns the full instructions.
export function skillCatalogueLine(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (text.length <= 160) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const trigger = sentences.slice(1).find((sentence) => /^use (for|when|on|after)\b/i.test(sentence)) || '';
  let line = sentences[0] + (trigger ? ' ' + trigger : '');
  if (line.length > 160) line = line.slice(0, 157).replace(/[\s,]+\S*$/, '') + '…';
  return line;
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
    // Clean/smudge filters named in the repository's own config would run on
    // worktree files during status and diff; switch them off here.
    const safeArgs = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', ...repoFilterOverrides(root, env), ...args];
    let child;
    const append = (target, chunk) => {
      const current = target === 'stdout' ? stdout : stderr;
      const next = current + chunk.toString('utf8');
      if (next.length > MAX_TOOL_OUTPUT) truncated = true;
      const clipped = next.slice(-MAX_TOOL_OUTPUT);
      if (target === 'stdout') stdout = clipped;
      else stderr = clipped;
    };
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A timed-out Git leader may exit while a child still lives. Keep escalation.
      if (!timedOut) clearTimeout(killTimer);
      resolve({
        command: 'git ' + args.join(' '),
        ...result,
        stdout,
        stderr,
        output: (stdout + (stderr ? '\n' + stderr : '')).slice(-MAX_TOOL_OUTPUT),
        truncated
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => { killTimer = null; signalProcessTree(child, 'SIGKILL'); }, 500);
      killTimer.unref?.();
    }, 15000);
    try {
      child = spawn('git', safeArgs, {
        cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        ...processTreeSpawnOptions()
      });
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      child.on('error', (error) => finish({ exitCode: 127, error: error.message, timedOut }));
      child.on('close', (code, signal) => finish({ exitCode: timedOut ? 124 : (code ?? 1), signal, timedOut }));
    } catch (error) {
      finish({ exitCode: 127, error: error.message, timedOut });
    }
  });
}

// Outside a Git work tree, `git diff` prints its whole usage text (about 16 KB)
// and `git status` a terse fatal line; either way the model learned nothing and
// paid for the tokens. Answer with one line that says what to do instead.
async function notAGitWorkTree(root, command) {
  const probe = await runReadOnlyGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (probe && probe.exitCode === 0 && /true/.test(String(probe.stdout || ''))) return null;
  if (probe && probe.exitCode === 127) return probe; // git itself is missing
  const message = 'This workspace is not a Git repository, so ' + command + ' has nothing to compare against. Review your changes by reading the files you edited (read_file), and run the project\'s checks.';
  return { command: 'git ' + command.replace(/^git /, ''), exitCode: 128, signal: null, timedOut: false, stdout: '', stderr: message, output: message, truncated: false, notGitRepository: true };
}

async function readGitStatus(root) {
  const outside = await notAGitWorkTree(root, 'git status');
  if (outside) return outside;
  return await runReadOnlyGit(root, ['status', '--short', '--branch', '--untracked-files=normal', '--no-ahead-behind']);
}

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

async function readGitDiff(root, args = {}) {
  const outside = await notAGitWorkTree(root, 'git diff');
  if (outside) return outside;
  const scope = ['unstaged', 'staged', 'all'].includes(args.scope) ? args.scope : 'all';
  const commandArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3'];
  if (scope === 'staged') commandArgs.push('--cached');
  else if (scope === 'all') {
    // A fresh repository has no HEAD yet; diff against the empty tree so the
    // first change can still be reviewed instead of failing.
    const head = await runReadOnlyGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (head && head.exitCode === 0) commandArgs.push('HEAD');
    else {
      const format = await runReadOnlyGit(root, ['rev-parse', '--show-object-format']);
      commandArgs.push(/sha256/.test(String(format && format.stdout || '')) ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1);
    }
  }
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
  const result = await runReadOnlyGit(root, commandArgs);
  if (scope === 'staged' || !result || result.exitCode !== 0) return result;
  // git diff never shows new, untracked files, so reviewing a freshly created
  // file looked like "no changes". Append them as new-file diffs.
  const listed = await runReadOnlyGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...(relativePath ? [relativePath] : [])]);
  const untracked = String(listed && listed.stdout || '').split('\0').filter(Boolean)
    .filter((file) => !SECRET_DIFF_PATH.test(file)).slice(0, 20);
  if (!untracked.length) return result;
  let extra = '';
  for (const file of untracked) {
    const shown = await runReadOnlyGit(root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', '/dev/null', file]);
    extra += String(shown && shown.stdout || '');
    if (extra.length > MAX_TOOL_OUTPUT) break;
  }
  const stdout = (String(result.stdout || '') + extra).slice(0, MAX_TOOL_OUTPUT);
  return { ...result, stdout, output: stdout + (result.stderr ? String(result.stderr) : ''), untracked, truncated: Boolean(result.truncated || (String(result.stdout || '') + extra).length > MAX_TOOL_OUTPUT) };
}

const SECRET_DIFF_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials\.json|secrets\.json|id_rsa|id_ed25519|id_ecdsa)$|\.(?:pem|key|p12|pfx|keystore)$|(?:^|\/)\.(?:ssh|aws|gnupg|azure|kube|docker)\//i;

export function updateTodos(store, rawTodos) {
  if (!Array.isArray(store)) throw new Error('A checklist store is required.');
  if (!Array.isArray(rawTodos)) throw new Error('todos must be an array of { content, status } items.');
  if (rawTodos.length > 50) throw new Error('Keep the checklist to 50 items or fewer.');
  const statuses = new Set(['pending', 'in_progress', 'completed']);
  const cleaned = rawTodos.map((item, index) => {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) {
      throw new Error('Item ' + (index + 1) + ' needs non-empty content.');
    }
    if (!statuses.has(item.status)) {
      throw new Error('Item ' + (index + 1) + ' has an invalid status; use pending, in_progress, or completed.');
    }
    return { content: item.content.trim().slice(0, 200), status: item.status };
  });
  if (cleaned.filter((item) => item.status === 'in_progress').length > 1) {
    throw new Error('Only one item may be in_progress at a time.');
  }
  // Replace only after the entire payload has passed validation.
  store.splice(0, store.length, ...cleaned);
  return { todos: cleaned.map((item) => ({ ...item })), remaining: cleaned.filter((item) => item.status !== 'completed').length };
}

// Read-modify-write tools on one file run one at a time per path. Parallel
// subagents share the workspace, and two concurrent edit_file calls on the
// same file both read the original, so the later write silently dropped the
// earlier edit while both reported success.
const PATH_LOCKED_TOOLS = new Set(['edit_file', 'write_file', 'multi_edit', 'notebook_edit', 'delete_file']);
const pathLocks = new Map();

async function withPathLock(key, fn) {
  const previous = pathLocks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  pathLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  }
}

// Normalize lock keys through the same workspace-path resolver used by the
// actual write. Existing files resolve to their real path; new files resolve
// their nearest existing parent so a symlinked directory cannot create a
// second lock for the same eventual target.
async function canonicalPathLockKey(root, rawPath) {
  const target = await resolveWorkspacePath(root, rawPath);
  try {
    return path.resolve(await realpath(target.absolute));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let cursor = path.dirname(target.absolute);
  const suffix = [path.basename(target.absolute)];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return path.resolve(existing, ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target.absolute);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function executeTool(name, args = {}, context = {}) {
  // The OS sandbox belongs to the session; a context without one inherits it
  // so run_command/run_shell actually run inside bubblewrap/Seatbelt.
  if (context && context.sandbox === undefined && context.session && context.session.sandbox) {
    context = { ...context, sandbox: context.session.sandbox };
  }
  if (PATH_LOCKED_TOOLS.has(name) && args && typeof args.path === 'string' && args.path) {
    const root = path.resolve(context.root || process.cwd());
    const key = await canonicalPathLockKey(root, args.path);
    return withPathLock(key, () => executeToolUnlocked(name, args, context));
  }
  return executeToolUnlocked(name, args, context);
}

async function executeToolUnlocked(name, args = {}, context = {}) {
  const root = path.resolve(context.root || process.cwd());
  switch (name) {
    case 'todo_write':
      if (!Array.isArray(context.todos)) context.todos = [];
      return updateTodos(context.todos, args.todos);
    case 'git_status':
      return await readGitStatus(root);
    case 'git_diff':
      return await readGitDiff(root, args);
    case 'list_files':
      return await listWorkspaceFiles(root, { path: args.path || '.', includeHidden: Boolean(args.includeHidden) });
    case 'read_file':
      if (imageMediaType(args.path)) return await readImageFile(root, args.path, { config: context.session && context.session.config || context.config, env: context.env || process.env });
      if (isPdfPath(args.path)) {
        const target = await resolveWorkspacePath(root, args.path);
        return await readPdf(target.absolute, target.relative.split(path.sep).join('/'), { pages: args.pages, env: context.env || process.env });
      }
      if (isNotebookPath(args.path) && args.offset === undefined && args.limit === undefined) return await readNotebook(root, args.path);
      {
        const range = readRangeArgs(args);
        const read = await readWorkspaceFile(root, args.path, { offset: range.offset, limit: range.limit, context });
        const partial = read && read.totalLines && (read.startLine > 1 || read.truncated) ? 'lines ' + read.startLine + '-' + read.endLine + ' of ' + read.totalLines : '';
        await recordFileState(context, (await resolveWorkspacePath(root, args.path)).absolute, { partial });
        return read;
      }
    case 'glob_files':
      {
        let folder = args.path;
        if (typeof folder === 'string' && path.isAbsolute(folder)) {
          const inside = path.relative(await realpath(root), await realpath(folder).catch(() => folder));
          // Inside the project: use the relative folder. Outside: keep it
          // absolute so the glob is rejected.
          if (!inside.startsWith('..') && !path.isAbsolute(inside)) folder = inside;
        }
        return await globWorkspaceFiles(root, globPatternWithPath(args.pattern, folder), args.limit);
      }
    case 'repo_map': {
      const { buildRepoMap } = await import('./repo-map.mjs');
      await resolveWorkspacePath(root, args.path || '.');
      return await buildRepoMap(root, { path: args.path, focus: args.focus, maxChars: args.max_chars });
    }
    case 'search_files':
      return trackSearchMisses(context.session, await searchWorkspaceFiles(root, args.query, args.limit ?? args.max_results, args.path));
    case 'list_skills':
      return { skills: await listAvailableSkills(root, { env: context.env || process.env }) };
    case 'load_skill':
      return pageSkillText(await loadSkillText(root, args.name, { env: context.env || process.env }), args.offset);
    case 'read_skill_resource':
      return pageSkillText(await loadSkillResource(root, args.name, args.path, { env: context.env || process.env }), args.offset);
    case 'configure_provider':
      return await configureProviderFromChat(args, context);
    case 'install_external_skill':
      return await installExternalSkill(args, context, root);
    case 'configure_mcp_server':
      return await configureMcpServer(args, context, root);
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
    case 'add_extension': {
      const { addAnything } = await import('./add-anything.mjs');
      const env = context.env || process.env;
      // Installing runs third-party code later (hooks, MCP servers), so this
      // always asks, even with --yes, like configure_mcp_server.
      const skillsBefore = (await listAvailableSkills(root, { env }).catch(() => [])).map((skill) => skill.name);
      const result = await addAnything(String(args.source || ''), {
        root, env, scope: args.scope, name: args.name, values: args.env && typeof args.env === 'object' ? args.env : undefined,
        approve: async (summary) => Boolean(context.approval && await context.approval(summary + (/^Save /.test(summary) ? '' : '\nInstall it now?'), true))
      });
      if (result.approved && result.reconnect && context.session && context.session.mcpClients instanceof Map) {
        // New values for a running server: restart it so they take effect.
        for (const name of result.installed) {
          const client = context.session.mcpClients.get(name);
          if (!client) continue;
          try { await (client.close ? client.close() : client.stop && client.stop()); } catch { /* already gone */ }
          context.session.mcpClients.delete(name);
        }
      }
      if (result.approved && result.installed && result.installed.length && context.session && context.session.mcpClients instanceof Map) {
        result.activated = await activateNewMcpServers(context.session, result.installed, { root, env }).catch((error) => ({ error: error.message }));
      }
      if (result.approved && result.reload) {
        // Skills are read from disk on every load_skill call, so new ones work now.
        const skills = (await listAvailableSkills(root, { env }).catch(() => [])).map((skill) => skill.name);
        const fresh = skills.filter((name) => !skillsBefore.includes(name));
        if (fresh.length) { result.newSkills = fresh.slice(0, 40); result.message += ' New skills, usable now with load_skill: ' + fresh.slice(0, 40).join(', ') + '.'; }
        result.message += ' Plugin slash commands and hooks load with /reload-plugins or a new session.';
      }
      if (result.agentHint) { result.message += ' ' + result.agentHint; delete result.agentHint; }
      return result;
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
      args = editFileArgs(args);
      if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') throw new Error('old_string and new_string must be strings.');
      if (!args.old_string.length) throw new Error('old_string must not be empty. To create a new file, use write_file.');
      if (args.old_string === args.new_string) throw new Error('old_string and new_string are identical; nothing to change.');
      if (Buffer.byteLength(args.old_string, 'utf8') > MAX_EDIT_FILE || Buffer.byteLength(args.new_string, 'utf8') > MAX_EDIT_FILE) throw new Error('The edit exceeds the 64 MiB text limit.');
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      let info;
      try { info = await lstat(target.absolute); } catch (error) {
        if (error.code === 'ENOENT') throw new Error('That file does not exist. Use write_file to create it.');
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('That path is not a regular file.');
      if (info.size > MAX_EDIT_FILE) throw new Error('File is larger than the 64 MiB limit for edits.');
      await assertFileFresh(context, target.absolute, target.relative.split(path.sep).join('/'), { exactMatch: true });
      const bufferText = await clientReadText(context, target.absolute);
      const { text: current, encoding: fileEncoding } = bufferText !== null ? { text: bufferText, encoding: 'utf8' } : await readTextFile(target.absolute);
      if (current.includes('\0')) throw new Error('This looks like a binary file; edit_file only supports text.');
      let matches = 0, offset = 0;
      while ((offset = current.indexOf(args.old_string, offset)) >= 0) { matches++; offset += args.old_string.length; }
      let relaxed = null;
      if (!matches && args.replace_all !== true) relaxed = relaxedReplace(current, args.old_string, args.new_string);
      if (!matches && !relaxed) {
        const hint = closestMatchHint(current, args.old_string);
        throw new Error('old_string was not found. It must match the file exactly, including whitespace and indentation.' + (hint ? '\n' + hint : ' Re-read the file and try again.'));
      }
      if (matches > 1 && args.replace_all !== true) throw new Error('old_string appears ' + matches + ' times. Add more surrounding context to make it unique, or set replace_all=true.');
      const insert = matchLineEndings(current, args.new_string);
      const next = relaxed ? relaxed.next : args.replace_all === true ? current.split(args.old_string).join(insert) : current.replace(args.old_string, () => insert);
      if (Buffer.byteLength(next, 'utf8') > MAX_EDIT_FILE) throw new Error('The edited file would exceed the 64 MiB edit limit.');
      if (next === current) return { path: target.relative.split(path.sep).join('/'), changed: false, message: 'The replacement produced no changes.' };
      const editDisplayPath = target.relative.split(path.sep).join('/');
      assertNoNewElision(args.old_string, args.new_string, editDisplayPath);
      await snapshotFile(target.root, target.absolute, 'before-agent-edit');
      await atomicWriteFile(target.absolute, encodeText(next, fileEncoding), { encoding: 'utf8' });
      await clientMirrorWrite(context, target.absolute, next);
      await recordFileState(context, target.absolute);
      const moduleWarning = await moduleSystemWarning(root, target.absolute, editDisplayPath, current, next).catch(() => '');
      const editWarning = combineWarnings(moduleWarning, commentWarning(current, next, editDisplayPath, context.session && context.session.commentMode), shrinkWarning(current, next, editDisplayPath), testTamperWarning(current, next, editDisplayPath), securityWarning(current, next, editDisplayPath), recordAndDetectCircling(context.session || context, target.absolute, current, next, editDisplayPath));
      return { path: editDisplayPath, changed: true, ...(relaxed ? { matchedBy: relaxed.strategy, matchedAtLine: relaxed.line, note: 'old_string did not match exactly; it matched uniquely after normalizing ' + relaxed.strategy + ' at line ' + relaxed.line + '.' } : {}), replacements: args.replace_all === true ? matches : 1, beforeBytes: Buffer.byteLength(current, 'utf8'), afterBytes: Buffer.byteLength(next, 'utf8'), backupCreated: true, ...(editWarning ? { warning: editWarning } : {}) };
    }
    case 'write_file': {
      if (typeof args.content !== 'string') throw new Error('File contents must be a string.');
      // Writes share edit_file's 64 MiB limit; at 256 KiB a large generated file
      // (fixture, data file, bundle) could not be written at all.
      if (Buffer.byteLength(args.content, 'utf8') > MAX_EDIT_FILE) throw new Error('New file content exceeds the 64 MiB limit.');
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      // append: true lets a model with a small output limit build a long file
      // over several calls instead of sending one call that gets cut off.
      const appending = args.append === true;
      let newContent = args.content;
      let backedUpExistingFile = false;
      let previousContent = null;
      let previousEncoding = 'utf8';
      const writeDisplayPath = target.relative.split(path.sep).join('/');
      try {
        const old = await lstat(target.absolute);
        if (old.isDirectory()) throw new Error('Refusing to replace a directory with a file.');
        await assertFileFresh(context, target.absolute, writeDisplayPath, { fullOverwrite: !appending });
        if (old.isFile() && old.size <= MAX_EDIT_FILE) {
          try { ({ text: previousContent, encoding: previousEncoding } = await readTextFile(target.absolute)); } catch { previousContent = null; }
        }
        if (appending) {
          if (previousContent === null) throw new Error('Cannot append to ' + writeDisplayPath + ': it is not a readable text file under 64 MiB.');
          newContent = previousContent + args.content;
          if (Buffer.byteLength(newContent, 'utf8') > MAX_EDIT_FILE) throw new Error('Appending would make ' + writeDisplayPath + ' larger than the 64 MiB limit.');
        } else {
          assertNoNewElision(previousContent, args.content, writeDisplayPath);
        }
        await snapshotFile(target.root, target.absolute, 'before-agent-write');
        backedUpExistingFile = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const conventions = preserveFileConventions(previousContent, newContent);
      const content = conventions.content;
      await mkdir(path.dirname(target.absolute), { recursive: true });
      // New project files get normal permissions (umask applies) so web servers, containers and
      // teammates can read them; only secret-looking files are created owner-only.
      // Overwriting a UTF-16 file keeps it UTF-16; new files are UTF-8.
      await atomicWriteFile(target.absolute, encodeText(content, previousEncoding), { encoding: 'utf8', mode: sensitivePath(target.relative) ? 0o600 : 0o666 });
      await clientMirrorWrite(context, target.absolute, content);
      await recordFileState(context, target.absolute);
      const docWarning = backedUpExistingFile ? '' : unrequestedDocWarning(writeDisplayPath, context.session && context.session.currentRequest);
      const writeModuleWarning = await moduleSystemWarning(root, target.absolute, writeDisplayPath, previousContent, newContent).catch(() => '');
      const writeWarning = previousContent === null ? combineWarnings(writeModuleWarning, docWarning, commentWarning('', newContent, writeDisplayPath, context.session && context.session.commentMode), securityWarning('', newContent, writeDisplayPath)) : combineWarnings(writeModuleWarning, commentWarning(previousContent, newContent, writeDisplayPath, context.session && context.session.commentMode), shrinkWarning(previousContent, newContent, writeDisplayPath), testTamperWarning(previousContent, newContent, writeDisplayPath), typographyWarning(previousContent, newContent, writeDisplayPath), securityWarning(previousContent, newContent, writeDisplayPath), recordAndDetectCircling(context.session || context, target.absolute, previousContent, newContent, writeDisplayPath));
      return { path: writeDisplayPath, writtenBytes: Buffer.byteLength(content, 'utf8'), backedUpExistingFile, ...(appending ? { appended: true, appendedBytes: Buffer.byteLength(args.content, 'utf8') } : {}), ...(conventions.kept.length ? { kept: conventions.kept } : {}), ...(writeWarning ? { warning: writeWarning } : {}) };
    }
    case 'delete_file': {
      const target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true });
      const info = await lstat(target.absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only regular files can be deleted with this tool.');
      const protectedHit = protectedEditsAllowed(context.env || process.env) || (context.autoApprove && context.permissionMode === 'bypassPermissions') ? null : protectedConfigPath(target.root, target.real);
      const deletePrompt = (protectedHit ? 'Warning: ' + target.relative + ' is a protected configuration file — ' + protectedHit.reason + '. Deleting it can remove deny rules or safety hooks.\n' : '') +
        'Delete the workspace file ' + target.relative + '? Its current contents will be backed up first.';
      if (!context.approval || !(await context.approval(deletePrompt, Boolean(protectedHit)))) {
        return { approved: false, path: target.relative, message: 'Deletion was not approved. No file was removed.' };
      }
      await snapshotFile(target.root, target.absolute, 'before-agent-delete');
      await unlink(target.absolute);
      forgetFileState(context, target.absolute);
      return { path: target.relative, deleted: true, backupCreated: true };
    }
    case 'run_command': {
      if (args.run_in_background !== true && args.interactive !== true) {
        const sleepError = longSleepError(argvSleepSeconds(args.command, args.args), context.env || process.env);
        if (sleepError) throw new Error(sleepError);
      }
      const env = context.env || process.env;
      const discard = gitSafety.gitSafetyEnabled(env) ? gitSafety.discardingGitCommand(args.command, args.args || []) : '';
      const commitCall = gitSafety.gitCommitInvocation(args.command, args.args || []);
      if (commitCall && Array.isArray(args.args)) {
        // Commits credit the user only: AI/bot Co-authored-by trailers and
        // "Generated with" footers the model added are removed before Git runs.
        const { sanitizeCommitArgv } = await import('./commit-attribution.mjs');
        const cleaned = sanitizeCommitArgv(args.command, args.args);
        if (cleaned !== args.args) args = { ...args, args: cleaned };
      }
      {
        const { rawBranchRuleBlock } = await import('./git-tools.mjs');
        const blockedByRule = await rawBranchRuleBlock(root, args.command, args.args || [], context.session && context.session.branchRules, env).catch(() => '');
        if (blockedByRule) return { command: args.command, approved: false, blocked: true, message: blockedByRule };
      }
      if (commitCall) {
        const { rawCommitSecretHits, formatSecretHits } = await import('./git-tools.mjs');
        const hits = await rawCommitSecretHits(root, { all: commitCall.all, env }).catch(() => []);
        if (hits.length) return { command: args.command, approved: false, blocked: true, secretHits: hits.slice(0, 15), message: formatSecretHits(hits) + ' The command was not run.' };
      }
      const { guardInstallCommand } = await import('./package-vetting.mjs');
      const install = await guardInstallCommand(args.command, args.args || [], { env, fetchImpl: context.fetchImpl || globalThis.fetch });
      if (install.blocked) return { command: args.command, ...install.blocked };
      const approval = install.approvalNote && context.approval ? (text, ...rest) => context.approval(install.approvalNote + '\n' + text, ...rest) : context.approval;
      const snapshot = discard ? await gitSafety.snapshotWorkingTree(root, discard) : null;
      const { snapshotScriptedEdit, noOpEditWarning } = await import('./inplace-edit-check.mjs');
      const editSnapshot = args.run_in_background === true || args.interactive === true ? null
        : await snapshotScriptedEdit(root, [args.command].concat(Array.isArray(args.args) ? args.args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg) : []).join(' '), env).catch(() => null);
      const commandResult = await runWorkspaceCommand(root, args.command, args.args || [], {
        approval,
        autoApprove: Boolean(context.autoApprove) && !install.forceAsk,
        timeoutSeconds: Math.min(args.timeoutSeconds || context.maxCommandSeconds || 120, context.maxCommandSeconds || 600),
        env: context.env || process.env,
        signal: context.signal,
        sandbox: context.sandbox,
        ruleAllowed: Boolean(context.ruleAllowed) && !install.forceAsk,
        bypassPermissions: Boolean(context.autoApprove && context.permissionMode === 'bypassPermissions'),
        readOnlyCommands: readOnlyCommandsEnabled(env, (context.session && context.session.settings) || {}),
        background: args.run_in_background === true,
        interactive: args.interactive === true,
        ptyManager: context.session && (context.session.ptyManager ||= new PtySessionManager()),
        backgroundRegistry: context.session && (context.session.background ||= new Map()),
        onExit: args.run_in_background === true && context.session ? backgroundExitNotifier(context.session) : undefined,
        onStuck: args.run_in_background === true && context.session ? backgroundStuckNotifier(context.session) : undefined,
        adoptOnExit: context.session ? backgroundExitNotifier(context.session) : undefined,
        adoptOnStuck: context.session ? backgroundStuckNotifier(context.session) : undefined,
        maxSeconds: args.max_seconds,
        injectionHold: injectionHoldReason(context.session),
        clientTerminal: context.session && typeof context.session.clientTerminal === 'function' ? context.session.clientTerminal : undefined,
        ...(typeof context.onOutput === 'function' && args.run_in_background !== true && args.interactive !== true ? { onOutput: context.onOutput } : {})
      }).catch(async (error) => { await gitSafety.dropSnapshot(snapshot); throw error; });
      if (install.warnings && commandResult && typeof commandResult === 'object') commandResult.packageWarnings = install.warnings;
      if (commandResult && typeof commandResult === 'object' && typeof commandResult.exitCode === 'number') {
        const flagNote = commandFlagWarning([args.command].concat(Array.isArray(args.args) ? args.args : []).join(' '));
        if (flagNote) commandResult.commandWarning = flagNote;
      }
      if (editSnapshot && commandResult && typeof commandResult === 'object') {
        const noOp = await noOpEditWarning(editSnapshot, commandResult.exitCode);
        if (noOp) commandResult.noOpEditWarning = noOp;
      }
      if (snapshot) {
        if (commandResult && commandResult.approved === false) await gitSafety.dropSnapshot(snapshot);
        else if (commandResult && typeof commandResult === 'object') commandResult.safetySnapshot = gitSafety.snapshotNote(snapshot);
      }
      return commandResult;
    }
    case 'monitor': {
      const session = context.session;
      if (!session) throw new Error('monitor is only available in an agent session.');
      const headless = Boolean(session.headless);
      if (args.ws) return await startWsMonitor(session, args, { approval: context.approval, autoApprove: Boolean(context.autoApprove), ruleAllowed: Boolean(context.ruleAllowed), headless });
      return await startCommandMonitor(session, args, {
        run: runWorkspaceCommand, root, headless,
        runOptions: {
          approval: context.approval, autoApprove: Boolean(context.autoApprove), env: context.env || process.env, signal: context.signal,
          sandbox: context.sandbox, ruleAllowed: Boolean(context.ruleAllowed), backgroundRegistry: session.background ||= new Map()
        }
      });
    }
    case 'install_package': {
      const name = normalizePackageName(args.packageName);
      const plan = planPackageInstall({ packageName: name, ecosystem: args.ecosystem || 'auto', workspaceRoot: root, env: context.env || process.env });
      const { vetPackage } = await import('./package-vetting.mjs');
      const vetting = await vetPackage(plan, { fetchImpl: context.fetchImpl || globalThis.fetch, env: context.env || process.env });
      if (vetting.missing) {
        return { approved: false, blocked: true, plan, vetting, message: vetting.warnings.join(' ') + ' Nothing was installed. The name may be misspelled or invented; check the exact package name in the project docs before trying again.' };
      }
      if (vetting.warnings.length) plan.note = plan.note + '\nPackage check: ' + vetting.warnings.join(' ');
      // Suspicious packages always need a human, even in auto-approve modes.
      const installResult = await runInstallPlan(plan, { root, approval: context.approval, autoApprove: Boolean(context.autoApprove) && !vetting.risky, env: context.env || process.env, signal: context.signal });
      return vetting.warnings.length ? { ...installResult, vetting } : installResult;
    }
    case 'fetch_url':
      return await fetchPublicUrl(args.url, { lookupImpl: context.lookupImpl, requestImpl: context.requestImpl, startIndex: args.start_index, maxLength: args.max_length, raw: args.raw === true, extract: args.full_page !== true });
    case 'web_search':
      // Zero-budget mode searches only with keyless backends unless a keyed one is declared free.
      { const { zeroBudgetSearchEnv } = await import('./cost-policy.mjs');
        return await webSearch(args, { env: zeroBudgetSearchEnv(context.env || process.env, context.session || {}) }); }
    case 'worktree_inspect':
    case 'worktree_merge':
    case 'git_log':
    case 'git_commit':
    case 'git_branch':
    case 'git_push':
    case 'create_pull_request':
      return await runGitTool(name, root, args, {
        approval: context.approval,
        autoApprove: Boolean(context.autoApprove),
        ruleAllowed: Boolean(context.ruleAllowed),
        env: context.env || process.env,
        signal: context.signal,
        branchRules: context.session && context.session.branchRules,
        session: context.session
      });
    case 'skill_propose': {
      const { runLearningTool } = await import('./learning.mjs');
      return await runLearningTool(name, args, { root, env: context.env || process.env, session: context.session });
    }
    case 'generate_image': {
      const { generateImage, imageGenerationConfig } = await import('./image-gen.mjs');
      const session = context.session || {};
      const config = session.imageGeneration || imageGenerationConfig(context.env || process.env, session.settings || {});
      if (config) (await import('./cost-policy.mjs')).assertZeroBudgetService('image', config, { session, env: context.env || process.env });
      return await generateImage(args, {
        config, approval: context.approval, autoApprove: Boolean(context.autoApprove), signal: context.signal,
        resolvePath: (rel) => resolveWorkspacePath(root, rel, { rejectSymlinks: true }),
        beforeWrite: async (target) => {
          try { if ((await lstat(target.absolute)).isFile()) await snapshotFile(target.root, target.absolute, 'before-agent-write'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      });
    }
    case 'text_to_speech': {
      const { textToSpeech, textToSpeechConfig } = await import('./tts.mjs');
      const session = context.session || {};
      const config = session.textToSpeech || textToSpeechConfig(context.env || process.env, session.settings || {});
      if (config) (await import('./cost-policy.mjs')).assertZeroBudgetService('tts', config, { session, env: context.env || process.env });
      return await textToSpeech(args, {
        config, approval: context.approval, autoApprove: Boolean(context.autoApprove), signal: context.signal,
        resolvePath: (rel) => resolveWorkspacePath(root, rel, { rejectSymlinks: true }),
        beforeWrite: async (target) => {
          try { if ((await lstat(target.absolute)).isFile()) await snapshotFile(target.root, target.absolute, 'before-agent-write'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      });
    }
    case 'session_search': {
      const { runSessionSearchTool } = await import('./session-search.mjs');
      return await runSessionSearchTool(args, { root, env: context.env || process.env, session: context.session });
    }
    case 'memory_save':
    case 'memory_search':
    case 'memory_read':
    case 'memory_delete': {
      const { runMemoryTool } = await import('./auto-memory.mjs');
      return await runMemoryTool(name, args, { root, env: context.env || process.env, session: context.session, approval: context.approval, autoApprove: Boolean(context.autoApprove) });
    }
    case 'ast_grep': {
      const { runAstGrep } = await import('./ast-grep.mjs');
      return await runAstGrep(root, args, { env: context.env || process.env, signal: context.signal });
    }
    case 'lsp':
      return await runLsp(root, args, {
        session: context.session,
        settings: context.session && context.session.settings,
        approval: context.approval,
        autoApprove: Boolean(context.autoApprove),
        ruleAllowed: Boolean(context.ruleAllowed),
        env: context.env || process.env
      });
    case 'security_scan': {
      const { runSecurityScan } = await import('./security-scan.mjs');
      return await runSecurityScan(root, args, {
        approval: context.approval,
        autoApprove: Boolean(context.autoApprove),
        ruleAllowed: Boolean(context.ruleAllowed),
        env: context.env || process.env,
        signal: context.signal,
        sandbox: context.sandbox
      });
    }
    case 'diagnostics':
      return await runDiagnostics(root, args, {
        approval: context.approval,
        autoApprove: Boolean(context.autoApprove),
        ruleAllowed: Boolean(context.ruleAllowed),
        env: context.env || process.env,
        signal: context.signal,
        sandbox: context.sandbox
      });
    case 'browser': {
      const { executeBrowserTool } = await import('./browser-tool.mjs');
      return await executeBrowserTool(args, { ...context, session: context.session || context });
    }
    default:
      if (POWER_TOOL_NAMES.has(name)) return await executePowerTool(name, args, context, root);
      throw new Error('Unknown or unavailable tool: ' + name);
  }
}

export async function loadProjectInstructions(root, options = {}) {
  // User, project, and local memory files (see memory.mjs). Skill instructions are
  // deliberately not loaded here: the model receives a compact catalogue and calls
  // load_skill when one is relevant.
  return await loadMemory(root, options);
}

TOOL_DEFINITIONS.push(...POWER_TOOL_DEFINITIONS);
TOOL_DEFINITIONS.push(WEB_SEARCH_TOOL_DEFINITION);
TOOL_DEFINITIONS.push(DIAGNOSTICS_TOOL_DEFINITION);
TOOL_DEFINITIONS.push(SECURITY_SCAN_TOOL_DEFINITION);
TOOL_DEFINITIONS.push(LSP_TOOL_DEFINITION);
TOOL_DEFINITIONS.push(MONITOR_TOOL_DEFINITION);
TOOL_DEFINITIONS.push(...GIT_TOOL_DEFINITIONS);

export function toolCount() {
  return TOOL_DEFINITIONS.length;
}

// "spawn foo ENOENT" means the program is missing; say so, and how to check.
export function spawnErrorText(error, command) {
  const code = error && error.code;
  const name = String(command || (error && error.path) || 'the command');
  if (code === 'ENOENT') return 'Command not found: ' + name + '. It is not installed or not on PATH (check with `command -v ' + name.replace(/[^\w@./+-]/g, '') + '`), or the working directory does not exist.';
  if (code === 'EACCES') return 'Permission denied running ' + name + ': the file is not executable (chmod +x) or not a program.';
  return String((error && error.message) || error);
}
