/**
 * Tool dispatch adapter.
 *
 * Provides a non-breaking seam between the agent runtime and the Tool Kernel.
 * It wraps the existing OASIS tool executor with kernel policy evaluation,
 * input validation, audit records, and secret redaction.
 */

import { evaluateToolPolicy, validateToolInput } from './tool-kernel.mjs';
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
    const tool = bridgeToolDefinition(definition, {
      capabilities: options.capabilities,
      risk: options.risk,
      requiresApproval: options.requiresApproval,
      rollback: options.rollback,
      run: async () => ({})
    });
    const policy = optionsOverride.policy || options.policy || {};
    const decision = evaluateToolPolicy(tool, input, policy);
    if (decision.decision === 'deny') {
      return { ok: false, tool: name, decision, error: decision.reason || 'tool denied by policy', audit: buildAudit(tool, input, decision, null, optionsOverride) };
    }
    if (decision.decision === 'ask') {
      return { ok: false, tool: name, decision, pendingApproval: true, audit: buildAudit(tool, input, decision, null, optionsOverride) };
    }
    const normalizedInput = validateToolInput(tool, input);
    try {
      const output = await executeTool(call, session, optionsOverride);
      const result = { ok: true, tool: name, decision, output: output === undefined ? null : output };
      if (decision.audit) result.audit = buildAudit(tool, normalizedInput, decision, result, optionsOverride);
      return result;
    } catch (error) {
      const result = { ok: false, tool: name, decision, error: error && error.message || String(error) };
      if (decision.audit) result.audit = buildAudit(tool, normalizedInput, decision, result, optionsOverride);
      return result;
    }
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
    input: redact(input),
    output: result && result.ok ? redact(result.output) : null,
    error: result && result.error || null
  });
}

const SECRET_PATTERN = /(?:api[_-]?key|token|secret|password|credential)[\s:=]{1,4}([^\s"']{8,})/gi;

function redact(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return value.replace(SECRET_PATTERN, (match, secret) => match.replace(secret, '[redacted]'));
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, depth + 1)]));
  return value;
}
