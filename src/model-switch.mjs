// Model switches with Claude Code's PreModelSwitch and PostModelSwitch hooks.
//
// PreModelSwitch runs before a switch the user or a client asked for (/model,
// an ACP or SDK client). Exit 2, decision "block", permissionDecision "deny" or a
// timeout cancels the switch; "ask" asks the user when a confirm callback exists
// and otherwise refuses, as Claude Code does outside interactive /model.
// PostModelSwitch runs after the model changed (also for "auto" and "resume"
// changes). It cannot block; its output reaches the model with the next request,
// and only the newest switch's output is delivered.
import { hasHooks, runHooks } from './hooks.mjs';
import { resolveModelAlias, canonicalClaudeId } from './model-aliases.mjs';
import { priceFor } from './pricing.mjs';

const CACHE_TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 };
// Assumed input rate (USD per million tokens) when the target has no known price.
const DEFAULT_INPUT_PRICE = 3;

// Claude Code matches these hooks against the target's canonical name: aliases,
// dated ids and provider ids (Bedrock, Vertex, gateways) all collapse to
// "claude-opus-5". Returns null for models without a Claude canonical name, and
// then every hook runs regardless of matcher.
export function canonicalModelName(model, options = {}) {
  return canonicalClaudeId(model, options);
}

function cacheTtl(env) {
  return env.ENABLE_PROMPT_CACHING_1H === '1' || env.OASIS_PROMPT_CACHE_TTL === '1h' ? '1h' : '5m';
}

// The cost fields Claude Code sends: what re-sending the conversation costs on the new model.
export function modelSwitchCost(session, toModel, env = process.env) {
  const usage = session && session.lastMainUsage || null;
  const contextTokens = usage ? Math.max(0, Number(usage.inputTokens || 0)) + Math.max(0, Number(usage.outputTokens || 0)) : 0;
  const ttl = cacheTtl(env);
  const warm = Boolean(usage && usage.at && Date.now() - usage.at < CACHE_TTL_MS[ttl]);
  const config = session && session.config || {};
  let price = null;
  try { price = priceFor(resolveModelAlias(toModel, { protocol: config.protocol, env }), { config, overrides: session && session.pricing || {}, env }); } catch { price = null; }
  const pricing = !price ? 'default' : price.custom ? 'configured' : 'catalog';
  const input = price ? Number(price.input) || 0 : DEFAULT_INPUT_PRICE;
  // Anthropic list rates: 5-minute writes cost 1.25x input, 1-hour writes 2x.
  const rate = ttl === '1h' ? input * 2 : (price && Number(price.cacheWrite)) || input * 1.25;
  return {
    context_tokens: contextTokens,
    prompt_cache_warm: warm,
    cache_ttl: ttl,
    estimated_cache_write_usd: Number((contextTokens * rate / 1e6).toFixed(4)),
    pricing
  };
}

function payloadFor(session, { from, to, requested, source, env }) {
  const config = session && session.config || {};
  return {
    session_id: session && session.sessionId || 'unsaved',
    from_model: String(from || ''),
    to_model: String(to || ''),
    requested_model: requested === undefined || requested === null || requested === '' ? null : String(requested),
    source,
    model_canonical: canonicalModelName(to, { protocol: config.protocol, env }),
    ...modelSwitchCost(session, to, env)
  };
}

function optionsFor(session, env) {
  return typeof session.hookOptionsFor === 'function' ? session.hookOptionsFor() : { hooks: session.hooks, root: session.root, env };
}

// Runs PreModelSwitch. Resolves { allowed, reason, messages }.
export async function preModelSwitch(session, { to, requested, source = 'command', env = process.env, confirm = null } = {}) {
  const from = session && session.config && session.config.model || '';
  if (!session || !hasHooks(session.hooks, 'PreModelSwitch')) return { allowed: true, reason: '', messages: [] };
  const result = await runHooks('PreModelSwitch', payloadFor(session, { from, to, requested, source, env }), optionsFor(session, env));
  const messages = [...result.messages];
  if (result.blocked || result.permissionDecision === 'deny') {
    return { allowed: false, reason: result.reason.trim() || 'Blocked by a PreModelSwitch hook.', messages };
  }
  if (result.permissionDecision === 'ask') {
    const question = (result.askReason || 'A PreModelSwitch hook asks you to confirm switching to ' + to + '.');
    if (typeof confirm !== 'function') return { allowed: false, reason: 'A PreModelSwitch hook asked for confirmation, which is not available here: ' + question, messages };
    const ok = await confirm(question + ' Continue?');
    return ok ? { allowed: true, reason: '', messages } : { allowed: false, reason: 'Model switch cancelled.', messages };
  }
  return { allowed: true, reason: '', messages };
}

// Runs PostModelSwitch in the background; its context joins the next request.
// A later switch supersedes the output of an earlier one that is still pending.
export function postModelSwitch(session, { from, to, requested, source = 'command', env = process.env } = {}) {
  if (!session || !hasHooks(session.hooks, 'PostModelSwitch') || String(from || '') === String(to || '')) return null;
  const token = (session.modelSwitchToken || 0) + 1;
  session.modelSwitchToken = token;
  const run = runHooks('PostModelSwitch', payloadFor(session, { from, to, requested, source, env }), optionsFor(session, env)).then((result) => {
    if (session.modelSwitchToken !== token) return result;
    if (result.additionalContext.length) (session.asyncHookFeedback ||= []).push('PostModelSwitch hook context (model is now ' + to + '):\n' + result.additionalContext.join('\n'));
    if (result.messages.length) (session.hookMessages ||= []).push(...result.messages);
    if (result.blocked && result.reason) (session.hookMessages ||= []).push('PostModelSwitch hook error: ' + result.reason);
    return result;
  }).catch(() => null);
  session.pendingModelSwitch = run;
  return run;
}

// Full switch: PreModelSwitch, apply, PostModelSwitch. Resolves { ok, reason, messages }.
export async function switchSessionModel(session, { to, requested = to, source = 'command', env = process.env, confirm = null, apply = null } = {}) {
  const from = session && session.config && session.config.model || '';
  const pre = await preModelSwitch(session, { to, requested, source, env, confirm });
  if (!pre.allowed) return { ok: false, reason: pre.reason, messages: pre.messages };
  if (typeof apply === 'function') apply(to);
  else session.config = { ...(session.config || {}), model: to };
  postModelSwitch(session, { from, to, requested, source, env });
  return { ok: true, reason: '', messages: pre.messages };
}
