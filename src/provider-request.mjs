// Provider request shaping: Anthropic prompt-cache breakpoints, Google endpoint detection,
// and replaying reasoning / provider extra content (Gemini thought signatures) in history.
// Extracted from agent.mjs, which re-exports the public names.
import { catalogReasoningReplay } from './model-catalog.mjs';

export function promptCachingEnabled(config = {}, env = process.env) {
  if (['0', 'off', 'false', 'no'].includes(String(env.OASIS_PROMPT_CACHE || '').toLowerCase())) return false;
  return config.promptCache !== false;
}

export function applyAnthropicCacheBreakpoints(request, tools = []) {
  const mark = { type: 'ephemeral' };
  if (request.system) request.system = [{ type: 'text', text: request.system, cache_control: mark }];
  if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: mark };
  const markMessage = (message) => {
    if (!message) return;
    if (typeof message.content === 'string') message.content = message.content ? [{ type: 'text', text: message.content, cache_control: mark }] : message.content;
    else if (Array.isArray(message.content) && message.content.length) {
      const block = message.content[message.content.length - 1];
      message.content[message.content.length - 1] = { ...block, cache_control: mark };
    }
  };
  const messages = request.messages || [];
  markMessage(messages[messages.length - 1]);
  // Also mark where the previous request ended (the user message before the
  // latest assistant reply). Anthropic looks back only 20 content blocks from a
  // breakpoint for a cached prefix, and one step with ten parallel tool calls
  // adds more than that (tool_use + tool_result blocks), so with the last
  // message marked alone such a step re-sent the whole history uncached.
  // system + last tool + these two = the four breakpoints Anthropic allows.
  for (let index = messages.length - 2; index > 0; index--) {
    if (messages[index].role !== 'assistant') continue;
    if (messages[index - 1].role === 'user') markMessage(messages[index - 1]);
    break;
  }
  return request;
}

export function isGoogleGenerativeBaseURL(baseURL) {
  try { return new URL(String(baseURL || '')).hostname.toLowerCase() === 'generativelanguage.googleapis.com'; } catch { return false; }
}

// Tool calls keep Google's extra_content (the Gemini 3 thought signature) so
// the next turn can echo it back, which Gemini requires. Requests to other
// models drop the field, so a session that falls back elsewhere stays valid.
//
// Reasoning models with interleaved thinking (DeepSeek, Kimi, GLM, MiMo, many
// hosted Qwen/MiniMax builds) expect their reasoning_content back on the next
// request, or they lose the thread between tool calls. Order: an explicit
// `replayReasoning` config value, then the models.dev catalog's `interleaved`
// field, then a name pattern for models the catalog does not list.
export function replaysReasoning(config, env = process.env) {
  if (!config || config.protocol !== 'openai-compatible') return false;
  if (typeof config.replayReasoning === 'boolean') return config.replayReasoning;
  const field = catalogReasoningReplay(String(config.model || ''), { baseURL: config.baseURL, provider: config.catalogProvider, env });
  if (field === 'reasoning_content') return true;
  return /deepseek|moonshot|kimi/i.test(String(config.baseURL || '') + ' ' + String(config.model || ''));
}

export function withProviderExtraContent(messages, baseURL, model = '') {
  // Gemini behind a gateway (LiteLLM, a local proxy) needs the signature too.
  if (isGoogleGenerativeBaseURL(baseURL) || /gemini/i.test(String(model || ''))) return messages;
  if (!messages.some((message) => Array.isArray(message && message.tool_calls) && message.tool_calls.some((call) => call && call.extra_content))) return messages;
  return messages.map((message) => {
    if (!Array.isArray(message && message.tool_calls) || !message.tool_calls.some((call) => call && call.extra_content)) return message;
    return { ...message, tool_calls: message.tool_calls.map((call) => {
      if (!call || !call.extra_content) return call;
      const { extra_content: _dropped, ...rest } = call;
      return rest;
    }) };
  });
}
