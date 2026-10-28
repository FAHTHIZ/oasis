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

export { createSession, runAgentTurn, runAgentPlan, runForkedTurn, closeSession, compactHistoryIfNeeded, applyEffort, hookOptions } from './agent.mjs';
export { runHeadless } from './headless.mjs';
export { loadConfig } from './config.mjs';
export { loadSettings, PERMISSION_MODES } from './settings.mjs';
export { executeTool, TOOL_DEFINITIONS } from './tools.mjs';
export { runHooks, HOOK_EVENTS } from './hooks.mjs';
export { validateJsonSchema } from './json-schema.mjs';

// Defines an in-process tool. `run(input, context)` returns any JSON value (or a string).
// Set { needsApproval: true } to route calls through permission checks and canUseTool.
export function tool(name, description, inputSchema, run, options = {}) {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(String(name))) throw new Error('Tool names must be 1-48 letters, digits, _ or -.');
  if (typeof run !== 'function') throw new Error('tool() needs a run(input) function.');
  return { name, description: String(description || name), inputSchema: inputSchema && typeof inputSchema === 'object' ? inputSchema : { type: 'object', properties: {} }, run, needsApproval: Boolean(options.needsApproval) };
}

// Groups tools under one server name. Their model-facing names are mcp_<server>_<tool>.
export function createToolServer(name, tools = []) {
  const byName = new Map(tools.map((item) => [item.name, item]));
  return {
    config: { name: String(name), type: 'sdk' },
    source: 'sdk',
    capabilities: {},
    tools: tools.map((item) => ({ name: item.name, description: item.description, inputSchema: item.inputSchema })),
    async callTool(toolName, args, options = {}) {
      const item = byName.get(toolName);
      if (!item) throw new Error('Unknown tool: ' + toolName);
      if (item.needsApproval && !options.autoApprove) {
        const ok = options.approval && await options.approval('Call tool "' + toolName + '" with arguments:\n' + JSON.stringify(args, null, 2).slice(0, 5000));
        if (!ok) return { approved: false, message: 'The tool call was not approved.' };
      }
      const value = await item.run(args || {}, { signal: options.signal });
      return value === undefined ? { ok: true } : value;
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
    signal: options.abortController ? options.abortController.signal : null,
    canUseTool: options.canUseTool || null,
    onSession: (session) => { for (const server of servers) attachToolServer(session, server); },
    onEvent: push
  }).catch((error) => { failure = error; }).finally(() => { finished = true; if (wake) { wake(); wake = null; } });

  while (true) {
    if (queue.length) { yield queue.shift(); continue; }
    if (finished) break;
    await new Promise((resolve) => { wake = resolve; });
  }
  await run;
  if (failure) throw failure;
}

// Convenience: runs a task and returns only the final result event.
export async function run(prompt, options = {}) {
  let last = null;
  for await (const event of query({ prompt, options })) if (event.type === 'result') last = event;
  return last;
}
