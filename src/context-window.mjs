// Context-window discovery and the compact tool profile: learn a provider's real
// window from its overflow error and shrink the prompt to fit it.
import { applySmallContextProfile, SMALL_CONTEXT_TOKENS } from './local-context.mjs';
import { deferredToolsPrompt, TOOL_SEARCH_DEFINITION } from './session-tools.mjs';

// Window size stated in a provider's overflow error, e.g. llama.cpp "exceeds the
// available context size (16384 tokens)", OpenAI "maximum context length is 8192
// tokens", vLLM "maximum model length is 4096".
export function contextWindowFromError(error) {
  const text = String(error && error.message || '');
  const match = text.match(/context size \((\d{3,7}) tokens\)|maximum context length is (\d{3,7})|maximum model length is (\d{3,7})|context (?:window|length) (?:of|is) (\d{3,7}) tokens|n_ctx(?:_slot)?\s*[=:]\s*(\d{3,7})/i);
  const value = match ? Number(match.slice(1).find(Boolean)) : 0;
  return value >= 512 ? value : 0;
}

// The first request itself can overflow a small local window: system prompt and
// tool schemas alone exceed it, so there is no history to compact. Learn the
// real window from the error and drop to the small-context tool set (rare tools
// stay reachable through tool_search).
const LLAMA_OVERFLOW_PATTERN = /exceed_context_size_error|exceeds the available context size/i;
export function isLoopbackBaseURL(baseURL) {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(String(baseURL || '')).hostname.toLowerCase()); } catch { return false; }
}

export function adoptReportedContextWindow(session, error, env) {
  const window = contextWindowFromError(error);
  if (!window) return false;
  const current = Number(session.config && session.config.contextWindow) || 0;
  let changed = false;
  if (!current || window < current) { session.config = { ...(session.config || {}), contextWindow: window }; changed = true; }
  // llama-server words its overflow error in its own way. On a port OASIS does not
  // probe, that error is the first sign of the server, so remember it: prompt
  // read progress (return_progress) then works for the rest of the session.
  if (!session.localContext && LLAMA_OVERFLOW_PATTERN.test(String(error && error.message || '')) && isLoopbackBaseURL(session.config && session.config.baseURL)) {
    session.localContext = { server: 'llama.cpp', contextLength: window, source: 'overflow-error' };
  }
  if (window <= SMALL_CONTEXT_TOKENS && useCompactToolProfile(session, env)) changed = true;
  return changed;
}

// Essential tools up front, the rest behind tool_search, and the compact
// system prompt: about half the tokens per request. Used for small context
// windows and when a provider caps input tokens per minute (Gemma 4 free
// tier: 16k/minute against ~7k tokens for the full prompt). Returns true
// when something was deferred.
export function useCompactToolProfile(session, env) {
  if (/^(?:0|false|off|no)$/i.test(String((env || process.env).OASIS_SMALL_CONTEXT_TOOLS || '')) || !Array.isArray(session && session.toolDefinitions)) return false;
  const deferred = applySmallContextProfile(session, TOOL_SEARCH_DEFINITION);
  if (!deferred) return false;
  const system = (session.messages || []).find((message) => message && message.role === 'system');
  // Apply to the live system message and to baseSystemPrompt, which
  // refreshTodoPrompt rebuilds the system message from on later steps.
  const swap = session.compactPromptSwap;
  session.compactPromptSwap = null;
  const shrink = (text) => {
    let next = swap && text.startsWith(swap.full) ? swap.compact + text.slice(swap.full.length) : text;
    if (!next.includes('tool_search')) next += '\n\n' + deferredToolsPrompt(session);
    return next;
  };
  if (typeof session.baseSystemPrompt === 'string') session.baseSystemPrompt = shrink(session.baseSystemPrompt);
  if (system && typeof system.content === 'string') system.content = shrink(system.content);
  return true;
}

// Gemini: generate_content_free_tier_input_token_count /
// GenerateContentInputTokensPerModelPerMinute. OpenAI-style: "tokens per min (TPM)".
export function isInputTokenRateLimit(body) {
  return /input_token_count|InputTokensPer\w*Minute|tokens per min(?:ute)?\b|\bTPM\b/i.test(String(body || ''));
}
