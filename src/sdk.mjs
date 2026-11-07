// Oasis SDK: build agents and automations on top of Oasis from your own Node code.
//
//   import { query, tool } from 'oasis-oss';
//   const weather = tool('weather', 'Current weather for a city', { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
//     async ({ city }) => ({ city, forecast: 'sunny' }));
//   for await (const event of query({ prompt: 'Plan my picnic in Dhaka', options: { tools: [weather], maxTurns: 10 } })) {
//     if (event.type === 'assistant') console.log(event.text);
//     if (event.type === 'result') console.log(event.subtype, event.usage);
//   }
//
// Events match `oasis -p --output-format stream-json`: system/init, assistant,
// tool_use, tool_result, system/auto_mode, system/permission, and a final result.
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { runHeadless } from './headless.mjs';
import { attachToolServer } from './mcp.mjs';
import { applyEffort } from './agent.mjs';
import { createToolRegistry, defineTool, redactAuditValue, runTool } from './tool-kernel.mjs';

export { createSession, runAgentTurn, runAgentPlan, runForkedTurn, closeSession, compactHistoryIfNeeded, applyEffort, hookOptions } from './agent.mjs';
export { runHeadless } from './headless.mjs';
export { loadConfig } from './config.mjs';
export { loadSettings, PERMISSION_MODES } from './settings.mjs';
export { executeTool, TOOL_DEFINITIONS } from './tools.mjs';
export { runHooks, HOOK_EVENTS } from './hooks.mjs';
export { validateJsonSchema } from './json-schema.mjs';

// Defines an in-process tool. `run(input, context)` returns any JSON value (or a string).
// Set { needsApproval: true } to require approval before the tool is executed.
export function tool(name, description, inputSchema, run, options = {}) {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(String(name))) throw new Error('Tool names must be 1-48 letters, digits, _ or -.');
  if (typeof run !== 'function') throw new Error('tool() needs a run(input) function.');
  const needsApproval = Boolean(options.needsApproval);
  return {
    name,
    description: String(description || name),
    inputSchema: inputSchema && typeof inputSchema === 'object' ? inputSchema : { type: 'object', properties: {} },
    outputSchema: options.outputSchema && typeof options.outputSchema === 'object' ? options.outputSchema : {},
    run,
    needsApproval,
    capabilities: Array.isArray(options.capabilities) ? options.capabilities : ['execute'],
    risk: options.risk || (needsApproval ? 'high' : 'medium'),
    timeoutMs: options.timeoutMs
  };
}

const UNDEFINED_TOOL_OUTPUT = Symbol('oasis-sdk-undefined-tool-output');

// Groups tools under one server name. Their model-facing names are mcp_<server>_<tool>.
// The kernel owns input validation, cancellation, timeout handling and audit redaction;
// the SDK server retains the existing approval UX before execution.
export function createToolServer(name, tools = []) {
  if (!Array.isArray(tools)) throw new TypeError('createToolServer tools must be an array.');
  const items = new Map();
  const registry = createToolRegistry(tools.map((item) => {
    if (!item || typeof item !== 'object') throw new TypeError('Every SDK tool must be a tool() definition.');
    if (items.has(item.name)) throw new Error('Duplicate SDK tool name: ' + item.name);
    items.set(item.name, item);
    return defineTool({
      name: item.name,
      title: item.name,
      description: item.description,
      capabilities: item.capabilities || ['execute'],
      risk: item.risk || (item.needsApproval ? 'high' : 'medium'),
      inputSchema: item.inputSchema,
      outputSchema: item.outputSchema,
      timeoutMs: item.timeoutMs,
      // Approval is handled below, where the SDK has access to its existing
      // approval callback. The kernel is responsible for the execution itself.
      requiresApproval: false,
      run: async (input, context) => {
        const value = await item.run(input, {
          signal: context.signal,
          env: context.env,
          cwd: context.cwd
        });
        return value === undefined ? UNDEFINED_TOOL_OUTPUT : value;
      }
    });
  }));

  return {
    config: { name: String(name), type: 'sdk' },
    source: 'sdk',
    capabilities: {},
    tools: registry.list().map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      ...(Object.keys(definition.outputSchema || {}).length ? { outputSchema: definition.outputSchema } : {})
    })),
    async callTool(toolName, args, options = {}) {
      const item = items.get(toolName);
      const definition = registry.get(toolName);
      if (!item || !definition) throw new Error('Unknown tool: ' + toolName);

      if (item.needsApproval && !options.autoApprove) {
        const ok = options.approval && await options.approval(
          'Call tool "' + toolName + '" with arguments:\n' + JSON.stringify(redactAuditValue(args), null, 2).slice(0, 5000)
        );
        if (!ok) return { approved: false, message: 'The tool call was not approved.' };
      }

      const outcome = await runTool(definition, args, {
        policy: { decide: () => ({ decision: 'allow' }) },
        signal: options.signal,
        env: options.env || process.env,
        cwd: options.cwd || options.root || process.cwd()
      });
      if (typeof options.onAudit === 'function' && outcome.audit) {
        try { options.onAudit(outcome.audit); } catch { /* audit observers cannot break tool execution */ }
      }
      if (!outcome.ok) throw new Error(outcome.error || 'SDK tool execution failed.');
      return outcome.output === UNDEFINED_TOOL_OUTPUT ? { ok: true } : outcome.output;
    },
    close() {}
  };
}

// Runs one task and yields events as they happen. Options:
//   cwd, model, effort, provider ({ protocol, baseURL, apiKey }), permissionMode,
//   allowedTools, disallowedTools, appendSystemPrompt, maxTurns, planOnly,
//   jsonSchema, tools (tool() items or createToolServer() servers),
//   canUseTool(toolName, input, { message }) -> true | false | { behavior },
//   autoApprove, abortController, resume (session id), persistSession, bare, env.
export async function* query({ prompt, options = {} }) {
  if (!prompt || typeof prompt !== 'string') throw new Error('query() needs a prompt string.');
  const env = options.env || process.env;
  const root = path.resolve(options.cwd || process.cwd());
  const config = { ...(await loadConfig({ env })), ...(options.provider || {}) };
  if (options.model) config.model = options.model;
  if (options.effort) Object.assign(config, applyEffort(config, options.effort));
  if (options.provider && (options.provider.apiKey || options.provider.baseURL)) config.configured = true;
  if (!config.configured) throw new Error('No model provider is configured. Run oasis setup, set OASIS_* environment variables, or pass options.provider.');

  const loose = (options.tools || []).filter((item) => item && !item.callTool);
  const servers = (options.tools || []).filter((item) => item && item.callTool);
  if (loose.length) servers.push(createToolServer('sdk', loose));

  const queue = [];
  let wake = null;
  let finished = false;
  let failure = null;
  const push = (event) => { queue.push(event); if (wake) { wake(); wake = null; } };
  // Owned by this generator: a consumer that stops iterating (break, return,
  // throw) stops the agent too, instead of leaving it calling the model and
  // running tools in the background with nothing reading its events.
  const controller = new AbortController();
  const external = options.abortController ? options.abortController.signal : null;
  const forwardAbort = () => controller.abort(external.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', forwardAbort, { once: true });
  }
  const run = runHeadless({
    prompt,
    root,
    config,
    env,
    outputFormat: 'none',
    write: () => {},
    autoApprove: Boolean(options.autoApprove),
    maxTurns: options.maxTurns || null,
    planOnly: Boolean(options.planOnly),
    jsonSchema: options.jsonSchema || null,
    persistence: { enabled: Boolean(options.persistSession), resumeId: options.resume || null },
    sessionOptions: {
      permissionMode: options.permissionMode || null,
      allowedTools: options.allowedTools || [],
      disallowedTools: options.disallowedTools || [],
      appendSystemPrompt: options.appendSystemPrompt || '',
      bare: Boolean(options.bare),
      ...(options.settings ? { settings: options.settings } : {})
    },
    signal: controller.signal,
    canUseTool: options.canUseTool || null,
    onSession: (session) => { for (const server of servers) attachToolServer(session, server); },
    onEvent: push
  }).catch((error) => { failure = error; }).finally(() => { finished = true; if (wake) { wake(); wake = null; } });

  let completed = false;
  try {
    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (finished) break;
      await new Promise((resolve) => { wake = resolve; });
    }
    completed = true;
  } finally {
    if (!completed && !finished) controller.abort();
    if (external) external.removeEventListener('abort', forwardAbort);
    await run;
  }
  if (failure) throw failure;
}

// Convenience: runs a task and returns only the final result event.
export async function run(prompt, options = {}) {
  let last = null;
  for await (const event of query({ prompt, options })) if (event.type === 'result') last = event;
  return last;
}
