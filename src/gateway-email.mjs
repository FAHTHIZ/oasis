// Email gateway: `oasis gateway email` reads a mailbox over IMAP (IDLE, so new
// mail arrives in seconds) and answers over SMTP. Each email thread is its own
// saved session; replies keep the thread (In-Reply-To / References).
//
// Required: OASIS_EMAIL_IMAP_HOST, OASIS_EMAIL_SMTP_HOST, OASIS_EMAIL_USER,
// OASIS_EMAIL_PASSWORD (an app password) and OASIS_EMAIL_ALLOWED_SENDERS
// (addresses, or @domain.com for a whole domain). Optional: OASIS_EMAIL_ADDRESS
// (From, default the user), OASIS_EMAIL_IMAP_PORT (993), OASIS_EMAIL_SMTP_PORT
// (465, or 587 with STARTTLS), OASIS_EMAIL_MAILBOX (INBOX).
//
// From addresses are easy to forge, so a message only counts when the
// receiving server's Authentication-Results header shows dmarc=pass, or
// dkim=pass for the sender's domain. Only that server's header counts: the
// topmost one, or those whose authserv-id is in OASIS_EMAIL_AUTHSERV_ID
// (recommended, e.g. mx.google.com). OASIS_EMAIL_REQUIRE_AUTH=0 turns that off
// (for a private mail server that adds no such header). Auto-replies, mailing
// lists and bounces are ignored so two robots never answer each other forever.
import { createChatCore, parseList } from './gateway-core.mjs';

const MAX_REPLY = 200_000;

export function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

export function senderAllowed(address, allowed) {
  const normal = normalizeAddress(address);
  if (!normal || !normal.includes('@')) return false;
  const domain = '@' + normal.split('@').pop();
  for (const entry of allowed) {
    const rule = normalizeAddress(entry);
    if (rule === normal || (rule.startsWith('@') && rule === domain)) return true;
  }
  return false;
}

/** The authserv-id of one Authentication-Results value ("mx.google.com; ..." -> "mx.google.com"). */
export function authservId(value) {
  // RFC 8601: authserv-id [ CFWS authres-version ] ";" ... (a version number may follow the id).
  return String(value || '').split(';')[0].replace(/\([^)]*\)/g, ' ').trim().split(/\s+/)[0].toLowerCase();
}

/**
 * True when the receiving server vouched for the sender's domain (DMARC, or
 * DKIM aligned with From).
 *
 * Only the receiving server's own Authentication-Results header counts. A
 * sender can put any header in a message, including a forged
 * "Authentication-Results: x; dmarc=pass"; receiving servers prepend theirs,
 * so it is the topmost one. With trusted authserv-ids configured
 * (OASIS_EMAIL_AUTHSERV_ID, e.g. mx.google.com) only headers carrying one of
 * those ids are read, which also holds for a server that adds no header.
 */
export function senderAuthenticated(headers, fromAddress, { trustedIds = [] } = {}) {
  const domain = normalizeAddress(fromAddress).split('@').pop();
  if (!domain || !domain.includes('.')) return false;
  const raw = headers && (typeof headers.get === 'function' ? headers.get('authentication-results') : headers['authentication-results']);
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((item) => typeof item === 'string' ? item : item && item.value ? item.value : String(item));
  const trusted = new Set([...trustedIds].map((id) => String(id || '').trim().toLowerCase()).filter(Boolean));
  const considered = trusted.size ? values.filter((value) => trusted.has(authservId(value))) : values.slice(0, 1);
  for (const value of considered) {
    const text = String(value).toLowerCase();
    // Each result is its own ";"-separated clause; a header.from in one clause
    // must not vouch for a dmarc=pass in another.
    for (const clause of text.split(';').slice(1)) {
      if (/^\s*dmarc=pass\b/.test(clause)) {
        const from = /header\.from=([^\s;]+)/.exec(clause);
        if (from && from[1] === domain) return true;
      }
      const dkim = /^\s*dkim=pass\b.*?header\.(?:d|i)=@?([^\s;]+)/.exec(clause);
      if (dkim) {
        const signer = dkim[1].replace(/^.*@/, '');
        // Relaxed alignment: the signer is the From domain or a parent of it,
        // never a bare top-level label such as "com".
        if (signer.includes('.') && (signer === domain || domain.endsWith('.' + signer))) return true;
      }
    }
  }
  return false;
}

/** Auto-replies, bulk mail, lists and bounces must never start a turn. */
export function isAutomated(headers, fromAddress) {
  const get = (name) => {
    const value = headers && (typeof headers.get === 'function' ? headers.get(name) : headers[name]);
    return value === undefined || value === null ? '' : String(typeof value === 'object' && value.value !== undefined ? value.value : value).toLowerCase();
  };
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (/^(bulk|list|junk|auto_reply)$/.test(get('precedence'))) return true;
  if (get('list-id') || get('list-unsubscribe') || get('x-autoreply') || get('x-autorespond')) return true;
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(normalizeAddress(fromAddress));
}

/** The new text of a reply, without the quoted message below it. */
export function stripQuotedReply(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On .{4,200}wrote:\s*$/.test(line) || (/^\s*On .{4,200}$/.test(line) && /wrote:\s*$/.test(lines[i + 1] || ''))) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(line)) break;
    if (/^\s*From: .+/.test(line) && /^\s*(Sent|Date): .+/.test(lines[i + 1] || '')) break;
    if (/^-- ?$/.test(line)) break; // signature
    out.push(line);
  }
  return out.join('\n').trim();
}

function replySubject(subject) {
  const text = String(subject || '').trim() || 'OASIS';
  return /^re:/i.test(text) ? text : 'Re: ' + text;
}

function messageIds(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/\s+/);
  return list.map((item) => String(item).trim()).filter((item) => /^<[^<>\s]{3,300}>$/.test(item));
}

export function createEmailGateway(options = {}) {
  const env = options.env || process.env;
  const imapHost = options.imapHost || env.OASIS_EMAIL_IMAP_HOST;
  const smtpHost = options.smtpHost || env.OASIS_EMAIL_SMTP_HOST;
  const user = options.user || env.OASIS_EMAIL_USER;
  const password = options.password || env.OASIS_EMAIL_PASSWORD;
  if (!imapHost) throw new Error('Set OASIS_EMAIL_IMAP_HOST (for Gmail: imap.gmail.com) and OASIS_EMAIL_SMTP_HOST (smtp.gmail.com).');
  if (!smtpHost) throw new Error('Set OASIS_EMAIL_SMTP_HOST, the outgoing mail server (for Gmail: smtp.gmail.com).');
  if (!user || !password) throw new Error('Set OASIS_EMAIL_USER and OASIS_EMAIL_PASSWORD (an app password, not your normal password).');
  const allowed = options.allowedSenders || parseList(env.OASIS_EMAIL_ALLOWED_SENDERS);
  if (![...allowed].length) throw new Error('Set OASIS_EMAIL_ALLOWED_SENDERS to the addresses (or @domain.com) allowed to email this agent.');
  const address = normalizeAddress(options.address || env.OASIS_EMAIL_ADDRESS || user);
  const requireAuth = options.requireAuth !== undefined ? options.requireAuth : !/^(0|false|off|no)$/i.test(String(env.OASIS_EMAIL_REQUIRE_AUTH || ''));
  const trustedIds = options.authservIds || parseList(env.OASIS_EMAIL_AUTHSERV_ID);
  const mailbox = options.mailbox || env.OASIS_EMAIL_MAILBOX || 'INBOX';
  const imapPort = Number(options.imapPort || env.OASIS_EMAIL_IMAP_PORT || 993);
  const smtpPort = Number(options.smtpPort || env.OASIS_EMAIL_SMTP_PORT || 465);
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const threads = new Map();
  const toldUnknown = new Set();
  let transport = options.transport || null;
  let client = null;
  let stopped = false;

  async function smtp() {
    if (transport) return transport;
    const nodemailer = (await import('nodemailer')).default;
    transport = nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort === 465, requireTLS: smtpPort !== 465, auth: { user, pass: password } });
    return transport;
  }

  async function send(chatKey, text, _extra = {}) {
    const thread = threads.get(chatKey);
    if (!thread) throw new Error('no email thread for ' + chatKey);
    const body = String(text || '').slice(0, MAX_REPLY);
    const info = await (await smtp()).sendMail({
      from: options.fromName || env.OASIS_EMAIL_FROM_NAME ? { name: options.fromName || env.OASIS_EMAIL_FROM_NAME, address } : address,
      to: thread.to,
      subject: replySubject(thread.subject),
      text: body,
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
      ...(thread.lastId ? { inReplyTo: thread.lastId, references: [...thread.references, thread.lastId].slice(-20).join(' ') } : {})
    });
    if (info && info.messageId) { thread.references = [...thread.references, ...(thread.lastId ? [thread.lastId] : [])].slice(-20); thread.lastId = info.messageId; }
  }

  const core = createChatCore({ ...options, platform: 'email', env, log, send, textApprovals: true });

  /** parsed: a mailparser ParsedMail (or the same shape). */
  async function handleParsed(parsed) {
    const from = parsed && parsed.from && parsed.from.value && parsed.from.value[0];
    const sender = normalizeAddress(from && from.address);
    if (!sender || sender === address) return 'ignored-self';
    if (isAutomated(parsed.headers, sender)) return 'ignored-automated';
    if (!senderAllowed(sender, allowed)) {
      if (!toldUnknown.has(sender)) { toldUnknown.add(sender); log('ignored email from ' + sender + ' (not in OASIS_EMAIL_ALLOWED_SENDERS)'); }
      return 'ignored-stranger';
    }
    if (requireAuth && !senderAuthenticated(parsed.headers, sender, { trustedIds })) { log('ignored email from ' + sender + ': no dmarc=pass or aligned dkim=pass in ' + ([...trustedIds].length ? 'an Authentication-Results header from ' + [...trustedIds].join(', ') : 'the receiving server\'s Authentication-Results header') + ' (set OASIS_EMAIL_REQUIRE_AUTH=0 for a server that adds none)'); return 'ignored-unauthenticated'; }
    const references = messageIds(parsed.references);
    const messageId = messageIds(parsed.messageId)[0] || '';
    const rootId = references[0] || messageIds(parsed.inReplyTo)[0] || messageId || String(parsed.subject || '');
    const chatKey = sender + ' ' + rootId;
    const thread = threads.get(chatKey) || { to: sender, subject: parsed.subject || 'OASIS', references: [], lastId: '' };
    thread.references = [...new Set([...references, ...thread.references])].slice(-20);
    if (messageId) thread.lastId = messageId;
    threads.set(chatKey, thread);
    const text = stripQuotedReply(parsed.text || '') || (references.length ? '' : String(parsed.subject || '').trim());
    const files = (Array.isArray(parsed.attachments) ? parsed.attachments : []).filter((item) => item && item.content && item.contentDisposition !== 'inline').map((item) => ({ name: item.filename || 'attachment', mime: item.contentType, size: item.size, download: async () => item.content }));
    const prompt = references.length || !parsed.subject || text === String(parsed.subject).trim() ? text : String(parsed.subject).trim() + '\n\n' + text;
    if (!prompt && !files.length) return 'ignored-empty';
    await core.handleText(chatKey, prompt, files);
    return chatKey;
  }

  async function handleRaw(source) {
    const { simpleParser } = await import('mailparser');
    return handleParsed(await simpleParser(source));
  }

  async function connectOnce() {
    const { ImapFlow } = await import('imapflow');
    client = options.createImap ? options.createImap() : new ImapFlow({ host: imapHost, port: imapPort, secure: imapPort === 993, auth: { user, pass: password }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    let lastUid = 0;
    try {
      const status = client.mailbox || {};
      lastUid = Math.max(0, Number(status.uidNext || 1) - 1); // only mail that arrives from now on
      log('watching ' + mailbox + ' of ' + address + ' for ' + core.root + '; allowed senders: ' + [...allowed].join(', '));
      if (requireAuth && ![...trustedIds].length) log('sender check reads the topmost Authentication-Results header; set OASIS_EMAIL_AUTHSERV_ID to your mail server\'s id (for Gmail: mx.google.com) so a forged header can never count');
      const drain = async () => {
        const fresh = [];
        for await (const message of client.fetch({ uid: (lastUid + 1) + ':*' }, { uid: true, source: true }, { uid: true })) {
          if (Number(message.uid) <= lastUid) continue;
          fresh.push(message);
        }
        for (const message of fresh) {
          lastUid = Math.max(lastUid, Number(message.uid));
          await client.messageFlagsAdd({ uid: message.uid }, ['\\Seen'], { uid: true }).catch(() => {});
          await handleRaw(message.source).catch((error) => log('email failed: ' + error.message));
        }
      };
      await new Promise((resolve) => {
        let running = Promise.resolve();
        client.on('exists', () => { running = running.then(drain).catch((error) => log(error.message)); });
        client.on('close', resolve);
        client.on('error', (error) => { log('IMAP error: ' + error.message); resolve(); });
      });
    } finally {
      try { lock.release(); } catch {}
    }
  }

  async function run() {
    let backoff = 1000;
    while (!stopped) {
      const started = Date.now();
      try { await connectOnce(); } catch (error) { log('IMAP: ' + error.message); }
      if (stopped) break;
      if (Date.now() - started > 60000) backoff = 1000;
      log('mailbox connection closed; reconnecting in ' + Math.round(backoff / 1000) + 's');
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(60000, backoff * 2);
    }
  }

  function stop() {
    stopped = true;
    core.stop();
    try { if (client) client.logout().catch(() => {}); } catch {}
  }

  return { run, stop, handleParsed, handleRaw, core, threads };
}

/** Routine delivery: one email to an address with the gateway's SMTP account. */
export async function deliverEmail(to, text, { env = process.env, transport = null } = {}) {
  const user = env.OASIS_EMAIL_USER;
  if (!env.OASIS_EMAIL_SMTP_HOST || !user || !env.OASIS_EMAIL_PASSWORD) throw new Error('delivery to email needs OASIS_EMAIL_SMTP_HOST, OASIS_EMAIL_USER and OASIS_EMAIL_PASSWORD');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) throw new Error('email: needs an address, e.g. email:me@example.com');
  const port = Number(env.OASIS_EMAIL_SMTP_PORT || 465);
  const mailer = transport || (await import('nodemailer')).default.createTransport({ host: env.OASIS_EMAIL_SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465, auth: { user, pass: env.OASIS_EMAIL_PASSWORD } });
  const subject = String(text || '').trim().split('\n')[0].slice(0, 120) || 'OASIS routine';
  await mailer.sendMail({ from: env.OASIS_EMAIL_ADDRESS || user, to, subject, text: String(text), headers: { 'Auto-Submitted': 'auto-generated' } });
}
