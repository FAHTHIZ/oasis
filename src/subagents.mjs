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
//   model: inherit                              (optional model id override)
//   ---
//   You are a test specialist...
// Locations (later wins): ~/.claude/agents, ~/.config/oasis/agents, .claude/agents, .oasis/agents
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const MAX_AGENT_FILE = 64 * 1024;
export const MAX_PARALLEL_SUBAGENTS = 6;

const CLAUDE_TO_OASIS = {
  read: ['read_file'], write: ['write_file'], edit: ['edit_file'], multiedit: ['multi_edit'], notebookedit: ['notebook_edit'],
  bash: ['run_command', 'run_shell', 'command_output', 'kill_command', 'list_background'],
  grep: ['grep', 'search_files'], glob: ['glob_files'], ls: ['list_files'], webfetch: ['fetch_url'], websearch: ['web_search'],
  todowrite: ['todo_write'], bashoutput: ['command_output'], killshell: ['kill_command']
};

const READ_ONLY = ['git_status', 'git_diff', 'git_log', 'lsp', 'list_files', 'glob_files', 'read_file', 'search_files', 'grep', 'fetch_url', 'web_search', 'list_skills', 'load_skill', 'read_skill_resource', 'memory_search', 'memory_read'];

export const BUILTIN_AGENTS = {
  'general-purpose': {
    name: 'general-purpose',
    description: 'General agent for researching complex questions, searching code, and executing multi-step tasks, including edits and commands. Use when a task is self-contained and would otherwise fill the main context.',
    tools: null,
    prompt: 'You are a general-purpose subagent. Complete the delegated task end to end using the available tools. Verify your work where possible.',
    source: 'built-in'
  },
  explore: {
    name: 'explore',
    description: 'Fast read-only agent for exploring a codebase: finding files, searching for symbols, and answering questions about how code works. Cannot edit files or run commands.',
    tools: READ_ONLY,
    prompt: 'You are a read-only exploration subagent. Search broadly, read the relevant code, and return precise findings with file paths and line numbers. Do not attempt edits.',
    source: 'built-in'
  },
  plan: {
    name: 'plan',
    description: 'Read-only software architect: investigates the codebase and returns a concrete, step-by-step implementation plan with files to change and risks.',
    tools: READ_ONLY,
    prompt: 'You are a planning subagent. Investigate the code, then return a numbered implementation plan listing the exact files and functions to change, the order of work, tests to add, and risks. Do not edit files.',
    source: 'built-in'
  }
};

export function parseFrontMatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: String(text) };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
    if (/^\[.*\]$/.test(value)) value = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    data[kv[1].toLowerCase()] = value;
  }
  return { data, body: match[2] };
}

export function mapToolNames(list) {
  if (!list) return null;
  const items = Array.isArray(list) ? list : String(list).split(',');
  const out = new Set();
  for (const raw of items) {
    const name = String(raw).trim();
    if (!name) continue;
    const mapped = CLAUDE_TO_OASIS[name.toLowerCase()];
    if (mapped) mapped.forEach((tool) => out.add(tool));
    else out.add(name);
  }
  return out.size ? [...out] : null;
}

function agentDirectories(root, env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return [
    { dir: path.join(home, '.claude', 'agents'), source: 'user' },
    { dir: path.join(getConfigDirectory(env), 'agents'), source: 'user' },
    { dir: path.join(root, '.claude', 'agents'), source: 'project' },
    { dir: path.join(root, '.oasis', 'agents'), source: 'project' }
  ];
}

export async function loadAgentDefinitions(root, options = {}) {
  const env = options.env || process.env;
  const agents = { ...BUILTIN_AGENTS };
  for (const { dir, source } of agentDirectories(root, env)) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      let text;
      try { text = await readFile(path.join(dir, entry.name), 'utf8'); } catch { continue; }
      if (Buffer.byteLength(text) > MAX_AGENT_FILE) continue;
      const { data, body } = parseFrontMatter(text);
      const name = String(data.name || entry.name.replace(/\.md$/, '')).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) continue;
      agents[name] = {
        name,
        description: String(data.description || 'Custom agent ' + name).slice(0, 600),
        tools: mapToolNames(data.tools),
        model: data.model && data.model !== 'inherit' ? String(data.model) : null,
        isolation: String(data.isolation || '').toLowerCase() === 'worktree' ? 'worktree' : null,
        prompt: body.trim().slice(0, 30000),
        source: source + ':' + path.join(dir, entry.name)
      };
    }
  }
  return agents;
}

export function taskToolDefinition(agents) {
  const list = Object.values(agents).map((agent) => '- ' + agent.name + ': ' + agent.description + (agent.tools ? ' (tools: ' + agent.tools.join(', ') + ')' : '')).join('\n');
  return { type: 'function', function: {
    name: 'task',
    description: 'Launch a subagent to handle a complex, multi-step task autonomously in its own context window. The subagent returns one final report; it cannot see this conversation, so give it a complete, self-contained prompt. Launch several task calls in ONE response to run them in parallel (up to ' + MAX_PARALLEL_SUBAGENTS + ' at once) when the work is independent. Set run_in_background for long jobs you do not need to wait on; every task returns an id that send_message can use to follow up with the same agent later.\nAvailable agent types:\n' + list,
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: 'Short (3-5 word) label for the task' },
      prompt: { type: 'string', description: 'Complete instructions for the subagent, including what to return' },
      subagent_type: { type: 'string', enum: Object.keys(agents), description: 'Which agent to use; default general-purpose' },
      run_in_background: { type: 'boolean', description: 'Start the agent and return its id immediately, so you can keep working (or launch more agents) while it runs. You are notified with its report when it finishes. In the background it cannot ask for approval: actions not already allowed by permission rules are denied, so prefer read-only agents or worktree isolation.' },
      isolation: { type: 'string', enum: ['worktree'], description: 'Set to "worktree" to run an editing subagent in its own git worktree and branch, so parallel agents never clash and the user can review or merge each result. The result lists the branch, changed files and merge command.' }
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
