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
