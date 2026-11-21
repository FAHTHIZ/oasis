// WhatsApp gateway: `oasis gateway whatsapp` uses Meta's official WhatsApp
// Business Cloud API. Meta delivers messages to a webhook, so this starts a small
// HTTP server; put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel, Tailscale
// Funnel) and register https://YOUR-HOST/webhook in the Meta app dashboard.
//
// Required: OASIS_WHATSAPP_TOKEN (a system-user access token),
// OASIS_WHATSAPP_PHONE_NUMBER_ID, OASIS_WHATSAPP_APP_SECRET (every webhook POST
// must carry a valid X-Hub-Signature-256), OASIS_WHATSAPP_VERIFY_TOKEN (any
// string; the dashboard sends it once to verify the URL) and
// OASIS_WHATSAPP_ALLOWED_USERS (phone numbers in international format, digits only
// or with +). Optional: OASIS_WHATSAPP_PORT (8787), OASIS_WHATSAPP_HOST (127.0.0.1).
//
// Each WhatsApp user gets one saved session. Approvals arrive as Allow / Always /
// Reject reply buttons; typed replies (yes / no, allow 3) work too.
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { chunkText, createChatCore, parseList } from './gateway-core.mjs';
import { createPairing, strangerMessage, withPairing } from './gateway-pairing.mjs';

const GRAPH = 'https://graph.facebook.com/v21.0';
const MAX_MESSAGE = 4000;
const MAX_BODY = 1024 * 1024;

export function normalizePhone(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

export function verifySignature(rawBody, header, appSecret) {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!match || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Webhook payload -> [{ from, id, type, text, media, buttonId }]. */
export function extractWhatsAppMessages(payload, phoneNumberId) {
  const out = [];
  for (const entry of (payload && payload.entry) || []) {
    for (const change of entry.changes || []) {
      const value = change && change.value;
      if (!value || change.field !== 'messages') continue;
      if (phoneNumberId && value.metadata && String(value.metadata.phone_number_id) !== String(phoneNumberId)) continue;
      for (const message of value.messages || []) {
        const type = String(message.type || '');
        const media = ['image', 'document', 'audio', 'video', 'sticker'].includes(type) && message[type] ? { id: message[type].id, mime: message[type].mime_type, name: message[type].filename || type + '-' + String(message[type].id || '').slice(-8) + (type === 'audio' ? '.ogg' : ''), caption: message[type].caption || '', voice: Boolean(message[type].voice) } : null;
        const buttonId = type === 'interactive' && message.interactive && message.interactive.button_reply ? String(message.interactive.button_reply.id || '') : type === 'button' && message.button ? String(message.button.payload || '') : '';
        out.push({ from: normalizePhone(message.from), id: String(message.id || ''), type, text: type === 'text' && message.text ? String(message.text.body || '') : media ? media.caption : '', media, buttonId });
      }
    }
  }
  return out;
}

export function createWhatsAppGateway(options = {}) {
  const env = options.env || process.env;
  const token = options.token || env.OASIS_WHATSAPP_TOKEN;
  const phoneNumberId = String(options.phoneNumberId || env.OASIS_WHATSAPP_PHONE_NUMBER_ID || '');
  const appSecret = options.appSecret || env.OASIS_WHATSAPP_APP_SECRET;
  const verifyToken = options.verifyToken || env.OASIS_WHATSAPP_VERIFY_TOKEN;
  if (!token) throw new Error('Set OASIS_WHATSAPP_TOKEN to a WhatsApp Cloud API access token (Meta app dashboard → WhatsApp → API setup, or a system-user token).');
  if (!/^\d{5,30}$/.test(phoneNumberId)) throw new Error('Set OASIS_WHATSAPP_PHONE_NUMBER_ID to the Phone number ID shown under WhatsApp → API setup.');
  if (!appSecret) throw new Error('Set OASIS_WHATSAPP_APP_SECRET (App settings → Basic → App secret); OASIS rejects webhook calls without a valid signature.');
  if (!verifyToken || String(verifyToken).length < 8) throw new Error('Set OASIS_WHATSAPP_VERIFY_TOKEN to a random string of 8+ characters and enter the same value in the webhook settings.');
  const pairing = createPairing({ platform: 'whatsapp', root: options.root, env, log: options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n')) });
  const allowed = withPairing(options.allowedUsers || new Set([...parseList(env.OASIS_WHATSAPP_ALLOWED_USERS)].map(normalizePhone).filter(Boolean)), pairing);
  if (!allowed.size && !pairing.enabled) throw new Error('Set OASIS_WHATSAPP_ALLOWED_USERS to the phone numbers allowed to use this agent, e.g. +15551234567.');
  const graph = String(options.graphBase || env.OASIS_WHATSAPP_GRAPH_BASE || GRAPH).replace(/\/+$/, '');
  const port = Number(options.port !== undefined ? options.port : env.OASIS_WHATSAPP_PORT || 8787);
  const host = options.host || env.OASIS_WHATSAPP_HOST || '127.0.0.1';
  const fetchImpl = options.fetchImpl || fetch;
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const seen = new Set();
  const toldUnknown = new Set();
  let server = null;

  async function api(body) {
    const response = await fetchImpl(graph + '/' + phoneNumberId + '/messages', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', ...body }), signal: AbortSignal.timeout(30000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error('WhatsApp send failed: ' + response.status + ' ' + String(data && data.error && data.error.message || '').slice(0, 200));
    return data;
  }

  async function send(to, text, extra = {}) {
    const parts = chunkText(text, MAX_MESSAGE);
    for (let i = 0; i < parts.length; i++) {
      const approval = i === parts.length - 1 && extra.approval;
      if (approval && parts[i].length <= 1024) {
        const button = (title, kind) => ({ type: 'reply', reply: { id: 'oasis:' + kind + ':' + approval.id, title } });
        await api({ to, type: 'interactive', interactive: { type: 'button', body: { text: parts[i] }, action: { buttons: [button('Allow', 'a'), ...(approval.canAlways ? [button('Always', 'A')] : []), button('Reject', 'r')] } } });
      } else {
        await api({ to, type: 'text', text: { body: parts[i], preview_url: false } });
      }
    }
  }

  const core = createChatCore({ ...options, env, log, send, textApprovals: true });

  function download(mediaId) {
    return async () => {
      const meta = await fetchImpl(graph + '/' + encodeURIComponent(mediaId), { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
      const info = await meta.json().catch(() => null);
      if (!meta.ok || !info || !/^https:\/\//.test(String(info.url || ''))) throw new Error('media lookup failed');
      const response = await fetchImpl(info.url, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return Buffer.from(await response.arrayBuffer());
    };
  }

  async function handleMessage(message) {
    if (!message.from || (message.id && seen.has(message.id))) return; // Meta retries deliveries
    if (message.id) { seen.add(message.id); if (seen.size > 2000) seen.delete(seen.values().next().value); }
    if (!allowed.has(message.from)) {
      if (!toldUnknown.has(message.from)) {
        toldUnknown.add(message.from);
        await send(message.from, strangerMessage({ pairing, id: message.from, label: '+' + message.from, idName: 'WhatsApp number', envName: 'OASIS_WHATSAPP_ALLOWED_USERS' })).catch(() => {});
        log('ignored message from +' + message.from);
      }
      return;
    }
    if (message.buttonId) {
      const [prefix, kind, id] = message.buttonId.split(':');
      if (prefix === 'oasis') {
        const resolved = core.answer(message.from, id, kind === 'r' ? 'reject' : kind === 'A' ? 'always' : 'allow');
        await send(message.from, resolved ? (kind === 'r' ? 'Rejected' : kind === 'A' ? 'Always allowed' : 'Allowed') + '.' : 'That approval is no longer pending.').catch(() => {});
      }
      return;
    }
    if (message.media && /^[\w.-]{1,200}$/.test(String(message.media.id || ''))) {
      await core.handleText(message.from, message.text, [{ name: message.media.name, mime: message.media.mime, download: download(message.media.id) }]);
      return;
    }
    if (message.text) await core.handleText(message.from, message.text);
  }

  /** The HTTP handler (exported for tests and for mounting behind your own server). */
  async function handleRequest(request, response) {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/webhook') { response.writeHead(404).end(); return; }
    if (request.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === verifyToken;
      response.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' }).end(ok ? String(url.searchParams.get('hub.challenge') || '') : 'forbidden');
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    if (!verifySignature(raw, request.headers['x-hub-signature-256'], appSecret)) { log('rejected a webhook call with a missing or invalid signature'); response.writeHead(401).end(); return; }
    response.writeHead(200).end('ok'); // acknowledge at once; Meta retries slow webhooks
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
    for (const message of extractWhatsAppMessages(payload, phoneNumberId)) await handleMessage(message).catch((error) => log('message failed: ' + error.message));
  }

  async function run() {
    server = http.createServer((request, response) => { handleRequest(request, response).catch((error) => { log(error.message); try { response.writeHead(500).end(); } catch {} }); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const address = server.address();
    log('WhatsApp webhook listening on http://' + host + ':' + (address && address.port) + '/webhook for ' + core.root + '; expose it over HTTPS and register it in the Meta dashboard. Allowed: +' + [...allowed].join(', +'));
    await new Promise((resolve) => server.once('close', resolve));
  }

  function stop() {
    core.stop();
    try { if (server) server.close(); } catch {}
  }

  return { run, stop, handleRequest, handleMessage, core, get server() { return server; } };
}

/** Routine delivery. WhatsApp only lets a business send free text within 24 hours of the user's last message. */
export async function deliverWhatsApp(to, text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!env.OASIS_WHATSAPP_TOKEN || !env.OASIS_WHATSAPP_PHONE_NUMBER_ID) throw new Error('delivery to whatsapp needs OASIS_WHATSAPP_TOKEN and OASIS_WHATSAPP_PHONE_NUMBER_ID');
  const graph = String(env.OASIS_WHATSAPP_GRAPH_BASE || GRAPH).replace(/\/+$/, '');
  for (const part of chunkText(text, MAX_MESSAGE)) {
    const response = await fetchImpl(graph + '/' + env.OASIS_WHATSAPP_PHONE_NUMBER_ID + '/messages', { method: 'POST', headers: { authorization: 'Bearer ' + env.OASIS_WHATSAPP_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'text', text: { body: part, preview_url: false } }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error('WhatsApp delivery failed: HTTP ' + response.status + (data && data.error && data.error.code === 131047 ? ' (more than 24 hours since the user last wrote; WhatsApp then allows only template messages)' : ''));
    }
  }
}
