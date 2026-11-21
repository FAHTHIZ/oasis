// Signal gateway: `oasis gateway signal` talks to Signal through a local
// signal-cli REST API (https://github.com/bbernhard/signal-cli-rest-api), the
// open-source bridge most self-hosted Signal bots use. No dependencies.
//
//   docker run -p 8080:8080 -v $HOME/.local/share/signal-api:/home/.local/share/signal-cli \
//     -e MODE=json-rpc bbernhard/signal-cli-rest-api
//
// Required: OASIS_SIGNAL_API_URL (http://127.0.0.1:8080), OASIS_SIGNAL_NUMBER
// (the bot's registered or linked number, +15551234567) and
// OASIS_SIGNAL_ALLOWED_USERS (phone numbers or Signal UUIDs). Optional:
// OASIS_SIGNAL_GROUPS (group IDs where every message is a task; elsewhere the bot
// answers direct messages and group messages that mention it) and
// OASIS_SIGNAL_MODE=normal for the polling API (default: json-rpc WebSocket).
//
// Each direct chat and each group gets its own saved session. Approvals are
// answered by replying "allow 3", "always 3" or "reject 3" (or yes / no).
import { chunkText, createChatCore, parseList } from './gateway-core.mjs';
import { createPairing, strangerMessage, withPairing } from './gateway-pairing.mjs';

const MAX_MESSAGE = 6000;
const NUMBER_RE = /^\+[1-9]\d{6,15}$/;

/** signal-cli's internal group ID -> the "group.<base64>" recipient the REST API sends to. */
export function signalGroupRecipient(internalId) {
  return 'group.' + Buffer.from(String(internalId)).toString('base64');
}

/** One received envelope -> { sender, senderNumber, chatKey, text, attachments, mentioned, group } or null. */
export function parseSignalEnvelope(item, botNumber, botUuid = '') {
  const envelope = item && (item.envelope || item.params && item.params.envelope || item);
  if (!envelope) return null;
  const data = envelope.dataMessage;
  if (!data) return null;
  const senderNumber = String(envelope.sourceNumber || (NUMBER_RE.test(String(envelope.source || '')) ? envelope.source : '') || '');
  const senderUuid = String(envelope.sourceUuid || (!NUMBER_RE.test(String(envelope.source || '')) ? envelope.source || '' : ''));
  if ((senderNumber && senderNumber === botNumber) || (botUuid && senderUuid === botUuid)) return null;
  const groupId = data.groupInfo && (data.groupInfo.groupId || data.groupInfo.id);
  const mentions = Array.isArray(data.mentions) ? data.mentions : [];
  const mentioned = mentions.some((item2) => (item2.number && item2.number === botNumber) || (botUuid && item2.uuid === botUuid));
  let text = String(data.message || '');
  // Mentions arrive as U+FFFC placeholders; drop the ones that point at the bot.
  if (mentioned) text = text.replace(/\uFFFC/g, '').trim();
  return {
    sender: senderNumber || senderUuid,
    senderNumber,
    senderUuid,
    chatKey: groupId ? signalGroupRecipient(groupId) : senderNumber || senderUuid,
    group: Boolean(groupId),
    text: text.trim(),
    mentioned,
    attachments: Array.isArray(data.attachments) ? data.attachments : []
  };
}

export function createSignalGateway(options = {}) {
  const env = options.env || process.env;
  const apiUrl = String(options.apiUrl || env.OASIS_SIGNAL_API_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(apiUrl)) throw new Error('Set OASIS_SIGNAL_API_URL to your signal-cli REST API, e.g. http://127.0.0.1:8080 (see docs/GATEWAYS.md#signal).');
  const number = String(options.number || env.OASIS_SIGNAL_NUMBER || '').trim();
  if (!NUMBER_RE.test(number)) throw new Error('Set OASIS_SIGNAL_NUMBER to the bot\'s Signal number in international format, e.g. +15551234567.');
  const pairing = createPairing({ platform: 'signal', root: options.root, env, log: options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n')) });
  const allowedUsers = withPairing(options.allowedUsers || parseList(env.OASIS_SIGNAL_ALLOWED_USERS), pairing);
  if (!allowedUsers.size && !pairing.enabled) throw new Error('Set OASIS_SIGNAL_ALLOWED_USERS to the phone numbers (or Signal UUIDs) allowed to use this agent.');
  const listenGroups = options.groups || new Set([...parseList(env.OASIS_SIGNAL_GROUPS)].map((id) => id.startsWith('group.') ? id : signalGroupRecipient(id)));
  const mode = String(options.mode || env.OASIS_SIGNAL_MODE || 'json-rpc').toLowerCase();
  const fetchImpl = options.fetchImpl || fetch;
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const botUuid = options.botUuid || '';
  const toldUnknown = new Set();
  let stopped = false;
  let socket = null;

  async function api(method, route, body, timeoutMs = 30000) {
    const response = await fetchImpl(apiUrl + route, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new Error('Signal API ' + method + ' ' + route.split('?')[0] + ' failed: ' + response.status + ' ' + String(data && data.error || text || '').slice(0, 200));
    return data;
  }

  async function send(chatKey, text, _extra = {}) {
    for (const part of chunkText(text, MAX_MESSAGE)) await api('POST', '/v2/send', { message: part, number, recipients: [chatKey] });
  }

  async function typing(chatKey) {
    await api('PUT', '/v1/typing-indicator/' + encodeURIComponent(number), { recipient: chatKey });
  }

  const core = createChatCore({ ...options, env, log, send, typing, textApprovals: true });

  async function handleEnvelope(item) {
    const message = parseSignalEnvelope(item, number, botUuid);
    if (!message) return;
    if (message.group && !message.mentioned && !listenGroups.has(message.chatKey)) return;
    const allowed = (message.senderNumber && allowedUsers.has(message.senderNumber)) || (message.senderUuid && allowedUsers.has(message.senderUuid));
    if (!allowed) {
      if (!toldUnknown.has(message.sender)) {
        toldUnknown.add(message.sender);
        await send(message.chatKey, strangerMessage({ pairing, id: message.sender, idName: 'Signal ID', envName: 'OASIS_SIGNAL_ALLOWED_USERS' })).catch(() => {});
        log('ignored message from ' + message.sender);
      }
      return;
    }
    const files = message.attachments.filter((item2) => item2 && /^[\w.-]{1,200}$/.test(String(item2.id || ''))).map((item2) => ({
      name: item2.filename || item2.id, mime: item2.contentType, size: item2.size,
      download: async () => {
        const response = await fetchImpl(apiUrl + '/v1/attachments/' + encodeURIComponent(item2.id), { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return Buffer.from(await response.arrayBuffer());
      }
    }));
    if (!message.text && !files.length) return;
    await core.handleText(message.chatKey, message.text, files);
  }

  async function pollOnce(timeoutSeconds = 20) {
    const items = await api('GET', '/v1/receive/' + encodeURIComponent(number) + '?timeout=' + timeoutSeconds, null, (timeoutSeconds + 20) * 1000);
    for (const item of Array.isArray(items) ? items : []) await handleEnvelope(item).catch((error) => log('message failed: ' + error.message));
    return Array.isArray(items) ? items.length : 0;
  }

  function connect() {
    return new Promise((resolve) => {
      if (typeof WebSocketImpl !== 'function') throw new Error('This Node.js has no WebSocket; use Node 22 or later, or OASIS_SIGNAL_MODE=normal.');
      const ws = new WebSocketImpl(apiUrl.replace(/^http/, 'ws') + '/v1/receive/' + encodeURIComponent(number));
      socket = ws;
      ws.addEventListener('open', () => log('connected to Signal as ' + number + ' for ' + core.root + '; allowed users: ' + [...allowedUsers].join(', ')));
      ws.addEventListener('close', () => resolve());
      ws.addEventListener('error', () => { try { ws.close(); } catch {} resolve(); });
      ws.addEventListener('message', (event) => {
        let item;
        try { item = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        Promise.resolve(handleEnvelope(item)).catch((error) => log('message failed: ' + error.message));
      });
    });
  }

  async function run() {
    try { await api('GET', '/v1/about'); } catch (error) { throw new Error('Cannot reach the signal-cli REST API at ' + apiUrl + ': ' + error.message); }
    let backoff = 1000;
    if (mode === 'normal') log('polling Signal as ' + number + ' for ' + core.root + '; allowed users: ' + [...allowedUsers].join(', '));
    while (!stopped) {
      const started = Date.now();
      try { if (mode === 'normal') await pollOnce(); else await connect(); if (mode === 'normal') { backoff = 1000; continue; } } catch (error) { log(error.message); }
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

  return { run, stop, pollOnce, connect, handleEnvelope, core };
}

/** Routine delivery: send one message to a number or group.<id> recipient. */
export async function deliverSignal(recipient, text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiUrl = String(env.OASIS_SIGNAL_API_URL || '').replace(/\/+$/, '');
  const number = env.OASIS_SIGNAL_NUMBER;
  if (!apiUrl || !number) throw new Error('delivery to signal needs OASIS_SIGNAL_API_URL and OASIS_SIGNAL_NUMBER');
  for (const part of chunkText(text, MAX_MESSAGE)) {
    const response = await fetchImpl(apiUrl + '/v2/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: part, number, recipients: [recipient] }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Signal delivery failed: HTTP ' + response.status);
  }
}
