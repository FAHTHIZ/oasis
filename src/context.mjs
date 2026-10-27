// Context management helpers: cheap token estimates and "microcompaction".
//
// Microcompaction replaces the bulky output of OLD tool calls with a short stub once the
// conversation grows large. It never changes message order or tool-call/tool-result
// pairing, so every provider's protocol rules stay satisfied. It is deliberately
// deterministic and needs no model call. The agent can simply re-run a tool if it needs
// pruned output again.

const CHARS_PER_TOKEN = 4;
const MIN_PRUNABLE_CHARS = 600;

export function estimateTokens(messages) {
  let chars = 0;
  for (const message of messages || []) {
    if (!message) continue;
    // Responses API items are the canonical replayable representation for that provider.
    // Count them instead of the duplicated normalized content/tool_calls fields.
    if (Array.isArray(message.responseItems)) {
      chars += JSON.stringify(message.responseItems).length;
      continue;
    }
    if (typeof message.content === 'string') chars += message.content.length;
    else if (Array.isArray(message.content)) chars += JSON.stringify(message.content).length;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        chars += String(call && call.function && call.function.name || '').length;
        chars += String(call && call.function && call.function.arguments || '').length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function contextWindowSize(config = {}, env = process.env) {
  const fromConfig = Number.parseInt(config.contextWindow, 10);
  if (fromConfig >= 4000) return fromConfig;
  const fromEnv = Number.parseInt(env.OASIS_CONTEXT_WINDOW, 10);
  if (fromEnv >= 4000) return fromEnv;
  return 128000;
}

function stubFor(message) {
  const size = typeof message.content === 'string' ? message.content.length : 0;
  return '[Tool output pruned to save context (' + (message.name || 'tool') + ', ' + size + ' characters). Re-run the tool if you need this information again.]';
}

/**
 * Returns { messages, pruned, before, after }. Pure: the input array is not mutated.
 *
 * Rules:
 *  - Nothing happens until the estimate exceeds `triggerRatio` of the window.
 *  - The most recent `keepRecentTokens` worth of messages is always left intact.
 *  - Only `tool` messages larger than MIN_PRUNABLE_CHARS are replaced, oldest first, until the
 *    estimate drops below `targetRatio` of the window.
 */
export function microcompact(messages, options = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
  const windowTokens = options.windowTokens || 128000;
  const triggerRatio = options.triggerRatio ?? 0.5;
  const targetRatio = options.targetRatio ?? 0.35;
  const keepRecentTokens = options.keepRecentTokens ?? Math.floor(windowTokens * 0.15);
  const before = estimateTokens(messages);
  if (before <= windowTokens * triggerRatio) return { messages, pruned: 0, before, after: before };

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
    if (message.content.length < MIN_PRUNABLE_CHARS || message.content.startsWith('[Tool output pruned')) continue;
    const stub = stubFor(message);
    current -= Math.ceil((message.content.length - stub.length) / CHARS_PER_TOKEN);
    output[i] = { ...message, content: stub };
    pruned++;
  }
  return { messages: output, pruned, before, after: Math.max(0, current) };
}
