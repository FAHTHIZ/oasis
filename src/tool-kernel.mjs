import { redactSecretText } from './secret-shield.mjs';
import { validateToolArguments } from './tool-schema-validation.mjs';

export const TOOL_CAPABILITIES = Object.freeze(['read', 'write', 'execute', 'network', 'mcp', 'browser', 'git', 'secret']);
export const TOOL_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

export function defineTool(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('Tool definition must be an object.');
  const name = String(definition.name || '');
  if (!/^[a-z][a-z0-9_.-]*$/i.test(name)) throw new Error('Invalid tool name: ' + name);
  if (!Array.isArray(definition.capabilities) || definition.capabilities.length === 0) throw new Error('Tool must declare at least one capability.');
  const capabilities = [...new Set(definition.capabilities.map(String))];
  const unknownCapabilities = capabilities.filter((capability) => !TOOL_CAPABILITIES.includes(capability));
  if (unknownCapabilities.length) throw new Error('Unknown tool capability: ' + unknownCapabilities.join(', '));
  const risk = String(definition.risk || 'medium');
  if (!TOOL_RISK_LEVELS.includes(risk)) throw new Error('Unknown tool risk level: ' + risk);
  if (typeof definition.run !== 'function') throw new Error('Tool must provide a run function.');
  return Object.freeze({
    name,
    title: String(definition.title || name),
    description: String(definition.description || ''),
    capabilities: Object.freeze(capabilities),
    risk,
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

export async function validateToolInput(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid input for ' + tool.name + ': arguments must be a JSON object.');
  }
  const value = input;
  const validation = await validateToolArguments(tool.inputSchema, value);
  if (!validation.valid) {
    const errors = validation.errors || [];
    const detail = validation.schemaError || errors.join('; ');
    if (!validation.schemaError && errors.some((message) => /missing required property/.test(message))) {
      throw new Error('Missing required input for ' + tool.name + ': ' + detail);
    }
    throw new Error('Invalid input for ' + tool.name + ': ' + (detail || 'does not match its JSON Schema.'));
  }
  return value;
}

// Audit records redact fields named like credentials even when their value is
// a short or synthetic token, then run the shared provider-secret scanner.
const SENSITIVE_AUDIT_FIELD = /(?:^|_)(?:api_?key|access_?key|token|secret|password|passwd|credentials?|authorization|proxy_authorization|cookie|private_?key|client_secret|database_url|connection_string|dsn)$/i;
const SENSITIVE_CLI_FLAG = /^--?(?:api[-_]?key|access[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|cookie)$/i;
const SENSITIVE_CLI_FLAG_WITH_VALUE = /^((?:--?)(?:api[-_]?key|access[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|cookie))=(.*)$/i;

function redactCredentialFlags(text) {
  return String(text).replace(
    /(^|\s)(--?(?:api[-_]?key|access[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|cookie))(=|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_whole, prefix, flag, separator) => prefix + flag + separator + '[redacted]'
  );
}


export function redactAuditValue(value, depth = 0, fieldName = '') {
  if (depth > 6) return '[depth-limit]';
  const normalizedField = String(fieldName || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_').toLowerCase();
  if (normalizedField && SENSITIVE_AUDIT_FIELD.test(normalizedField) && value !== null && value !== undefined) return '[redacted]';
  if (typeof value === 'string') return redactCredentialFlags(redactSecretText(value));
  if (Array.isArray(value)) {
    const normalizedParent = String(fieldName || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_').toLowerCase();
    if (['args', 'argv', 'command_args'].includes(normalizedParent)) {
      const out = [];
      for (let index = 0; index < value.length; index++) {
        const item = value[index];
        if (typeof item === 'string') {
          const combined = SENSITIVE_CLI_FLAG_WITH_VALUE.exec(item);
          if (combined) { out.push(combined[1] + '=[redacted]'); continue; }
          if (SENSITIVE_CLI_FLAG.test(item) && index + 1 < value.length) {
            out.push(item, '[redacted]');
            index++;
            continue;
          }
        }
        out.push(redactAuditValue(item, depth + 1, fieldName));
      }
      return out;
    }
    return value.map((item) => redactAuditValue(item, depth + 1, fieldName));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAuditValue(item, depth + 1, key)]));
  }
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

  let normalizedInput;
  try {
    normalizedInput = await validateToolInput(tool, input);
  } catch (error) {
    const result = { ok: false, tool: tool.name, decision, error: error && error.message || String(error) };
    if (decision.audit) result.audit = buildAuditRecord(tool, input, decision, result, options);
    return result;
  }

  const controller = new AbortController();
  let timedOut = false;
  const externalSignal = options.signal;
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal.reason || new Error('Tool was cancelled.'));
  };
  if (externalSignal) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort(new Error('Tool timed out after ' + tool.timeoutMs + ' ms'));
  }, tool.timeoutMs);
  let onAbort;
  try {
    // Do not invoke a tool whose caller has already cancelled the request.
    // A rejected abort promise alone is not sufficient: the run microtask could
    // start a side effect before Promise.race observes that rejection.
    if (controller.signal.aborted) {
      const error = controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Tool was cancelled.');
      const result = {
        ok: false,
        tool: tool.name,
        decision,
        error: error.message,
        ...(timedOut ? { timedOut: true } : { cancelled: true })
      };
      if (decision.audit) result.audit = buildAuditRecord(tool, normalizedInput, decision, result, options);
      return result;
    }
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Tool was cancelled.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const running = Promise.resolve().then(() => tool.run(normalizedInput, {
      signal: controller.signal,
      policy,
      sandbox: decision.sandbox,
      env: options.env || process.env,
      cwd: options.cwd || process.cwd()
    }));
    const output = await Promise.race([running, aborted]);
    const result = { ok: true, tool: tool.name, decision, output: output === undefined ? null : output };
    if (decision.audit) result.audit = buildAuditRecord(tool, normalizedInput, decision, result, options);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      tool: tool.name,
      decision,
      error: error && error.message || String(error),
      ...(timedOut ? { timedOut: true } : controller.signal.aborted ? { cancelled: true } : {})
    };
    if (decision.audit) result.audit = buildAuditRecord(tool, normalizedInput, decision, result, options);
    return result;
  } finally {
    clearTimeout(timeout);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
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
    input: redactAuditValue(input),
    output: result && result.ok ? redactAuditValue(result.output) : null,
    error: result && result.error ? redactAuditValue(result.error) : null,
    cwd: options.cwd || process.cwd()
  });
}

