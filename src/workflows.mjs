// Dynamic workflows (Claude Code's Workflow tool): a JavaScript script that orchestrates many
// subagents. The script runs in an isolated QuickJS WebAssembly runtime with no filesystem, shell, module or clock
// access; only these globals exist:
//
//   agent(prompt, { label, schema, agentType, model, isolation })  -> report text, or JSON if schema
//   pipeline(items, (item, index) => agent(...))                  -> results (null for failures)
//   parallel([() => agent(...), ...])                             -> results (null for failures)
//   phase(title)   groups the agents that follow in /workflows
//   log(message)   shows a message above the phases
//   args           input passed to a saved workflow
//
// A saved workflow is a .js file whose first statement is `export const meta = { name, description }`.
// Locations: .claude/workflows/ and .oasis/workflows/ (project, closest wins), ~/.claude/workflows/
// and ~/.oasis/workflows/ (personal), plugin workflows/ directories (/plugin:name), and built-ins.
// Runs are resumable: an agent call whose prompt and options match a completed call from the
// previous run returns the saved result; failed, stopped or changed calls run again.
import { runWorkflowScript } from './workflow-sandbox.mjs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getConfigDirectory } from './config.mjs';
import { validateJsonSchema, extractJson } from './json-schema.mjs';

export const MAX_ITEMS_PER_CALL = 4096;
export const MAX_AGENTS_PER_RUN = 1000;
const MAX_WORKFLOW_SOURCE_CHARS = 512 * 1024;
const DEFAULT_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows');

export function defaultConcurrency(env = process.env) {
  const configured = Number.parseInt(env.OASIS_WORKFLOW_MAX_CONCURRENT_AGENTS || env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS || '', 10);
  if (Number.isInteger(configured) && configured >= 1 && configured <= 256) return configured;
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(16, cpus || 4));
}

// Finds `export const meta = { ... }` (the first statement) and the object literal's extent.
function findMeta(source) {
  const match = /^(\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*)export\s+const\s+meta\s*=\s*\{/.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0; let quote = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      let end = i + 1;
      while (end < source.length && /[ \t;]/.test(source[end])) end++;
      return { statementStart: match.index + match[1].length, literal: source.slice(start, i + 1), end };
    }
  }
  return null;
}

function parseLiteralObject(source) {
 let i = 0;
 const fail = () => { throw new Error('Static workflow metadata only'); };
 const skip = () => {
  while (i < source.length) {
   if (/\s/.test(source[i])) { i++; continue; }
   if (source.startsWith('//',i)) { i+=2; while(i<source.length&&source[i]!=='\n')i++; continue; }
   if (source.startsWith('/*',i)) { const end=source.indexOf('*/',i+2); if(end<0)fail(); i=end+2; continue; }
   break;
  }
 };
 const parse = () => {
  skip(); const ch=source[i];
  if(ch==='{' ){
   i++; const out=Object.create(null); skip(); if(source[i]==='}'){i++;return out;}
   while(i<source.length){
    skip(); const q=source[i]==='"'||source[i]==="'"?source[i++]:null; let key='';
    if(q){while(i<source.length&&source[i]!==q){if(source[i]==='\\'){i++;if(i>=source.length)fail();key+=source[i++];}else key+=source[i++];}if(source[i++]!==q)fail();}
    else {const m=/^[A-Za-z_$][\w$]*/.exec(source.slice(i));if(!m)fail();key=m[0];i+=key.length;}
    skip();if(source[i++]!==':')fail();out[key]=parse();skip();if(source[i]==='}'){i++;return out;}if(source[i++]!==',')fail();skip();if(source[i]==='}'){i++;return out;}
   }return fail();
  }
  if(ch==='['){i++;const a=[];skip();if(source[i]===']'){i++;return a;}while(i<source.length){a.push(parse());skip();if(source[i]===']'){i++;return a;}if(source[i++]!==',')fail();skip();if(source[i]===']'){i++;return a;}}return fail();}
  if(ch==='"'||ch==="'"){const q=source[i++];let s='';while(i<source.length&&source[i]!==q){if(source[i]==='\\'){i++;if(i>=source.length)fail();const e=source[i++];s+=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'})[e]??e;}else s+=source[i++];}if(source[i++]!==q)fail();return s;}
  const m=/^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
  if(m){i+=m[0].length;return m[0]==='true'?true:m[0]==='false'?false:m[0]==='null'?null:Number(m[0]);}
  return fail();
 };
 skip();const result=parse();skip();if(i!==source.length||!result||Array.isArray(result)||typeof result!=='object')fail();return result;
}

/** Parses a workflow script into { meta, body, literalMeta }. Throws on import(). */
export function parseWorkflowScript(source) {
  const text = String(source || '');
  if (text.length > MAX_WORKFLOW_SOURCE_CHARS) throw new Error('Workflow scripts must be 512 KiB or smaller.');
  if (/(^|[^\w$.])import\s*\(/.test(text) || /^\s*import\s[^(]/m.test(text)) throw new Error('Workflow scripts cannot load modules (import is unavailable); put work that needs a library in an agent\'s task.');
  const found = findMeta(text);
  let meta = {}; let literalMeta = false; let body = text;
  if (found) {
    try { meta = parseLiteralObject(found.literal); literalMeta = true; }
    catch { meta = {}; literalMeta = false; }
    body = text.slice(0, found.statementStart) + 'const meta = ' + found.literal + ';' + text.slice(found.end);
  }
  return { meta: meta && typeof meta === 'object' ? meta : {}, body, literalMeta };
}

function hashCall(prompt, options) {
  const { label, stallMs, ...rest } = options || {};
  return createHash('sha256').update(String(prompt) + '\0' + JSON.stringify(rest)).digest('hex').slice(0, 24);
}

function semaphore(limit) {
  let active = 0; const queue = [];
  const release = () => { active--; const next = queue.shift(); if (next) next(); };
  return async (fn) => {
    if (active >= limit) await new Promise((resolve) => queue.push(resolve));
    active++;
    try { return await fn(); } finally { release(); }
  };
}

function schemaContradiction(schema) {
  if (!schema || typeof schema !== 'object') return '';
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  if (schema.additionalProperties === false && Array.isArray(schema.required)) {
    const missing = schema.required.filter((key) => !Object.hasOwn(props, key));
    if (missing.length) return 'required key ' + missing.map((key) => JSON.stringify(key)).join(', ') + ' is ruled out by additionalProperties: false';
  }
  for (const [key, value] of Object.entries(props)) { const inner = schemaContradiction(value); if (inner) return key + ': ' + inner; }
  if (schema.items) return schemaContradiction(schema.items);
  return '';
}

/**
 * Runs a workflow. `runAgent({ prompt, label, agentType, model, isolation, signal })` returns the
 * subagent's report text. `cache` is the previous run's { calls: [...] } for resuming.
 */
export async function runWorkflow({ source, args, runAgent, onEvent = () => {}, cache = null, signal = null, concurrency = defaultConcurrency(), maxAgents = MAX_AGENTS_PER_RUN, structuredRetries = 5, filename = 'workflow.js', timeoutMs = DEFAULT_WORKFLOW_TIMEOUT_MS }) {
  const { meta, body } = parseWorkflowScript(source);
  const state = { meta, phases: [], logs: [], agents: [], calls: [], status: 'running', result: undefined, error: null };
  const executionController = new AbortController();
  const forwardAbort = () => executionController.abort(signal && signal.reason || new Error('Workflow cancelled.'));
  if (signal && signal.aborted) forwardAbort();
  else if (signal) signal.addEventListener('abort', forwardAbort, { once: true });
  const workflowSignal = executionController.signal;
  let timedOut = false;
  let scriptLimitExceeded = false;
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, DEFAULT_WORKFLOW_TIMEOUT_MS)
    : DEFAULT_WORKFLOW_TIMEOUT_MS;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  void abortPromise.catch(() => {});
  const rejectForAbort = () => rejectAbort(workflowSignal.reason instanceof Error ? workflowSignal.reason : new Error('Workflow cancelled.'));
  if (workflowSignal.aborted) rejectForAbort();
  else workflowSignal.addEventListener('abort', rejectForAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    executionController.abort(new Error('Workflow timed out after ' + effectiveTimeoutMs + ' ms.'));
  }, effectiveTimeoutMs);

  let currentPhase = null;
  let seq = 0;
  const limit = semaphore(concurrency);
  const emit = (event) => { try { onEvent(event, state); } catch {} };
  const ensurePhase = (title) => {
    let phase = state.phases.find((item) => item.title === title);
    if (!phase) { phase = { title, agents: [] }; state.phases.push(phase); }
    return phase;
  };
  for (const title of Array.isArray(meta.phases) ? meta.phases : []) if (typeof title === 'string') ensurePhase(title);

  const agent = (prompt, options = {}) => {
    if (workflowSignal && workflowSignal.aborted) return Promise.resolve(null);
    if (typeof prompt !== 'string' || !prompt.trim()) return Promise.reject(new Error('agent() needs a prompt string.'));
    if (state.agents.length >= maxAgents) return Promise.reject(new Error('This workflow reached the limit of ' + maxAgents + ' agents per run.'));
    options = options && typeof options === 'object' ? JSON.parse(JSON.stringify(options)) : {};
    if (options.schema) { const contradiction = schemaContradiction(options.schema); if (contradiction) return Promise.reject(new Error('agent() schema contradicts itself: ' + contradiction + '.')); }
    const index = seq++;
    const key = hashCall(prompt, options);
    const record = { index, label: String(options.label || prompt.split('\n')[0]).slice(0, 80), phase: currentPhase, status: 'queued', attempts: 0, key };
    state.agents.push(record);
    if (currentPhase) ensurePhase(currentPhase).agents.push(index);
    // Same prompt and options at the same position: reuse the saved result. If the order shifted,
    // fall back to any unused completed call with the same key.
    let previous = cache && Array.isArray(cache.calls) ? cache.calls[index] : null;
    if (cache && Array.isArray(cache.calls) && !(previous && previous.key === key)) {
      cache.used ||= new Set();
      const found = cache.calls.findIndex((call, i) => call && call.key === key && call.status === 'completed' && !cache.used.has(i));
      previous = found >= 0 ? cache.calls[found] : null;
      if (found >= 0) cache.used.add(found);
    }
    if (previous && previous.key === key && previous.status === 'completed') {
      record.status = 'completed'; record.cached = true; record.result = previous.result;
      state.calls[index] = previous;
      emit({ type: 'agent_cached', agent: record });
      return Promise.resolve(previous.result);
    }
    return limit(async () => {
      if (workflowSignal && workflowSignal.aborted) { record.status = 'stopped'; state.calls[index] = { key, status: 'stopped' }; return null; }
      record.status = 'running'; record.startedAt = Date.now();
      emit({ type: 'agent_start', agent: record });
      let instructions = prompt;
      if (options.schema) instructions += '\n\nReply with only a JSON value matching this JSON Schema, with no prose around it:\n' + JSON.stringify(options.schema).slice(0, 8000);
      try {
        let result; let lastError = '';
        for (let attempt = 0; attempt < (options.schema ? structuredRetries : 1); attempt++) {
          record.attempts = attempt + 1;
          const text = String(await runAgent({ prompt: attempt && lastError ? instructions + '\n\nYour previous reply was invalid: ' + lastError + '. Reply again with only the JSON.' : instructions, label: record.label, agentType: options.agentType || options.subagent_type || options.agent || null, model: options.model || null, isolation: options.isolation || null, signal: workflowSignal }) ?? '');
          if (!options.schema) { result = text; lastError = ''; break; }
          const parsed = extractJson(text);
          const value = parsed.ok ? parsed.value : undefined;
          const errors = parsed.ok ? validateJsonSchema(options.schema, value) : ['the reply had no JSON'];
          if (!errors.length) { result = value; lastError = ''; break; }
          lastError = errors.slice(0, 5).join('; ');
        }
        if (lastError) throw new Error('structured output failed validation after ' + structuredRetries + ' attempts: ' + lastError);
        record.status = 'completed'; record.result = result; record.finishedAt = Date.now();
        state.calls[index] = { key, status: 'completed', result, label: record.label };
        emit({ type: 'agent_done', agent: record });
        return result;
      } catch (error) {
        const stopped = workflowSignal && workflowSignal.aborted;
        record.status = stopped ? 'stopped' : 'failed'; record.error = error.message || String(error); record.finishedAt = Date.now();
        state.calls[index] = { key, status: record.status, error: record.error };
        emit({ type: stopped ? 'agent_stopped' : 'agent_failed', agent: record });
        if (stopped) return null;
        throw error;
      }
    });
  };
  const guardList = (list, what) => {
    if (!Array.isArray(list)) throw new Error(what + '() needs an array.');
    if (list.length > MAX_ITEMS_PER_CALL) throw new Error(what + '() accepts at most ' + MAX_ITEMS_PER_CALL + ' items.');
  };
  const pipeline = (items, fn) => {
    guardList(items, 'pipeline');
    if (typeof fn !== 'function') throw new Error('pipeline() needs a function as its second argument.');
    return Promise.all(items.map((item, i) => { try { return Promise.resolve(fn(item, i)).catch(() => null); } catch { return Promise.resolve(null); } }));
  };
  const parallel = (tasks) => {
    guardList(tasks, 'parallel');
    return Promise.all(tasks.map((task) => { try { return Promise.resolve(typeof task === 'function' ? task() : task).catch(() => null); } catch { return Promise.resolve(null); } }));
  };
  const phase = (title) => { currentPhase = String(title || '').slice(0, 120) || null; if (currentPhase) ensurePhase(currentPhase); emit({ type: 'phase', title: currentPhase }); };
  const log = (...parts) => { const message = parts.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(' ').slice(0, 2000); state.logs.push(message); emit({ type: 'log', message }); };


  try {
    state.result = await runWorkflowScript({
      body, args, agent, phase, log, signal: workflowSignal,
      onLimit: (error) => {
        scriptLimitExceeded = true;
        executionController.abort(error instanceof Error ? error : new Error(String(error)));
      }
    });
    state.status = workflowSignal.aborted ? (timedOut || scriptLimitExceeded ? 'failed' : 'stopped') : 'completed';
  } catch (error) {
    state.status = timedOut || scriptLimitExceeded ? 'failed' : workflowSignal.aborted ? 'stopped' : 'failed';
    state.error = timedOut
      ? 'Workflow timed out after ' + effectiveTimeoutMs + ' ms.'
      : error && error.message ? error.message : String(error);
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', forwardAbort);
    workflowSignal.removeEventListener('abort', rejectForAbort);
  }
  // Failed agents inside pipeline()/parallel() resolve to null, so a run can
  // finish "completed" with missing work. Count them and say so plainly.
  const failedAgents = state.agents.filter((agent) => agent.status === 'failed');
  state.failedAgents = failedAgents.length;
  if (state.status === 'completed' && failedAgents.length) {
    state.warning = failedAgents.length + ' of ' + state.agents.length + ' agent(s) failed; their results are null in the output. Failed: ' +
      failedAgents.slice(0, 10).map((agent) => (agent.label || 'agent ' + agent.index) + (agent.error ? ' (' + String(agent.error).slice(0, 160) + ')' : '')).join('; ') +
      (failedAgents.length > 10 ? '; …' : '') + '. Do not report the workflow as fully successful; rerun or resume the failed parts.';
  }
  emit({ type: 'done', status: state.status, failedAgents: state.failedAgents });
  return state;
}

// ---- Saved workflows -------------------------------------------------------------------------

function projectWorkflowDirs(root) {
  const dirs = [];
  let dir = path.resolve(root);
  for (let i = 0; i < 40; i++) {
    dirs.push(path.join(dir, '.claude', 'workflows'), path.join(dir, '.oasis', 'workflows'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs; // closest first
}

export function personalWorkflowDirs(env = process.env) {
  const home = env.HOME || os.homedir();
  const dirs = [path.join(getConfigDirectory(env), 'workflows')];
  dirs.push(env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'workflows') : path.join(home, '.claude', 'workflows'));
  return [...new Set(dirs)];
}

async function readWorkflowDir(dir, scope, out, prefix = '') {
  let names = [];
  try { names = await readdir(dir); } catch { return; }
  for (const file of names.filter((name) => name.endsWith('.js') || name.endsWith('.mjs')).sort()) {
    const full = path.join(dir, file);
    try {
      const info = await lstat(full);
      if (!info.isFile() || info.size > 512 * 1024) continue;
      const source = await readFile(full, 'utf8');
      const { meta, literalMeta } = parseWorkflowScript(source);
      const base = String(meta.name || path.basename(file).replace(/\.m?js$/, '')).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(base)) continue;
      const name = prefix ? prefix + ':' + base : base;
      if (out.has(name)) continue;
      out.set(name, { name, description: String(meta.description || '').slice(0, 300), file: full, scope, phases: Array.isArray(meta.phases) ? meta.phases.map(String) : [], autocomplete: literalMeta });
    } catch {}
  }
}

/** Saved workflows by name. Project (closest first) beats personal beats plugin beats built-in. */
export async function loadWorkflows(root, { env = process.env, plugins = null } = {}) {
  const out = new Map();
  if (env.OASIS_SAFE_MODE === '1') { await readWorkflowDir(BUILTIN_DIR, 'builtin', out); return out; }
  for (const dir of projectWorkflowDirs(root)) await readWorkflowDir(dir, 'project', out);
  for (const dir of personalWorkflowDirs(env)) await readWorkflowDir(dir, 'user', out);
  try {
    const list = plugins || await (await import('./claude-plugins.mjs')).loadEnabledPlugins(root, { env });
    for (const plugin of list || []) {
      const manifestDirs = plugin.manifest && plugin.manifest.workflows ? [].concat(plugin.manifest.workflows).map((dir) => path.resolve(plugin.root, String(dir))) : [path.join(plugin.root, 'workflows')];
      for (const dir of manifestDirs) if (dir.startsWith(path.resolve(plugin.root))) await readWorkflowDir(dir, 'plugin', out, plugin.name);
    }
  } catch {}
  await readWorkflowDir(BUILTIN_DIR, 'builtin', out);
  return out;
}

/** Saves a run's script as a command. Refuses symlinked targets like Claude Code. */
export async function saveWorkflow(source, { root, env = process.env, scope = 'project', name = null } = {}) {
  const { meta } = parseWorkflowScript(source);
  const id = String(name || meta.name || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(id)) throw new Error('A saved workflow needs meta.name (letters, digits, - or _).');
  let dir;
  if (scope === 'user') dir = personalWorkflowDirs(env)[0];
  else {
    const projectRoot = path.resolve(root);
    for (const part of [path.join(projectRoot, '.claude'), path.join(projectRoot, '.claude', 'workflows')]) {
      try { if ((await lstat(part)).isSymbolicLink()) throw new Error('Refusing to save: ' + part + ' is a symlink.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    dir = path.join(projectRoot, '.claude', 'workflows');
  }
  const target = path.join(dir, id + '.js');
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Refusing to save: ' + target + ' is a symlink.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dir, { recursive: true });
  await writeFile(target, source.endsWith('\n') ? source : source + '\n', 'utf8');
  return target;
}

export function workflowRunsDirectory(sessionId, env = process.env) {
  return path.join(getConfigDirectory(env), 'workflow-runs', String(sessionId || 'unsaved').replace(/[^\w.-]/g, '_'));
}

export function newRunId() { return 'wf_' + randomUUID().replace(/-/g, '').slice(0, 8); }

/** One-line and detailed progress text for /workflows. */
export function describeRun(run, { detail = false } = {}) {
  const agents = run.state ? run.state.agents : [];
  const count = (status) => agents.filter((agent) => agent.status === status).length;
  const head = run.id + '  ' + String(run.status === 'completed' && count('failed') ? 'partial' : run.status).padEnd(9) + ' ' + (run.name || 'workflow') + '  ' + count('completed') + '/' + agents.length + ' agents done' + (count('failed') ? ', ' + count('failed') + ' failed' : '') + (count('running') ? ', ' + count('running') + ' running' : '');
  if (!detail) return head;
  const lines = [head, '  script: ' + run.scriptPath];
  for (const message of (run.state && run.state.logs || []).slice(-10)) lines.push('  log: ' + message);
  const phases = run.state && run.state.phases.length ? run.state.phases : [{ title: '(no phase)', agents: agents.map((agent) => agent.index) }];
  for (const phase of phases) {
    const members = phase.agents.map((index) => agents[index]).filter(Boolean);
    lines.push('  ' + phase.title + ' — ' + members.filter((agent) => agent.status === 'completed').length + '/' + members.length);
    for (const agent of members.slice(0, 50)) lines.push('    ' + ({ completed: '✓', failed: '✗', running: '…', queued: '·', stopped: '■' }[agent.status] || '?') + ' ' + agent.label + (agent.cached ? ' (cached)' : '') + (agent.error ? ' — ' + agent.error.slice(0, 120) : ''));
  }
  if (run.status === 'failed' && run.state && run.state.error) lines.push('  error: ' + run.state.error);
  return lines.join('\n');
}

export const WORKFLOW_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'workflow',
    description: 'Run a dynamic workflow: a JavaScript script that orchestrates many subagents (codebase-wide audits, large migrations, cross-checked research, fix-until-green loops). The script body has top-level await and these globals only: agent(prompt, {label, schema, agentType, model, isolation:"worktree"}) returns the subagent report (or JSON matching schema); pipeline(items, (item, i) => agent(...)) runs one agent per item; parallel([() => agent(...), ...]) runs tasks together; phase(title) groups agents; log(msg); args (input). Failed agents inside pipeline/parallel become null. The script has no filesystem, shell, import(), Date.now() or Math.random(); agents do the work. Start with `export const meta = { name, description, phases: [...] }` and end with `return` of the final result. Use action "status"/"stop"/"list" to manage runs, resume_run_id to relaunch a stopped or failed run (completed agents return saved results), name to run a saved workflow.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'status', 'stop', 'list'], description: 'Default run' },
        script: { type: 'string', description: 'The workflow script to run (export const meta = {...} first)' },
        path: { type: 'string', description: 'Run a workflow script file from the workspace instead of inline' },
        name: { type: 'string', description: 'Run a saved workflow by name (see /workflows)' },
        args: { description: 'Input exposed to the script as the global args' },
        resume_run_id: { type: 'string', description: 'Relaunch this run, reusing completed agents\' results' },
        run_id: { type: 'string', description: 'For status/stop' },
        run_in_background: { type: 'boolean', description: 'Return immediately; you are notified when the run finishes' }
      }
    }
  }
};
