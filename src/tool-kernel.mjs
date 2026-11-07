// Node runtime adapter: inject OASIS's full secret scanner into the portable kernel.
import { redactSecretText } from './secret-shield.mjs';
import * as core from './tool-kernel-core.mjs';

export const TOOL_CAPABILITIES = core.TOOL_CAPABILITIES;
export const TOOL_RISK_LEVELS = core.TOOL_RISK_LEVELS;
export const defineTool = core.defineTool;
export const validateToolInput = core.validateToolInput;

export function evaluateToolPolicy(tool, input, policy) {
  return core.evaluateToolPolicy(tool, input, policy, redactSecretText);
}

export function redactAuditValue(value, depth = 0, fieldName = '') {
  return core.redactAuditValue(value, depth, fieldName, redactSecretText);
}

export async function runTool(tool, input, options = {}) {
  return core.runTool(tool, input, {
    ...options,
    redactText: options.redactText || redactSecretText
  });
}
