// Subagents: the `task` tool launches a focused child agent with its own context
// window and returns only its final report to the parent. Several task calls in
// one model response run in parallel.
//
// Custom agents are Markdown files with YAML-style front matter, compatible with
// Claude Code's .claude/agents format:
//   ---
//   name: test-runner
//   description: Use after code changes to run tests and fix failures
//   tools: Read, Grep, Glob, Bash, Edit        (optional; omit for all tools)
//   disallowedTools: Write                      (optional; removed after `tools`)
//   model: inherit                              (optional model id override)
//   maxTurns: 40                                (optional tool-step cap)
//   permissionMode: plan                        (optional; `plan` keeps it read-only)
//   skills: [lint-rules]                        (optional; preloaded into its prompt)
//   memory: project                             (optional; user | project | local)
//   background: true                            (optional; run in the background by default)
//   isolation: worktree, effort: high, color: blue
//   ---
//   You are a test specialist...
// Locations (later wins): ~/.claude/agents, ~/.config/oasis/agents, .claude/agents, .oasis/agents
// Other agents' definition folders are read below those (OASIS_OTHER_AGENT_RULES=0 skips them):
// Gemini CLI ~/.gemini/agents and .gemini/agents, OpenCode ~/.config/opencode/agents and
// .opencode/agents (also the older singular agent/), Kilo Code .kilo/agents, .kilo/agent,
// .kilocode/agents and ~/.config/kilo/agent (OpenCode's format), translated by
// foreignAgentFrontMatter; Roo Code .roomodes and Kilo .kilocodemodes custom modes (loadLegacyModes).
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { parseFrontMatter } from './frontmatter.mjs';

export { parseFrontMatter };
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

// Claude Code reads agent files of any size; 64 KiB dropped larger ones silently.
const MAX_AGENT_FILE = 1024 * 1024;
const MAX_AGENT_PROMPT = 200000;
export const MAX_PARALLEL_SUBAGENTS = 6;

const CLAUDE_TO_OASIS = {
  read: ['read_file'], write: ['write_file'], edit: ['edit_file'], multiedit: ['multi_edit'], notebookedit: ['notebook_edit'],
  bash: ['run_command', 'run_shell', 'command_output', 'kill_command', 'list_background'],
  grep: ['grep', 'search_files', 'ast_grep'], glob: ['glob_files'], ls: ['list_files'], webfetch: ['fetch_url'], websearch: ['web_search'],
  todowrite: ['todo_write'], bashoutput: ['command_output'], killshell: ['kill_command'],
  // Agent (formerly Task) launches subagents; Agent(type, ...) type lists are ignored, as in Claude Code.
  agent: ['task'], task: ['task'],
  // Google Antigravity tool names (.agents/agents/*.md).
  view_file: ['read_file'], view_code_item: ['read_file'], replace_file_content: ['edit_file'], multi_replace_file_content: ['multi_edit'],
  write_to_file: ['write_file'], grep_search: ['grep', 'search_files'], find_by_name: ['glob_files'], list_dir: ['list_files'],
  codebase_search: ['grep', 'search_files', 'repo_map'], read_url_content: ['fetch_url'], search_web: ['web_search'], command_status: ['command_output'],
  invoke_subagent: ['task']
};

const READ_ONLY = ['git_status', 'git_diff', 'git_log', 'lsp', 'list_files', 'glob_files', 'repo_map', 'read_file', 'search_files', 'grep', 'ast_grep', 'fetch_url', 'web_search', 'list_skills', 'load_skill', 'read_skill_resource', 'memory_search', 'memory_read', 'session_search'];

export const BUILTIN_AGENTS = {
  'general-purpose': {
    name: 'general-purpose',
    description: 'General agent for research, code search and multi-step work including edits and commands. Use for self-contained work that would fill the main context.',
    summary: 'Edits, commands and research for self-contained multi-step work.',
    tools: null,
    prompt: 'You are a general-purpose subagent. Complete the delegated task end to end using the available tools. Verify your work where possible.',
    source: 'built-in'
  },
  explore: {
    name: 'explore',
    description: 'Fast read-only agent for exploring a codebase: finding files, searching for symbols, and answering questions about how code works. Cannot edit files or run commands.',
    summary: 'Read-only code search; returns findings with paths and line numbers.',
    tools: READ_ONLY,
    prompt: 'You are a read-only exploration subagent. Search broadly, read the relevant code, and return precise findings with file paths and line numbers. Do not attempt edits.',
    source: 'built-in'
  },
  plan: {
    name: 'plan',
    description: 'Read-only software architect: investigates the codebase and returns a concrete, step-by-step implementation plan with files to change and risks.',
    summary: 'Read-only; returns a step-by-step implementation plan with files and risks.',
    tools: READ_ONLY,
    prompt: 'You are a planning subagent. Investigate the code, then return a numbered implementation plan listing the exact files and functions to change, the order of work, tests to add, and risks. Do not edit files.',
    source: 'built-in'
  },
  'code-review': {
    name: 'code-review',
    description: 'Independent read-only reviewer: finds correctness bugs, regressions, edge cases and missing tests in proposed changes.',
    summary: 'Read-only review of changes for bugs, regressions, edge cases and missing tests.',
    tools: READ_ONLY,
    prompt: 'You are an independent code reviewer. Inspect the actual diff and surrounding implementation. Report only actionable findings, ordered by severity. For every finding include the exact file and line, the failing scenario, why the behavior is incorrect, and a concrete test that would catch it. Distinguish confirmed defects from risks or suggestions. Do not edit files. Do not report style-only preferences as bugs. If you find no actionable defects, say so and list the areas you inspected. Judge the code, not the author’s description of it: do not praise the change, soften a real defect, or agree with a claim you have not checked.',
    source: 'built-in'
  },
  'security-review': {
    name: 'security-review',
    description: 'Independent read-only security reviewer: inspects trust boundaries, permissions, secrets, filesystem and network access.',
    summary: 'Read-only security review: trust boundaries, permissions, secrets, file and network access.',
    tools: READ_ONLY,
    prompt: 'You are an independent security reviewer. Inspect the relevant changed code and nearby enforcement boundaries. Focus on authorization, path traversal and symlink races, secrets, untrusted input, network destinations, process execution, cancellation and data exposure. Do not attempt exploitation or make changes. Report only evidence-backed findings with file paths and line numbers, realistic impact, preconditions and a specific regression test. Separate confirmed vulnerabilities from hardening suggestions. If you find no actionable issue, state the scope and limits of your review.',
    source: 'built-in'
  }
};

export function mapToolNames(list) {
  if (!list) return null;
  const items = Array.isArray(list) ? list : String(list).split(',');
  const out = new Set();
  for (const raw of items) {
    const name = String(raw).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const mapped = CLAUDE_TO_OASIS[key] || (/^(agent|task)\s*\(/.test(key) ? ['task'] : null);
    if (mapped) mapped.forEach((tool) => out.add(tool));
    else out.add(name);
  }
  return out.size ? [...out] : null;
}

const EFFORTS = ['low', 'medium', 'high', 'max'];
const MEMORY_SCOPES = ['user', 'project', 'local'];
const MAX_PRELOADED_SKILLS = 32;
const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

function listField(value) {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function mcpServersField(value) {
  if (!value || typeof value !== 'object') return null;
  const refs = [];
  const inline = {};
  const take = (map) => { for (const [name, spec] of Object.entries(map)) if (spec && typeof spec === 'object' && !Array.isArray(spec) && Object.keys(inline).length < 10) inline[name] = spec; };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) refs.push(item.trim());
      else if (item && typeof item === 'object' && !Array.isArray(item)) take(item);
    }
  } else take(value);
  return refs.length || Object.keys(inline).length ? { refs, inline } : null;
}

function booleanField(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

// One normalizer for every agent source, so project, user and plugin agents
// accept the same Claude Code front matter.
export function normalizeAgentDefinition(raw, body, { name, source, plugin = false }) {
  // Keys are matched case-insensitively and with dashes or underscores removed:
  // maxTurns, max-turns and maxturns are the same field.
  const data = {};
  for (const [key, value] of Object.entries(raw || {})) data[key.toLowerCase().replace(/[-_]/g, '')] = value;
  const lower = (value) => String(value || '').trim().toLowerCase();
  const maxTurns = Number.parseInt(data.maxturns ?? '', 10);
  const memory = lower(data.memory);
  const color = lower(data.color);
  return {
    name,
    description: String(data.description || (plugin ? 'Plugin agent ' : 'Custom agent ') + name).slice(0, 600),
    tools: mapToolNames(data.tools),
    // Antigravity's commandExecutionPolicy: off removes the shell tools (other values keep OASIS's own approval rules).
    disallowedTools: lower(data.commandexecutionpolicy) === 'off' ? [...new Set([...(mapToolNames(data.disallowedtools) || []), ...CLAUDE_TO_OASIS.bash])] : mapToolNames(data.disallowedtools),
    // Antigravity's model tiers (flash, pro) name no concrete model, so they inherit.
    model: data.model && !['inherit', 'flash', 'pro'].includes(lower(data.model)) ? String(data.model) : null,
    isolation: lower(data.isolation) === 'worktree' ? 'worktree' : null,
    effort: EFFORTS.includes(lower(data.effort)) ? lower(data.effort) : null,
    maxTurns: Number.isInteger(maxTurns) && maxTurns > 0 ? Math.min(maxTurns, 400) : null,
    // Plugin agents cannot change their permission mode (matches Claude Code).
    // Only `plan` is honoured: a definition file may tighten, never loosen, approvals.
    permissionMode: !plugin && lower(data.permissionmode) === 'plan' ? 'plan' : null,
    skills: listField(data.skills).map((skill) => skill.replace(/\/+$/, '').split('/').pop()).filter((skill) => /^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(skill)).slice(0, MAX_PRELOADED_SKILLS),
    memory: MEMORY_SCOPES.includes(memory) ? memory : null,
    background: booleanField(data.background),
    color: AGENT_COLORS.includes(color) ? color : null,
    // Hooks scoped to this agent; ignored for plugin agents (matches Claude Code).
    hooks: !plugin && data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : null,
    // MCP servers for this agent: names of configured servers (already shared
    // with every subagent) and inline definitions connected only while it runs.
    mcpServers: plugin ? null : mcpServersField(data.mcpservers),
    // Compact as if the context window were this many tokens (100,000-1,000,000).
    autoCompactWindow: (() => { const value = Number.parseInt(data.autocompactwindow ?? '', 10); return Number.isInteger(value) && value >= 100_000 && value <= 1_000_000 ? value : null; })(),
    // Start without CLAUDE.md / OASIS.md project instructions.
    omitClaudeMd: booleanField(data.omitclaudemd),
    // First user turn when this agent runs as the main session agent (--agent); not for plugin agents.
    initialPrompt: !plugin && data.initialprompt ? String(data.initialprompt).trim().slice(0, 20000) : '',
    prompt: agentPromptText(body),
    // Antigravity: `subagent: false` keeps an agent out of the task tool (it can still be the main agent).
    subagentAllowed: data.subagent === undefined ? true : booleanField(data.subagent),
    source
  };
}

const MEMORY_LINES = 200;
const MEMORY_BYTES = 25 * 1024;

// Persistent per-agent memory, laid out like Claude Code's agent memory.
export function agentMemoryDirectory(agent, root, env = process.env) {
  if (!agent || !agent.memory) return null;
  const name = String(agent.name).replace(/[^a-z0-9_-]/gi, '-');
  if (agent.memory === 'user') return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude', 'agent-memory', name);
  if (agent.memory === 'local') return path.join(root, '.claude', 'agent-memory-local', name);
  return path.join(root, '.claude', 'agent-memory', name);
}

// The first 200 lines (at most 25 KB) of MEMORY.md, or '' when there is none.
export async function loadAgentMemory(agent, root, env = process.env) {
  const dir = agentMemoryDirectory(agent, root, env);
  if (!dir) return '';
  const file = path.join(dir, 'MEMORY.md');
  try {
    const info = await stat(file);
    if (!info.isFile()) return '';
    const text = (await readFile(file, 'utf8')).split('\n').slice(0, MEMORY_LINES).join('\n');
    return Buffer.byteLength(text) > MEMORY_BYTES ? Buffer.from(text).subarray(0, MEMORY_BYTES).toString('utf8') : text;
  } catch { return ''; }
}

// Gemini CLI tool names (docs/core/subagents.md, docs/tools in google-gemini/gemini-cli).
const GEMINI_TOOLS = {
  read_file: ['read_file'], read_many_files: ['read_file'], write_file: ['write_file'], replace: ['edit_file'],
  run_shell_command: CLAUDE_TO_OASIS.bash, grep_search: CLAUDE_TO_OASIS.grep, search_file_content: CLAUDE_TO_OASIS.grep,
  glob: ['glob_files'], list_directory: ['list_files'], web_fetch: ['fetch_url'], google_web_search: ['web_search'],
  write_todos: ['todo_write']
};
// OpenCode tool and permission names (opencode.ai/docs/agents, /docs/permissions).
const OPENCODE_TOOLS = {
  bash: CLAUDE_TO_OASIS.bash, shell: CLAUDE_TO_OASIS.bash, read: ['read_file'], edit: ['edit_file', 'multi_edit', 'write_file', 'apply_patch'],
  write: ['write_file'], patch: ['apply_patch'], grep: CLAUDE_TO_OASIS.grep, glob: ['glob_files'], list: ['list_files'],
  webfetch: ['fetch_url', 'web_search'], websearch: ['web_search'], todowrite: ['todo_write'], task: ['task'], subagent: ['task']
};

/**
 * Gemini CLI and OpenCode agent front matter -> the Claude-style fields
 * normalizeAgentDefinition reads. Returns null for files OASIS cannot run
 * (Gemini remote/A2A agents, disabled OpenCode agents). Models are not carried over:
 * Gemini model ids and OpenCode provider/model ids rarely name a model on the
 * user's OASIS provider, so these agents inherit the session model.
 */
function foreignAgentFrontMatter(flavor, raw = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const lower = (value) => String(value ?? '').trim().toLowerCase();
  if (flavor === 'gemini') {
    if (lower(data.kind) === 'remote') return null;
    const listed = Array.isArray(data.tools) ? data.tools.map(String) : data.tools ? String(data.tools).split(',') : null;
    let tools = null;
    if (listed && !listed.some((tool) => tool.trim() === '*')) {
      // MCP wildcards (mcp_*, mcp_server_*) have no OASIS equivalent and are dropped.
      tools = [...new Set(listed.flatMap((tool) => GEMINI_TOOLS[lower(tool)] || (lower(tool).includes('*') ? [] : [tool.trim()])))];
      if (!tools.length) tools = ['read_file'];
    }
    const maxTurns = Number.parseInt(data.max_turns ?? '', 10);
    return { name: data.name, description: data.description, tools: tools || undefined, maxTurns: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : undefined, mcpServers: data.mcpServers };
  }
  if (flavor === 'opencode') {
    if (data.disable === true || data.disabled === true || lower(data.disable) === 'true' || lower(data.disabled) === 'true') return null;
    const denied = new Set();
    const deny = (name) => (OPENCODE_TOOLS[lower(name)] || []).forEach((tool) => denied.add(tool));
    // V1: tools: { write: false, bash: false }
    if (data.tools && typeof data.tools === 'object' && !Array.isArray(data.tools)) for (const [tool, on] of Object.entries(data.tools)) if (on === false || lower(on) === 'false') deny(tool);
    // V1: permission: { edit: deny, bash: deny | { pattern: action }, webfetch: deny }. Only a whole-tool deny
    // is carried over; ask and per-command rules leave OASIS's own approvals in charge.
    if (data.permission && typeof data.permission === 'object' && !Array.isArray(data.permission)) {
      for (const [tool, value] of Object.entries(data.permission)) {
        if (lower(value) === 'deny' || (value && typeof value === 'object' && Object.keys(value).length === 1 && lower(value['*']) === 'deny')) deny(tool);
      }
    }
    // V2: permissions: [{ action, resource, effect }], last match wins; only resource "*" rules apply here.
    if (Array.isArray(data.permissions)) {
      const effect = {};
      for (const rule of data.permissions) if (rule && typeof rule === 'object' && (rule.resource === undefined || rule.resource === '*')) effect[lower(rule.action)] = lower(rule.effect);
      for (const [action, value] of Object.entries(effect)) if (value === 'deny') deny(action);
    }
    const steps = Number.parseInt(data.steps ?? data.maxSteps ?? '', 10);
    const mode = lower(data.mode) || 'primary';
    return {
      description: data.description,
      disallowedTools: denied.size ? [...denied] : undefined,
      maxTurns: Number.isInteger(steps) && steps > 0 ? steps : undefined,
      // Primary-only and hidden agents can run as the main agent (oasis --agent NAME) but are not offered to the task tool.
      subagent: mode === 'primary' || data.hidden === true || lower(data.hidden) === 'true' ? false : undefined
    };
  }
  return data;
}

// Roo Code `.roomodes` and Kilo Code's legacy `.kilocodemodes` (YAML or JSON, `customModes:`),
// from docs.roocode.com/features/custom-modes and /custom-instructions. Each mode becomes an
// agent: whenToUse (or description, or the first sentence of roleDefinition) describes it,
// and its prompt is roleDefinition, customInstructions and the mode's rule files
// (.roo/rules-{slug}/ in the workspace and home, else .roorules-{slug}, else .clinerules-{slug};
// .kilocode/rules-{slug}/ for Kilo). Tool groups left out of `groups` are removed
// (read, edit, command); an edit `fileRegex` is passed on as an instruction only, and the mcp
// and browser groups are not enforced. Global custom_modes.yaml in VS Code storage is not read.
const ROO_GROUP_TOOLS = {
  read: ['read_file', 'list_files', 'glob_files', 'search_files', 'grep', 'ast_grep', 'repo_map', 'lsp'],
  edit: ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'notebook_edit'],
  command: CLAUDE_TO_OASIS.bash
};
const MAX_MODE_RULES = 48 * 1024;

async function readRuleTree(dir, budget) {
  const files = [];
  const walk = async (current, depth) => {
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || /\.(?:swp|tmp)$|~$/.test(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (entry.isFile()) files.push(full);
    }
  };
  await walk(dir, 0);
  // Roo sorts by file name only, case-insensitively.
  files.sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase()));
  const parts = [];
  let used = 0;
  for (const file of files.slice(0, 50)) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    if (!text.trim() || text.includes('\0') || used + text.length > budget) continue;
    used += text.length;
    parts.push('# Rules from ' + file + ':\n' + text.trim());
  }
  return parts;
}

async function readRuleFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_MODE_RULES) return '';
    const text = await readFile(file, 'utf8');
    return text.trim() && !text.includes('\0') ? text.trim() : '';
  } catch { return ''; }
}

async function loadLegacyModes(root, env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const out = [];
  const seen = new Set();
  // Roo's file wins over Kilo's legacy file for the same slug.
  for (const { file, tool } of [{ file: '.roomodes', tool: 'Roo Code' }, { file: '.kilocodemodes', tool: 'Kilo Code' }]) {
    let text;
    try { const info = await stat(path.join(root, file)); if (!info.isFile() || info.size > MAX_AGENT_FILE * 4) continue; text = await readFile(path.join(root, file), 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = (await import('yaml')).parse(text, { schema: 'core', maxAliasCount: 50 }); } catch { continue; }
    const modes = parsed && Array.isArray(parsed.customModes) ? parsed.customModes : [];
    for (const mode of modes.slice(0, 50)) {
      if (!mode || typeof mode !== 'object' || !/^[a-zA-Z0-9-]{1,64}$/.test(String(mode.slug || ''))) continue;
      const slug = String(mode.slug);
      const name = slug.toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      const role = typeof mode.roleDefinition === 'string' ? mode.roleDefinition.trim() : '';
      const groups = Array.isArray(mode.groups) ? mode.groups : [];
      const granted = new Set();
      const notes = [];
      for (const group of groups) {
        const [id, options] = Array.isArray(group) ? group : [group];
        granted.add(String(id).toLowerCase());
        if (String(id).toLowerCase() === 'edit' && options && typeof options.fileRegex === 'string') {
          try { new RegExp(options.fileRegex); notes.push('Edit only files whose workspace-relative path matches the regular expression `' + options.fileRegex + '`' + (options.description ? ' (' + String(options.description) + ')' : '') + '.'); } catch { /* invalid patterns are ignored, as Roo rejects them */ }
        }
      }
      const disallowed = Object.entries(ROO_GROUP_TOOLS).filter(([group]) => !granted.has(group)).flatMap(([, tools]) => tools);
      const ruleDirs = tool === 'Roo Code' ? [path.join(home, '.roo', 'rules-' + slug), path.join(root, '.roo', 'rules-' + slug)] : [path.join(root, '.kilocode', 'rules-' + slug)];
      let rules = [];
      for (const dir of ruleDirs) rules.push(...await readRuleTree(dir, MAX_MODE_RULES));
      if (!rules.length) {
        for (const fallback of tool === 'Roo Code' ? ['.roorules-' + slug, '.clinerules-' + slug] : ['.kilocoderules-' + slug]) {
          const content = await readRuleFile(path.join(root, fallback));
          if (content) { rules = ['# Rules from ' + fallback + ':\n' + content]; break; }
        }
      }
      const body = [role, typeof mode.customInstructions === 'string' ? mode.customInstructions.trim() : '', ...notes, ...rules].filter(Boolean).join('\n\n');
      const description = String(mode.whenToUse || mode.description || role.split(/(?<=[.!?])\s/)[0] || mode.name || slug).trim();
      const agent = normalizeAgentDefinition({ description, disallowedTools: disallowed.length ? disallowed : undefined }, body, { name, source: 'project:' + path.join(root, file) });
      agent.origin = tool + ' mode';
      if (mode.name) agent.displayName = String(mode.name).slice(0, 80);
      out.push(agent);
    }
  }
  return out;
}

function agentDirectories(root, env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const foreign = env.OASIS_OTHER_AGENT_RULES !== '0';
  const opencodeHome = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  // Later folders override earlier ones: user before project, other agents' folders first, OASIS's own last.
  return [
    ...(foreign ? [
      { dir: path.join(home, '.gemini', 'agents'), source: 'user', flavor: 'gemini' },
      { dir: path.join(opencodeHome, 'agent'), source: 'user', flavor: 'opencode' },
      { dir: path.join(opencodeHome, 'agents'), source: 'user', flavor: 'opencode' },
      // Kilo Code's current agents use OpenCode's format.
      { dir: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'kilo', 'agent'), source: 'user', flavor: 'opencode', label: 'Kilo Code' },
      { dir: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'kilo', 'agents'), source: 'user', flavor: 'opencode', label: 'Kilo Code' }
    ] : []),
    { dir: path.join(home, '.claude', 'agents'), source: 'user' },
    // Google Antigravity layouts: <name>.md or <name>/agent.md.
    { dir: path.join(home, '.gemini', 'config', 'agents'), source: 'user', nested: true },
    { dir: path.join(getConfigDirectory(env), 'agents'), source: 'user' },
    ...(foreign ? [
      { dir: path.join(root, '.gemini', 'agents'), source: 'project', flavor: 'gemini' },
      { dir: path.join(root, '.opencode', 'agent'), source: 'project', flavor: 'opencode' },
      { dir: path.join(root, '.opencode', 'agents'), source: 'project', flavor: 'opencode' },
      { dir: path.join(root, '.kilocode', 'agents'), source: 'project', flavor: 'opencode', label: 'Kilo Code' },
      { dir: path.join(root, '.kilo', 'agent'), source: 'project', flavor: 'opencode', label: 'Kilo Code' },
      { dir: path.join(root, '.kilo', 'agents'), source: 'project', flavor: 'opencode', label: 'Kilo Code' }
    ] : []),
    { dir: path.join(root, '.claude', 'agents'), source: 'project' },
    { dir: path.join(root, '.agents', 'agents'), source: 'project', nested: true },
    { dir: path.join(root, '.oasis', 'agents'), source: 'project' }
  ];
}

// OpenCode (opencode.ai/docs/agents) and Kilo Code accept agents inline in their JSON config:
// "agent" (or the newer "agents") maps a name to { description, mode, prompt | system, tools,
// permission(s), steps, disable }. `prompt` may be "{file:./path}", resolved against the
// config file's folder; project configs may only reference files inside the project.
// Entries with no prompt and no description only tweak OpenCode's built-in agents, so skip them.
const JSON_AGENT_CONFIGS = [['opencode', 'OpenCode'], ['kilo', 'Kilo Code']];

async function loadJsonConfigAgents(root, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const workspace = path.resolve(root);
  const files = [];
  for (const [base, label] of JSON_AGENT_CONFIGS) for (const ext of ['json', 'jsonc']) files.push({ file: path.join(configHome, base, base + '.' + ext), source: 'user', label });
  for (const [base, label] of JSON_AGENT_CONFIGS) for (const ext of ['json', 'jsonc']) files.push({ file: path.join(workspace, base + '.' + ext), source: 'project', label });
  const out = [];
  for (const { file, source, label } of files) {
    let data;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      data = (await import('./importers.mjs')).parseJsonc(await readFile(file, 'utf8'));
    } catch { continue; }
    if (!data || typeof data !== 'object') continue;
    const tables = [data.agent, data.agents].filter((table) => table && typeof table === 'object' && !Array.isArray(table));
    for (const table of tables) {
      for (const [rawName, entry] of Object.entries(table).slice(0, 200)) {
        const name = String(rawName).trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        let body = typeof entry.prompt === 'string' ? entry.prompt : typeof entry.system === 'string' ? entry.system : '';
        const ref = /^\{file:([^}]+)\}$/.exec(body.trim());
        if (ref) body = await readJsonAgentPromptFile(ref[1].trim(), path.dirname(file), source === 'project' ? workspace : null, home);
        if (body == null || (!body.trim() && !entry.description)) continue;
        if (Buffer.byteLength(body) > MAX_AGENT_FILE) continue;
        const meta = { ...entry };
        delete meta.prompt; delete meta.system;
        const normalized = foreignAgentFrontMatter('opencode', meta);
        if (!normalized) continue;
        const agent = normalizeAgentDefinition(normalized, body, { name, source: source + ':' + file });
        agent.origin = label;
        out.push(agent);
      }
    }
  }
  return out;
}

async function readJsonAgentPromptFile(ref, base, confine, home) {
  const target = ref.startsWith('~/') ? path.join(home, ref.slice(2)) : path.resolve(base, ref);
  const inside = (dir, file) => { const rel = path.relative(dir, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  try {
    if (confine && !inside(await realpath(confine), await realpath(target))) return null;
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_AGENT_FILE) return null;
    return await readFile(target, 'utf8');
  } catch { return null; }
}

// The agent's own prompt, cut with a note past MAX_AGENT_PROMPT characters
// instead of mid-sentence with no sign of the rest.
function agentPromptText(body) {
  const text = String(body || '').trim();
  if (text.length <= MAX_AGENT_PROMPT) return text;
  return text.slice(0, MAX_AGENT_PROMPT) + '\n\n[Agent prompt cut: ' + (text.length - MAX_AGENT_PROMPT).toLocaleString('en-US') + ' more characters are in the agent file.]';
}

export async function loadAgentDefinitions(root, options = {}) {
  const env = options.env || process.env;
  const agents = { ...BUILTIN_AGENTS };
  // Roo Code / Kilo Code custom modes come first, so any agent file of the same name wins.
  if (env.OASIS_OTHER_AGENT_RULES !== '0') for (const mode of await loadLegacyModes(root, env)) agents[mode.name] = mode;
  // OpenCode / Kilo Code agents defined inline in opencode.json(c) / kilo.json(c); agent files of the same name win.
  if (env.OASIS_OTHER_AGENT_RULES !== '0') for (const agent of await loadJsonConfigAgents(root, env)) agents[agent.name] = agent;
  for (const { dir, source, nested, flavor, label } of agentDirectories(root, env)) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      let file;
      let fallback;
      if (entry.isFile() && entry.name.endsWith('.md')) { file = path.join(dir, entry.name); fallback = entry.name.replace(/\.md$/, ''); }
      else if (nested && entry.isDirectory()) { file = path.join(dir, entry.name, 'agent.md'); fallback = entry.name; }
      else continue;
      let text;
      try { const info = await stat(file); if (!info.isFile() || info.size > MAX_AGENT_FILE) continue; text = await readFile(file, 'utf8'); } catch { continue; }
      if (Buffer.byteLength(text) > MAX_AGENT_FILE) continue;
      const parsed = parseFrontMatter(text);
      const data = flavor ? foreignAgentFrontMatter(flavor, parsed.data) : parsed.data;
      if (!data) continue;
      // OpenCode names agents by file name only.
      const name = String((flavor !== 'opencode' && data.name) || fallback).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) continue;
      agents[name] = normalizeAgentDefinition(data, parsed.body, { name, source: source + ':' + file });
      if (flavor) agents[name].origin = label || (flavor === 'gemini' ? 'Gemini CLI' : 'OpenCode');
    }
  }
  // Agents from enabled Claude Code plugins, named plugin-name:agent.
  try {
    const { loadEnabledPlugins, pluginAgents } = await import('./claude-plugins.mjs');
    for (const item of await pluginAgents(await loadEnabledPlugins(root, { env }), { env, root })) {
      if (Buffer.byteLength(item.body) > MAX_AGENT_FILE || agents[item.name]) continue;
      const { data, body } = parseFrontMatter(item.body);
      const pluginName = item.name.split(':')[0];
      const name = data.name ? pluginName + ':' + String(data.name).trim().toLowerCase() : item.name;
      if (!/^[a-z0-9][a-z0-9_.-]{0,63}:[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) continue;
      agents[name] = normalizeAgentDefinition(data, body, { name, source: 'plugin:' + item.plugin, plugin: true });
    }
  } catch { /* Plugins are optional. */ }
  return agents;
}

const TASK_AGENT_LIST_BUDGET = 3000;

export function taskToolDefinition(agents) {
  // Keep the schema lean: projects with dozens of custom agents used to send
  // every 600-char description on every request. Clip each entry and cap the list.
  const clip = (text, max) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value; };
  agents = Object.fromEntries(Object.entries(agents).filter(([, agent]) => agent.subagentAllowed !== false));
  const entries = Object.values(agents).map((agent) => '- ' + agent.name + ': ' + clip(agent.summary || agent.description, 220) + (agent.tools && agent.source !== 'built-in' ? ' (tools: ' + clip(agent.tools.join(', '), 120) + ')' : ''));
  const kept = [];
  let used = 0;
  for (const entry of entries) {
    if (used + entry.length > TASK_AGENT_LIST_BUDGET && kept.length) break;
    kept.push(entry);
    used += entry.length + 1;
  }
  if (kept.length < entries.length) kept.push('- …and ' + (entries.length - kept.length) + ' more (' + Object.keys(agents).slice(kept.length).join(', ') + ')');
  const list = kept.join('\n');
  return { type: 'function', function: {
    name: 'task',
    description: 'Run a subagent with its own context; it returns one report. It cannot see this conversation: give a complete, self-contained prompt. Task calls in ONE response run in parallel (max ' + MAX_PARALLEL_SUBAGENTS + '); each returns an id for send_message.\nAgent types:\n' + list,
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: '3-5 word label' },
      prompt: { type: 'string', description: 'Full instructions, including what to return' },
      subagent_type: { type: 'string', enum: Object.keys(agents), description: 'Default general-purpose' },
      run_in_background: { type: 'boolean', description: 'Return the id now, report later. It cannot ask for approval; unallowed actions are denied.' },
      isolation: { type: 'string', enum: ['worktree'], description: 'Work in its own git worktree and branch' },
      team_id: { type: 'string', description: 'Team ID from team_create' },
      model: { type: 'string', description: 'Model ID; omit to inherit' },
      fork_context: { type: 'boolean', description: 'Give it a bounded copy of this conversation, only if it needs earlier discussion' },
      output_schema: { type: 'object', description: 'JSON Schema its final report must match; it gets one correction turn, then you receive `structured`' }
    }, required: ['description', 'prompt'] }
  } };
}

// Runs async functions with a concurrency limit, preserving result order.
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
