// Mattermost gateway: `oasis gateway mattermost` talks to the workspace's agent
// from Mattermost (self-hosted or Cloud) over its WebSocket event stream and
// REST API v4. No dependencies.
//
// Required: OASIS_MATTERMOST_URL (https://chat.example.com), OASIS_MATTERMOST_TOKEN
// (a bot account's access token, or a personal access token) and
// OASIS_MATTERMOST_ALLOWED_USERS (user IDs or usernames). Optional:
// OASIS_MATTERMOST_CHANNELS (channel IDs where every message is a task; elsewhere
// the bot answers direct messages and posts that @mention it).
//
// A direct message chat is one session; in a channel each thread is its own
// session and the agent answers inside the thread. Approvals are typed replies:
// "allow 3", "always 3" or "reject 3" (or yes / no).
import { chunkText, createChatCore, parseList } from './gateway-core.mjs';
import { createPairing, strangerMessage, withPairing } from './gateway-pairing.mjs';

const MAX_MESSAGE = 15000; // Mattermost's default limit is 16383 characters
const ID_RE = /^[a-z0-9]{26}$/;

/** "CHANNEL" or "CHANNEL:ROOT_POST" -> { channelId, rootId } */
export function splitChatKey(chatKey) {
  const [channelId, rootId = ''] = String(chatKey).split(':');
  return { channelId, rootId };
}

/** A `posted` WebSocket event -> the post, or null when it is not a user message. */
export function parsePostedEvent(event) {
  if (!event || event.event !== 'posted' || !event.data || !event.data.post) return null;
  let post;
  try { post = typeof event.data.post === 'string' ? JSON.parse(event.data.post) : event.data.post; } catch { return null; }
  if (!post || !post.id || !post.channel_id || !post.user_id) return null;
  if (post.type && post.type !== '') return null; // join/leave and other system posts
  let mentions = [];
  try { mentions = event.data.mentions ? JSON.parse(event.data.mentions) : []; } catch { mentions = []; }
  return {
    id: post.id,
    userId: post.user_id,
    channelId: post.channel_id,
    rootId: post.root_id || '',
    text: String(post.message || ''),
    fileIds: Array.isArray(post.file_ids) ? post.file_ids : [],
    channelType: String(event.data.channel_type || ''),
    mentions: Array.isArray(mentions) ? mentions : [],
    fromBot: Boolean(post.props && post.props.from_bot)
  };
}

export function createMattermostGateway(options = {}) {
  const env = options.env || process.env;
  const baseUrl = String(options.url || env.OASIS_MATTERMOST_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) throw new Error('Set OASIS_MATTERMOST_URL to your Mattermost server, e.g. https://chat.example.com.');
  const token = options.token || env.OASIS_MATTERMOST_TOKEN;
  if (!token || String(token).length < 20) throw new Error('Set OASIS_MATTERMOST_TOKEN to a bot account access token (Integrations, Bot Accounts).');
  const pairing = createPairing({ platform: 'mattermost', root: options.root, env, log: options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n')) });
  const allowedUsers = withPairing(options.allowedUsers || parseList(env.OASIS_MATTERMOST_ALLOWED_USERS), pairing);
  if (!allowedUsers.size && !pairing.enabled) throw new Error('Set OASIS_MATTERMOST_ALLOWED_USERS to the user IDs or usernames allowed to use this agent.');
  const listenChannels = options.channels || parseList(env.OASIS_MATTERMOST_CHANNELS);
  const fetchImpl = options.fetchImpl || fetch;
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const toldUnknown = new Set();
  const usernames = new Map();
  let me = options.me || null;
  let stopped = false;
  let socket = null;
  let seq = 1;

  async function api(method, route, body, { raw = false, timeoutMs = 30000 } = {}) {
    const response = await fetchImpl(baseUrl + '/api/v4' + route, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (raw) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return Buffer.from(await response.arrayBuffer());
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error('Mattermost ' + method + ' ' + route.split('?')[0] + ' failed: ' + response.status + ' ' + String(data && data.message || text || '').slice(0, 200));
    return data;
  }

  async function send(chatKey, text, _extra = {}) {
    const { channelId, rootId } = splitChatKey(chatKey);
    for (const part of chunkText(text, MAX_MESSAGE)) await api('POST', '/posts', { channel_id: channelId, message: part, ...(rootId ? { root_id: rootId } : {}) });
  }

  async function typing(chatKey) {
    const { channelId, rootId } = splitChatKey(chatKey);
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ seq: seq++, action: 'user_typing', data: { channel_id: channelId, parent_id: rootId } }));
  }

  const core = createChatCore({ ...options, platform: 'mattermost', env, log, send, typing, textApprovals: true });

  async function usernameOf(userId) {
    if (usernames.has(userId)) return usernames.get(userId);
    let name = '';
    try { name = String((await api('GET', '/users/' + encodeURIComponent(userId))).username || ''); } catch { name = ''; }
    usernames.set(userId, name);
    if (usernames.size > 500) usernames.delete(usernames.keys().next().value);
    return name;
  }

  async function handleEvent(event) {
    const post = parsePostedEvent(event);
    if (!post || !me || post.userId === me.id || post.fromBot) return;
    const direct = post.channelType === 'D';
    const mentioned = post.mentions.includes(me.id) || (me.username && new RegExp('(^|\\W)@' + me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(post.text));
    if (!direct && !mentioned && !listenChannels.has(post.channelId)) return;
    const chatKey = direct ? post.channelId : post.channelId + ':' + (post.rootId || post.id);
    const username = await usernameOf(post.userId);
    if (!allowedUsers.has(post.userId) && !(username && (allowedUsers.has(username) || allowedUsers.has('@' + username)))) {
      if (!toldUnknown.has(post.userId)) {
        toldUnknown.add(post.userId);
        await send(chatKey, strangerMessage({ pairing, id: post.userId, label: username ? '@' + username : '', idName: 'Mattermost user ID', envName: 'OASIS_MATTERMOST_ALLOWED_USERS' })).catch(() => {});
        log('ignored message from ' + post.userId);
      }
      return;
    }
    let text = post.text;
    if (me.username) text = text.replace(new RegExp('@' + me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), '').trim();
    const files = [];
    for (const fileId of post.fileIds.filter((id) => ID_RE.test(String(id))).slice(0, 10)) {
      let info = {};
      try { info = await api('GET', '/files/' + fileId + '/info'); } catch { info = {}; }
      files.push({ name: info.name || fileId, mime: info.mime_type, size: info.size, download: () => api('GET', '/files/' + fileId, null, { raw: true, timeoutMs: 60000 }) });
    }
    if (!text && !files.length) return;
    await core.handleText(chatKey, text, files);
  }

  function connect() {
    return new Promise((resolve) => {
      if (typeof WebSocketImpl !== 'function') throw new Error('This Node.js has no WebSocket; use Node 22 or later.');
      const ws = new WebSocketImpl(baseUrl.replace(/^http/, 'ws') + '/api/v4/websocket');
      socket = ws;
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ seq: seq++, action: 'authentication_challenge', data: { token } }));
        log('connected to Mattermost as @' + me.username + ' for ' + core.root + '; allowed users: ' + [...allowedUsers].join(', '));
      });
      ws.addEventListener('close', () => resolve());
      ws.addEventListener('error', () => { try { ws.close(); } catch {} resolve(); });
      ws.addEventListener('message', (event) => {
        let item;
        try { item = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        Promise.resolve(handleEvent(item)).catch((error) => log('message failed: ' + error.message));
      });
    });
  }

  async function run() {
    try { me = await api('GET', '/users/me'); } catch (error) { throw new Error('Cannot sign in to Mattermost at ' + baseUrl + ': ' + error.message); }
    let backoff = 1000;
    while (!stopped) {
      const started = Date.now();
      try { await connect(); } catch (error) { log(error.message); }
      if (stopped) break;
      if (Date.now() - started > 60000) backoff = 1000;
      log('disconnected; reconnecting in ' + Math.round(backoff / 1000) + 's');
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(60000, backoff * 2);
    }
  }

  function stop() {
    stopped = true;
    core.stop();
    try { if (socket) socket.close(1000); } catch {}
  }

  return { run, stop, connect, handleEvent, core, setMe: (value) => { me = value; } };
}

/** Routine delivery: post one message to a channel ID. */
export async function deliverMattermost(channelId, text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(env.OASIS_MATTERMOST_URL || '').replace(/\/+$/, '');
  if (!baseUrl || !env.OASIS_MATTERMOST_TOKEN) throw new Error('delivery to mattermost needs OASIS_MATTERMOST_URL and OASIS_MATTERMOST_TOKEN');
  for (const part of chunkText(text, MAX_MESSAGE)) {
    const response = await fetchImpl(baseUrl + '/api/v4/posts', { method: 'POST', headers: { authorization: 'Bearer ' + env.OASIS_MATTERMOST_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ channel_id: channelId, message: part }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Mattermost delivery failed: HTTP ' + response.status);
  }
}
