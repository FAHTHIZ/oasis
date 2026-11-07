export const TOOL_CAPABILITIES = ['read', 'write', 'execute', 'network', 'mcp', 'browser', 'git', 'secret'];

export function defineTool(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('Tool definition must be an object.');
  const name = String(definition.name || '');
  if (!/^[a-z][a-z0-9_.-]*$/i.test(name)) throw new Error('Invalid tool name: ' + name);
  if (!Array.isArray(definition.capabilities) || definition.capabilities.length === 0) throw new Error('Tool must declare at least one capability.');
  if (typeof definition.run !== 'function') throw new Error('Tool must provide a run function.');
  return Object.freeze({
    name,
    title: String(definition.title || name),
    description: String(definition.description || ''),
    capabilities: Object.freeze([...definition.capabilities]),
    risk: definition.risk || 'medium',
    inputSchema: definition.inputSchema || {},
    outputSchema: definition.outputSchema || {},
    timeoutMs: Number(definition.timeoutMs) || 120000,
    requiresApproval: Boolean(definition.requiresApproval),
    rollback: Object.freeze({ supported: Boolean(definition.rollback && definition.rollback.supported), kind: (definition.rollback && definition.rollback.kind) || 'none' }),
    run: definition.run
  });
}

export function createToolRegistry(definitions = []) {
  const tools = new Map();
  for (const definition of definitions) {
    const tool = defineTool(definition);
    if (tools.has(tool.name)) throw new Error('Duplicate tool name: ' + tool.name);
    tools.set(tool.name, tool);
  }
  return Object.freeze({
    get: (name) => tools.get(String(name || '')) || null,
    has: (name) => tools.has(String(name || '')),
    list: () => [...tools.values()],
    names: () => [...tools.keys()],
    byCapability: (capability) => [...tools.values()].filter((tool) => tool.capabilities.includes(capability))
  });
}

export function evaluateToolPolicy(tool, input, policy) {
  if (!policy || typeof policy.decide !== 'function') {
    return { decision: 'deny', reason: 'no tool policy is configured', requiredCapabilities: [...tool.capabilities], sandbox: false, audit: true };
  }
  const raw = policy.decide({ tool, input }) || {};
  const decision = String(raw.decision || 'deny');
  if (!['allow', 'deny', 'ask'].includes(decision)) throw new Error('Invalid tool policy decision: ' + decision);
  const result = {
    decision,
    reason: String(raw.reason || ''),
    requiredCapabilities: Array.isArray(raw.requiredCapabilities) ? [...raw.requiredCapabilities] : [...tool.capabilities],
    sandbox: Boolean(raw.sandbox),
    audit: raw.audit !== false
  };
  if (tool.requiresApproval && decision === 'allow') {
    return { ...result, decision: 'ask', reason: result.reason || 'tool explicitly requires approval' };
  }
  return result;
}

export function validateToolInput(tool, input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const schema = tool.inputSchema || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((name) => !(name in value));
  if (missing.length) throw new Error('Missing required input for ' + tool.name + ': ' + missing.join(', '));
  return value;
}

export async function runTool(tool, input, options = {}) {
  const policy = options.policy || {};
  const decision = evaluateToolPolicy(tool, input, policy);
  if (decision.decision === 'deny') {
    return { ok: false, tool: tool.name, decision, error: decision.reason || 'tool denied by policy', audit: decision.audit ? buildAuditRecord(tool, input, decision, null, options) : null };
  }
  if (decision.decision === 'ask') {
    return { ok: false, tool: tool.name, decision, pendingApproval: true, audit: decision.audit ? buildAuditRecord(tool, input, decision, null, options) : null };
  }
  const normalizedInput = validateToolInput(tool, input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Tool timed out after ' + tool.timeoutMs + ' ms')), tool.timeoutMs);
  const signal = options.signal || controller.signal;
  try {
    const output = await tool.run(normalizedInput, { signal, policy, sandbox: decision.sandbox, env: options.env || process.env, cwd: options.cwd || process.cwd() });
    const result = { ok: true, tool: tool.name, decision, output: output === undefined ? null : output };
    if (decision.audit) result.audit = buildAuditRecord(tool, normalizedInput, decision, result, options);
    return result;
  } catch (error) {
    const result = { ok: false, tool: tool.name, decision, error: error && error.message || String(error) };
    if (decision.audit) result.audit = buildAuditRecord(tool, normalizedInput, decision, result, options);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function buildAuditRecord(tool, input, decision, result, options) {
  return Object.freeze({
    at: new Date().toISOString(),
    tool: tool.name,
    capabilities: [...tool.capabilities],
    risk: tool.risk,
    decision: decision.decision,
    sandbox: decision.sandbox,
    input: redact(input),
    output: result && result.ok ? redact(result.output) : null,
    error: result && result.error || null,
    cwd: options.cwd || process.cwd()
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
