// Provider HTTP error messages: the provider's own message, plus advice for the
// usual causes (credit or quota limits, rate limits, wrong key or endpoint).
import { openRouterCreditInfo } from './model-budgets.mjs';
import { isUnconfiguredRouteError, isPromptTooLargeError } from './provider-retry.mjs';

export function formatApiError(status, body, protocol, baseURL = '') {
  let detail = '';
  try {
    let parsed = JSON.parse(body);
    // Google's OpenAI-compatible endpoint wraps the error in an array: [{ error: {...} }].
    if (Array.isArray(parsed)) parsed = parsed.find((item) => item && typeof item === 'object') || {};
    detail = parsed.error && (parsed.error.message || parsed.error.code || parsed.error.type)
      ? String(parsed.error.message || parsed.error.code || parsed.error.type) : (typeof parsed.message === 'string' ? parsed.message : '');
    // OmniRoute wraps the upstream provider's own error in upstream_details.
    const upstream = parsed && parsed.upstream_details && parsed.upstream_details.error;
    const upstreamText = upstream ? String(typeof upstream === 'string' ? upstream : upstream.message || '').trim() : '';
    if (upstreamText && !detail.includes(upstreamText)) detail = (detail ? detail.replace(/\.+$/, '') + ' (upstream: ' + upstreamText.replace(/\.+$/, '') + ')' : upstreamText);
  } catch { detail = String(body || '').slice(0, 500); }
  const creditInfo = openRouterCreditInfo(status, body, baseURL);
  if (creditInfo) {
    const requested = creditInfo.requested ? ' The request reserved up to ' + creditInfo.requested.toLocaleString() + ' output tokens.' : '';
    return 'OpenRouter does not have enough remaining credits for this request. Its response says the current balance can cover about ' +
      creditInfo.available.toLocaleString() + ' output tokens.' + requested +
      ' This is a credit limit, not an invalid API key. Try a free model or a smaller output limit.';
  }
  const mode = protocol === 'anthropic' ? 'native Anthropic Messages API' : protocol === 'bedrock' ? 'AWS Bedrock (Claude)' : protocol === 'vertex' ? 'Google Vertex AI (Claude)' : protocol === 'foundry' ? 'Microsoft Foundry (Claude)' :
    protocol === 'openai-responses' ? 'OpenAI Responses API' : 'OpenAI-compatible chat completions';
  detail = detail.trim().replace(/\.+$/, '');
  return 'Model provider returned HTTP ' + status + (detail ? ': ' + detail : '') + '. ' + apiErrorAdvice(status, detail, mode);
}

// The closing hint fits the error: a used-up quota or a rate limit is not a
// wrong endpoint, and saying so sends people looking in the wrong place.
export function apiErrorAdvice(status, detail = '', mode = 'OpenAI-compatible chat completions') {
  const text = String(detail || '');
  if (status === 402) return 'This is a billing or quota limit, not an API-key authentication failure.';
  if (status === 429 && /per ?day|daily|PerDay/i.test(text)) {
    const wait = /retry in ([0-9hms.]+?)(?:\d*\.\d+)?s\b/i.exec(text) || /retry in ([^.\n]+)/i.exec(text);
    const when = wait ? ' (the provider says it resets in ' + wait[1].replace(/m(\d+)$/, 'm') + ')' : '';
    return 'The daily request quota for this model is used up' + when + '. Switch to another model with /model, or use a key with billing enabled.';
  }
  if (status === 429 && /per ?minute|PerMinute|per_minute/i.test(text)) {
    const tokens = /token/i.test(text);
    return 'This is a per-minute ' + (tokens ? 'token' : 'request') + ' limit, which resets within a minute; send the message again shortly.' + (tokens ? ' /compact makes each request smaller.' : '');
  }
  if (status === 429 && /quota|billing|insufficient/i.test(text)) return 'This is a quota or billing limit, not a wrong key or endpoint. Check the plan for this key, or switch models with /model.';
  if (status === 429) return 'The provider is rate-limiting requests. Wait a little and try again, or lower the request rate.';
  if (status === 401 || status === 403) return 'Check the API key for this provider (oasis setup, or the matching environment variable).';
  if (status === 404) return 'Check the model name and the ' + mode + ' endpoint URL.';
  if (isPromptTooLargeError(text)) return 'The request is larger than this model or endpoint accepts, so retrying will not help. Use /compact, or switch to a model with a larger context window with /model.';
  if (isUnconfiguredRouteError(status, text)) return 'The gateway has no working account for this model\'s provider. Connect that provider in the gateway (for OmniRoute: its dashboard), or pick another model with /model.';
  if (status >= 500) return 'The provider had a server-side problem. Try again shortly.';
  return 'Check the configured ' + mode + ' endpoint, model name, credentials, and tool-calling support.';
}

export function responseText(output) {
  if (!Array.isArray(output)) return '';
  const parts = [];
  for (const item of output) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block && block.type === 'output_text' && typeof block.text === 'string') parts.push(block.text);
      else if (block && block.type === 'refusal' && typeof block.refusal === 'string') parts.push(block.refusal);
    }
  }
  return parts.join('\n').trim();
}
