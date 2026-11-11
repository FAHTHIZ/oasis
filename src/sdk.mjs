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
import { defineTool, redactAuditValue, runTool } from './tool-kernel.mjs';

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
  const definitions = new Map();
  for (const definition of tools.map((item) => {
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
  })) definitions.set(definition.name, definition);

  return {
    config: { name: String(name), type: 'sdk' },
    source: 'sdk',
    capabilities: {},
    tools: [...definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      ...(Object.keys(definition.outputSchema || {}).length ? { outputSchema: definition.outputSchema } : {})
    })),
    async callTool(toolName, args, options = {}) {
      const item = items.get(toolName);
      const definition = definitions.get(toolName);
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
// The returned object is an async generator with Agent SDK style controls:
//   interrupt(), setModel(model?), setPermissionMode(mode), setMaxThinkingTokens(n | null),
//   supportedModels(), mcpServerStatus(), close().
export function query({ prompt, options = {} } = {}) {
  if (!prompt || typeof prompt !== 'string') throw new Error('query() needs a prompt string.');
  const control = { session: null, controller: new AbortController(), pending: [], waiters: [] };
  const generator = runQuery({ prompt, options }, control);
  const withSession = () => control.session ? Promise.resolve(control.session) : new Promise((resolve, reject) => control.waiters.push({ resolve, reject }));
  const env = options.env || process.env;
  return Object.assign(generator, {
    async interrupt() { control.controller.abort(new Error('Interrupted by the SDK host.')); },
    close() { control.controller.abort(new Error('Closed by the SDK host.')); },
    // Like Claude Code's setModel(): undefined or "default" goes back to the starting model.
    // availableModels/deniedModels apply and PreModelSwitch/PostModelSwitch hooks run with source "sdk".
    async setModel(model) {
      const session = await withSession();
      const { modelAllowed, modelRestrictionMessage } = await import('./model-aliases.mjs');
      const { switchSessionModel } = await import('./model-switch.mjs');
      const target = model === undefined || model === null || model === 'default' ? control.startModel : String(model).trim();
      if (!target || target.length > 200 || /[\r\n\0]/.test(target)) throw new Error('setModel() needs a model id.');
      if (!modelAllowed(target, session.availableModels, { env, protocol: session.config && session.config.protocol, ...(session.modelPolicy || {}) })) {
        throw new Error(modelRestrictionMessage(target, session.availableModels || [], { env, ...(session.modelPolicy || {}) }));
      }
      if ((session.config.model || '') === target) return;
      const switched = await switchSessionModel(session, { to: target, requested: model === undefined ? null : String(model), source: 'sdk', env, apply: (next) => { session.config = { ...session.config, model: next }; } });
      if (!switched.ok) throw new Error('Model unchanged: ' + switched.reason);
    },
    async setPermissionMode(mode) {
      const { PERMISSION_MODES } = await import('./permission-modes.mjs');
      if (!PERMISSION_MODES.includes(mode)) throw new Error('Unknown permission mode ' + JSON.stringify(mode) + '. Use one of: ' + PERMISSION_MODES.join(', ') + '.');
      const session = await withSession();
      const permissions = session.settings && session.settings.permissions || {};
      if (mode === 'bypassPermissions' && permissions.disableBypassPermissionsMode) throw new Error('bypassPermissions mode is disabled by settings (disableBypassPermissionsMode).');
      session.permissions.setMode(mode);
    },
    // Takes effect from the next model request; null restores the turn's own budget.
    async setMaxThinkingTokens(tokens) {
      const session = await withSession();
      if (tokens === null) {
        session.thinkingOverride = null;
        if (session.turnThinking) { session.thinkingBudget = session.turnThinking.budget; session.thinkingOff = session.turnThinking.off; }
        return;
      }
      const value = Number(tokens);
      if (!Number.isInteger(value) || value < 0) throw new Error('setMaxThinkingTokens() needs a whole number of tokens, or null.');
      session.thinkingOverride = value === 0 ? 0 : Math.max(1024, Math.min(value, 64000));
      session.thinkingBudget = session.thinkingOverride;
      session.thinkingOff = value === 0;
    },
    async supportedModels() {
      const session = await withSession();
      const current = session.config && session.config.model || '';
      return [...new Set([current, ...(session.availableModels || [])].filter((item) => item && !item.includes('*')))].map((value) => ({ value, displayName: value, description: value === current ? 'Current model' : '' }));
    },
    async mcpServerStatus() {
      const session = await withSession();
      const connected = [...(session.mcpClients || new Map()).keys()].map((name) => ({ name, status: 'connected' }));
      const failed = (session.mcpFailures || []).map((failure) => ({ name: failure.name || String(failure.server || ''), status: 'failed', error: String(failure.error || failure.message || '') }));
      const pending = session.mcpConnecting ? [{ name: '(connecting)', status: 'pending' }] : [];
      return [...connected, ...failed, ...pending];
    }
  });
}

async function* runQuery({ prompt, options }, control) {
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
  const controller = control.controller;
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
    onSession: (session) => {
      for (const server of servers) attachToolServer(session, server);
      control.session = session;
      control.startModel = session.config && session.config.model || '';
      for (const waiter of control.waiters.splice(0)) waiter.resolve(session);
    },
    onEvent: push
  }).catch((error) => { failure = error; }).finally(() => {
    finished = true;
    for (const waiter of control.waiters.splice(0)) waiter.reject(new Error('The query finished before the session started.'));
    if (wake) { wake(); wake = null; }
  });

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
