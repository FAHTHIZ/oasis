/**
 * Tool runner bridge.
 *
 * Provides the first integration seam between the agent runtime and the Tool
 * Kernel. It adapts legacy-style tool handlers into kernel tool definitions
 * and returns a normalized result without changing existing tool behavior.
 */

import { defineTool, evaluateToolPolicy, validateToolInput } from './tool-kernel.mjs';

export function createToolRunner(handlers = [], options = {}) {
  const tools = new Map();
  for (const handler of handlers) {
    const tool = defineTool({
      name: handler.name,
      title: handler.title || handler.name,
      description: handler.description || '',
      capabilities: handler.capabilities || ['read'],
      risk: handler.risk || 'medium',
      inputSchema: handler.inputSchema || {},
      outputSchema: handler.outputSchema || {},
      timeoutMs: handler.timeoutMs,
      requiresApproval: handler.requiresApproval,
      rollback: handler.rollback,
      run: handler.run
    });
    tools.set(tool.name, tool);
  }

  return {
    has: (name) => tools.has(String(name || '')),
    get: (name) => tools.get(String(name || '')) || null,
    names: () => [...tools.keys()],
    async run(name, input, context = {}) {
      const tool = tools.get(String(name || ''));
      if (!tool) return { ok: false, error: 'Unknown tool: ' + name };
      const policy = context.policy || options.policy || {};
      const decision = evaluateToolPolicy(tool, input, policy);
      if (decision.decision === 'deny') {
        return { ok: false, tool: tool.name, decision, error: decision.reason || 'tool denied by policy' };
      }
      if (decision.decision === 'ask') {
        return { ok: false, tool: tool.name, decision, pendingApproval: true };
      }
      const normalizedInput = validateToolInput(tool, input);
      try {
        const output = await tool.run(normalizedInput, {
          signal: context.signal,
          policy,
          sandbox: decision.sandbox,
          env: context.env || process.env,
          cwd: context.cwd || process.cwd()
        });
        return { ok: true, tool: tool.name, decision, output: output === undefined ? null : output };
      } catch (error) {
        return { ok: false, tool: tool.name, decision, error: error && error.message || String(error) };
      }
    }
  };
}
