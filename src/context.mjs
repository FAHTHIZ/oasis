// Within-turn context protection for coding sessions.
// Estimates are deliberately cheap and deterministic; model-specific tokenizer counts are not available
// for every provider routed through Oasis. Set OASIS_CONTEXT_WINDOW to the selected model's real limit.
const DEFAULT_CONTEXT_WINDOW = 32_768;
const MAX_CONTEXT_WINDOW = 2_000_000;
const MIN_PRUNABLE_CHARS = 600;

function validWindow(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 4_000 && parsed <= MAX_CONTEXT_WINDOW ? parsed : null;
}

export function estimateTokens(messages) {
  let chars = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    // Responses API output items may contain reasoning/tool metadata not represented in content.
    if (Array.isArray(message.responseItems)) {
      try { chars += JSON.stringify(message.responseItems).length; }
      catch { chars += String(message.content || '').length; }
      continue;
    }
    if (Array.isArray(message.images)) chars += message.images.length * 1600 * 4;
    if (typeof message.content === 'string') chars += message.content.length;
    else if (Array.isArray(message.content)) {
      try { chars += JSON.stringify(message.content).length; }
      catch { /* Ignore content that cannot be represented safely. */ }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        chars += String(call && call.function && call.function.name || '').length;
        chars += String(call && call.function && call.function.arguments || '').length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// Known context windows by model-name pattern (first match wins). Names are matched
// anywhere in the id, so router ids such as "anthropic/claude-sonnet-4" work too.
// Unknown and local models keep the conservative 32K default; set contextWindow in
// the provider config or OASIS_CONTEXT_WINDOW to override.
const MODEL_WINDOWS = [
  [/claude/, 200_000],
  [/gpt-4\.1/, 1_000_000],
  [/gpt-5/, 400_000],
  [/(^|[^a-z])o[134](-|$)|o[34]-mini/, 200_000],
  [/gpt-4o|gpt-4-turbo|chatgpt-4o/, 128_000],
  [/gemini/, 1_000_000],
  [/grok-[34]/, 256_000],
  [/grok/, 128_000],
  [/qwen3-coder|qwen3-max/, 256_000],
  [/qwen3/, 128_000],
  [/codestral|devstral/, 128_000],
  [/mistral-(large|medium)/, 128_000],
  [/deepseek/, 64_000],
  [/kimi|moonshot/, 128_000],
  [/glm-4\.[5-9]|glm-[5-9]/, 128_000],
  [/llama-?3\.[1-3]|llama-?4/, 128_000]
];

export function modelContextWindow(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return null;
  for (const [pattern, size] of MODEL_WINDOWS) if (pattern.test(id)) return size;
  return null;
}

export function contextWindowSize(config = {}, env = process.env) {
  return validWindow(config.contextWindow) ||
    validWindow(env && env.OASIS_CONTEXT_WINDOW) ||
    modelContextWindow(config.model) ||
    DEFAULT_CONTEXT_WINDOW;
}

// History compaction threshold in characters. Small windows keep the original
// 60,000-character trigger; larger windows compact at about 60% full.
export function compactionThresholdChars(config = {}, env = process.env) {
  const explicit = Number.parseInt(config.compactThresholdChars ?? (env && env.OASIS_COMPACT_THRESHOLD_CHARS), 10);
  if (Number.isInteger(explicit) && explicit >= 10_000 && explicit <= 8_000_000) return explicit;
  const windowTokens = contextWindowSize(config, env);
  // /autocompact PCT, or Claude Code's CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1-100).
  const pct = Number(config.autoCompactPercent ?? (env && (env.OASIS_AUTOCOMPACT_PCT || env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)));
  if (config.autoCompactPercent === 0 || (config.autoCompactPercent === undefined && env && String(env.OASIS_AUTOCOMPACT_PCT || '') === '0')) return 8_000_000;
  if (Number.isFinite(pct) && pct >= 1 && pct <= 100) return Math.max(10_000, Math.floor(windowTokens * 4 * pct / 100));
  if (windowTokens <= DEFAULT_CONTEXT_WINDOW) return 60_000;
  return Math.floor(windowTokens * 4 * 0.6);
}

function stubFor(message) {
  const size = typeof message.content === 'string' ? message.content.length : 0;
  return '[Older tool output compacted to protect context (' + String(message.name || 'tool').slice(0, 80) +
    ', ' + size + ' characters). Re-run the tool if the details are needed again.]';
}

/**
 * Replace old bulky tool outputs with explicit re-fetch instructions while preserving
 * message order and every assistant tool-call/tool-result pairing. Never mutates input.
 * Only runs after the estimate exceeds triggerRatio of the configured context window.
 */
export function microcompact(messages, options = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
  const windowTokens = validWindow(options.windowTokens) || DEFAULT_CONTEXT_WINDOW;
  const triggerRatio = Number.isFinite(options.triggerRatio) ? options.triggerRatio : 0.5;
  const targetRatio = Number.isFinite(options.targetRatio) ? options.targetRatio : 0.35;
  const keepRecentTokens = Math.max(0, Number.isFinite(options.keepRecentTokens)
    ? options.keepRecentTokens
    : Math.floor(windowTokens * 0.15));
  const before = estimateTokens(messages);
  if (before <= windowTokens * triggerRatio) {
    return { messages, pruned: 0, before, after: before };
  }

  let protectedFrom = messages.length;
  let recent = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    recent += estimateTokens([messages[i]]);
    protectedFrom = i;
    if (recent >= keepRecentTokens) break;
  }

  const output = messages.slice();
  let current = before;
  let pruned = 0;
  for (let i = 1; i < protectedFrom && current > windowTokens * targetRatio; i++) {
    const message = output[i];
    if (!message || message.role !== 'tool' || typeof message.content !== 'string') continue;
    if (message.name === 'todo_write' || message.content.length < MIN_PRUNABLE_CHARS ||
        message.content.startsWith('[Older tool output compacted')) continue;
    const stub = stubFor(message);
    current -= Math.max(0, Math.ceil((message.content.length - stub.length) / 4));
    output[i] = { ...message, content: stub };
    pruned++;
  }
  return { messages: output, pruned, before, after: Math.max(0, current) };
}


const MUST_PRESERVE_KINDS = new Set(['rule', 'goal', 'plan', 'path', 'constraint', 'error', 'verification']);
const MAX_MUST_PRESERVE_ITEMS = 20;
const MAX_MUST_PRESERVE_TEXT = 600;
const MAX_MUST_PRESERVE_TOTAL = 8000;

export function sanitizeMustPreserve(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const kind = MUST_PRESERVE_KINDS.has(String(item.kind || '').toLowerCase()) ? String(item.kind).toLowerCase() : 'rule';
    const text = String(item.text || '').trim().slice(0, MAX_MUST_PRESERVE_TEXT);
    if (!text) continue;
    const key = kind + '\0' + text.toLowerCase();
    if (out.some((entry) => entry.kind + '\0' + entry.text.toLowerCase() === key)) continue;
    if (out.length >= MAX_MUST_PRESERVE_ITEMS || total + text.length > MAX_MUST_PRESERVE_TOTAL) break;
    out.push({ kind, text });
    total += text.length;
  }
  return out;
}

export function addMustPreserve(session, kind, text) {
  if (!session || typeof session !== 'object') throw new TypeError('An active session is required.');
  const normalizedKind = MUST_PRESERVE_KINDS.has(String(kind || '').toLowerCase()) ? String(kind).toLowerCase() : 'rule';
  const normalizedText = String(text || '').trim();
  if (!normalizedText) throw new Error('Preserved context cannot be empty.');
  const current = sanitizeMustPreserve(session.mustPreserve);
  const entry = { kind: normalizedKind, text: normalizedText.slice(0, MAX_MUST_PRESERVE_TEXT) };
  const next = sanitizeMustPreserve([...current, entry]);
  if (next.length === current.length && !next.some((item) => item.kind === entry.kind && item.text === entry.text)) {
    throw new Error('Must-preserve limit reached. Remove an old item before adding another.');
  }
  session.mustPreserve = next;
  return next;
}

function previewSafeText(value) {
  return String(value || '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 220);
}

export function createCompactionPreview(session, focus = '') {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  const history = messages.slice(1);
  const byRole = { user: 0, assistant: 0, tool: 0, other: 0 };
  const large = [];
  const paths = new Set();
  let errors = 0;
  let checks = 0;
  for (let i = 0; i < history.length; i++) {
    const message = history[i] || {};
    if (Object.prototype.hasOwnProperty.call(byRole, message.role)) byRole[message.role]++;
    else byRole.other++;
    const text = typeof message.content === 'string' ? message.content : '';
    const tokens = estimateTokens([message]);
    if (tokens > 500) large.push({ index: i + 2, role: String(message.role || 'unknown'), name: String(message.name || ''), tokens, preview: previewSafeText(text) });
    if (/\b(error|failed|exception|timed out|not found)\b/i.test(text)) errors++;
    if (/\b(test|type.?check|lint|build|diagnostic|verification)\b/i.test(text)) checks++;
    for (const match of text.matchAll(/\b((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\b/g)) {
      if (paths.size < 30) paths.add(match[1]);
    }
  }
  const mustPreserve = sanitizeMustPreserve(session && session.mustPreserve);
  const systemTokens = estimateTokens(messages.slice(0, 1));
  return {
    focus: String(focus || '').trim().slice(0, 1000),
    beforeTokens: estimateTokens(messages),
    systemTokens,
    historyMessages: history.length,
    summarizedMessages: history.length,
    retainedMessagesAfterCompaction: messages.length ? 3 : 0,
    byRole,
    largestMessages: large.sort((a, b) => b.tokens - a.tokens).slice(0, 5),
    recentPaths: [...paths].slice(-12),
    errorOrFailureMessages: errors,
    verificationRelatedMessages: checks,
    mustPreserve,
    note: 'Manual compaction summarizes all non-system messages into one digest. This preview is an estimate; the model-generated digest cannot be known in advance.'
  };
}
