import { createParser as createSseParser } from 'eventsource-parser';
import { isAnthropicFamily } from './cloud-providers.mjs';

export function mergeExtraContent(current, next) {
  if (!current) return next;
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) && current[key] && typeof current[key] === 'object' ? { ...current[key], ...value } : value;
  }
  return merged;
}

const MAX_PROVIDER_STREAM_BYTES = 8 * 1024 * 1024;

// SSE framing (CR/LF/CRLF, multi-line data, comments, id/retry) comes from
// eventsource-parser; lines that are not SSE fields go to onStray.
export async function consumeServerSentEvents(response, onEvent, onStray) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('The provider announced streaming but returned no readable event stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  const parser = createSseParser({
    onEvent: (message) => onEvent({ event: message.event || 'message', data: message.data }),
    onError: (error) => { if (error.type === 'unknown-field' && error.line && typeof onStray === 'function') onStray(error.line); }
  });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAX_PROVIDER_STREAM_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('The model provider stream exceeded Oasis’s 8 MiB response limit.');
      }
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    // A final event without its blank line is still delivered.
    parser.feed(decoder.decode() + '\n\n');
  } finally {
    reader.releaseLock();
  }
}

function parseProviderEvent(raw) {
  try { return JSON.parse(raw); }
  catch { throw new Error('The model provider sent an invalid server-sent event payload.'); }
}

const ANTHROPIC_USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
// Keeps every token count an Anthropic stream reports (message_start and the
// cumulative message_delta), including prompt-cache reads and writes, which
// dominate cost on long sessions.
export function mergeAnthropicUsage(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const field of ANTHROPIC_USAGE_FIELDS) {
    const value = Number(source[field]);
    if (Number.isFinite(value) && value >= 0 && (value > 0 || target[field] === undefined)) target[field] = value;
  }
  return target;
}

/**
 * Which streamed tool call a delta belongs to. OpenAI sends `index`; Gemini's
 * OpenAI endpoint sends each parallel call whole, with its own id and no
 * index, which used to merge two reads into one "read_fileread_file" call
 * with doubled JSON. A delta with a new id is a new call; one with no id and
 * no index continues the latest call.
 */
export function toolCallSlot(calls, part) {
  const next = calls.size ? Math.max(...calls.keys()) + 1 : 0;
  const id = part && typeof part.id === 'string' && part.id ? part.id : '';
  if (id) for (const [slot, call] of calls) if (call.id === id) return slot;
  const hasIndex = part && part.index !== undefined && part.index !== null && Number.isFinite(Number(part.index));
  if (hasIndex) {
    const slot = Number(part.index);
    const existing = calls.get(slot);
    // A new index with no id and no name is a stray continuation: a live
    // Pollinations stream sent the closing "}" of call 0 as index 1. Keep it
    // with the previous call instead of opening a nameless one.
    const named = part.function && typeof part.function.name === 'string' && part.function.name;
    if (!existing && !id && !named && calls.size) return next - 1;
    // Same index but a different, already-named call: some gateways number every call 0.
    if (id && existing && existing.function.name && existing.id && !existing.id.startsWith('stream-tool-') && existing.id !== id) return next;
    return slot;
  }
  if (id) return next;
  return calls.size ? next - 1 : 0;
}

/** A JSON error body ({ error } or [{ error }]) found outside SSE events, if any. */
export function strayStreamError(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
    return /"error"/.test(raw) ? { message: match ? match[1] : 'the provider sent an error', status: Number((/"code"\s*:\s*(\d{3})/.exec(raw) || [])[1]) || 0 } : null;
  }
  const body = Array.isArray(parsed) ? parsed[0] : parsed;
  const error = body && typeof body === 'object' ? body.error : null;
  if (!error) return null;
  const message = typeof error === 'string' ? error : String(error.message || error.status || 'the provider sent an error');
  return { message: message.slice(0, 400), status: Number(error.code) || 0 };
}

export async function readProviderStream(response, protocol, onDelta, onProgress) {
  if (isAnthropicFamily(protocol)) {
    const blocks = new Map();
    const usage = { input_tokens: 0, output_tokens: 0 };
    let messageId;
    let model;
    let stopReason;
    let sawStop = false;
    await consumeServerSentEvents(response, ({ data }) => {
      if (data === '[DONE]') return;
      const event = parseProviderEvent(data);
      const type = event.type || '';
      if (type === 'error' || type === 'message_error') {
        throw new Error(String(event.error && event.error.message || event.message || 'The Anthropic stream failed.'));
      }
      if (type === 'message_start') {
        const message = event.message || {};
        messageId = message.id;
        model = message.model;
        if (message.usage) mergeAnthropicUsage(usage, message.usage);
      } else if (type === 'content_block_start') {
        const block = { ...(event.content_block || {}), partialJson: '' };
        if (block.type === 'text') block.text = String(block.text || '');
        if (block.type === 'thinking') { block.thinking = String(block.thinking || ''); block.signature = String(block.signature || ''); }
        blocks.set(Number(event.index || 0), block);
      } else if (type === 'content_block_delta') {
        const block = blocks.get(Number(event.index || 0));
        const delta = event.delta || {};
        if (!block) return;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = String(block.text || '') + delta.text;
          onDelta(delta.text);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.partialJson += delta.partial_json;
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking = String(block.thinking || '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = String(block.signature || '') + delta.signature;
        }
      } else if (type === 'message_stop') {
        sawStop = true;
      } else if (type === 'message_delta') {
        if (event.delta) stopReason = event.delta.stop_reason || stopReason;
        // message_delta usage is cumulative; newer APIs also repeat input and cache counts here.
        if (event.usage) mergeAnthropicUsage(usage, event.usage);
      }
    });
    // Cut off before message_delta/message_stop: the text is partial.
    if (!stopReason && !sawStop) throw Object.assign(new Error('The model stream was interrupted: the connection closed before the reply finished.'), { code: 'OASIS_STREAM_INTERRUPTED' });
    const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => {
      const normalized = { ...block };
      delete normalized.partialJson;
      if (block.type === 'tool_use') {
        if (block.partialJson) {
          try { normalized.input = JSON.parse(block.partialJson); }
          catch {
            if (stopReason !== 'max_tokens') throw new Error('The Anthropic stream returned incomplete JSON for a tool call.');
            normalized.input = {};
            normalized.incomplete = true;
          }
        } else if (!normalized.input || typeof normalized.input !== 'object') normalized.input = {};
      }
      return normalized;
    });
    return { id: messageId, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, usage };
  }

  if (protocol === 'openai-responses') {
    let finalResponse = null;
    await consumeServerSentEvents(response, ({ data, event: eventName }) => {
      if (data === '[DONE]') return;
      const event = parseProviderEvent(data);
      const type = event.type || eventName || '';
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        onDelta(event.delta);
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        finalResponse = event.response || event;
      } else if (type === 'response.failed' || type === 'error') {
        const detail = event.response && event.response.error && event.response.error.message || event.error && event.error.message || event.message;
        throw new Error(String(detail || 'The Responses API stream failed.'));
      }
    });
    if (!finalResponse) throw new Error('The Responses API stream ended without a completed response event.');
    return finalResponse;
  }

  let content = '';
  let reasoning = '';
  const calls = new Map();
  let usage = {};
  let finishReason = null;
  let sawDone = false;
  let stray = '';
  await consumeServerSentEvents(response, ({ data }) => {
    if (data === '[DONE]') { sawDone = true; return; }
    const event = parseProviderEvent(data);
    if (event.error) throw new Error(String(event.error.message || 'The chat-completions stream failed.'));
    if (event.prompt_progress && typeof onProgress === 'function') { try { onProgress(event.prompt_progress); } catch {} }
    if (event.usage) usage = event.usage;
    for (const choice of Array.isArray(event.choices) ? event.choices : []) {
      const delta = choice.delta || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      // Reasoning is not the answer: DeepSeek/vLLM send reasoning_content,
      // OpenRouter-style gateways send reasoning, and Google's endpoint marks
      // thought chunks with extra_content.google.thought.
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      else if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
      if (typeof delta.content === 'string') {
        if (delta.extra_content && delta.extra_content.google && delta.extra_content.google.thought === true) reasoning += delta.content;
        else {
          content += delta.content;
          onDelta(delta.content);
        }
      }
      for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = toolCallSlot(calls, part);
        const tool = calls.get(index) || { id: 'stream-tool-' + index, type: 'function', function: { name: '', arguments: '' } };
        if (part.id) tool.id = part.id;
        if (part.type) tool.type = part.type;
        if (part.function && typeof part.function.name === 'string') tool.function.name += part.function.name;
        if (part.function && typeof part.function.arguments === 'string') tool.function.arguments += part.function.arguments;
        // Gemini 3 sends a thought signature here and rejects the next turn without it.
        if (part.extra_content && typeof part.extra_content === 'object') tool.extra_content = mergeExtraContent(tool.extra_content, part.extra_content);
        calls.set(index, tool);
      }
    }
  }, (line) => { if (stray.length < 16384) stray += line + '\n'; });
  // Gemini's OpenAI endpoint can fail mid-stream (503 "high demand") by
  // appending a plain JSON error body after some data events, with no
  // [DONE]. That is a broken reply, not a short answer: restart it.
  const streamError = finishReason ? null : strayStreamError(stray);
  if (streamError) throw Object.assign(new Error('The model stream was interrupted: ' + streamError.message), { code: 'OASIS_STREAM_INTERRUPTED', status: streamError.status });
  // A connection that closes with neither a finish_reason nor [DONE] was cut
  // off mid-reply. Its partial text used to be taken as the whole answer.
  if (!finishReason && !sawDone) throw Object.assign(new Error('The model stream was interrupted: the connection closed before the reply finished.'), { code: 'OASIS_STREAM_INTERRUPTED' });
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  return { choices: [{ message: { role: 'assistant', content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason }], usage };
}
