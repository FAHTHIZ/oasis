// execute_code: programmatic tool calling. The model writes a short JavaScript
// program that calls OASIS tools directly (`await tools.grep({...})`), loops and
// filters in code, and returns only what matters. Intermediate tool output never
// enters the conversation, which collapses multi-step read/search pipelines into
// one model turn and saves context.
//
// Every nested call goes through the normal tool path: permission rules, plan
// mode, hooks, approvals and the sandbox apply exactly as if the model had made
// the call itself. The script runs in the same QuickJS sandbox as workflows (no
// filesystem, network, imports, clock or randomness of its own; 16 MB heap).
const MAX_CODE_CHARS = 20000;
export const MAX_NESTED_CALLS = 60;
const MAX_RESULT_CHARS = 30000;
const BLOCKED = new Set(['execute_code', 'task', 'workflow', 'ask_user_question', 'connect_service', 'enter_plan_mode', 'exit_plan_mode', 'enter_worktree', 'exit_worktree', 'schedule_wakeup', 'advisor', 'run_specialist_review', 'send_message', 'team_send_message', 'skill_propose', 'memory_save', 'memory_delete']);

export const EXECUTE_CODE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'execute_code',
    description: 'Run a short JavaScript program (top-level await) that calls OASIS tools directly and returns a compact result. Use it to chain many reads/searches or process tool output in code (loop over files, filter grep hits, aggregate) instead of making one tool call per step; only the returned value comes back to you. Call tools as `await tools.NAME({...args})` or `await tool("NAME", {...})`; each returns that tool\'s normal result object. `log(...)` adds notes. Permissions and approvals apply to every nested call; at most ' + MAX_NESTED_CALLS + ' calls per run; no imports, filesystem, network, Date.now or Math.random. Example: const hits = await tools.grep({ pattern: "TODO", path: "src" }); return String(hits.output || "").split("\\n").length;',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript body with top-level await. End with `return VALUE` (JSON-serializable).' }
      },
      required: ['code'],
      additionalProperties: false
    }
  }
};

function clip(value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  if (text === undefined) return null;
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '… [truncated ' + (text.length - MAX_RESULT_CHARS) + ' chars]' : value;
}

// runTool(name, args) must execute one tool through the agent's normal path
// and resolve to its result (or reject with its error).
export async function runExecuteCode(args = {}, { runTool, signal, runScript } = {}) {
  const code = String(args.code || '');
  if (!code.trim()) throw new Error('execute_code needs a non-empty "code" string.');
  if (code.length > MAX_CODE_CHARS) throw new Error('execute_code accepts at most ' + MAX_CODE_CHARS + ' characters of code.');
  if (/\bimport\s*\(|^\s*import\s/m.test(code)) throw new Error('execute_code scripts cannot import modules; call tools instead.');
  const run = runScript || (await import('./workflow-sandbox.mjs')).runWorkflowScript;
  const calls = [];
  const logs = [];
  const prelude = [
    'const tool = (name, input = {}) => agent(String(name), input && typeof input === "object" ? input : {});',
    'const tools = new Proxy({}, { get: (_target, name) => (input = {}) => tool(String(name), input) });'
  ].join('\n');
  const started = Date.now();
  const value = await run({
    body: prelude + '\n' + code,
    args: null,
    signal,
    phase: () => {},
    log: (...parts) => { if (logs.length < 100) logs.push(parts.join(' ').slice(0, 2000)); },
    agent: async (name, input) => {
      if (BLOCKED.has(name)) throw new Error(name + ' cannot be called from execute_code.');
      if (calls.length >= MAX_NESTED_CALLS) throw new Error('execute_code reached its limit of ' + MAX_NESTED_CALLS + ' tool calls.');
      calls.push(name);
      const result = await runTool(name, input || {});
      if (result && typeof result === 'object' && typeof result.error === 'string' && Object.keys(result).length <= 3) throw new Error(name + ': ' + result.error);
      return result;
    }
  });
  return { result: clip(value), toolCalls: calls.length, tools: [...new Set(calls)], ...(logs.length ? { logs } : {}), durationMs: Date.now() - started };
}
