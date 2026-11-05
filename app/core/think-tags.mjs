// Reasoning that some models write into the answer text itself.
//
// Gemma 4 on Google's endpoint answers "<thought>...</thought>Hello", and
// DeepSeek-R1, Qwen3 and QwQ served by Ollama, llama.cpp or vLLM without a
// reasoning parser answer "<think>...</think>Hello". Shown as is, the user
// reads the model's private reasoning as the reply, and sending it back
// every turn wastes context. Only a block at the very start of a reply is
// treated as reasoning, so an answer that talks about <think> tags is left
// alone.
//
// Shared by the CLI (src/agent.mjs) and the browser app (app/core).

const OPEN = /^\s*<(think|thinking|thought|reasoning)>/i;
// Gemini flags thought chunks (extra_content.google.thought) and those go to
// reasoning, but Gemma's closing tag arrives in the first answer chunk:
// "</thought>I'll start by...". A reply never means to begin with one.
const ORPHAN_CLOSE = /^\s*<\/(think|thinking|thought|reasoning)>\s*/i;
const TAG_NAMES = ['think', 'thinking', 'thought', 'reasoning'];
const LONGEST_OPEN = Math.max(...TAG_NAMES.map((name) => name.length)) + 2;

// Text that could still grow into an opening (or orphan closing) tag.
function partialTag(trimmed) {
  if (trimmed.length > LONGEST_OPEN || !trimmed.startsWith('<')) return false;
  const lower = trimmed.toLowerCase();
  return TAG_NAMES.some((name) => ('<' + name + '>').startsWith(lower) || ('</' + name + '>').startsWith(lower));
}

/**
 * Splits leading reasoning blocks from a finished reply.
 * Returns { content, reasoning }. An unclosed leading block (the reply was
 * cut off while thinking) is all reasoning.
 */
export function splitThinking(text) {
  let rest = typeof text === 'string' ? text : '';
  const thoughts = [];
  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) break;
    const close = new RegExp('</' + open[1] + '>', 'i');
    const after = rest.slice(open[0].length);
    const end = close.exec(after);
    if (!end) { thoughts.push(after.trim()); rest = ''; break; }
    thoughts.push(after.slice(0, end.index).trim());
    rest = after.slice(end.index + end[0].length);
  }
  if (!thoughts.length) {
    const value = typeof text === 'string' ? text : '';
    const orphan = ORPHAN_CLOSE.exec(value);
    return { content: orphan ? value.slice(orphan[0].length) : value, reasoning: '' };
  }
  return { content: rest.replace(/^\s+/, ''), reasoning: thoughts.filter(Boolean).join('\n\n') };
}

/**
 * Streaming version: wraps an onText(chunk) callback so leading reasoning
 * blocks never reach it. `onThinking(chunk)` (optional) receives the
 * reasoning instead. Call flush() when the stream ends.
 */
export function createThinkFilter(onText, onThinking = null) {
  let state = 'start'; // start -> (thinking -> start)* -> text
  let buffer = '';
  let closeTag = '';
  const emit = (chunk) => { if (chunk && onText) onText(chunk); };
  const think = (chunk) => { if (chunk && onThinking) onThinking(chunk); };
  function drain() {
    for (;;) {
      if (state === 'text') { emit(buffer); buffer = ''; return; }
      if (state === 'start') {
        const trimmed = buffer.replace(/^\s+/, '');
        if (!trimmed) return;
        const orphan = !closeTag && ORPHAN_CLOSE.exec(buffer);
        if (orphan) { buffer = buffer.slice(orphan[0].length); continue; }
        const open = OPEN.exec(buffer);
        if (open) {
          closeTag = '</' + open[1].toLowerCase() + '>';
          buffer = buffer.slice(open[0].length);
          state = 'thinking';
          continue;
        }
        // Could still become an opening tag once more text arrives.
        if (partialTag(trimmed)) return;
        state = 'text';
        buffer = trimmed;
        continue;
      }
      // thinking
      const at = buffer.toLowerCase().indexOf(closeTag);
      if (at < 0) {
        // Keep enough tail to catch a close tag split across chunks.
        const keep = closeTag.length - 1;
        if (buffer.length > keep) { think(buffer.slice(0, buffer.length - keep)); buffer = buffer.slice(buffer.length - keep); }
        return;
      }
      think(buffer.slice(0, at));
      buffer = buffer.slice(at + closeTag.length);
      state = 'start';
    }
  }
  return {
    push(chunk) { if (typeof chunk === 'string' && chunk) { buffer += chunk; drain(); } },
    flush() {
      if (state === 'thinking') think(buffer);
      else if (state === 'start' && buffer.trim()) emit(buffer.replace(/^\s+/, ''));
      else if (state === 'text') emit(buffer);
      buffer = '';
    },
    get sawThinking() { return state !== 'start' || Boolean(closeTag); }
  };
}

/**
 * For callers that re-render the whole reply so far on every delta: the
 * part of `text` to show. Hides an opening tag that is still arriving.
 */
export function visibleReply(text) {
  const value = typeof text === 'string' ? text : '';
  const trimmed = value.replace(/^\s+/, '');
  if (partialTag(trimmed)) return '';
  return splitThinking(value).content;
}
