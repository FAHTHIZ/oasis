// Discord gateway: `oasis gateway discord` connects a Discord bot to this
// workspace's agent over the Discord Gateway WebSocket (no dependencies).
//
// Required: OASIS_DISCORD_BOT_TOKEN and OASIS_DISCORD_ALLOWED_USERS (comma-separated
// Discord user IDs). The bot answers direct messages and, in servers, messages that
// mention it (or every message in channels listed in OASIS_DISCORD_CHANNELS).
// Enable the Message Content intent for the bot in the Developer Portal.
// Each channel gets its own saved session. Approvals arrive as Allow / Always /
// Reject buttons that only allowlisted users can press.
import { chunkText, createChatCore, parseIdList, reconnectLoop } from './gateway-core.mjs';

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const MAX_MESSAGE = 1900;

export function stripMention(text, botId) {
  return botId ? String(text || '').replace(new RegExp('<@!?' + botId + '>', 'g'), '').trim() : String(text || '').trim();
}

export function createDiscordGateway(options = {}) {
  const env = options.env || process.env;
  const token = options.token || env.OASIS_DISCORD_BOT_TOKEN;
  if (!token || String(token).length < 50) throw new Error('Set OASIS_DISCORD_BOT_TOKEN to the bot token from the Discord Developer Portal.');
  const allowedUsers = options.allowedUsers || parseIdList(env.OASIS_DISCORD_ALLOWED_USERS);
  if (!allowedUsers.size) throw new Error('Set OASIS_DISCORD_ALLOWED_USERS to the Discord user IDs allowed to use this agent (DM the bot once to see yours).');
  const listenChannels = options.channels || parseIdList(env.OASIS_DISCORD_CHANNELS);
  const apiBase = String(options.apiBase || env.OASIS_DISCORD_API_BASE || API).replace(/\/+$/, '');
  const gatewayUrl = options.gatewayUrl || env.OASIS_DISCORD_GATEWAY_URL || GATEWAY;
  const fetchImpl = options.fetchImpl || fetch;
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const toldUnknown = new Set();
  let botId = options.botId || '';
  let stopped = false;
  let socket = null;

  async function api(method, route, body) {
    const response = await fetchImpl(apiBase + route, { method, headers: { authorization: 'Bot ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error('Discord ' + method + ' ' + route.replace(/\/[A-Za-z0-9_-]{60,}/g, '/…') + ' failed: ' + response.status + ' ' + String(data && data.message || '').slice(0, 200));
    return data;
  }

  function buttons(id, canAlways) {
    const button = (label, style, kind) => ({ type: 2, style, label, custom_id: 'oasis:' + kind + ':' + id });
    return [{ type: 1, components: [button('Allow', 3, 'a'), ...(canAlways ? [button('Always', 1, 'A')] : []), button('Reject', 4, 'r')] }];
  }

  async function send(channelId, text, extra = {}) {
    const parts = chunkText(text, MAX_MESSAGE);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await api('POST', '/channels/' + channelId + '/messages', { content: parts[i], allowed_mentions: { parse: [] }, ...(last && extra.approval ? { components: buttons(extra.approval.id, extra.approval.canAlways) } : {}) });
    }
  }

  const core = createChatCore({ ...options, env, log, send, typing: (channelId) => api('POST', '/channels/' + channelId + '/typing') });

  async function handleMessage(message) {
    if (!message || !message.author || message.author.bot) return;
    const userId = String(message.author.id);
    const isDm = !message.guild_id;
    const mentioned = Boolean(botId) && (Array.isArray(message.mentions) && message.mentions.some((user) => String(user.id) === botId) || String(message.content || '').includes('<@' + botId + '>') || String(message.content || '').includes('<@!' + botId + '>'));
    if (!isDm && !mentioned && !listenChannels.has(String(message.channel_id))) return;
    if (!allowedUsers.has(userId)) {
      if (!toldUnknown.has(userId)) {
        toldUnknown.add(userId);
        await send(message.channel_id, 'You are not allowed to use this agent. Your Discord user ID is ' + userId + '. Ask the owner to add it to OASIS_DISCORD_ALLOWED_USERS.').catch(() => {});
        log('ignored message from user ' + userId);
      }
      return;
    }
    const text = stripMention(message.content, botId);
    if (!text) { if (!(message.attachments || []).length) return; await send(message.channel_id, 'Only text messages are supported for now.'); return; }
    await core.handleText(String(message.channel_id), text);
  }

  async function handleInteraction(interaction) {
    if (!interaction || interaction.type !== 3 || !interaction.data) return;
    const [prefix, kind, id] = String(interaction.data.custom_id || '').split(':');
    if (prefix !== 'oasis') return;
    const user = interaction.member && interaction.member.user || interaction.user || {};
    const allowedUser = allowedUsers.has(String(user.id));
    const resolved = allowedUser && core.answer(String(interaction.channel_id), id, kind === 'r' ? 'reject' : kind === 'A' ? 'always' : 'allow');
    const original = String(interaction.message && interaction.message.content || '');
    const note = !allowedUser ? null : resolved ? (kind === 'r' ? 'Rejected' : kind === 'A' ? 'Always allowed' : 'Allowed') + ' by <@' + user.id + '>' : 'This approval is no longer pending.';
    const body = note ? { type: 7, data: { content: (original + '\n→ ' + note).slice(0, 2000), components: [], allowed_mentions: { parse: [] } } } : { type: 4, data: { content: 'You are not allowed to answer approvals for this agent.', flags: 64 } };
    await api('POST', '/interactions/' + interaction.id + '/' + interaction.token + '/callback', body).catch((error) => log(error.message));
  }

  async function dispatch(event, data) {
    if (event === 'READY') { botId = String(data && data.user && data.user.id || botId); log('connected as ' + (data && data.user && data.user.username) + ' for ' + core.root + '; allowed users: ' + [...allowedUsers].join(', ')); return; }
    if (event === 'MESSAGE_CREATE') return handleMessage(data);
    if (event === 'INTERACTION_CREATE') return handleInteraction(data);
  }

  function connect() {
    return new Promise((resolve) => {
      if (typeof WebSocketImpl !== 'function') throw new Error('This Node.js has no WebSocket; use Node 22 or later.');
      const ws = new WebSocketImpl(gatewayUrl);
      socket = ws;
      let heartbeat = null;
      let sequence = null;
      let acked = true;
      const finish = () => { if (heartbeat) clearInterval(heartbeat); heartbeat = null; resolve(); };
      ws.addEventListener('close', finish);
      ws.addEventListener('error', () => { try { ws.close(); } catch {} finish(); });
      ws.addEventListener('message', (event) => {
        let packet;
        try { packet = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        if (packet.s !== null && packet.s !== undefined) sequence = packet.s;
        if (packet.op === 10) {
          const interval = Number(packet.d && packet.d.heartbeat_interval) || 41250;
          heartbeat = setInterval(() => {
            if (!acked) { log('heartbeat not acknowledged; reconnecting'); try { ws.close(4000); } catch {} return; }
            acked = false;
            ws.send(JSON.stringify({ op: 1, d: sequence }));
          }, interval);
          if (heartbeat.unref) heartbeat.unref();
          ws.send(JSON.stringify({ op: 2, d: { token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: 'oasis', device: 'oasis' } } }));
        } else if (packet.op === 11) acked = true;
        else if (packet.op === 1) ws.send(JSON.stringify({ op: 1, d: sequence }));
        else if (packet.op === 7 || packet.op === 9) { try { ws.close(4000); } catch {} }
        else if (packet.op === 0) Promise.resolve(dispatch(packet.t, packet.d)).catch((error) => log('event failed: ' + error.message));
      });
    });
  }

  async function run() {
    await reconnectLoop(connect, { log, isStopped: () => stopped });
  }

  function stop() {
    stopped = true;
    core.stop();
    try { if (socket) socket.close(1000); } catch {}
  }

  return { run, stop, connect, dispatch, handleMessage, handleInteraction, core, get botId() { return botId; } };
}
