/**
 * Tool dispatch adapter.
 *
 * Provides a non-breaking seam between the agent runtime and the Tool Kernel.
 * It wraps the existing OASIS tool executor with kernel policy evaluation,
 * input validation, audit records, and secret redaction.
 */

import { runTool } from './tool-kernel.mjs';
import { bridgeToolDefinition } from './tool-registry-bridge.mjs';

export function createToolDispatch(executeTool, options = {}) {
  if (typeof executeTool !== 'function') throw new TypeError('executeTool must be a function.');
  return async function dispatchTool(call, session, optionsOverride = {}) {
    const name = call && (call.name || (call.function && call.function.name));
    const rawInput = call && (call.arguments || (call.function && call.function.arguments) || {});
    let input = rawInput;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = {}; }
    }
    const definition = options.definition || { type: 'function', function: { name, description: '', parameters: {} } };
    const policy = optionsOverride.policy || options.policy || {};
    const tool = bridgeToolDefinition(definition, {
      capabilities: options.capabilities,
      risk: options.risk,
      requiresApproval: options.requiresApproval,
      rollback: options.rollback,
      run: async () => await executeTool(call, session, optionsOverride)
    });
    return await runTool(tool, input, {
      policy,
      signal: optionsOverride.signal,
      env: optionsOverride.env || process.env,
      cwd: optionsOverride.root || process.cwd()
    });
  };
}

function buildAudit(tool, input, decision, result, options) {
  return Object.freeze({
    at: new Date().toISOString(),
    tool: tool.name,
    capabilities: [...tool.capabilities],
    risk: tool.risk,
    decision: decision.decision,
    sandbox: decision.sandbox,
    input: redactAuditValue(input),
    output: result && result.ok ? redactAuditValue(result.output) : null,
    error: result && result.error || null
  });
}

