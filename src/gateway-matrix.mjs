// Matrix gateway: `oasis gateway matrix` connects a Matrix account (Element,
// any homeserver) to this workspace's agent over the Client-Server API
// (/sync long-polling, no dependencies).
//
// Required: OASIS_MATRIX_HOMESERVER (https://matrix.example.org),
// OASIS_MATRIX_ACCESS_TOKEN (the bot account's access token) and
// OASIS_MATRIX_ALLOWED_USERS (comma-separated Matrix IDs such as @me:example.org).
// Optional: OASIS_MATRIX_ROOMS (room IDs where every message is a task; elsewhere
// the bot answers direct rooms and messages that mention it).
//
// The bot joins rooms it is invited to by an allowlisted user. Each room gets its
// own saved session. Approvals are answered by replying "allow 3", "always 3" or
// "reject 3" (or just yes / no when one is pending). End-to-end encrypted rooms are
// not supported: the bot says so once and ignores encrypted events.
import { chunkText, createChatCore, parseList } from './gateway-core.mjs';
import { createPairing, strangerMessage, withPairing } from './gateway-pairing.mjs';

const MAX_MESSAGE = 16000;
const SYNC_TIMEOUT_MS = 30000;

export function stripMatrixMention(text, userId, displayName) {
  let value = String(text || '');
  for (const name of [userId, displayName].filter(Boolean)) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp('^\\s*' + escaped + '\\s*[:,]?\\s*', 'i'), '').replace(new RegExp('\\s' + escaped + '\\b', 'gi'), ' ');
  }
  return value.trim();
}

export function matrixMentions(content, userId, displayName) {
  if (!content) return false;
  const mentions = content['m.mentions'];
  if (mentions && Array.isArray(mentions.user_ids) && mentions.user_ids.includes(userId)) return true;
  const body = String(content.body || '');
  if (userId && body.includes(userId)) return true;
  if (displayName && new RegExp('(^|\\s)' + String(displayName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(body)) return true;
  return String(content.formatted_body || '').includes('matrix.to/#/' + userId);
}

/** mxc://server/id -> [server, id], or null. */
export function parseMxc(uri) {
  const match = /^mxc:\/\/([A-Za-z0-9.:[\]-]+)\/([A-Za-z0-9_-]+)$/.exec(String(uri || ''));
  return match ? [match[1], match[2]] : null;
}

export function createMatrixGateway(options = {}) {
  const env = options.env || process.env;
  const homeserver = String(options.homeserver || env.OASIS_MATRIX_HOMESERVER || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(homeserver)) throw new Error('Set OASIS_MATRIX_HOMESERVER to your homeserver URL, e.g. https://matrix.example.org.');
  const token = options.token || env.OASIS_MATRIX_ACCESS_TOKEN;
  if (!token || String(token).length < 8) throw new Error('Set OASIS_MATRIX_ACCESS_TOKEN to the bot account\'s access token (Element: Settings → Help & About → Access token).');
  const pairing = createPairing({ platform: 'matrix', root: options.root, env, log: options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n')) });
  const allowedUsers = withPairing(options.allowedUsers || parseList(env.OASIS_MATRIX_ALLOWED_USERS), pairing);
  if (!allowedUsers.size && !pairing.enabled) throw new Error('Set OASIS_MATRIX_ALLOWED_USERS to the Matrix IDs allowed to use this agent, e.g. @me:example.org.');
  const listenRooms = options.rooms || parseList(env.OASIS_MATRIX_ROOMS);
  const fetchImpl = options.fetchImpl || fetch;
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const toldUnknown = new Set();
  const toldEncrypted = new Set();
  const memberCounts = new Map();
  let userId = options.userId || '';
  let displayName = options.displayName || '';
  let since = null;
  let txn = 0;
  let stopped = false;
  let pollController = null;

  async function api(method, route, body, { timeoutMs = 30000, signal } = {}) {
    const response = await fetchImpl(homeserver + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: signal || AbortSignal.timeout(timeoutMs) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error('Matrix ' + method + ' ' + route.split('?')[0] + ' failed: ' + response.status + ' ' + String(data && (data.error || data.errcode) || '').slice(0, 200));
    return data;
  }

  async function send(roomId, text, _extra = {}) {
    for (const part of chunkText(text, MAX_MESSAGE)) {
      const id = 'oasis' + Date.now().toString(36) + (++txn);
      await api('PUT', '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/send/m.room.message/' + id, { msgtype: 'm.text', body: part, 'm.mentions': {} });
    }
  }

  async function typing(roomId) {
    if (!userId) return;
    await api('PUT', '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/typing/' + encodeURIComponent(userId), { typing: true, timeout: 30000 });
  }

  const core = createChatCore({ ...options, env, log, send, typing, textApprovals: true });

  function download(content) {
    const parsed = parseMxc(content.url);
    return async () => {
      if (!parsed) throw new Error('unsupported media URL');
      const [server, mediaId] = parsed;
      // Authenticated media (Matrix 1.11) first, then the legacy unauthenticated route.
      for (const route of ['/_matrix/client/v1/media/download/', '/_matrix/media/v3/download/']) {
        const response = await fetchImpl(homeserver + route + encodeURIComponent(server) + '/' + encodeURIComponent(mediaId), { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(60000) });
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        if (response.status !== 404 && response.status !== 400) throw new Error('HTTP ' + response.status);
      }
      throw new Error('media not found');
    };
  }

  async function handleEvent(roomId, event) {
    if (!event || event.sender === userId) return;
    if (event.type === 'm.room.encrypted') {
      if (!toldEncrypted.has(roomId) && allowedUsers.has(String(event.sender))) {
        toldEncrypted.add(roomId);
        await send(roomId, 'This room is end-to-end encrypted, which the OASIS Matrix gateway cannot read. Use an unencrypted room or a direct chat with encryption turned off.').catch(() => {});
      }
      return;
    }
    if (event.type !== 'm.room.message' || !event.content) return;
    const content = event.content;
    if (content['m.relates_to'] && content['m.relates_to'].rel_type === 'm.replace') return; // edits
    const sender = String(event.sender || '');
    const direct = (memberCounts.get(roomId) || 0) > 0 && memberCounts.get(roomId) <= 2;
    const mentioned = matrixMentions(content, userId, displayName);
    if (!direct && !mentioned && !listenRooms.has(roomId)) return;
    if (!allowedUsers.has(sender)) {
      if (!toldUnknown.has(sender)) {
        toldUnknown.add(sender);
        await send(roomId, strangerMessage({ pairing, id: sender, idName: 'Matrix ID', envName: 'OASIS_MATRIX_ALLOWED_USERS' })).catch(() => {});
        log('ignored message from ' + sender);
      }
      return;
    }
    const msgtype = String(content.msgtype || '');
    const files = ['m.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype) && content.url
      ? [{ name: content.filename || content.body || msgtype.slice(2), mime: content.info && content.info.mimetype, size: content.info && content.info.size, download: download(content) }]
      : [];
    const text = files.length ? (content.filename && content.body !== content.filename ? String(content.body || '') : '') : stripMatrixMention(content.body, userId, displayName);
    if (!text && !files.length) return;
    await core.handleText(roomId, text, files);
  }

  async function handleSync(data, { initial = false } = {}) {
    if (!data) return;
    if (data.next_batch) since = data.next_batch;
    const rooms = data.rooms || {};
    for (const [roomId, room] of Object.entries(rooms.invite || {})) {
      const events = (room.invite_state && room.invite_state.events) || [];
      const invite = events.find((item) => item.type === 'm.room.member' && item.state_key === userId);
      const inviter = String(invite && invite.sender || '');
      if (allowedUsers.has(inviter)) {
        await api('POST', '/_matrix/client/v3/join/' + encodeURIComponent(roomId), {}).then(() => log('joined ' + roomId + ' (invited by ' + inviter + ')')).catch((error) => log(error.message));
      } else {
        await api('POST', '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/leave', {}).catch(() => {});
        log('declined invite to ' + roomId + ' from ' + (inviter || 'unknown'));
      }
    }
    for (const [roomId, room] of Object.entries(rooms.join || {})) {
      const summary = room.summary || {};
      if (summary['m.joined_member_count'] !== undefined) memberCounts.set(roomId, Number(summary['m.joined_member_count']) + Number(summary['m.invited_member_count'] || 0));
      if (initial) continue; // never replay history after a restart
      for (const event of (room.timeline && room.timeline.events) || []) await handleEvent(roomId, event).catch((error) => log('event failed: ' + error.message));
    }
  }

  async function syncOnce(timeoutMs = SYNC_TIMEOUT_MS) {
    const query = new URLSearchParams({ timeout: String(timeoutMs) });
    if (since) query.set('since', since);
    else query.set('filter', JSON.stringify({ room: { timeline: { limit: 1 } } }));
    pollController = new AbortController();
    const timer = setTimeout(() => pollController.abort(), timeoutMs + 20000);
    try {
      const initial = !since;
      const data = await api('GET', '/_matrix/client/v3/sync?' + query, null, { signal: pollController.signal });
      await handleSync(data, { initial });
      return data;
    } finally { clearTimeout(timer); }
  }

  async function run() {
    const me = await api('GET', '/_matrix/client/v3/account/whoami');
    userId = String(me && me.user_id || userId);
    try { displayName = String((await api('GET', '/_matrix/client/v3/profile/' + encodeURIComponent(userId) + '/displayname')).displayname || ''); } catch {}
    await syncOnce(0);
    log('connected to ' + homeserver + ' as ' + userId + ' for ' + core.root + '; allowed users: ' + [...allowedUsers].join(', '));
    let backoff = 1000;
    while (!stopped) {
      try { await syncOnce(); backoff = 1000; } catch (error) {
        if (stopped) break;
        log(error.message + '; retrying in ' + Math.round(backoff / 1000) + 's');
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(60000, backoff * 2);
      }
    }
  }

  function stop() {
    stopped = true;
    core.stop();
    try { if (pollController) pollController.abort(); } catch {}
  }

  return { run, stop, syncOnce, handleSync, handleEvent, core, get userId() { return userId; }, memberCounts };
}

/** Routine delivery: post one message to a room with the gateway's credentials. */
export async function deliverMatrix(roomId, text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const homeserver = String(env.OASIS_MATRIX_HOMESERVER || '').replace(/\/+$/, '');
  const token = env.OASIS_MATRIX_ACCESS_TOKEN;
  if (!homeserver || !token) throw new Error('delivery to matrix needs OASIS_MATRIX_HOMESERVER and OASIS_MATRIX_ACCESS_TOKEN');
  for (const part of chunkText(text, MAX_MESSAGE)) {
    const response = await fetchImpl(homeserver + '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/send/m.room.message/oasis' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'm.text', body: part }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Matrix delivery failed: HTTP ' + response.status);
  }
}
