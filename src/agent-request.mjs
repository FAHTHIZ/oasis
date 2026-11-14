// The model-request pipeline: request timeouts, stream restarts, provider
// fallback and key rotation, tracing, the raw provider request (chat
// completions, Responses and Anthropic Messages), and the connection test that
// `oasis connect` runs. Moved out of agent.mjs unchanged; agent.mjs re-exports
// the public names, so existing imports keep working.
import { briefFailure } from './provider-errors.mjs';
import { sessionKeyPool, ROTATE_STATUSES } from './key-pool.mjs';
import { explainNetworkError, unreachableProviderMessage } from './network-doctor.mjs';
import { proxyForUrl } from './proxy.mjs';
import { appendEvent } from './event-stream.mjs';
import { providerFetch } from './loopback-fetch.mjs';
import { redactSecretText } from './secret-shield.mjs';
import { priceFor, estimateCostUsd, recordBudgetSpend } from './pricing.mjs';
import { hasImages, toChatMessagesWithImages, imagesUnsupportedError, withoutImages } from './images.mjs';
import { resolveModelAlias, isModelAlias, applyModelOverride, fastModeRequest } from './model-aliases.mjs';
import { readProviderStream, uniqueToolCallIds } from './provider-stream.mjs';
import { openAIEndpoint, responsesEndpoint, anthropicEndpoint, toResponsesRequest, toAnthropicRequest, chatCompletionTool } from './provider-requests.mjs';
import { debugLog, debugEnabled } from './debug-log.mjs';
import { TOOL_DEFINITIONS } from './tools.mjs';
import { recordContextAnchor } from './context.mjs';
import { validateProtocol, validateBaseUrl } from './config.mjs';
import { GENAI_TOKEN_BUCKETS, genAiErrorType, genAiProviderName, genAiServer, genAiSpanNames, getTelemetry } from './telemetry.mjs';
import { isAnthropicFamily, cloudEndpoint, cloudBody, cloudHeaders, cloudStreams } from './cloud-providers.mjs';
import { assertZeroBudgetRoute, chargeRequestAttempt, recordTokenUsage } from './cost-policy.mjs';
import { quotaRoute, assertRouteAvailable, recordSuccess as recordQuotaSuccess, recordFailure as recordQuotaFailure, recordTokens as recordQuotaTokens } from './quota-ledger.mjs';
import { parseFallbackChain, remainingFallbacks, fallbackReason, FALLBACK_REASON_TEXT } from './fallback-chain.mjs';
import { runWithProviderBreaker, providerBreakerKey, isBreakerOpenError } from './circuit-breaker.mjs';
import { promptToolCalling, toPromptToolMessages, foldSystemMessages, withSystemInUserTurn } from './prompt-tools.mjs';
import { MAX_PROVIDER_RETRIES, QUICK_PROVIDER_RETRIES, RETRYABLE_PROVIDER_STATUSES, serverRetryAdvice, isHardQuotaError, isMalformedGenerationError, isUnconfiguredRouteError, isPromptTooLargeError, notifyProviderRetry, providerErrorSummary, providerRetryDelayMs, providerRetryLimit, rateLimitResetMs, rateLimitWaitMs, shortRateLimitMs, waitForProviderRetry } from './provider-retry.mjs';
import { parallelToolCalls, promptCacheKeyField, samplingTemperature } from './turn-guards.mjs';
import { postModelSwitch } from './model-switch.mjs';
import { claudeEffortFor, claudeThinkingMode, firstPositiveConfiguredInteger, isOpenRouterBaseURL, maxOutputTokensFor, openRouterOutputCapFromError, outputCapFromError } from './model-budgets.mjs';
import { applyAnthropicCacheBreakpoints, promptCachingEnabled, withProviderExtraContent } from './provider-request.mjs';
import { formatApiError, gatewayBudgetNotice, responseText, redactProviderDetail } from './api-error.mjs';
import { normalizeUsage, usageOrEstimate } from './usage-estimate.mjs';
import { isInputTokenRateLimit, useCompactToolProfile } from './context-window.mjs';
import { wireToolCallIds, toolCallIdStyle } from './tool-call-ids.mjs';

export function withResolvedModel(config, env, planMode, overrides) {
  if (!config) return config;
  const resolved = isModelAlias(config.model) ? { ...config, model: resolveModelAlias(config.model, { protocol: config.protocol, env, planMode }) } : config;
  // Claude Code's modelOverrides: send the provider-specific id (a Bedrock ARN, a gateway name).
  const mapped = overrides ? applyModelOverride(resolved.model, overrides, { env, protocol: config.protocol }) : resolved.model;
  return mapped === resolved.model ? resolved : { ...resolved, model: mapped };
}

// Provider said the request does not fit the context window (estimates drift:
// images, tool schemas, tokenizer differences). Compact and retry instead of dying.
export function isContextOverflowError(error) {
  if (!error || error.name === 'AbortError') return false;
  const status = Number(error.status || error.statusCode);
  const text = String(error.message || '');
  if (/max_tokens|max_output|output tokens/i.test(text) && !/prompt|input|context/i.test(text)) return false;
  return status === 413 || isPromptTooLargeError(text) || /prompt (?:is )?too long|context.?length.?exceeded|maximum context length|context window|input is too long|too many (?:input )?tokens|request (?:entity )?too large|reduce the length of the (?:messages|input|prompt)|input length .*exceed|exceeds? the (?:model'?s )?(?:maximum |available )?context|available context size/i.test(text);
}

export function stopFailureType(error) {
  const status = Number(error && (error.status || error.statusCode));
  const text = String(error && error.message || '').toLowerCase();
  if (status === 402 || isHardQuotaError(text)) return 'billing_error';
  if (status === 429 || /rate.?limit/.test(text)) return 'rate_limit';
  if (status === 529 || /overloaded/.test(text)) return 'overloaded';
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication/.test(text)) return 'authentication_failed';
  if (status === 404 || /model.*not.?found|unknown model/.test(text)) return 'model_not_found';
  if (isContextOverflowError(error)) return 'context_overflow';
  if (/max.?(output|tokens)/.test(text)) return 'max_output_tokens';
  if (status === 400) return 'invalid_request';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

export function chargeAuxiliaryUsage(session, usage, { env = process.env, model } = {}) {
  if (!session || !usage) return 0;
  const config = session.config || {};
  const priced = resolveModelAlias(model || config.model, { protocol: config.protocol, env });
  const pricing = { config, overrides: session.pricing || {}, env };
  const cost = estimateCostUsd(priced, session.lastRequestSpeed === 'fast' && !usage.speed ? { ...usage, speed: 'fast' } : usage, pricing);
  recordTokenUsage(session, usage);
  try { recordBudgetSpend(session, cost, { costKnown: priceFor(priced, pricing) !== null, enforce: false }); } catch { return cost; }
  return cost;
}

const LOCAL_FIRST_TOKEN_TIMEOUT_MS = 900000;

// How long to wait for response headers. Defaults: 120 s for streamed cloud
// requests, 600 s otherwise, 900 s for providers on localhost (a laptop can
// spend minutes reading a long prompt). Defaults never exceed 15 minutes; an
// explicit OASIS_REQUEST_TIMEOUT_SECONDS is honored up to 2 hours.
export function requestTimeoutMs({ timeoutMs = 0, configuredSeconds = 0, local = false, streaming = false } = {}) {
  const explicit = Number(timeoutMs) || 0;
  const configured = (Number(configuredSeconds) || 0) * 1000;
  const fallback = local ? LOCAL_FIRST_TOKEN_TIMEOUT_MS : streaming ? 120000 : 600000;
  const cap = !explicit && configured ? 7200000 : 900000;
  return Math.min(cap, Math.max(1000, explicit || configured || fallback));
}


// True when the provider runs on this machine (llama.cpp, Ollama, LM Studio, vLLM on localhost).
export function isLoopbackProvider(config = {}) {
  try {
    const host = new URL(String(config && config.baseURL || '')).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0' || host.endsWith('.localhost');
  } catch { return false; }
}

// A fallback caused by a transient overload shouldn't stick for the rest of the
// session: once the cooldown has passed, the next turn goes back to the model
// the user chose. A model the user picked since (/model) is left alone.
export function fallbackCooldownMs(env = process.env) {
  const minutes = Number.parseFloat(env.OASIS_FALLBACK_COOLDOWN_MINUTES);
  return Number.isFinite(minutes) && minutes >= 0 ? Math.min(minutes, 24 * 60) * 60000 : 5 * 60000;
}

export function restorePrimaryModel(session, env = process.env, now = Date.now()) {
  const active = session && session.fallbackActive;
  if (!active || !session.config) return false;
  if (session.config.model !== active.to) { session.fallbackActive = null; return false; }
  if (now - (Number(active.at) || 0) < fallbackCooldownMs(env)) return false;
  const fallbackModel = session.config.model;
  session.config = active.fromConfig ? { ...active.fromConfig } : { ...session.config, model: active.from };
  postModelSwitch(session, { from: fallbackModel, to: session.config.model, requested: null, source: 'auto', env });
  session.fallbackActive = null;
  (session.hookMessages ||= []).push('[fallback] back to ' + active.from + ' after the cooldown; ' + active.to + ' will be used again only if it fails.');
  return true;
}


// --prompt-suggestions: one short guess at the user's next message, from the recent conversation.
export async function suggestNextPrompt(session, options = {}) {
  const tail = session.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).slice(-6)
    .map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content.slice(0, 2000)).join('\n\n');
  if (!tail) return '';
  try {
    const completion = await requestCompletion({ budgetParent: session, config: session.config, toolDefinitions: [], messages: [
      { role: 'system', content: 'Predict the single most likely next message the user will type to this coding agent. Reply with only that message: under 15 words, imperative, no quotes. Reply with nothing if there is no clear next step.' },
      { role: 'user', content: '--- BEGIN UNTRUSTED TRANSCRIPT ---\n' + tail + '\n--- END UNTRUSTED TRANSCRIPT ---' }
    ] }, { noTools: true, signal: options.signal });
    chargeAuxiliaryUsage(session, completion.usage, { env: options.env });
    return String(completion.content || '').trim().replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 200);
  } catch { return ''; }
}

// A response that dies mid-stream never yields tool calls (they're only returned
// once the stream completes), so retrying the same request can't run anything twice.
// Codex retries a dropped stream 5 times (stream_max_retries); two was too
// few for a flaky network or a provider that resets long streams. The
// backoff between restarts grows (0.25 s to 10 s), and
// OASIS_STREAM_MAX_RETRIES (0-20) overrides the count.
const DEFAULT_STREAM_RESTARTS = 5;
const MAX_STALL_RESTARTS = 2;
export function streamRestartLimit(env = process.env) {
  const raw = (env || process.env).OASIS_STREAM_MAX_RETRIES;
  const wanted = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isInteger(wanted) && wanted >= 0 ? Math.min(wanted, 20) : DEFAULT_STREAM_RESTARTS;
}
// Gemini's MALFORMED_FUNCTION_CALL: its own tool call did not parse.
export const MAX_MALFORMED_CALL_RECOVERIES = 3;
export const MALFORMED_CALL_NUDGE = '<system-reminder>\nYour last tool call could not be parsed (the provider rejected it as a malformed function call), so nothing ran. Call the tool again with valid JSON arguments. If it carried a long file body, split the work: write a short file first, then add to it with edit_file.\n</system-reminder>';

export function defaultStreamIdleMs(effort) {
  return /^(?:high|xhigh|max)$/i.test(String(effort || '')) ? 600000 : 300000;
}

// Records a retry or recovery on the active trace (model request or turn span),
// so a trace shows why a step took several attempts. No-op without telemetry.
export function traceRecovery(env, kind, details = {}) {
  const tel = getTelemetry(env || process.env);
  if (!tel) return;
  const attrs = { kind };
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null || value === '') continue;
    attrs[key] = key === 'reason' ? redactSecretText(String(value)).slice(0, 300) : value;
  }
  try {
    tel.add('oasis.recovery.count', 1, { kind }, '1', 'Retries and recoveries during model requests and turns');
    tel.event('oasis.recovery', attrs);
  } catch {}
}

async function requestCompletionWithStreamRestarts(session, options = {}) {
  for (let restart = 0; ; restart++) {
    try {
      const reply = await requestCompletionTraced(session, options);
      // PreModelSwitch reports what re-sending this conversation would cost.
      if (reply && reply.usage) session.lastMainUsage = { inputTokens: Number(reply.usage.inputTokens) || 0, outputTokens: Number(reply.usage.outputTokens) || 0, at: Date.now() };
      return reply;
    } catch (error) {
      // A provider that reported overload mid-stream gets one more, slower try.
      const overloaded = Number(error && error.status) >= 500;
      // A stall already cost a full idle window (300 s or more), so it gets
      // at most two restarts; a dropped connection fails fast and gets them all.
      const allowed = streamRestartLimit(options.env || session.providerEnv || process.env);
      const limit = (error && error.stalled ? Math.min(allowed, MAX_STALL_RESTARTS) : allowed) + (overloaded ? 1 : 0);
      // A malformed tool call tends to repeat on the identical request, so the
      // turn loop retries it with a corrective note instead (see below).
      if (!error || error.code !== 'OASIS_STREAM_INTERRUPTED' || error.malformedCall || restart >= limit || (options.signal && options.signal.aborted)) throw error;
      traceRecovery(options.env || session.providerEnv, 'stream_restart', { attempt: restart + 1, limit: limit, status: Number(error.status) || undefined, reason: error.message });
      if (typeof options.onStreamRestart === 'function') options.onStreamRestart({ attempt: restart + 1, limit: limit, reason: error.message, ...(error.status ? { status: Number(error.status) } : {}) });
      await waitForProviderRetry(providerRetryDelayMs(restart + (overloaded ? 3 : 1)), options.signal || new AbortController().signal);
    }
  }
}

// Fallback reasons that say the provider itself is unhealthy. A missing model
// is specific to that model, so it does not open the provider's breaker.
const PROVIDER_FAULTS = new Set(['server', 'rate', 'credits', 'auth']);

export async function requestCompletion(session, options = {}) {
  const chain = parseFallbackChain(session && session.fallbackModel);
  if (!chain.length || !session.config) return requestCompletionWithStreamRestarts(session, options);
  const env = options.env || session.providerEnv || process.env;
  const failed = new Set();
  const attempts = [];
  for (;;) {
    const attempted = session.config;
    try {
      // Failures that point at the provider (not the request) count against its
      // breaker; once it opens, calls fail at once and the chain moves on.
      return await runWithProviderBreaker(providerBreakerKey(attempted), () => requestCompletionWithStreamRestarts(session, options), {
        env,
        signal: options.signal,
        shouldTrip: (error) => !(options.signal && options.signal.aborted) && !(error && error.code === 'OASIS_QUOTA_COOLDOWN') && PROVIDER_FAULTS.has(fallbackReason(error, { onFallbackProvider: Boolean(attempted && attempted.fallbackProvider) }))
      });
    } catch (error) {
      if (options.signal && options.signal.aborted) throw error;
      const current = session.config;
      const kind = fallbackReason(error, { onFallbackProvider: Boolean(current.fallbackProvider) });
      if (!kind) throw summarizeFallbackFailure(error, attempts);
      failed.add((current.fallbackProvider ? current.fallbackProvider + ':' : '') + current.model);
      attempts.push({ model: (current.fallbackProvider ? current.fallbackProvider + ':' : '') + current.model, reason: shortProviderReason(error), kind });
      const active = session.fallbackActive;
      const fromConfig = active && active.fromConfig ? active.fromConfig : current;
      const next = remainingFallbacks(chain, { current, baseConfig: fromConfig, failed, env })[0];
      if (!next) throw summarizeFallbackFailure(error, attempts);
      const reason = String(error && error.message || error);
      session.config = next.config;
      session.fallbackActive = { from: active ? active.from : current.model, to: next.config.model, fromConfig, kind, provider: next.entry.provider || '', reason: reason.slice(0, 200), at: Date.now() };
      (session.hookMessages ||= []).push('[fallback] ' + current.model + ' ' + (FALLBACK_REASON_TEXT[kind] || 'failed') + ' (' + reason.slice(0, 120) + '); switched to ' + (next.entry.provider ? next.entry.provider + ':' : '') + next.config.model + '.');
      // Claude Code reports automatic fallbacks to PostModelSwitch with source "auto" and no requested model.
      postModelSwitch(session, { from: current.model, to: next.config.model, requested: null, source: 'auto', env });
      recordSessionEvent(session, { type: 'recovery', action: 'model_fallback', from: (current.fallbackProvider ? current.fallbackProvider + ':' : '') + current.model, to: (next.entry.provider ? next.entry.provider + ':' : '') + next.config.model, kind, reason: reason.slice(0, 200) }, env);
      if (typeof options.onFallback === 'function') options.onFallback(session.fallbackActive);
    }
  }
}

// One line per failed model, e.g. "daily free-tier quota used up (retry in 21h11m)".
export function shortProviderReason(error) {
  if (error && error.code === 'OASIS_ZERO_BUDGET_BLOCKED') return 'refused by zero-budget mode, not sent (cost ' + error.cost + ')';
  if (isBreakerOpenError(error)) return 'skipped: it failed repeatedly just now (circuit breaker open' + (error.retryInSeconds > 0 ? ', next try in ' + error.retryInSeconds + 's' : '') + ')';
  return briefFailure(error && error.message || error, error && (error.status || error.statusCode));
}

// When the whole chain fails, say what happened to every model, not just the
// last backup (which is often a retired model and hides the real cause).
export function summarizeFallbackFailure(error, attempts) {
  if (!attempts.length || !error || typeof error !== 'object') return error;
  const lastModel = attempts[attempts.length - 1].model;
  const lines = attempts.map((attempt) => '  ' + attempt.model + ': ' + attempt.reason);
  const allQuota = attempts.every((attempt) => /quota|rate limit/.test(attempt.reason));
  const allPaid = attempts.every((attempt) => attempt.kind === 'paid');
  const hint = allPaid ? '\nZero-budget mode found no model proven free, so nothing was sent. Add a local model or an OpenRouter :free model to fallbackModel, or declare a route free with OASIS_FREE_MODELS.' : allQuota ? '\nEvery model is out of quota. Wait for the limit to reset, add billing, or connect another key with `oasis connect`.' : '\nRun `oasis connect` to pick models that work, or set fallbackModel in config.';
  try {
    error.message = 'All ' + attempts.length + ' models in the fallback chain failed:\n' + lines.join('\n') + hint + '\nLast error (' + lastModel + '): ' + error.message;
  } catch {}
  error.fallbackAttempts = attempts;
  return error;
}

async function requestCompletionTraced(session, options = {}) {
  const sent = Array.isArray(session.messages) ? session.messages : [];
  const sentLength = sent.length;
  const sentLast = sent[sentLength - 1];
  const reply = await requestCompletionTracedAuth(session, options);
  recordContextAnchor(session, reply && reply.usage, sentLength, sentLast);
  return reply;
}

async function requestCompletionTracedAuth(session, options = {}) {
  if (!session.config || !session.config.apiKeyHelper || options.refreshApiKey) return requestCompletionTracedOnce(session, options);
  try { return await requestCompletionTracedOnce(session, options); } catch (error) {
    if (stopFailureType(error) !== 'authentication_failed') throw error;
    return requestCompletionTracedOnce(session, { ...options, refreshApiKey: true });
  }
}

async function requestCompletionTracedOnce(session, options = {}) {
  if (debugEnabled('api')) {
    const started = Date.now();
    debugLog('api', 'request ' + ((session.config && session.config.protocol) || '') + ' model=' + ((session.config && session.config.model) || '') + ' messages=' + session.messages.length + ' tools=' + ((session.toolDefinitions || []).length));
    try {
      const reply = await requestCompletionTracedInner(session, options);
      const usage = reply.usage || {};
      debugLog('api', 'response in ' + (Date.now() - started) + 'ms input=' + (usage.inputTokens || 0) + ' output=' + (usage.outputTokens || 0) + ' cacheRead=' + (usage.cacheReadTokens || 0) + ' toolCalls=' + (reply.tool_calls || []).length);
      return reply;
    } catch (error) {
      debugLog('api', 'error after ' + (Date.now() - started) + 'ms' + (error && error.status ? ' status=' + error.status : '') + ': ' + String(error && error.message || error).slice(0, 800));
      throw error;
    }
  }
  return requestCompletionTracedInner(session, options);
}

async function requestCompletionTracedInner(session, options = {}) {
  const tel = getTelemetry(options.env || session.providerEnv || process.env);
  if (!tel) return requestCompletionRaw(session, options);
  const model = session.config && session.config.model || '';
  const attrs = { model, provider: session.config && session.config.protocol || '', ...(session.sessionId ? { 'session.id': session.sessionId } : {}) };
  const server = genAiServer(session.config);
  const genAi = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': genAiProviderName(session.config), 'gen_ai.request.model': model, ...server, ...(session.sessionId ? { 'gen_ai.conversation.id': session.sessionId } : {}), ...(typeof options.onDelta === 'function' ? { 'gen_ai.request.stream': true } : {}), ...(session.reasoningEffort ? { 'gen_ai.request.reasoning.level': String(session.reasoningEffort) } : {}) };
  // Attributes for the gen_ai.client.inference.* metrics (no session id).
  const metricAttrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': genAi['gen_ai.provider.name'], 'gen_ai.request.model': model, ...server };
  const recordInference = (seconds, usage, extra = {}) => {
    const all = { ...metricAttrs, ...extra };
    tel.genAiRecord('gen_ai.client.inference.duration', seconds, all, 's', undefined, 'GenAI inference duration');
    tel.genAiRecord('gen_ai.client.inference.operation.input_tokens', usage.inputTokens || 0, all, '{token}', GENAI_TOKEN_BUCKETS, 'Input tokens per inference');
    tel.genAiRecord('gen_ai.client.inference.operation.output_tokens', usage.outputTokens || 0, all, '{token}', GENAI_TOKEN_BUCKETS, 'Output tokens per inference');
    // Providers do not split OASIS's counts by modality, so they are "unknown".
    const counted = { ...all, 'gen_ai.token.modality': 'unknown' };
    tel.genAiCount('gen_ai.client.inference.usage.input_tokens', usage.inputTokens, counted, 'Input tokens, including cached tokens');
    tel.genAiCount('gen_ai.client.inference.usage.output_tokens', usage.outputTokens, counted, 'Output tokens, including reasoning tokens');
    tel.genAiCount('gen_ai.client.inference.usage.cache_read.input_tokens', usage.cacheReadTokens, counted, 'Input tokens served from a provider cache');
    tel.genAiCount('gen_ai.client.inference.usage.cache_write.input_tokens', usage.cacheCreationTokens, counted, 'Input tokens written to a provider cache');
    tel.genAiCount('gen_ai.client.inference.usage.reasoning.output_tokens', usage.reasoningTokens, all, 'Output tokens used for reasoning');
  };
  const spanName = genAiSpanNames(tel.env) ? ('chat ' + (model || '')).trim() : 'oasis.llm_request';
  return tel.span(spanName, { ...attrs, ...genAi }, async (span) => {
    const started = Date.now();
    try {
      const reply = await requestCompletionRaw(session, options);
      const usage = reply.usage || {};
      const duration = Date.now() - started;
      Object.assign(span.attrs, {
        'gen_ai.usage.input_tokens': usage.inputTokens || 0,
        'gen_ai.usage.output_tokens': usage.outputTokens || 0,
        ...(usage.cacheReadTokens ? { 'gen_ai.usage.cache_read.input_tokens': usage.cacheReadTokens } : {}),
        // cache_write is the current name; cache_creation is kept for existing dashboards.
        ...(usage.cacheCreationTokens ? { 'gen_ai.usage.cache_write.input_tokens': usage.cacheCreationTokens, 'gen_ai.usage.cache_creation.input_tokens': usage.cacheCreationTokens } : {}),
        ...(usage.reasoningTokens ? { 'gen_ai.usage.reasoning.output_tokens': usage.reasoningTokens } : {}),
        // string[] per the conventions: one reason per returned choice (OASIS asks for one).
        'gen_ai.response.finish_reasons': [reply.truncated ? 'length' : Array.isArray(reply.tool_calls) && reply.tool_calls.length ? 'tool_calls' : 'stop']
      });
      recordInference(duration / 1000, usage);
      tel.record('oasis.api.duration', duration, attrs, 'ms', 'Model request latency');
      tel.add('oasis.token.usage', usage.inputTokens || 0, { ...attrs, type: 'input' }, 'tokens', 'Tokens used');
      tel.add('oasis.token.usage', usage.outputTokens || 0, { ...attrs, type: 'output' }, 'tokens', 'Tokens used');
      tel.add('oasis.token.usage', usage.cacheReadTokens || 0, { ...attrs, type: 'cacheRead' }, 'tokens', 'Tokens used');
      tel.add('oasis.token.usage', usage.cacheCreationTokens || 0, { ...attrs, type: 'cacheCreation' }, 'tokens', 'Tokens used');
      Object.assign(span.attrs, { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, tool_calls: (reply.tool_calls || []).length });
      tel.event('oasis.api_request', { ...attrs, duration_ms: duration, input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, cache_read_tokens: usage.cacheReadTokens || 0 });
      return reply;
    } catch (error) {
      tel.add('oasis.api.error.count', 1, attrs, '1', 'Failed model requests');
      tel.event('oasis.api_error', { ...attrs, duration_ms: Date.now() - started, error: String(error && error.message || error).slice(0, 500) });
      span.attrs['error.type'] = genAiErrorType(error);
      recordInference((Date.now() - started) / 1000, {}, { 'error.type': span.attrs['error.type'] });
      throw error;
    }
  }, { kind: 3 });
}

// Records the reply's tokens against the provider, key and model that served
// it (src/quota-ledger.mjs). Internal re-sends share one record.
async function requestCompletionRaw(session, options = {}) {
  try {
    return await requestCompletionRawQuota(session, options);
  } catch (error) {
    // Stream error events and transport errors can quote the request or its
    // Authorization header; redact before the message reaches any output.
    if (error && typeof error.message === 'string') {
      const clean = redactProviderDetail(error.message, [session.config && session.config.apiKey]);
      if (clean !== error.message) try { error.message = clean; } catch { /* frozen error */ }
    }
    throw error;
  }
}

async function requestCompletionRawQuota(session, options = {}) {
  if (options.quotaState) return requestCompletionRawInner(session, options);
  const quotaState = { route: null };
  const reply = await requestCompletionRawInner(session, { ...options, quotaState });
  if (quotaState.route && reply && reply.usage) recordQuotaTokens(quotaState.route, reply.usage, { env: options.env || session.providerEnv || process.env });
  return reply;
}

async function requestCompletionRawInner(session, options = {}) {
  const config = withResolvedModel(session.config, options.env || session.providerEnv || session.modelEnv || process.env, Boolean(session.permissions && session.permissions.mode === 'plan'), session.settings && session.settings.modelOverrides);
  const textOnly = Boolean(session.textOnlyModels && session.textOnlyModels.has(String(config.model || '')));
  const sentMessages = wireToolCallIds(textOnly && hasImages(session.messages) ? withoutImages(session.messages, config.model) : session.messages, { style: toolCallIdStyle(config) });
  const nativeAnthropic = isAnthropicFamily(config.protocol);
  const cloudAnthropic = config.protocol === 'bedrock' || config.protocol === 'vertex' || config.protocol === 'foundry';
  const providerEnv = options.env || session.providerEnv || process.env;
  // Side requests (summaries, titles, /btw) run on a bare session object and
  // charge their parent's budget.
  const budgetOwner = session.budgetParent || session;
  // Zero-budget mode refuses a route not proven free before anything is sent;
  // the fallback chain then moves to the next entry.
  assertZeroBudgetRoute(budgetOwner, config, providerEnv);
  const nativeResponses = config.protocol === 'openai-responses';
  // schedule_wakeup only exists while a self-paced /loop is running.
  // Tools that can only answer "not available" right now are not sent: no
  // one to ask in a headless run, and exit_plan_mode is a no-op outside plan
  // mode. Calls still work if the model names them anyway.
  const availableTools = options.noTools ? [] : (session.toolDefinitions || TOOL_DEFINITIONS).filter((tool) => (tool.function.name !== 'schedule_wakeup' || Boolean(session.selfPacedLoop)) && (tool.function.name !== 'wait_for_mcp_servers' || Boolean(session.mcpNonBlocking)) && (tool.function.name !== 'ask_user_question' || session.turnCanAskUser !== false) && (tool.function.name !== 'exit_plan_mode' || Boolean(session.permissions && session.permissions.mode === 'plan')));
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  let apiKey = config.apiKey;
  if (!apiKey && config.apiKeyHelper) {
    const { apiKeyFromHelper } = await import('./api-key-helper.mjs');
    apiKey = await apiKeyFromHelper(config.apiKeyHelper, { env: providerEnv, cwd: session.root, refresh: Boolean(options.refreshApiKey) });
  }
  // OASIS_API_KEY_POOL / OASIS_API_KEY_POOL_FILE: rotate across keys on 429/401/402/403.
  const keyPool = !cloudAnthropic && !config.apiKeyHelper && !config.fallbackProvider && (providerEnv.OASIS_API_KEY_POOL || providerEnv.OASIS_API_KEY_POOL_FILE) ? sessionKeyPool(session, providerEnv, apiKey) : null;
  if (keyPool) apiKey = keyPool.current() || apiKey;
  // A route the provider said is out of quota is skipped without a request
  // (a guessed cooldown only when there is a fallback to move to).
  let route = quotaRoute(config, apiKey);
  if (!keyPool) assertRouteAvailable(route, { env: providerEnv, hasFallback: parseFallbackChain(session && session.fallbackModel).length > 0 });
  let fastRequest = null;
  session.lastRequestSpeed = '';
  if (nativeAnthropic) {
    if (apiKey && !cloudAnthropic) headers['x-api-key'] = apiKey;
    if (!cloudAnthropic) headers['anthropic-version'] = '2023-06-01';
    // --betas / ANTHROPIC_BETAS: extra beta headers (API key users, as in Claude Code).
    const betas = [...(Array.isArray(config.betas) ? config.betas : []), ...String(providerEnv.ANTHROPIC_BETAS || '').split(',')].map((item) => String(item).trim()).filter(Boolean);
    // /fast: only the first-party API supports it; other models ignore the toggle.
    fastRequest = session.fastMode && !cloudAnthropic && !/^(1|true)$/i.test(String(providerEnv.CLAUDE_CODE_DISABLE_FAST_MODE || '')) ? fastModeRequest(config.model) : null;
    if (fastRequest && fastRequest.beta) betas.push(fastRequest.beta);
    // Cost tracking reads this to bill the response at the fast-mode rate.
    session.lastRequestSpeed = fastRequest ? 'fast' : '';
    if (betas.length && !cloudAnthropic) headers['anthropic-beta'] = [...new Set(betas)].join(',');
  } else if (apiKey) {
    headers.authorization = 'Bearer ' + apiKey;
  }

  // Gateway headers (ANTHROPIC_CUSTOM_HEADERS, customHeaders, customHeadersHelper). They never replace
  // the body headers, and only fill authorization / x-api-key when OASIS did not set a key itself.
  if (config.customHeaders || config.customHeadersHelper || providerEnv.ANTHROPIC_CUSTOM_HEADERS || providerEnv.OASIS_CUSTOM_HEADERS || providerEnv.OASIS_CUSTOM_HEADERS_HELPER) {
    const { customHeadersFor } = await import('./api-key-helper.mjs');
    const extra = await customHeadersFor(config, { env: providerEnv, cwd: session.root, refresh: Boolean(options.refreshApiKey) });
    for (const [name, value] of Object.entries(extra)) {
      if (name === 'accept' || name === 'anthropic-version') continue;
      if ((name === 'authorization' || name === 'x-api-key') && (headers.authorization || headers['x-api-key'])) continue;
      headers[name] = value;
    }
  }

  let endpoint;
  let bodyObject;
  let outputLimit = 0;
  if (nativeAnthropic) {
    endpoint = cloudAnthropic ? cloudEndpoint(config, providerEnv, typeof options.onDelta === 'function' && cloudStreams(config.protocol)) : anthropicEndpoint(config.baseURL);
    const thinkingMode = claudeThinkingMode(config.model);
    // Models that can turn adaptive thinking off do so when the session has thinking off
    // (alwaysThinkingEnabled: false, MAX_THINKING_TOKENS=0); always-thinking models ignore it.
    const adaptive = thinkingMode === 'adaptive-only' || (thinkingMode === 'adaptive' && !session.thinkingOff);
    // Adaptive models return signed thinking blocks on their own; they must be replayed in tool loops.
    const converted = toAnthropicRequest(sentMessages, { thinking: adaptive || (Boolean(session.thinkingBudget) && !options.forceTool) });
    const cache = promptCachingEnabled(config, options.env || process.env);
    const anthropicTools = availableTools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters
    }));
    if (cache) applyAnthropicCacheBreakpoints(converted, anthropicTools);
    const cappedThinking = options.forceTool ? 0 : Math.min(Number(session.thinkingBudget || 0), session.outputTokenCap ? Math.max(0, session.outputTokenCap - 2048) : Infinity);
    const thinkingBudget = cappedThinking >= 1024 ? cappedThinking : 0;
    outputLimit = session.outputTokenCap || maxOutputTokensFor(config, providerEnv);
    let effort = adaptive && !options.forceTool ? claudeEffortFor(config.model, { level: session.effortLevel, budget: thinkingBudget }) : '';
    // With thinking off, an adaptive model still takes effort, capped at high (higher levels need thinking).
    if (thinkingMode === 'adaptive' && session.thinkingOff && !options.forceTool) {
      effort = claudeEffortFor(config.model, { level: session.effortLevel, budget: 0 });
      if (effort === 'xhigh' || effort === 'max') effort = 'high';
    }
    let thinkingFields = {};
    // Opus 4.7+ and Claude 5 return empty thinking blocks unless asked for the
    // summary; it is what the page shows while the model reasons.
    const thinkingDisplay = /^(omitted|off|0)$/i.test(String(providerEnv.OASIS_THINKING_DISPLAY || '')) ? {} : { display: 'summarized' };
    if (!adaptive && thinkingBudget) thinkingFields = { thinking: { type: 'enabled', budget_tokens: thinkingBudget, ...thinkingDisplay } };
    else if (thinkingMode === 'adaptive' && session.thinkingOff && effort) thinkingFields = { output_config: { effort } };
    else if (adaptive && (thinkingBudget || effort)) thinkingFields = { thinking: { type: 'adaptive', ...thinkingDisplay }, ...(effort ? { output_config: { effort } } : {}) };
    // Claude 4.7+ rejects forced tool_choice (thinking is on); the probe prompt asks for the call instead.
    const forcedChoice = options.forceTool && thinkingMode !== 'adaptive-only' ? { type: 'tool', name: options.forceTool } : { type: 'auto' };
    bodyObject = {
      model: config.model,
      max_tokens: session.outputTokenCap ? outputLimit : outputLimit + thinkingBudget,
      ...thinkingFields,
      ...(typeof options.onDelta === 'function' ? { stream: true } : {}),
      system: converted.system,
      messages: converted.messages,
      ...(availableTools.length ? { tools: anthropicTools, tool_choice: forcedChoice } : {}),
      ...(fastRequest ? { speed: 'fast' } : {})
    };
    if (cloudAnthropic) bodyObject = cloudBody(config.protocol, bodyObject);
  } else if (nativeResponses) {
    endpoint = responsesEndpoint(config.baseURL);
    const converted = toResponsesRequest(sentMessages);
    bodyObject = {
      model: config.model,
      instructions: converted.instructions,
      input: converted.input,
      ...(availableTools.length ? { tools: availableTools.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: false
      })), tool_choice: options.forceTool ? { type: 'function', name: options.forceTool } : 'auto' } : {}),
      parallel_tool_calls: parallelToolCalls(config, providerEnv),
      max_output_tokens: (outputLimit = session.outputTokenCap || maxOutputTokensFor(config, providerEnv)),
      ...(() => {
        // Reasoning models stream a readable summary only when asked for it.
        const summary = !options.forceTool && session.reasoningEffort !== 'none' && !/^(off|0|none)$/i.test(String(providerEnv.OASIS_REASONING_SUMMARY || ''))
          && (session.reasoningEffort || /^(?:[\w.-]+\/)?(?:o\d|gpt-[5-9]|codex)/i.test(String(config.model || '')));
        const effort = session.reasoningEffort && !options.forceTool ? { effort: session.reasoningEffort } : {};
        return summary || effort.effort ? { reasoning: { ...effort, ...(summary ? { summary: 'auto' } : {}) } } : {};
      })(),
      ...(typeof options.onDelta === 'function' ? { stream: true } : {}),
      // The runtime owns state and replays response items locally, including reasoning items.
      store: false,
      ...promptCacheKeyField(session, config, providerEnv)
    };
  } else {
    endpoint = openAIEndpoint(config.baseURL);
    // Compatible gateways differ on max_tokens support. OpenRouter needs an
    // explicit ceiling; otherwise it may reserve the model's entire output window.
    const configuredChatLimit = session.outputTokenCap || firstPositiveConfiguredInteger(providerEnv.OASIS_MAX_OUTPUT_TOKENS, providerEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS, config.maxOutputTokens);
    const explicitChatLimit = configuredChatLimit || (isOpenRouterBaseURL(config.baseURL) ? 4096 : 0);
    if (explicitChatLimit) outputLimit = explicitChatLimit;
    // Endpoints that drop `tools` get them described in the prompt instead (see prompt-tools.mjs).
    const promptTools = availableTools.length > 0 && promptToolCalling(config, providerEnv);
    const chatMessages = withProviderExtraContent(hasImages(sentMessages) ? toChatMessagesWithImages(sentMessages) : sentMessages, config.baseURL, config.model);
    bodyObject = {
      model: config.model,
      ...(explicitChatLimit ? { max_tokens: explicitChatLimit } : {}),
      ...samplingTemperature(config, providerEnv),
      messages: (() => {
        const shaped = promptTools ? toPromptToolMessages(chatMessages, availableTools.map(chatCompletionTool), { forceTool: options.forceTool || '' }) : chatMessages;
        return foldSystemMessages(config, providerEnv) ? withSystemInUserTurn(shaped) : shaped;
      })(),
      ...(session.reasoningEffort && !options.forceTool ? { reasoning_effort: session.reasoningEffort } : {}),
      ...(availableTools.length && !promptTools ? { tools: availableTools.map(chatCompletionTool), tool_choice: options.forceTool ? { type: 'function', function: { name: options.forceTool } } : 'auto', parallel_tool_calls: parallelToolCalls(config, providerEnv) } : {}),
      ...(typeof options.onDelta === 'function' ? { stream: true } : {}),
      // Chat Completions accepts prompt_cache_key too (same rules as Responses:
      // api.openai.com by default, OASIS_PROMPT_CACHE_KEY=1 for other gateways).
      ...promptCacheKeyField(session, config, providerEnv),
      // Without include_usage, OpenAI-compatible streams report no token counts,
      // so cost, /cost and --max-budget-usd silently read zero.
      ...(typeof options.onDelta === 'function' && !session.streamUsageUnsupported && providerEnv.OASIS_STREAM_USAGE !== '0' ? { stream_options: { include_usage: true } } : {}),
      // llama-server can report how far it has read a long prompt; only asked of a server identified as llama.cpp.
      ...(typeof options.onDelta === 'function' && typeof options.onPromptProgress === 'function' && session.localContext && session.localContext.server === 'llama.cpp' ? { return_progress: true } : {})
    };
  }

  const controller = new AbortController();
  // A local model on a laptop can spend minutes reading a long prompt before the
  // first byte, so loopback providers get the longest wait by default.
  // timeoutMs bounds the wait for response headers. Once a stream starts, an
  // idle watchdog (reset on every chunk) replaces it, so long generations are
  // never cut off while tokens are still arriving, but a silent hang is.
  const configuredTimeoutSeconds = Number(providerEnv.OASIS_REQUEST_TIMEOUT_SECONDS) || 0;
  const timeoutMs = requestTimeoutMs({ timeoutMs: options.timeoutMs, configuredSeconds: configuredTimeoutSeconds, local: isLoopbackProvider(config), streaming: typeof options.onDelta === 'function' });
  // A reasoning model can think for minutes without sending a byte (OpenAI
  // Responses and chat completions send no keepalive meanwhile), so the
  // default matches Codex's 5 minutes, doubled for high effort.
  const streamIdleMs = Math.min(900000, Math.max(1000, Number(options.streamIdleMs) || Number(providerEnv.OASIS_STREAM_IDLE_SECONDS) * 1000 || defaultStreamIdleMs(session.reasoningEffort)));
  let timedOut = false;
  let stalled = false;
  let responseStarted = false;
  let timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  // The header timeout bounds one attempt. Retry waits pause it and the next
  // attempt gets a fresh one, or a few patient 5xx retries would trip it and
  // report a provider that answered every time as "timed out".
  const waitBetweenAttempts = async (milliseconds) => {
    clearTimeout(timer);
    await waitForProviderRetry(milliseconds, controller.signal);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  };
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : providerFetch(isLoopbackProvider(config));
  const abortFromCaller = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) abortFromCaller();
    else options.signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  try {
    let response = null;
    const bodyText = JSON.stringify(bodyObject);
    const requestHeaders = cloudAnthropic ? await cloudHeaders(config, providerEnv, endpoint, bodyText, headers) : headers;
    let limitWaits = 0;
    let keyRotations = 0;
    // Per-minute limits: with a backup model, wait once and then let the
    // fallback chain move on; with none, waiting beats failing the task.
    let shortWaits = 0;
    // Per-minute limits reset within a minute, so waiting is cheap and safe.
    // Seen live on Gemma's 16k input-tokens/minute free tier: three waits were
    // not enough, and "retry in 1s" hints kept hitting the same full window.
    const shortWaitBudget = parseFallbackChain(session && session.fallbackModel).length ? 1 : 6;
    const attemptLimit = Math.max(MAX_PROVIDER_RETRIES, providerRetryLimit(0));
    // 529 means this model is overloaded right now. With a backup model set,
    // switching to it beats waiting out the overload on the same one.
    const hasFallback = parseFallbackChain(session && session.fallbackModel).length > 0;
    for (let attempt = 0; attempt <= attemptLimit; attempt++) {
      // Every attempt is a real request: --max-requests and --max-total-tokens
      // stop before the one that would pass them (about 4 characters a token).
      chargeRequestAttempt(budgetOwner, { estimatedInputTokens: bodyText.length / 4, env: providerEnv });
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: requestHeaders,
          signal: controller.signal,
          body: bodyText
        });
      } catch (error) {
        // Only transient failures (reset, timeout, dropped socket) get patient
        // retries. Nothing listening, no such host or an untrusted certificate
        // won't fix itself in a minute, so those fail fast with the real reason.
        const code = String((error && error.cause && error.cause.code) || '');
        const unreachable = Boolean(code) && !/^(?:ECONNRESET|ETIMEDOUT|EPIPE|ECONNABORTED|ENETDOWN|EAI_AGAIN|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|CLOSED))$/.test(code);
        const networkLimit = unreachable ? Math.min(QUICK_PROVIDER_RETRIES, providerRetryLimit(0, options.env)) : providerRetryLimit(0, options.env);
        if (attempt < networkLimit && error instanceof TypeError && !controller.signal.aborted) {
          const delay = providerRetryDelayMs(attempt + 1);
          traceRecovery(providerEnv, 'connection_retry', { attempt: attempt + 1, limit: networkLimit, wait_ms: delay, reason: error.message });
          notifyProviderRetry(options, { status: 0, attempt: attempt + 1, limit: networkLimit, waitMs: delay, reason: 'connection failed' });
          await waitBetweenAttempts(delay);
          continue;
        }
        throw error;
      }

      if (response.ok) {
        recordQuotaSuccess(route, { headers: response.headers, env: providerEnv });
        if (options.quotaState) options.quotaState.route = route;
        break;
      }
      const status = response.status;
      let errorBody = '';
      try { errorBody = await response.text(); } catch {}
      recordQuotaFailure(route, { status, headers: response.headers, body: errorBody, env: providerEnv });
      if (keyPool && ROTATE_STATUSES.has(status) && keyRotations < keyPool.size - 1 && requestHeaders === headers) {
        const next = keyPool.fail(apiKey, status, rateLimitResetMs(response.headers));
        if (next) {
          keyRotations++;
          apiKey = next;
          route = quotaRoute(config, apiKey);
          if (headers['x-api-key']) headers['x-api-key'] = next; else headers.authorization = 'Bearer ' + next;
          (session.hookMessages ||= []).push('[key-pool] provider returned ' + status + '; switched to the next API key (' + keyRotations + ' of ' + (keyPool.size - 1) + ' spare).');
          attempt--;
          continue;
        }
      }
      const hintedWait = (status === 429 || status === 402) && shortWaits < shortWaitBudget ? shortRateLimitMs(errorBody) : null;
      // After a failed wait, wait at least 10 s more each time, capped by the
      // one-minute window the limit is measured over.
      const shortWait = hintedWait === null ? null : Math.max(hintedWait, Math.min(60000, shortWaits * 10000));
      if (shortWait !== null) {
        clearTimeout(timer);
        // Over a per-minute input-token budget: later steps send the compact profile.
        let compactTools = false;
        if (isInputTokenRateLimit(errorBody) && session && !session.rateLimitCompacted) {
          session.rateLimitCompacted = true;
          compactTools = useCompactToolProfile(session, options.env || process.env);
        }
        traceRecovery(providerEnv, 'rate_limit_wait', { status, attempt: shortWaits + 1, wait_ms: shortWait, per_minute: true });
        if (typeof options.onRateLimitWait === 'function') {
          try { options.onRateLimitWait({ waitMs: shortWait, until: new Date(Date.now() + shortWait).toISOString(), attempt: shortWaits + 1, perMinute: true, compactTools }); } catch {}
        }
        shortWaits++;
        await waitForProviderRetry(shortWait, controller.signal);
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        attempt -= 1; // bounded by shortWaitBudget; leaves 5xx retries intact
        continue;
      }
      const retryDelay = providerRetryDelayMs(attempt + 1, response.headers);
      const serverAdvice = serverRetryAdvice(response.headers);
      if (retryDelay !== null && serverAdvice !== false && attempt < providerRetryLimit(status, options.env) && !(hasFallback && status === 529) && (serverAdvice === true || RETRYABLE_PROVIDER_STATUSES.has(status) || isMalformedGenerationError(status, errorBody)) && !isHardQuotaError(errorBody) && !isUnconfiguredRouteError(status, errorBody) && !isPromptTooLargeError(errorBody) && !(status === 429 && shortRateLimitMs(errorBody) !== null)) {
        traceRecovery(providerEnv, 'provider_retry', { status, attempt: attempt + 1, limit: providerRetryLimit(status, options.env), wait_ms: retryDelay, reason: providerErrorSummary(errorBody) });
        notifyProviderRetry(options, { status, attempt: attempt + 1, limit: providerRetryLimit(status, options.env), waitMs: retryDelay, reason: providerErrorSummary(errorBody) });
        await waitBetweenAttempts(retryDelay);
        continue;
      }
      const limitWait = limitWaits < 3 ? rateLimitWaitMs({ status, headers: response.headers, body: errorBody, maxMinutes: providerEnv.OASIS_WAIT_FOR_RATE_LIMIT_MINUTES }) : null;
      if (limitWait !== null) {
        limitWaits++;
        // The header timeout must not fire while deliberately waiting for the reset.
        clearTimeout(timer);
        traceRecovery(providerEnv, 'rate_limit_wait', { status, attempt: limitWaits, wait_ms: limitWait });
        if (typeof options.onRateLimitWait === 'function') {
          try { options.onRateLimitWait({ waitMs: limitWait, until: new Date(Date.now() + limitWait).toISOString(), attempt: limitWaits }); } catch {}
        }
        await waitForProviderRetry(limitWait, controller.signal);
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        attempt = -1;
        continue;
      }
      if (bodyObject && bodyObject.stream_options && (status === 400 || status === 422) && /stream_options|include_usage/i.test(errorBody)) {
        // An older gateway rejected stream_options; remember and retry without it.
        session.streamUsageUnsupported = true;
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abortFromCaller);
        return requestCompletionRaw(session, options);
      }
      const creditCap = !options.openRouterCreditCapRetried ? openRouterOutputCapFromError(status, errorBody, config) : 0;
      if (creditCap >= 64 && outputLimit && creditCap < outputLimit) {
        session.outputTokenCap = creditCap;
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abortFromCaller);
        return requestCompletionRaw(session, { ...options, openRouterCreditCapRetried: true });
      }
      const cap = outputLimit && !options.outputCapRetried ? outputCapFromError(status, errorBody) : 0;
      if (cap && cap < outputLimit + Number(session.thinkingBudget || 0)) {
        session.outputTokenCap = cap;
        if (session.thinkingBudget && session.thinkingBudget >= cap) session.thinkingBudget = Math.max(1024, cap - 2048);
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abortFromCaller);
        return requestCompletionRaw(session, { ...options, outputCapRetried: true });
      }
      if (!textOnly && hasImages(session.messages) && imagesUnsupportedError(status, errorBody)) {
        // Remember that this model is text-only for the session and resend
        // without image data; otherwise every later message fails the same way.
        (session.textOnlyModels ||= new Set()).add(String(config.model || ''));
        if (typeof options.onProviderRetry === 'function') { try { options.onProviderRetry({ status, attempt: 1, limit: 1, waitMs: 0, reason: config.model + ' cannot read images; sending the conversation without them' }); } catch {} }
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abortFromCaller);
        return requestCompletionRaw(session, options);
      }
      throw Object.assign(new Error(formatApiError(status, errorBody, config.protocol, config.baseURL, { secrets: [config.apiKey] })), { status });
    }
    if (!response || !response.ok) throw new Error('The model provider did not return a successful response after bounded retries.');
    responseStarted = true;
    const contentType = response.headers.get('content-type') || '';
    const streamed = Boolean(typeof options.onDelta === 'function' && contentType.toLowerCase().includes('text/event-stream'));
    let data;
    if (streamed) {
      clearTimeout(timer);
      const armIdle = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; controller.abort(); }, streamIdleMs); };
      armIdle();
      const watched = response.body && typeof response.body.pipeThrough === 'function'
        ? new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, sink) { armIdle(); sink.enqueue(chunk); } })), { status: response.status, headers: response.headers })
        : response;
      data = await readProviderStream(watched, config.protocol, options.onDelta, options.onPromptProgress, options.onReasoning);
    } else {
      const body = await response.text();
      try { data = JSON.parse(body); } catch {
        throw new Error('The model provider returned invalid JSON. Confirm the configured endpoint and provider protocol.');
      }
      // Gateways answer some failures with HTTP 200 and an error body. Seen live
      // from OpenRouter when a :free model is withdrawn: {"error":{"code":404,
      // "message":"This model is unavailable for free. ... use this slug
      // instead: <paid slug>"}}. Treat it as the HTTP error it describes, so the
      // fallback chain moves on (and never to the suggested paid slug) instead
      // of reporting "no assistant message".
      if (data && data.error && !data.choices && !Array.isArray(data.content) && !Array.isArray(data.output)) {
        const code = Number(data.error.code || data.error.status);
        const status = code >= 400 && code <= 599 ? code : 502;
        recordQuotaFailure(route, { status, headers: response.headers, body, env: providerEnv, retract: true });
        throw Object.assign(new Error(formatApiError(status, body, config.protocol, config.baseURL, { secrets: [config.apiKey] })), { status });
      }
    }
    if (nativeAnthropic) {
      if (!Array.isArray(data.content)) throw new Error('The Anthropic provider returned no content blocks.');
      const text = data.content.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n').trim();
      const toolCalls = data.content.filter((block) => block.type === 'tool_use').map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
      }));
      if (typeof options.onDelta === 'function' && !streamed && text) options.onDelta(text);
      const thinkingBlocks = data.content.filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking');
      if (thinkingBlocks.length && typeof options.onThinking === 'function') options.onThinking(thinkingBlocks.map((block) => block.thinking || '').join('\n'));
      if (!streamed && typeof options.onReasoning === 'function') { const said = thinkingBlocks.map((block) => block.thinking || '').filter(Boolean).join('\n\n'); if (said) options.onReasoning(said); }
      const truncated = data.stop_reason === 'max_tokens';
      const incompleteIds = data.content.filter((block) => block.type === 'tool_use' && block.incomplete).map((block) => block.id);
      return { role: 'assistant', content: text, tool_calls: toolCalls, usage: normalizeUsage(data.usage), ...(data.stop_reason === 'refusal' ? { providerStop: 'refusal' } : {}), ...(thinkingBlocks.length ? { thinkingBlocks } : {}), ...(truncated ? { truncated: true, outputLimit, incompleteToolCallIds: incompleteIds } : {}) };
    }
    if (nativeResponses) {
      if (!Array.isArray(data.output)) throw new Error('The Responses API returned no output items.');
      const incompleteReason = data.incomplete_details && data.incomplete_details.reason;
      const responsesTruncated = data.status === 'incomplete' && incompleteReason === 'max_output_tokens';
      if (data.status && data.status !== 'completed' && !responsesTruncated) {
        const reason = incompleteReason;
        throw new Error('The Responses API ended with status "' + data.status + '"' + (reason ? ' (' + reason + ')' : '') + '. Increase the output limit or adjust the request.');
      }
      const toolCalls = data.output.filter((item) => item && item.type === 'function_call').map((item) => ({
        id: item.call_id || item.id,
        type: 'function',
        function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) }
      }));
      const text = responseText(data.output);
      if (!streamed && typeof options.onReasoning === 'function') {
        const said = data.output.filter((item) => item && item.type === 'reasoning').flatMap((item) => Array.isArray(item.summary) ? item.summary : []).map((part) => part && part.text || '').filter(Boolean).join('\n\n');
        if (said) options.onReasoning(said);
      }
      if (typeof options.onDelta === 'function' && !streamed && text) options.onDelta(text);
      return { role: 'assistant', content: text, tool_calls: toolCalls, responseItems: data.output, usage: normalizeUsage(data.usage), ...(responsesTruncated ? { truncated: true, outputLimit } : {}) };
    }
    const message = data.choices && data.choices[0] && data.choices[0].message;
    if (!message) throw new Error('The model provider returned no assistant message.');
    // Gemini ends a reply with finish_reason "function_call_filter:
    // MALFORMED_FUNCTION_CALL" and nothing else when its own tool call failed
    // to parse. That is not a final answer (it used to end the task with no
    // changes); ask again, as Gemini CLI does.
    if (/MALFORMED_FUNCTION_CALL/i.test(String(data.choices[0].finish_reason || '')) && !(typeof message.content === 'string' && message.content.trim()) && !(Array.isArray(message.tool_calls) && message.tool_calls.length)) {
      throw Object.assign(new Error('The model stream was interrupted: the model produced a malformed tool call (' + data.choices[0].finish_reason + ').'), { code: 'OASIS_STREAM_INTERRUPTED', malformedCall: true });
    }
    const budgetNotice = gatewayBudgetNotice(message, data);
    if (budgetNotice) {
      // HTTP 200, but the "reply" is the gateway saying its budget is spent:
      // record and fail it as the 402 it is, so fallback runs.
      const body = JSON.stringify({ error: { message: budgetNotice } });
      recordQuotaFailure(route, { status: 402, headers: response.headers, body, env: providerEnv, retract: true });
      throw Object.assign(new Error(formatApiError(402, body, config.protocol, config.baseURL, { secrets: [config.apiKey] }) + ' (The gateway sent this as an HTTP 200 reply; OASIS did not use it as the answer.)'), { status: 402, gatewayBudgetNotice: true });
    }
    if (!streamed && typeof options.onReasoning === 'function') { const said = typeof message.reasoning_content === 'string' ? message.reasoning_content : typeof message.reasoning === 'string' ? message.reasoning : ''; if (said) options.onReasoning(said); }
    if (typeof options.onDelta === 'function' && !streamed && typeof message.content === 'string' && message.content) options.onDelta(message.content);
    if (Array.isArray(message.tool_calls)) uniqueToolCallIds(message.tool_calls.filter((call) => call && typeof call === 'object'));
    const chatTruncated = data.choices[0].finish_reason === 'length';
    const chatStop = String(data.choices[0].finish_reason || '');
    return { ...message, usage: usageOrEstimate(data.usage, bodyText, message), ...(/^(content_filter|error)$/i.test(chatStop) ? { providerStop: chatStop.toLowerCase() } : {}), ...(chatTruncated ? { truncated: true, outputLimit } : {}) };
  } catch (error) {
    if (options.signal && options.signal.aborted) {
      const cancelled = new Error('Agent task cancelled by the user.');
      cancelled.name = 'AbortError';
      throw cancelled;
    }
    if (stalled) throw Object.assign(new Error('The model stream stalled: no data arrived for ' + Math.round(streamIdleMs / 1000) + ' seconds (set OASIS_STREAM_IDLE_SECONDS to change this).'), { code: 'OASIS_STREAM_INTERRUPTED', stalled: true });
    if (error.name === 'AbortError' || timedOut) throw new Error('The model request timed out after ' + Math.round(timeoutMs / 1000) + ' seconds waiting for a response (set OASIS_REQUEST_TIMEOUT_SECONDS to change this).');
    // undici reports a connection dropped while reading the body as TypeError('terminated').
    if (error instanceof TypeError && responseStarted) throw Object.assign(new Error('The model stream was interrupted: the connection closed before the response finished.'), { code: 'OASIS_STREAM_INTERRUPTED' });
    if (error instanceof TypeError) {
      let proxied = false;
      try { proxied = Boolean(proxyForUrl(String(endpoint && endpoint.url || endpoint))); } catch {}
      const why = explainNetworkError(error, { proxied });
      const detail = why.kind === 'error' && /^(fetch failed)?$/i.test(why.detail.trim()) ? 'Check the network and provider base URL.' : why.detail;
      throw Object.assign(new Error(unreachableProviderMessage(String(endpoint && endpoint.url || endpoint), detail)), { code: 'OASIS_NETWORK', networkKind: why.kind, cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Verify that the selected model can emit a valid tool call before Oasis persists
 * the configuration. One inert schema is offered; the returned call is inspected
 * only and is never executed. Provider response bodies and credentials are not returned.
 */
export async function testProviderConnection(rawConfig, options = {}) {
  if (!rawConfig || typeof rawConfig !== 'object') throw new Error('Provider configuration is required.');
  let protocol;
  let baseURL;
  try {
    protocol = validateProtocol(rawConfig.protocol);
    baseURL = validateBaseUrl(rawConfig.baseURL);
  } catch (error) {
    throw new Error('Invalid provider configuration: ' + String(error && error.message || error).slice(0, 400));
  }
  const model = String(rawConfig.model || '').trim();
  const apiKey = String(rawConfig.apiKey || '');
  if (!model || model.length > 200) throw new Error('Enter a valid model name before testing the provider.');
  const probeToolName = 'oasis_connection_probe';
  const config = { protocol, baseURL, model, apiKey };
  const session = {
    config,
    toolDefinitions: [{
      type: 'function',
      function: {
        name: probeToolName,
        description: 'A harmless connection-check tool. This tool is never executed; only return the ready boolean.',
        parameters: {
          type: 'object',
          properties: { ready: { type: 'boolean' } },
          required: ['ready'],
          additionalProperties: false
        }
      }
    }],
    messages: [
      { role: 'system', content: 'You are checking coding-agent compatibility. You must call the offered oasis_connection_probe function exactly once with ready set to true. Do not answer in normal text. The tool is inert and will not be executed.' },
      { role: 'user', content: 'Call oasis_connection_probe with {"ready":true} now.' }
    ]
  };
  // One answer without a usable call gets a single retry, as the agent loop
  // gives the model one correction turn. Transport/HTTP errors are not retried.
  class ProbeAnswerError extends Error {}
  const attempt = async () => {
    const response = await requestCompletion(session, {
      forceTool: probeToolName,
      signal: options.signal,
      timeoutMs: options.timeoutMs || 30000
    });
    const toolCall = (Array.isArray(response && response.tool_calls) ? response.tool_calls : [])
      .find((call) => call && call.function && call.function.name === probeToolName);
    let args;
    let fromText = false;
    if (toolCall) {
      try { args = JSON.parse(String(toolCall.function.arguments || '{}')); }
      catch { throw new ProbeAnswerError('The model returned malformed arguments for the validation tool.'); }
    } else {
      // Small local models sometimes write the call as JSON in the reply text.
      // The agent loop recovers that format (tool-call-repair.mjs), so the
      // probe accepts it too instead of rejecting a model that works.
      const { extractTextToolCalls } = await import('./tool-call-repair.mjs');
      const recovered = extractTextToolCalls(response && response.content, [probeToolName]);
      const call = recovered && recovered.calls.find((entry) => entry.name === probeToolName);
      if (!call) throw new ProbeAnswerError('The model responded without calling the validation tool. Choose a model and provider endpoint that support tool calling.');
      args = call.args;
      fromText = true;
    }
    if (!args || args.ready !== true) {
      throw new ProbeAnswerError('The model did not return the expected validation-tool arguments. Check model and provider compatibility.');
    }
    return fromText;
  };
  try {
    let fromText;
    let attempts = 1;
    try { fromText = await attempt(); }
    catch (error) {
      if (!(error instanceof ProbeAnswerError) || (options.signal && options.signal.aborted)) throw error;
      attempts = 2;
      fromText = await attempt();
    }
    const caveat = fromText || attempts > 1;
    return {
      ok: true,
      protocol,
      provider: new URL(baseURL).host,
      model,
      attempts,
      toolCallsFromText: fromText,
      reliabilityWarning: caveat,
      note: (fromText
        ? 'The model wrote the tool call in its reply text instead of a native tool call; Oasis recovers that format, but tool use may be less reliable with this model. '
        : attempts > 1 ? 'The model needed a second try to make a valid tool call, so tool use may be less reliable with this model. ' : 'A valid tool-call response was received. ') +
        'The inert validation tool was not executed.'
    };
  } catch (error) {
    let message = String(error && error.message || error);
    if (apiKey) message = message.split(apiKey).join('[redacted]');
    throw new Error('Provider connection test failed; configuration was not verified. ' + message.slice(0, 1200));
  }
}

// Append-only audit log next to the saved session (oasis sessions events ID).
// Only sessions that have been saved have an ID; writes are queued in call
// order and never slow down or fail the turn.
export function recordSessionEvent(session, event, env) {
  if (!session || !session.sessionId) return;
  appendEvent(session.root, session.sessionId, event, { env: env || process.env }).catch(() => {});
}
