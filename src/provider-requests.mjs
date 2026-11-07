// Provider-specific request serialization. These pure adapters keep wire-format
// differences out of the agent turn loop and are tested independently.
import { recentImageSet, anthropicImageBlocks, responsesImageItems } from './images.mjs';

export function openAIEndpoint(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : base + '/chat/completions';
}

export function responsesEndpoint(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  return base.endsWith('/responses') ? base : base + '/responses';
}

export function anthropicEndpoint(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  if (base.endsWith('/v1/messages')) return base;
  if (base.endsWith('/v1')) return base + '/messages';
  return base + '/v1/messages';
}

function parseToolInput(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function toResponsesRequest(messages) {
  const system = messages.find((message) => message.role === 'system');
  const input = [];
  const keepImages = recentImageSet(messages);
  let pendingImages = [];
  const flushImages = () => {
    if (pendingImages.length) input.push({ role: 'user', content: [{ type: 'input_text', text: 'Images returned by the previous tool calls:' }, ...pendingImages] });
    pendingImages = [];
  };
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool') flushImages();
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const images = responsesImageItems(message, index, keepImages);
      input.push({ role: 'user', content: images.length ? [{ type: 'input_text', text: String(message.content || '') }, ...images] : String(message.content || '') });
      continue;
    }
    if (message.role === 'assistant') {
      // Responses API output items include reasoning and tool-call metadata. Replay the
      // whole output array when present so stateless tool continuation remains valid.
      if (Array.isArray(message.responseItems) && message.responseItems.length) {
        input.push(...message.responseItems);
        continue;
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        if (typeof message.content === 'string' && message.content.trim()) {
          input.push({ role: 'assistant', content: message.content });
        }
        for (const call of message.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function && call.function.name,
            arguments: typeof (call.function && call.function.arguments) === 'string'
              ? call.function.arguments
              : JSON.stringify((call.function && call.function.arguments) || {})
          });
        }
      } else {
        input.push({ role: 'assistant', content: String(message.content || ' ') });
      }
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: String(message.content || '')
      });
      pendingImages.push(...responsesImageItems(message, index, keepImages));
    }
  }
  flushImages();
  return { instructions: system ? String(system.content || '') : '', input };
}

export function toAnthropicRequest(messages, options = {}) {
  const system = messages.find((message) => message.role === 'system');
  const converted = [];
  const keepImages = recentImageSet(messages);
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const images = anthropicImageBlocks(message, index, keepImages);
      converted.push({ role: 'user', content: images.length ? [{ type: 'text', text: String(message.content || '') }, ...images] : message.content || '' });
      continue;
    }
    if (message.role === 'assistant') {
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const content = [];
        // Thinking blocks must be replayed unchanged (with signatures) during a tool-use loop.
        if (options.thinking && Array.isArray(message.thinkingBlocks)) content.push(...message.thinkingBlocks.map((block) => ({ ...block })));
        if (typeof message.content === 'string' && message.content.trim()) content.push({ type: 'text', text: message.content });
        for (const call of message.tool_calls) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function && call.function.name,
            input: parseToolInput(call.function && call.function.arguments)
          });
        }
        converted.push({ role: 'assistant', content });
      } else {
        converted.push({ role: 'assistant', content: typeof message.content === 'string' && message.content ? message.content : ' ' });
      }
      continue;
    }
    if (message.role === 'tool') {
      const images = anthropicImageBlocks(message, index, keepImages);
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: images.length ? [{ type: 'text', text: String(message.content || '') }, ...images] : String(message.content || '') };
      const last = converted[converted.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((item) => item.type === 'tool_result')) {
        last.content.push(block);
      } else {
        converted.push({ role: 'user', content: [block] });
      }
    }
  }
  const merged = [];
  for (const message of converted) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role && message.role === 'user') {
      const asBlocks = (content) => Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
      last.content = asBlocks(last.content).concat(asBlocks(message.content));
    } else {
      merged.push(message);
    }
  }
  // Anthropic rejects empty or whitespace-only text ("text content blocks must
  // contain non-whitespace text") and, since the history is replayed, would
  // then fail every later request in the session. An empty reply used to be
  // sent as a single space.
  for (const message of merged) {
    const placeholder = message.role === 'assistant' ? '(empty reply)' : '(empty message)';
    if (typeof message.content === 'string') {
      if (!message.content.trim()) message.content = placeholder;
    } else if (Array.isArray(message.content)) {
      const kept = message.content.filter((block) => !(block && block.type === 'text' && !String(block.text || '').trim()));
      message.content = kept.length ? kept : [{ type: 'text', text: placeholder }];
    }
  }
  return { system: system ? String(system.content || '') : '', messages: merged };
}

const CHAT_TOOL_FUNCTION_KEYS = ['name', 'description', 'parameters', 'strict'];
export export function chatCompletionTool(tool) {
  if (!tool || tool.type !== 'function' || !tool.function) return tool;
  const fn = {};
  for (const key of CHAT_TOOL_FUNCTION_KEYS) if (tool.function[key] !== undefined) fn[key] = tool.function[key];
  return { type: 'function', function: fn };
}
