// Tool-call IDs as sent to the provider.
//
// A conversation can hold IDs that the next provider rejects:
// - a stream without IDs gets OASIS placeholders (stream-tool-0) and text tool
//   calls get oasis_text_call_<step>_<n>; both repeat on later steps, and
//   Anthropic rejects a request whose tool_use IDs are not unique;
// - switching model mid-session carries the old provider's IDs: Kimi uses
//   "functions.bash:0" (Anthropic allows only [A-Za-z0-9_-]), some gateways
//   send IDs longer than the 40 characters OpenAI Chat Completions accepts,
//   and Mistral accepts exactly nine letters or digits.
//
// Only the request copy changes; the saved transcript keeps the original IDs.
// The mapping depends only on earlier messages, so the request prefix (and the
// provider's prompt cache) stays stable from one step to the next. Valid,
// unique IDs are passed through untouched.
import { createHash } from 'node:crypto';

const GENERIC_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MISTRAL_ID = /^[A-Za-z0-9]{9}$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function toolCallIdStyle(config = {}) {
  let host = '';
  try { host = new URL(String(config.baseURL || '')).hostname.toLowerCase(); } catch {}
  return host === 'api.mistral.ai' || host.endsWith('.mistral.ai') ? 'mistral' : 'generic';
}

function derivedId(original, occurrence, style, attempt) {
  const digest = createHash('sha256').update(String(original) + '\0' + occurrence + '\0' + attempt).digest();
  if (style === 'mistral') {
    let out = '';
    for (let i = 0; i < 9; i++) out += BASE62[digest[i] % 62];
    return out;
  }
  return 'call_' + digest.toString('hex').slice(0, 24);
}

export function wireToolCallIds(messages, { style = 'generic' } = {}) {
  if (!Array.isArray(messages)) return messages;
  const valid = style === 'mistral' ? MISTRAL_ID : GENERIC_ID;
  const used = new Set();
  const occurrences = new Map();
  let current = new Map();
  let changed = false;
  const out = messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      current = new Map();
      // Replayed Responses API items carry their own call_id; they came from
      // OpenAI and are left exactly as they were.
      const frozen = Array.isArray(message.responseItems) && message.responseItems.length > 0;
      let rewritten = false;
      const calls = message.tool_calls.map((call) => {
        if (!call || typeof call !== 'object') return call;
        const original = typeof call.id === 'string' ? call.id : '';
        const seen = occurrences.get(original) || 0;
        occurrences.set(original, seen + 1);
        let id = original;
        for (let attempt = 0; !frozen && (!valid.test(id) || used.has(id)); attempt++) id = derivedId(original, seen, style, attempt);
        used.add(id);
        if (!current.has(original)) current.set(original, []);
        current.get(original).push(id);
        if (id === original) return call;
        rewritten = true;
        return { ...call, id };
      });
      if (!rewritten) return message;
      changed = true;
      return { ...message, tool_calls: calls };
    }
    if (message.role === 'tool') {
      const original = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      const queue = current.get(original);
      const id = queue && queue.length ? (queue.length > 1 ? queue.shift() : queue[0]) : original;
      if (id === original) return message;
      changed = true;
      return { ...message, tool_call_id: id };
    }
    return message;
  });
  return changed ? out : messages;
}
