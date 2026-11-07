/**
 * Tool dispatch adapter.
 *
 * Validates the model's tool-call envelope before the shared Tool Kernel runs
 * policy, JSON Schema validation, cancellation, timeout, and audit redaction.
 */
import { runTool } from './tool-kernel.mjs';
import { bridgeToolDefinition } from './tool-registry-bridge.mjs';

export function createToolDispatch(executeTool, options = {}) {
  if (typeof executeTool !== 'function') throw new TypeError('executeTool must be a function.');

  return async function dispatchTool(call, session, optionsOverride = {}) {
    const name = call && (call.name || (call.function && call.function.name));
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: 'Tool call is missing a tool name.' };
    }

    const definition = options.definition;
    const definitionName = definition && definition.function && definition.function.name;
    if (definitionName !== name) {
      return {
        ok: false,
        tool: name,
        error: definitionName
          ? 'The supplied tool definition does not match the requested tool.'
          : 'A matching tool definition is required before dispatch.'
      };
    }

    const schema = definition.function.parameters;
    if (!schema || typeof schema !== 'object') {
      return { ok: false, tool: name, error: 'The registered tool definition has no valid JSON Schema.' };
    }

    const rawInput = call.arguments ?? (call.function && call.function.arguments) ?? {};
    let input = rawInput;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch (error) {
        return {
          ok: false,
          tool: name,
          error: 'Invalid JSON arguments for ' + name + ': ' + String(error && error.message || error)
        };
      }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, tool: name, error: 'Arguments for ' + name + ' must be a JSON object.' };
    }

    const policy = optionsOverride.policy || options.policy || {};
    const tool = bridgeToolDefinition(definition, {
      capabilities: options.capabilities,
      risk: options.risk,
      requiresApproval: options.requiresApproval,
      rollback: options.rollback,
      run: async (_normalizedInput, runtime) => executeTool(call, session, {
        ...optionsOverride,
        signal: runtime.signal,
        env: runtime.env,
        root: optionsOverride.root || runtime.cwd
      })
    });

    return runTool(tool, input, {
      policy,
      signal: optionsOverride.signal,
      env: optionsOverride.env || process.env,
      cwd: optionsOverride.root || process.cwd()
    });
  };
}
