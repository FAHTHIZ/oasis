// Telegram gateway: `oasis gateway telegram` long-polls the Telegram Bot API
// and lets allowlisted chats talk to an OASIS agent in one workspace. Each chat
// gets its own saved session. Approvals arrive as Allow / Always / Reject
// buttons; anything unanswered for 10 minutes is rejected.
//
// Required: OASIS_TELEGRAM_BOT_TOKEN (from @BotFather) and
// OASIS_TELEGRAM_ALLOWED_CHATS (comma-separated numeric chat IDs). Messages
// from every other chat are ignored, apart from a one-line reply that shows
// the sender their chat ID so the owner can add it. No dependencies; uses fetch.
//
// Chat commands: /new (fresh session), /stop (cancel the running turn),
// /status, /mode default|acceptEdits|plan|auto, /help.
import path from 'node:path';
import { receiveAttachments, gatewayTranscriber } from './gateway-core.mjs';
import { speakableText, synthesizeSpeech, textToSpeechConfig, voiceReplyMode } from './tts.mjs';

const API = 'https://api.telegram.org';
const MAX_MESSAGE = 4000;
const APPROVAL_TIMEOUT_MS = 10 * 60000;

export function parseAllowedChats(value) {
  return new Set(String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter((item) => /^-?\d{1,20}$/.test(item)));
}

// Telegram caps messages at 4096 characters; split on line breaks when possible.
export function chunkMessage(text, size = MAX_MESSAGE) {
  const source = String(text || '').trim() || '(empty reply)';
  const parts = [];
  let rest = source;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

export function createTelegramGateway(options = {}) {
  const env = options.env || process.env;
  const token = options.token || env.OASIS_TELEGRAM_BOT_TOKEN;
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Set OASIS_TELEGRAM_BOT_TOKEN to the bot token from @BotFather.');
  const allowed = options.allowedChats || parseAllowedChats(env.OASIS_TELEGRAM_ALLOWED_CHATS);
  if (!allowed.size) throw new Error('Set OASIS_TELEGRAM_ALLOWED_CHATS to the numeric chat IDs allowed to use this agent (message the bot once to see yours).');
  const root = path.resolve(options.root || process.cwd());
  const base = String(options.apiBase || env.OASIS_TELEGRAM_API_BASE || API).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const deps = options.deps || {};
  const chats = new Map();
  const approvals = new Map();
  const toldUnknown = new Set();
  let offset = 0;
  let stopped = false;
  let approvalCounter = 0;
  let speechConfig;
  const defaultVoiceReply = voiceReplyMode(options.voiceReply !== undefined ? options.voiceReply : env.OASIS_GATEWAY_VOICE_REPLY);
  async function speech() {
    if (speechConfig !== undefined) return speechConfig;
    if (options.speechConfig !== undefined) return (speechConfig = options.speechConfig);
    let settings = options.settings || null;
    if (!settings) { try { settings = await (await import('./settings.mjs')).loadSettings(root, { env }); } catch { settings = {}; } }
    return (speechConfig = textToSpeechConfig(env, settings));
  }

  async function sendVoiceReply(chatId, text) {
    const config = await speech();
    if (!config) { log('voice reply skipped: text to speech is not configured (OASIS_TTS_API_KEY or OASIS_TTS_BASE_URL)'); return; }
    const spoken = speakableText(text);
    if (!spoken || spoken === '(code omitted)') return;
    api('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => {});
    // Telegram voice messages are OGG/Opus; OpenAI-compatible "opus" output is Ogg Opus.
    const audio = await synthesizeSpeech(config, { text: spoken, format: 'opus' }, { fetchImpl });
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('voice', new Blob([audio], { type: 'audio/ogg' }), 'reply.ogg');
    const response = await fetchImpl(base + '/bot' + token + '/sendVoice', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    const data = await response.json().catch(() => ({ ok: false }));
    if (!data.ok) throw new Error('Telegram sendVoice failed: ' + String(data.description || response.status).slice(0, 200));
  }

  const transcribe = options.transcribe !== undefined ? options.transcribe : gatewayTranscriber(env, options.settings || null, root);

  async function api(method, body) {
    const response = await fetchImpl(base + '/bot' + token + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: body && body.timeout ? AbortSignal.timeout((body.timeout + 15) * 1000) : AbortSignal.timeout(30000) });
    const data = await response.json().catch(() => ({ ok: false, description: 'invalid JSON from Telegram' }));
    if (!data.ok) throw new Error('Telegram ' + method + ' failed: ' + String(data.description || response.status).slice(0, 200));
    return data.result;
  }

  async function say(chatId, text, extra = {}) {
    for (const part of chunkMessage(text)) await api('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true, ...extra });
  }

  async function chatState(chatId) {
    if (chats.has(chatId)) return chats.get(chatId);
    const { createSession } = deps.agent || await import('./agent.mjs');
    const { loadConfig } = deps.config || await import('./config.mjs');
    const config = options.config || await loadConfig({ env });
    if (!config.configured) throw new Error('No model provider is configured. Run `oasis setup` first.');
    const session = await createSession({ root, config, env, permissionMode: options.permissionMode || null });
    session.headless = true;
    const state = { session, controller: null, queue: [], voiceReply: defaultVoiceReply };
    chats.set(chatId, state);
    return state;
  }

  function approvalButtons(id, canAlways) {
    return { inline_keyboard: [[{ text: 'Allow', callback_data: 'a:' + id }, ...(canAlways ? [{ text: 'Always', callback_data: 'A:' + id }] : []), { text: 'Reject', callback_data: 'r:' + id }]] };
  }

  async function runPrompt(chatId, text, extra = {}) {
    const state = await chatState(chatId);
    if (state.controller) { await say(chatId, 'Still working on the previous request. Send /stop to cancel it.'); return; }
    const { runAgentTurn } = deps.agent || await import('./agent.mjs');
    const controller = new AbortController();
    state.controller = controller;
    api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const tools = [];
    try {
      const turn = await runAgentTurn(state.session, text, {
        env,
        signal: controller.signal,
        ...(extra.images && extra.images.length ? { images: extra.images } : {}),
        onToolStart: ({ name }) => { tools.push(name); },
        approval: (message, _force = false, meta = {}) => new Promise((resolve) => {
          const id = String(++approvalCounter);
          const timer = setTimeout(() => { approvals.delete(id); resolve(false); say(chatId, 'Approval ' + id + ' timed out and was rejected.').catch(() => {}); }, APPROVAL_TIMEOUT_MS);
          approvals.set(id, { chatId, resolve: (value) => { clearTimeout(timer); approvals.delete(id); resolve(value); }, always: Boolean(meta && meta.suggestion) });
          say(chatId, 'Approval needed:\n' + String(message).slice(0, 3000), { reply_markup: approvalButtons(id, Boolean(meta && meta.suggestion)) }).catch((error) => { log(error.message); approvals.get(id) && approvals.get(id).resolve(false); });
        })
      });
      try { const { saveSession } = deps.sessions || await import('./sessions.mjs'); await saveSession(state.session, { env }); } catch {}
      if (controller.signal.aborted) await say(chatId, 'Stopped.');
      else {
        await say(chatId, (turn && turn.text ? turn.text : 'Done.') + (tools.length ? '\n\n(' + tools.length + ' tool call' + (tools.length === 1 ? '' : 's') + ')' : ''));
        const mode = state.voiceReply || 'off';
        if (turn && turn.text && (mode === 'always' || (mode === 'auto' && extra.fromVoice))) await sendVoiceReply(chatId, turn.text).catch((error) => log('voice reply failed: ' + error.message));
      }
    } catch (error) {
      await say(chatId, controller.signal.aborted ? 'Stopped.' : 'Error: ' + String(error && error.message || error).slice(0, 1000));
    } finally {
      state.controller = null;
      for (const [id, waiter] of approvals) if (waiter.chatId === chatId) waiter.resolve(false);
    }
  }

  async function command(chatId, text) {
    const [name, ...args] = text.trim().split(/\s+/);
    const cmd = name.replace(/@.*$/, '').toLowerCase();
    if (cmd === '/start' || cmd === '/help') return say(chatId, 'OASIS agent for ' + root + '.\nSend a message to give it a task.\n/new starts a fresh session, /stop cancels the running task, /status shows the session, /mode default|acceptEdits|plan|auto changes approvals, /voice on|off|auto sets spoken replies.'), true;
    if (cmd === '/new') {
      const state = chats.get(chatId);
      if (state && state.controller) state.controller.abort();
      chats.delete(chatId);
      await say(chatId, 'Started a fresh session.');
      return true;
    }
    if (cmd === '/stop') {
      const state = chats.get(chatId);
      if (state && state.controller) { state.controller.abort(); await say(chatId, 'Cancelling…'); } else await say(chatId, 'Nothing is running.');
      return true;
    }
    if (cmd === '/status') {
      const state = chats.get(chatId);
      await say(chatId, state ? 'Workspace: ' + root + '\nModel: ' + (state.session.config && state.session.config.model) + '\nMode: ' + (state.session.permissions && state.session.permissions.mode) + '\nMessages: ' + state.session.messages.length + '\nRunning: ' + (state.controller ? 'yes' : 'no') : 'No session yet. Send a task to start one.');
      return true;
    }
    if (cmd === '/voice') {
      const choice = String(args[0] || '').toLowerCase();
      const state = await chatState(chatId);
      if (!['on', 'off', 'auto'].includes(choice)) { await say(chatId, 'Voice replies: ' + state.voiceReply + '. Usage: /voice on|off|auto (auto answers voice notes with voice).'); return true; }
      state.voiceReply = choice === 'on' ? 'always' : choice;
      await say(chatId, 'Voice replies: ' + state.voiceReply + '.' + (state.voiceReply !== 'off' && !(await speech()) ? ' Text to speech is not configured yet; set OASIS_TTS_API_KEY or OASIS_TTS_BASE_URL.' : ''));
      return true;
    }
    if (cmd === '/mode') {
      const mode = args[0];
      if (!['default', 'acceptEdits', 'plan', 'auto'].includes(mode)) { await say(chatId, 'Usage: /mode default|acceptEdits|plan|auto'); return true; }
      const state = await chatState(chatId);
      if (typeof state.session.permissions.setMode === 'function') state.session.permissions.setMode(mode); else state.session.permissions.mode = mode;
      await say(chatId, 'Mode set to ' + mode + '.');
      return true;
    }
    return false;
  }

  async function handleUpdate(update) {
    if (update.callback_query) {
      const query = update.callback_query;
      const chatId = String(query.message && query.message.chat && query.message.chat.id || '');
      if (!allowed.has(chatId)) return;
      const [kind, id] = String(query.data || '').split(':');
      const waiter = approvals.get(id);
      await api('answerCallbackQuery', { callback_query_id: query.id, text: waiter ? (kind === 'r' ? 'Rejected' : 'Allowed') : 'This approval is no longer pending.' }).catch(() => {});
      if (waiter && waiter.chatId === chatId) waiter.resolve(kind === 'A' && waiter.always ? 'always' : kind === 'a' || kind === 'A');
      return;
    }
    const message = update.message;
    if (!message || !message.chat) return;
    const chatId = String(message.chat.id);
    if (!allowed.has(chatId)) {
      if (!toldUnknown.has(chatId)) {
        toldUnknown.add(chatId);
        await say(chatId, 'This chat is not allowed to use this agent. Chat ID: ' + chatId + '. Ask the owner to add it to OASIS_TELEGRAM_ALLOWED_CHATS.').catch(() => {});
        log('ignored message from chat ' + chatId);
      }
      return;
    }
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
    const files = telegramFiles(message);
    if (!text.trim() && !files.length) { await say(chatId, 'Send text, a photo or a file.'); return; }
    if (!files.length && text.startsWith('/') && await command(chatId, text)) return;
    let prompt = text, images = [], transcripts = [];
    if (files.length) ({ text: prompt, images, transcripts } = await receiveAttachments(root, text, files, { log, transcribe }));
    const fromVoice = Boolean(message.voice) && Array.isArray(transcripts) && transcripts.length > 0;
    runPrompt(chatId, prompt, { images, fromVoice }).catch((error) => log(error.message));
  }

  // Photos (largest size), documents, videos and audio; the Bot API serves files up to 20 MB.
  function telegramFiles(message) {
    const items = [];
    if (Array.isArray(message.photo) && message.photo.length) {
      const best = message.photo[message.photo.length - 1];
      items.push({ fileId: best.file_id, name: 'photo-' + String(best.file_unique_id || best.file_id).slice(0, 16) + '.jpg', mime: 'image/jpeg', size: best.file_size });
    }
    for (const key of ['document', 'video', 'audio', 'voice']) {
      const item = message[key];
      if (item && item.file_id) items.push({ fileId: item.file_id, name: item.file_name || key + '-' + String(item.file_unique_id || item.file_id).slice(0, 16) + (key === 'voice' ? '.ogg' : ''), mime: item.mime_type, size: item.file_size });
    }
    return items.map((item) => ({
      ...item,
      download: async () => {
        const info = await api('getFile', { file_id: item.fileId });
        if (!info || !info.file_path || /\.\./.test(info.file_path)) throw new Error('Telegram did not return a file path');
        const response = await fetchImpl(base + '/file/bot' + token + '/' + info.file_path, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return Buffer.from(await response.arrayBuffer());
      }
    }));
  }

  async function pollOnce(timeout = 30) {
    const updates = await api('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] });
    for (const update of updates || []) {
      offset = Math.max(offset, Number(update.update_id) + 1);
      await handleUpdate(update).catch((error) => log('update failed: ' + error.message));
    }
    return (updates || []).length;
  }

  async function run() {
    const me = await api('getMe', {});
    log('connected as @' + (me && me.username) + ' for ' + root + '; allowed chats: ' + [...allowed].join(', '));
    let backoff = 1000;
    while (!stopped) {
      try { await pollOnce(30); backoff = 1000; } catch (error) {
        if (stopped) break;
        log(error.message + '; retrying in ' + Math.round(backoff / 1000) + 's');
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(60000, backoff * 2);
      }
    }
  }

  function stop() {
    stopped = true;
    for (const state of chats.values()) if (state.controller) state.controller.abort();
    for (const waiter of approvals.values()) waiter.resolve(false);
  }

  return { run, stop, pollOnce, handleUpdate, chats, approvals };
}

export async function runGateway(args = [], options = {}) {
  const kind = String(args[0] || '').toLowerCase();
  let gateway;
  if (kind === 'telegram') gateway = createTelegramGateway(options);
  else if (kind === 'discord') gateway = (await import('./gateway-discord.mjs')).createDiscordGateway(options);
  else if (kind === 'slack') gateway = (await import('./gateway-slack.mjs')).createSlackGateway(options);
  else throw new Error('Usage: oasis gateway telegram|discord|slack\n  telegram: OASIS_TELEGRAM_BOT_TOKEN, OASIS_TELEGRAM_ALLOWED_CHATS\n  discord:  OASIS_DISCORD_BOT_TOKEN, OASIS_DISCORD_ALLOWED_USERS [, OASIS_DISCORD_CHANNELS]\n  slack:    OASIS_SLACK_APP_TOKEN, OASIS_SLACK_BOT_TOKEN, OASIS_SLACK_ALLOWED_USERS');
  const onSignal = () => { gateway.stop(); process.exit(0); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await gateway.run();
}
