/**
 * Tool runner bridge.
 *
 * Provides the first integration seam between the agent runtime and the Tool
 * Kernel. It adapts legacy-style tool handlers into kernel tool definitions
 * and returns a normalized result without changing existing tool behavior.
 */

import { defineTool, runTool } from './tool-kernel.mjs';

export function createToolRunner(handlers = [], options = {}) {
  const tools = new Map();
  for (const handler of handlers) {
    const capabilities = handler.capabilities ?? ['execute'];
    const capabilitySet = new Set(capabilities);
    const readOnly = capabilitySet.size > 0 && [...capabilitySet].every((capability) => capability === 'read');
    const inferredRisk = !handler.capabilities ? 'critical'
      : readOnly ? 'low'
        : capabilitySet.has('execute') || capabilitySet.has('mcp') ? 'critical' : 'high';
    const tool = defineTool({
      name: handler.name,
      title: handler.title || handler.name,
      description: handler.description || '',
      capabilities,
      risk: handler.risk ?? inferredRisk,
      inputSchema: handler.inputSchema || {},
      outputSchema: handler.outputSchema || {},
      timeoutMs: handler.timeoutMs,
      requiresApproval: handler.requiresApproval ?? !readOnly,
      rollback: handler.rollback,
      run: handler.run
    });
    if (tools.has(tool.name)) throw new Error('Duplicate tool name: ' + tool.name);
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
      return await runTool(tool, input, {
        policy,
        signal: context.signal,
        env: context.env || process.env,
        cwd: context.cwd || process.cwd()
      });
    }
  };
}
