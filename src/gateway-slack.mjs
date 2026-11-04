// Slack gateway: `oasis gateway slack` connects a Slack app to this workspace's
// agent over Socket Mode (no public URL, no dependencies).
//
// Required: OASIS_SLACK_APP_TOKEN (xapp-…, with connections:write),
// OASIS_SLACK_BOT_TOKEN (xoxb-…, with chat:write, app_mentions:read, im:history)
// and OASIS_SLACK_ALLOWED_USERS (comma-separated Slack member IDs such as U012ABC).
// The app answers direct messages and @mentions; each DM and each channel thread
// gets its own saved session, and replies go to the thread. Approvals arrive as
// Allow / Always / Reject buttons that only allowlisted users can press.
// Slack reserves "/", so chat commands also work as !new, !stop, !status, !mode.
import { chunkText, createChatCore, parseIdList, reconnectLoop } from './gateway-core.mjs';

const API = 'https://slack.com/api';
const MAX_MESSAGE = 3500;

export function slackChatKey(event) {
  if (event.channel_type === 'im') return String(event.channel);
  return String(event.channel) + ':' + String(event.thread_ts || event.ts);
}

export function stripSlackMention(text, botUserId) {
  const value = String(text || '');
  return (botUserId ? value.replace(new RegExp('<@' + botUserId + '(\\|[^>]*)?>', 'g'), '') : value.replace(/^<@[A-Z0-9]+(\|[^>]*)?>/, '')).trim();
}

export function createSlackGateway(options = {}) {
  const env = options.env || process.env;
  const appToken = options.appToken || env.OASIS_SLACK_APP_TOKEN;
  const botToken = options.botToken || env.OASIS_SLACK_BOT_TOKEN;
  if (!appToken || !/^xapp-/.test(appToken)) throw new Error('Set OASIS_SLACK_APP_TOKEN to the app-level token (xapp-…) with connections:write, and enable Socket Mode.');
  if (!botToken || !/^xoxb-/.test(botToken)) throw new Error('Set OASIS_SLACK_BOT_TOKEN to the bot token (xoxb-…).');
  const allowedUsers = options.allowedUsers || parseIdList(env.OASIS_SLACK_ALLOWED_USERS);
  if (!allowedUsers.size) throw new Error('Set OASIS_SLACK_ALLOWED_USERS to the Slack member IDs allowed to use this agent (DM the app once to see yours).');
  const apiBase = String(options.apiBase || env.OASIS_SLACK_API_BASE || API).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const toldUnknown = new Set();
  let botUserId = options.botUserId || '';
  let stopped = false;
  let socket = null;

  async function api(method, body, tokenOverride) {
    const response = await fetchImpl(apiBase + '/' + method, { method: 'POST', headers: { authorization: 'Bearer ' + (tokenOverride || botToken), 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30000) });
    const data = await response.json().catch(() => ({ ok: false, error: 'invalid JSON from Slack' }));
    if (!data.ok) throw new Error('Slack ' + method + ' failed: ' + String(data.error || response.status).slice(0, 200));
    return data;
  }

  function target(chatKey) {
    const [channel, thread] = String(chatKey).split(':');
    return thread ? { channel, thread_ts: thread } : { channel };
  }

  function approvalBlocks(text, id, canAlways, chatKey) {
    const button = (label, kind, style) => ({ type: 'button', text: { type: 'plain_text', text: label }, action_id: 'oasis_' + kind, value: id + '|' + chatKey, ...(style ? { style } : {}) });
    return [
      { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
      { type: 'actions', elements: [button('Allow', 'a', 'primary'), ...(canAlways ? [button('Always', 'A')] : []), button('Reject', 'r', 'danger')] }
    ];
  }

  async function send(chatKey, text, extra = {}) {
    const parts = chunkText(text, MAX_MESSAGE);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await api('chat.postMessage', { ...target(chatKey), text: parts[i], unfurl_links: false, ...(last && extra.approval ? { blocks: approvalBlocks(parts[i], extra.approval.id, extra.approval.canAlways, chatKey) } : {}) });
    }
  }

  const core = createChatCore({ ...options, env, log, send });

  async function handleEvent(event) {
    if (!event || event.bot_id || (event.subtype && event.subtype !== 'file_share') || (botUserId && event.user === botUserId)) return;
    const isDm = event.channel_type === 'im';
    if (event.type === 'message' && !isDm) return; // channel messages arrive as app_mention
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    const userId = String(event.user || '');
    const chatKey = slackChatKey(event);
    if (!allowedUsers.has(userId)) {
      if (!toldUnknown.has(userId)) {
        toldUnknown.add(userId);
        await send(chatKey, 'You are not allowed to use this agent. Your Slack member ID is ' + userId + '. Ask the owner to add it to OASIS_SLACK_ALLOWED_USERS.').catch(() => {});
        log('ignored message from user ' + userId);
      }
      return;
    }
    const text = stripSlackMention(event.text, botUserId);
    // Files need the files:read scope; Slack serves them only with the bot token.
    const files = (Array.isArray(event.files) ? event.files : []).filter((item) => item && /^https:\/\/files\.slack\.com\//.test(String(item.url_private_download || item.url_private || ''))).map((item) => ({
      name: item.name, mime: item.mimetype, size: item.size,
      download: async () => { const response = await fetchImpl(item.url_private_download || item.url_private, { headers: { authorization: 'Bearer ' + botToken }, signal: AbortSignal.timeout(60000) }); if (!response.ok) throw new Error('HTTP ' + response.status); const type = response.headers.get('content-type') || ''; if (/text\/html/.test(type) && !/html/.test(String(item.mimetype || ''))) throw new Error('Slack returned a login page; add the files:read scope'); return Buffer.from(await response.arrayBuffer()); }
    }));
    if (!text && !files.length) return;
    await core.handleText(chatKey, text, files);
  }

  async function handleInteractive(payload) {
    if (!payload || payload.type !== 'block_actions') return;
    const action = (payload.actions || [])[0];
    if (!action || !/^oasis_[aAr]$/.test(String(action.action_id))) return;
    const kind = String(action.action_id).slice(6);
    const [id, chatKey] = String(action.value || '').split(/\|(.*)/s);
    const userId = String(payload.user && payload.user.id || '');
    const channel = String(payload.channel && payload.channel.id || payload.container && payload.container.channel_id || '');
    if (!allowedUsers.has(userId) || !chatKey || target(chatKey).channel !== channel) return;
    const resolved = core.answer(chatKey, id, kind === 'r' ? 'reject' : kind === 'A' ? 'always' : 'allow');
    const ts = payload.container && payload.container.message_ts || payload.message && payload.message.ts;
    const original = String(payload.message && payload.message.text || 'Approval');
    const note = resolved ? (kind === 'r' ? 'Rejected' : kind === 'A' ? 'Always allowed' : 'Allowed') + ' by <@' + userId + '>' : 'This approval is no longer pending.';
    if (ts) await api('chat.update', { channel, ts, text: original + '\n→ ' + note, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: (original + '\n→ ' + note).slice(0, 2900) } }] }).catch((error) => log(error.message));
  }

  async function handleEnvelope(envelope, ws) {
    if (envelope.envelope_id && ws) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (envelope.type === 'events_api') return handleEvent(envelope.payload && envelope.payload.event);
    if (envelope.type === 'interactive') return handleInteractive(envelope.payload);
    if (envelope.type === 'disconnect' && ws) { try { ws.close(1000); } catch {} }
  }

  async function connect() {
    if (typeof WebSocketImpl !== 'function') throw new Error('This Node.js has no WebSocket; use Node 22 or later.');
    const { url } = await api('apps.connections.open', {}, appToken);
    await new Promise((resolve) => {
      const ws = new WebSocketImpl(url);
      socket = ws;
      ws.addEventListener('close', () => resolve());
      ws.addEventListener('error', () => { try { ws.close(); } catch {} resolve(); });
      ws.addEventListener('message', (event) => {
        let envelope;
        try { envelope = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        if (envelope.type === 'hello') { log('connected to Slack for ' + core.root + '; allowed users: ' + [...allowedUsers].join(', ')); return; }
        Promise.resolve(handleEnvelope(envelope, ws)).catch((error) => log('event failed: ' + error.message));
      });
    });
  }

  async function run() {
    try { botUserId = String((await api('auth.test', {})).user_id || botUserId); } catch (error) { throw new Error('Slack bot token check failed: ' + error.message); }
    await reconnectLoop(connect, { log, isStopped: () => stopped });
  }

  function stop() {
    stopped = true;
    core.stop();
    try { if (socket) socket.close(1000); } catch {}
  }

  return { run, stop, connect, handleEvent, handleInteractive, handleEnvelope, core };
}
