// Honcho user modeling (https://honcho.dev, Apache-2.0 server by Plastic Labs).
//
// Honcho keeps a long-lived model of the user across sessions, projects and
// chat platforms: every finished turn is sent to a Honcho session, and Honcho's
// background reasoning turns those messages into "conclusions" about the user,
// a short peer card, and a representation the agent can query in plain language.
//
// OASIS talks to the Honcho v3 REST API directly (no SDK needed):
//   honcho_profile    read or replace the user's peer card (key facts)
//   honcho_search     semantic search over what the user said in past sessions
//   honcho_context    session summary + user representation + card + recent messages
//   honcho_reasoning  ask Honcho a question about the user (dialectic chat)
//   honcho_conclude   record or delete a durable conclusion about the user
//
// It is opt-in: set HONCHO_API_KEY for Honcho cloud (api.honcho.dev), or point
// HONCHO_URL (OASIS_HONCHO_URL) at a self-hosted server. Everything fails open:
// an unreachable Honcho never blocks a turn.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { redactSecretText } from './secret-shield.mjs';

export const DEFAULT_HONCHO_URL = 'https://api.honcho.dev';
const API = '/v3';
const TIMEOUT_MS = 20_000;
const SYNC_TIMEOUT_MS = 4_000;
const CONTEXT_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_CHARS = 24_000;
const MAX_OUTPUT = 24 * 1024;
export const RECALL_MODES = ['hybrid', 'context', 'tools'];
export const SESSION_STRATEGIES = ['per-directory', 'per-repo', 'per-session', 'global'];
export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'max'];
const OFF = /^(0|false|off|no)$/i;

/** Honcho IDs may only contain letters, digits, underscores and hyphens. */
export function honchoId(value, fallback = 'oasis') {
  const id = String(value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return id || fallback;
}

function defaultPeerName(env) {
  try { return env.USER || env.USERNAME || userInfo().username || 'user'; } catch { return env.USER || env.USERNAME || 'user'; }
}

/**
 * Resolve the Honcho configuration from the environment and (trusted) settings.
 * Returns null when Honcho is not configured or turned off.
 */
export function honchoConfig(env = process.env, settings = {}) {
  const raw = settings && typeof settings.honcho === 'object' && settings.honcho ? settings.honcho : {};
  if (OFF.test(String(env.OASIS_HONCHO || '')) || raw.enabled === false) return null;
  const apiKey = String(env.OASIS_HONCHO_API_KEY || env.HONCHO_API_KEY || '').trim();
  const explicitUrl = String(env.OASIS_HONCHO_URL || env.HONCHO_URL || raw.baseUrl || '').trim().replace(/\/+$/, '');
  if (!apiKey && !explicitUrl) return null;
  const baseUrl = explicitUrl || DEFAULT_HONCHO_URL;
  if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) return null;
  const pick = (value, allowed, fallback) => {
    const text = String(value || '').trim().toLowerCase();
    return allowed.includes(text) ? text : fallback;
  };
  const tokens = Number(env.OASIS_HONCHO_CONTEXT_TOKENS || raw.contextTokens || 1200);
  return {
    baseUrl,
    apiKey,
    workspace: honchoId(env.OASIS_HONCHO_WORKSPACE || env.HONCHO_WORKSPACE_ID || raw.workspace, 'oasis'),
    userPeer: honchoId(env.OASIS_HONCHO_PEER || raw.peerName || defaultPeerName(env), 'user'),
    aiPeer: honchoId(env.OASIS_HONCHO_AI_PEER || raw.aiPeer, 'oasis'),
    recallMode: pick(env.OASIS_HONCHO_RECALL || raw.recallMode, RECALL_MODES, 'hybrid'),
    sessionStrategy: pick(env.OASIS_HONCHO_SESSION || raw.sessionStrategy, SESSION_STRATEGIES, 'per-directory'),
    contextTokens: Number.isFinite(tokens) ? Math.max(100, Math.min(20_000, Math.round(tokens))) : 1200,
    sync: !OFF.test(String(env.OASIS_HONCHO_SYNC || '')) && raw.sync !== false
  };
}

function findRepoRoot(root) {
  let dir = resolve(root);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The Honcho session ID for a workspace root under the configured strategy. */
export function honchoSessionId(config, { root = process.cwd(), sessionId = '', platform = '', chatId = '' } = {}) {
  if (platform && chatId) return honchoId(platform + '-' + chatId);
  const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10);
  switch (config.sessionStrategy) {
    case 'global': return 'oasis-global';
    case 'per-session': return honchoId('session-' + (sessionId || hash(String(Date.now()) + Math.random())));
    case 'per-repo': {
      const repo = findRepoRoot(root) || resolve(root);
      return honchoId('repo-' + basename(repo).slice(0, 60) + '-' + hash(repo));
    }
    default: {
      const dir = resolve(root);
      return honchoId('dir-' + basename(dir).slice(0, 60) + '-' + hash(dir));
    }
  }
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function honchoRequest(config, method, path, { body, query, fetchImpl = globalThis.fetch, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const url = new URL(config.baseUrl + API + path);
  for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (config.apiKey) headers.authorization = 'Bearer ' + config.apiKey;
  let response;
  try {
    response = await fetchImpl(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: withTimeout(signal, timeoutMs) });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError') && !(signal && signal.aborted)) throw new Error('Honcho at ' + config.baseUrl + ' did not answer in time.');
    throw new Error('Could not reach Honcho at ' + config.baseUrl + ': ' + (error && error.message || error));
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? ' Check HONCHO_API_KEY.' : '';
    let detail = text.slice(0, 300);
    try { const parsed = JSON.parse(text); detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail || parsed).slice(0, 300); } catch {}
    throw new Error('Honcho ' + method + ' ' + path + ' failed (' + response.status + ').' + hint + (detail ? ' ' + redactSecretText(detail) : ''));
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function ws(config) { return '/workspaces/' + encodeURIComponent(config.workspace); }

/**
 * Get-or-create the workspace, both peers and the session (memoized per state).
 * The user peer is observed; the agent peer is not, so Honcho models the user.
 */
export async function ensureHoncho(state, options = {}) {
  if (state.ready) return state.ready;
  const { config, sessionId } = state;
  const run = async () => {
    await honchoRequest(config, 'POST', '/workspaces', { ...options, body: { id: config.workspace } });
    await Promise.all([
      honchoRequest(config, 'POST', ws(config) + '/peers', { ...options, body: { id: config.userPeer } }),
      honchoRequest(config, 'POST', ws(config) + '/peers', { ...options, body: { id: config.aiPeer } })
    ]);
    await honchoRequest(config, 'POST', ws(config) + '/sessions', { ...options, body: { id: sessionId } });
    await honchoRequest(config, 'POST', ws(config) + '/sessions/' + encodeURIComponent(sessionId) + '/peers', {
      ...options,
      body: { [config.userPeer]: { observe_me: true, observe_others: false }, [config.aiPeer]: { observe_me: false, observe_others: true } }
    });
  };
  state.ready = run().catch((error) => { state.ready = null; throw error; });
  return state.ready;
}

/** Per-session Honcho state kept on the OASIS session object. */
export function createHonchoState(config, { root, sessionId, platform, chatId } = {}) {
  return { config, sessionId: honchoSessionId(config, { root, sessionId, platform, chatId }), ready: null, synced: 0, lastError: '' };
}

function clean(text) {
  return redactSecretText(String(text || '').replace(/<private>[\s\S]*?<\/private>/gi, '[private]')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Send one finished turn (user prompt + final reply) to Honcho. Fails open and
 * never takes longer than a few seconds; the error is kept on the state.
 */
export async function syncHonchoTurn(state, prompt, reply, { fetchImpl, signal, timeoutMs = SYNC_TIMEOUT_MS } = {}) {
  if (!state || !state.config || !state.config.sync) return false;
  const userText = clean(prompt);
  const aiText = clean(reply);
  if (!userText && !aiText) return false;
  const messages = [];
  if (userText) messages.push({ peer_id: state.config.userPeer, content: userText });
  if (aiText) messages.push({ peer_id: state.config.aiPeer, content: aiText });
  const options = { fetchImpl, signal, timeoutMs };
  try {
    await ensureHoncho(state, options);
    await honchoRequest(state.config, 'POST', ws(state.config) + '/sessions/' + encodeURIComponent(state.sessionId) + '/messages', { ...options, body: { messages } });
    state.synced += messages.length;
    state.lastError = '';
    return true;
  } catch (error) {
    state.lastError = String(error && error.message || error);
    return false;
  }
}

function cardLines(card) {
  return (Array.isArray(card) ? card : []).map((line) => String(line || '').trim()).filter(Boolean);
}

function representationText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value.representation === 'string') return value.representation.trim();
  try { return JSON.stringify(value).slice(0, 4000); } catch { return ''; }
}

/**
 * The block added to the system prompt (recallMode hybrid or context): what
 * Honcho knows about the user, capped at contextTokens.
 */
export async function honchoContextPrompt(state, { fetchImpl, signal, timeoutMs = CONTEXT_TIMEOUT_MS } = {}) {
  if (!state || state.config.recallMode === 'tools') return '';
  const { config } = state;
  const options = { fetchImpl, signal, timeoutMs };
  let data;
  try {
    data = await honchoRequest(config, 'GET', ws(config) + '/peers/' + encodeURIComponent(config.userPeer) + '/context', options);
  } catch (error) {
    state.lastError = String(error && error.message || error);
    return '';
  }
  const card = cardLines(data && data.peer_card);
  const representation = representationText(data && data.representation);
  if (!card.length && !representation) return '';
  const budget = config.contextTokens * 4;
  let body = (card.length ? 'Key facts:\n' + card.map((line) => '- ' + line).join('\n') : '') + (representation ? (card.length ? '\n\n' : '') + 'What Honcho has concluded about the user:\n' + representation : '');
  if (body.length > budget) body = body.slice(0, budget) + '\n[truncated]';
  return '<honcho-user-model peer="' + config.userPeer + '">\n'
    + 'This is a long-term model of the user built by Honcho from earlier conversations. Use it to tailor answers; it may be outdated, and the user\'s current words win.\n'
    + redactSecretText(body) + '\n</honcho-user-model>';
}

export const HONCHO_TOOL_NAMES = ['honcho_profile', 'honcho_search', 'honcho_context', 'honcho_reasoning', 'honcho_conclude'];
export const HONCHO_READ_ONLY_TOOLS = ['honcho_search', 'honcho_context', 'honcho_reasoning'];

export const HONCHO_TOOL_DEFINITIONS = [
  { type: 'function', function: {
    name: 'honcho_profile',
    description: 'Read or replace the user\'s Honcho peer card: a short list of durable key facts about the user (name, role, preferences, ongoing projects). action=get returns it; action=set replaces it with the given lines, so read it first and keep the facts that still hold.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'set'] },
      card: { type: 'array', items: { type: 'string' }, description: 'set: the full new list of facts, one short sentence each' }
    }, required: ['action'], additionalProperties: false }
  } },
  { type: 'function', function: {
    name: 'honcho_search',
    description: 'Semantic search over what the user said in earlier sessions (all projects and chat platforms connected to Honcho). Returns raw message excerpts. Use it to find a past decision, preference or detail in the user\'s own words.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10' }
    }, required: ['query'], additionalProperties: false }
  } },
  { type: 'function', function: {
    name: 'honcho_context',
    description: 'Honcho\'s view of the current conversation thread: a summary of earlier messages, the user\'s representation and peer card, and the most recent messages. Use it to pick up a long-running thread.',
    parameters: { type: 'object', properties: {
      tokens: { type: 'integer', minimum: 100, maximum: 20000, description: 'Token budget for the context (default from settings)' }
    }, additionalProperties: false }
  } },
  { type: 'function', function: {
    name: 'honcho_reasoning',
    description: 'Ask Honcho a natural-language question about the user, answered by reasoning over everything it has learned ("What testing style does the user prefer?", "What is the user working towards this month?"). Higher reasoning levels are slower and cost more.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' },
      reasoning_level: { type: 'string', enum: REASONING_LEVELS, description: 'Default low' },
      this_session_only: { type: 'boolean', description: 'Only use what was learned in the current thread' }
    }, required: ['query'], additionalProperties: false }
  } },
  { type: 'function', function: {
    name: 'honcho_conclude',
    description: 'Record a durable conclusion about the user in Honcho (a stable preference, fact or goal the user stated or confirmed), or delete a wrong one. action=list shows recent conclusions with their IDs. Never record secrets or one-off task details.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['create', 'delete', 'list'] },
      content: { type: 'string', description: 'create: the conclusion, one sentence' },
      id: { type: 'string', description: 'delete: the conclusion ID' }
    }, required: ['action'], additionalProperties: false }
  } }
];

function cap(text) {
  const out = String(text || '');
  return out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '\n[truncated]' : out;
}

function itemsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function messageLine(message) {
  const who = message.peer_id || message.peer_name || '?';
  const when = message.created_at ? String(message.created_at).slice(0, 16).replace('T', ' ') + ' ' : '';
  const where = message.session_id ? ' [' + message.session_id + ']' : '';
  return '- ' + when + who + where + ': ' + String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

export async function runHonchoTool(name, args = {}, { state, fetchImpl, signal } = {}) {
  if (!state || !state.config) throw new Error('Honcho is not configured. Set HONCHO_API_KEY (Honcho cloud) or HONCHO_URL (self-hosted).');
  const { config } = state;
  const options = { fetchImpl, signal };
  const peer = ws(config) + '/peers/' + encodeURIComponent(config.userPeer);
  await ensureHoncho(state, options);
  switch (name) {
    case 'honcho_profile': {
      if (args.action === 'set') {
        const card = cardLines(args.card).map((line) => redactSecretText(line).slice(0, 500)).slice(0, 60);
        if (!card.length) throw new Error('honcho_profile set needs card: a list of facts. Use action=get first.');
        const saved = await honchoRequest(config, 'PUT', peer + '/card', { ...options, body: { peer_card: card } });
        return 'Saved the peer card for ' + config.userPeer + ' (' + cardLines(saved && saved.peer_card || card).length + ' facts).';
      }
      const data = await honchoRequest(config, 'GET', peer + '/card', options);
      const card = cardLines(data && data.peer_card);
      return card.length ? 'Peer card for ' + config.userPeer + ':\n' + card.map((line) => '- ' + line).join('\n') : 'Honcho has no peer card for ' + config.userPeer + ' yet.';
    }
    case 'honcho_search': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('honcho_search needs a query.');
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
      const results = itemsOf(await honchoRequest(config, 'POST', peer + '/search', { ...options, body: { query, limit } }));
      return results.length ? cap('Messages from ' + config.userPeer + ' matching "' + query + '":\n' + results.map(messageLine).join('\n')) : 'No past messages matched "' + query + '".';
    }
    case 'honcho_context': {
      const tokens = Math.max(100, Math.min(20_000, Number(args.tokens) || config.contextTokens));
      const data = await honchoRequest(config, 'GET', ws(config) + '/sessions/' + encodeURIComponent(state.sessionId) + '/context', { ...options, query: { tokens, summary: true, peer_target: config.userPeer, peer_perspective: config.aiPeer } }) || {};
      const parts = [];
      const summary = data.summary && (data.summary.content || data.summary);
      if (summary && typeof summary === 'string') parts.push('Summary of earlier messages:\n' + summary.trim());
      const representation = representationText(data.peer_representation);
      if (representation) parts.push('User representation:\n' + representation);
      const card = cardLines(data.peer_card);
      if (card.length) parts.push('Peer card:\n' + card.map((line) => '- ' + line).join('\n'));
      const messages = itemsOf(data.messages);
      if (messages.length) parts.push('Recent messages:\n' + messages.slice(-20).map(messageLine).join('\n'));
      return parts.length ? cap('Honcho context for thread ' + state.sessionId + ':\n\n' + parts.join('\n\n')) : 'Honcho has no context for this thread yet (messages are processed in the background).';
    }
    case 'honcho_reasoning': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('honcho_reasoning needs a query.');
      const level = REASONING_LEVELS.includes(args.reasoning_level) ? args.reasoning_level : 'low';
      const body = { query, reasoning_level: level, stream: false, ...(args.this_session_only ? { session_id: state.sessionId } : {}) };
      const data = await honchoRequest(config, 'POST', peer + '/chat', { ...options, body, timeoutMs: 120_000 });
      const content = data && typeof data === 'object' ? data.content : data;
      return content ? cap(String(content)) : 'Honcho does not know enough about the user to answer that yet.';
    }
    case 'honcho_conclude': {
      const base = ws(config) + '/conclusions';
      if (args.action === 'create') {
        const content = redactSecretText(String(args.content || '').trim()).slice(0, 2000);
        if (!content) throw new Error('honcho_conclude create needs content.');
        const created = await honchoRequest(config, 'POST', base, { ...options, body: { conclusions: [{ content, observer_id: config.aiPeer, observed_id: config.userPeer, session_id: state.sessionId }] } });
        const first = itemsOf(created)[0] || created || {};
        return 'Recorded the conclusion' + (first.id ? ' ' + first.id : '') + ': ' + content;
      }
      if (args.action === 'delete') {
        const id = String(args.id || '').trim();
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('honcho_conclude delete needs the conclusion id (see action=list).');
        await honchoRequest(config, 'DELETE', base + '/' + encodeURIComponent(id), options);
        return 'Deleted conclusion ' + id + '.';
      }
      const listed = itemsOf(await honchoRequest(config, 'POST', base + '/list', { ...options, query: { page: 1, size: 30, reverse: true }, body: { filters: { observer_id: config.aiPeer, observed_id: config.userPeer } } }));
      return listed.length ? cap('Conclusions about ' + config.userPeer + ':\n' + listed.map((item) => '- ' + item.id + ': ' + String(item.content || '').replace(/\s+/g, ' ').slice(0, 400)).join('\n')) : 'No conclusions about ' + config.userPeer + ' yet.';
    }
    default:
      throw new Error('Unknown Honcho tool ' + name + '.');
  }
}

/**
 * Give a chat-gateway session its own Honcho thread (telegram-123, discord-456...).
 * The user peer stays the same, so what OASIS learns in one chat carries over
 * to the terminal and to every other platform.
 */
export function scopeHonchoToChat(session, platform, chatId) {
  if (!session || !session.honcho || !platform || chatId === undefined || chatId === null || chatId === '') return;
  session.honcho = createHonchoState(session.honcho.config, { platform, chatId: String(chatId) });
}

/** `oasis honcho [status|test]` and `/honcho`. */
export async function honchoCommand(args = [], { env = process.env, settings = {}, root = process.cwd(), state, fetchImpl } = {}) {
  const action = String(args[0] || 'status').toLowerCase();
  const config = (state && state.config) || honchoConfig(env, settings);
  if (!config) return { exitCode: action === 'status' ? 0 : 1, text: 'Honcho is off. Set HONCHO_API_KEY (Honcho cloud, https://app.honcho.dev) or HONCHO_URL for a self-hosted server to give OASIS a long-term model of you across sessions and chats.' };
  const current = state || createHonchoState(config, { root });
  const lines = [
    'Honcho: ' + config.baseUrl + (config.apiKey ? ' (API key set)' : ' (no API key)'),
    'Workspace: ' + config.workspace + '   user peer: ' + config.userPeer + '   agent peer: ' + config.aiPeer,
    'Recall: ' + config.recallMode + '   sessions: ' + config.sessionStrategy + ' (' + current.sessionId + ')   context: ' + config.contextTokens + ' tokens',
    'Sync: ' + (config.sync ? 'on' + (current.synced ? ', ' + current.synced + ' messages sent this session' : '') : 'off')
  ];
  if (current.lastError) lines.push('Last error: ' + current.lastError);
  if (action === 'status') return { exitCode: 0, text: lines.join('\n') };
  if (action === 'test') {
    try {
      await ensureHoncho(current, { fetchImpl });
      const card = await honchoRequest(config, 'GET', ws(config) + '/peers/' + encodeURIComponent(config.userPeer) + '/card', { fetchImpl });
      return { exitCode: 0, text: lines.join('\n') + '\nConnected. Peer card: ' + (cardLines(card && card.peer_card).length || 'empty') + (cardLines(card && card.peer_card).length ? ' facts' : '') + '.' };
    } catch (error) {
      return { exitCode: 1, text: lines.join('\n') + '\nNot connected: ' + (error && error.message || error) };
    }
  }
  return { exitCode: 2, text: 'Usage: oasis honcho [status|test]' };
}
