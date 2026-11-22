// Free model discovery: which models can drive an agent at no cost right now.
//
// Free cloud models come and go every few weeks (OpenRouter withdraws `:free`
// variants without notice), so a fixed list in the docs goes stale. This asks
// the sources at the moment you run it:
//
//   - OpenRouter's public model list (no key needed to read it): models whose
//     every listed price is zero, that output text, accept tool calls and have
//     at least a 32k context, and are not about to expire
//   - Ollama on this computer, if it runs: installed models, with tool support
//     read from /api/show where the server reports capabilities
//
// and ranks them for agent work: tool calling is required, then larger models,
// longer context and newer releases first, tiny models last. `oasis models free
// --apply` appends the best ones to your fallback chain (settings
// `fallbackModel`), where zero-budget mode and the quota ledger already treat
// them as free (src/cost-policy.mjs).

import { discoverLocalOllamaModels } from './ollama-discovery.mjs';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MIN_CONTEXT = 32768;
const EXPIRY_MARGIN_MS = 7 * 24 * 3600 * 1000;
const RECENT_MS = 120 * 24 * 3600 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;
const OLLAMA = 'http://127.0.0.1:11434';

function zero(value) {
  return value === undefined || value === null || value === '' || Number(value) === 0;
}

/** Size in billions of parameters from an id such as `nemotron-3-ultra-550b-a55b`, or 0. */
export function parameterBillions(id) {
  const match = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/i.exec(String(id || '').replace(/:free$/i, ''));
  return match ? Number(match[1]) : 0;
}

/**
 * Agent-capable free models from an OpenRouter /models response, unranked.
 * Each: { id, spec, name, context, maxOutput, tools, structured, vision, reasoning, billions, created, router }.
 */
export function parseOpenRouterFree(body, { now = Date.now() } = {}) {
  const items = Array.isArray(body && body.data) ? body.data : [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !/^[\w.:/@+-]{1,200}$/.test(item.id)) continue;
    const pricing = item.pricing && typeof item.pricing === 'object' ? item.pricing : null;
    if (!pricing || !Object.values(pricing).every(zero)) continue;
    const arch = item.architecture || {};
    const outputs = Array.isArray(arch.output_modalities) ? arch.output_modalities : ['text'];
    if (!outputs.includes('text')) continue;
    const params = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
    if (!params.includes('tools')) continue;
    const context = Number(item.context_length || (item.top_provider && item.top_provider.context_length)) || 0;
    if (context < MIN_CONTEXT) continue;
    const expires = item.expiration_date ? Date.parse(item.expiration_date) : NaN;
    if (Number.isFinite(expires) && expires - now < EXPIRY_MARGIN_MS) continue;
    const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
    out.push({
      id: item.id, spec: 'openrouter:' + item.id, source: 'openrouter', name: String(item.name || item.id).slice(0, 120),
      context, maxOutput: Number(item.top_provider && item.top_provider.max_completion_tokens) || 0,
      tools: true, structured: params.includes('structured_outputs') || params.includes('response_format'),
      vision: inputs.includes('image'), reasoning: params.includes('reasoning'),
      billions: parameterBillions(item.id), created: Number(item.created) ? Number(item.created) * 1000 : 0,
      // openrouter/free picks any free model per request: a last resort.
      router: /^openrouter\/free$/i.test(item.id),
      ...(Number.isFinite(expires) ? { expires: new Date(expires).toISOString() } : {})
    });
  }
  return out;
}

/** Higher is better for agent work. */
export function agentScore(model, { now = Date.now() } = {}) {
  if (!model.tools) return -100;
  if (model.router) return -50;
  let score = 0;
  const size = model.billions;
  if (size) score += size < 4 ? -6 : size < 10 ? -3 : size < 25 ? 0 : size < 70 ? 2 : size < 200 ? 3 : 4;
  score += Math.min(3, Math.max(0, Math.log2((model.context || MIN_CONTEXT) / MIN_CONTEXT)) * 0.6);
  if (model.created && now - model.created < RECENT_MS) score += 1;
  if (model.structured) score += 0.5;
  if (model.reasoning) score += 0.5;
  if (model.source === 'ollama') score += 1; // no rate limit, no daily allowance, private
  return Number(score.toFixed(2));
}

export function rankFreeModels(models, options = {}) {
  return models.map((model) => ({ ...model, score: agentScore(model, options) }))
    .sort((a, b) => b.score - a.score || (b.context - a.context) || a.id.localeCompare(b.id));
}

async function fetchJson(fetchImpl, url, { timeoutMs, method = 'GET', body } = {}) {
  const response = await fetchImpl(url, {
    method, redirect: 'error', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('the response was too large');
  return JSON.parse(text);
}

async function ollamaModels(fetchImpl, timeoutMs) {
  const found = await discoverLocalOllamaModels({ fetchImpl, timeoutMs });
  if (!found.available) return { models: [], available: false };
  const models = [];
  for (const name of found.models.slice(0, 20)) {
    if (/embed|rerank|whisper|tts/i.test(name)) continue;
    let tools = null;
    let context = 0;
    try {
      const show = await fetchJson(fetchImpl, OLLAMA + '/api/show', { method: 'POST', body: { model: name }, timeoutMs });
      if (Array.isArray(show.capabilities)) tools = show.capabilities.includes('tools');
      for (const [key, value] of Object.entries(show.model_info || {})) if (/\.context_length$/.test(key) && Number(value) > 0) context = Number(value);
    } catch {}
    if (tools === false) continue;
    models.push({ id: name, spec: 'ollama:' + name, source: 'ollama', name, context, maxOutput: 0, tools: tools !== false, toolsReported: tools === true, structured: false, vision: false, reasoning: false, billions: parameterBillions(name.replace(/:/g, '-')), created: 0, router: false });
  }
  return { models, available: true };
}

/**
 * Discovers free agent-capable models. Never throws; each source that failed
 * is named in `errors`. Returns { models, errors, ollama, checkedAt }.
 */
export async function discoverFreeModels({ fetchImpl = globalThis.fetch, timeoutMs = 8000, local = true, cloud = true, now = Date.now() } = {}) {
  const errors = [];
  const found = [];
  let ollama = false;
  if (cloud) {
    try { found.push(...parseOpenRouterFree(await fetchJson(fetchImpl, OPENROUTER_MODELS_URL, { timeoutMs }), { now })); }
    catch (error) { errors.push('OpenRouter: ' + String(error && error.message || error).slice(0, 160)); }
  }
  if (local) {
    try { const result = await ollamaModels(fetchImpl, Math.min(timeoutMs, 3000)); ollama = result.available; found.push(...result.models); }
    catch (error) { errors.push('Ollama: ' + String(error && error.message || error).slice(0, 160)); }
  }
  return { models: rankFreeModels(found, { now }), errors, ollama, checkedAt: new Date(now).toISOString() };
}

/**
 * The fallback chain with up to `count` new free entries appended (best first),
 * skipping routers and models already in it. When a local model is available
 * and the chain has none, the last slot goes to the best one: cloud free tiers
 * run out each day, a local model does not. Returns { chain, added }.
 */
export function withFreeFallbacks(existing, models, count = 3) {
  const current = (Array.isArray(existing) ? existing : String(existing || '').split(',')).map((item) => String(item).trim()).filter(Boolean);
  const present = new Set(current.map((item) => item.toLowerCase()));
  const usable = models.filter((model) => !model.router && model.score > -50 && !present.has(model.spec.toLowerCase()));
  const local = current.some((item) => /^ollama:/i.test(item)) ? null : usable.find((model) => model.source === 'ollama');
  const picked = usable.filter((model) => model !== local).slice(0, local ? count - 1 : count);
  if (local) picked.push(local);
  const added = picked.map((model) => model.spec);
  return { chain: [...current, ...added], added };
}
