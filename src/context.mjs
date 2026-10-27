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

export function contextWindowSize(config = {}, env = process.env) {
  return validWindow(config.contextWindow) ||
    validWindow(env && env.OASIS_CONTEXT_WINDOW) ||
    DEFAULT_CONTEXT_WINDOW;
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
