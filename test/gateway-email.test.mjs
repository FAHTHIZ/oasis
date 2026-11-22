import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { authservId, createEmailGateway, deliverEmail, isAutomated, senderAllowed, senderAuthenticated, stripQuotedReply } from '../src/gateway-email.mjs';
import { parseDeliver, deliverOutput } from '../src/routines.mjs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

function fakeAgent(onTurn) {
  return {
    createSession: async () => ({ messages: [], config: { model: 'm' }, permissions: { mode: 'default' } }),
    runAgentTurn: async (session, text, options) => onTurn(session, text, options)
  };
}
const deps = (agent) => ({ agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } });
function fakeTransport() { const sent = []; let n = 0; return { sent, sendMail: async (mail) => { sent.push(mail); return { messageId: '<reply' + (++n) + '@oasis>' }; } }; }

const raw = ({ from = 'me@example.com', subject = 'Fix the login test', body = 'It fails on CI.', auth = 'mx.example.net; dkim=pass header.d=example.com; spf=pass; dmarc=pass header.from=example.com', id = '<m1@example.com>', extra = '' } = {}) => [
  'Authentication-Results: ' + auth,
  'From: Me <' + from + '>',
  'To: bot@example.org',
  'Subject: ' + subject,
  'Message-ID: ' + id,
  ...(extra ? [extra] : []),
  'Content-Type: text/plain; charset=utf-8',
  '',
  body
].join('\r\n');

const options = (agent, transport, extra = {}) => ({ imapHost: 'imap.x', smtpHost: 'smtp.x', user: 'bot@example.org', password: 'pw', allowedSenders: new Set(['me@example.com', '@team.example.com']), transport, deps: deps(agent), transcribe: null, log: () => {}, ...extra });

test('sender rules', () => {
  const allowed = new Set(['me@example.com', '@team.example.com']);
  assert.ok(senderAllowed('ME@Example.com', allowed));
  assert.ok(senderAllowed('ann@team.example.com', allowed));
  assert.ok(!senderAllowed('ann@evil-team.example.com', allowed));
  assert.ok(!senderAllowed('example.com', allowed));
  assert.ok(senderAuthenticated({ 'authentication-results': 'mx; dmarc=pass header.from=example.com' }, 'me@example.com'));
  assert.ok(!senderAuthenticated({ 'authentication-results': 'mx; dmarc=pass header.from=evil.com' }, 'me@example.com'));
  assert.ok(senderAuthenticated({ 'authentication-results': 'mx; dkim=pass header.d=example.com; dmarc=none' }, 'me@example.com'));
  assert.ok(!senderAuthenticated({ 'authentication-results': 'mx; dkim=pass header.d=evil.com; spf=pass' }, 'me@example.com'));
  assert.ok(!senderAuthenticated({}, 'me@example.com'));
});

test('sender check ignores forged Authentication-Results headers', () => {
  // A sender can add any header; the receiving server prepends its own, so only the topmost counts.
  const forgedBelow = { 'authentication-results': ['mx.google.com; dmarc=fail header.from=example.com; spf=fail', 'evil; dmarc=pass header.from=example.com'] };
  assert.equal(senderAuthenticated(forgedBelow, 'me@example.com'), false);
  assert.equal(senderAuthenticated({ 'authentication-results': ['mx.google.com; dmarc=pass header.from=example.com', 'evil; dmarc=fail'] }, 'me@example.com'), true);
  // With trusted ids, a server that adds nothing cannot be impersonated by a forged topmost header.
  assert.equal(senderAuthenticated({ 'authentication-results': ['evil; dmarc=pass header.from=example.com'] }, 'me@example.com', { trustedIds: ['mx.google.com'] }), false);
  assert.equal(senderAuthenticated({ 'authentication-results': ['evil; dmarc=pass header.from=example.com', 'mx.google.com 1; dkim=pass header.i=@example.com'] }, 'me@example.com', { trustedIds: ['MX.Google.com'] }), true);
  // dmarc=pass without header.from, or with header.from in another clause, does not vouch.
  assert.equal(senderAuthenticated({ 'authentication-results': 'mx; dmarc=pass' }, 'me@example.com'), false);
  assert.equal(senderAuthenticated({ 'authentication-results': 'mx; dmarc=pass header.from=evil.com; spf=pass header.from=example.com' }, 'me@example.com'), false);
  // A DKIM signer must be the From domain or a real parent of it, never a bare TLD.
  assert.equal(senderAuthenticated({ 'authentication-results': 'mx; dkim=pass header.d=com' }, 'me@example.com'), false);
  assert.equal(senderAuthenticated({ 'authentication-results': 'mx; dkim=pass header.d=example.com' }, 'me@team.example.com'), true);
  assert.equal(authservId('mx.google.com 1 (comment); dmarc=pass'), 'mx.google.com');
  assert.ok(isAutomated({ 'auto-submitted': 'auto-replied' }, 'me@example.com'));
  assert.ok(isAutomated({ precedence: 'bulk' }, 'me@example.com'));
  assert.ok(isAutomated({}, 'MAILER-DAEMON@example.com'));
  assert.ok(!isAutomated({ 'auto-submitted': 'no' }, 'me@example.com'));
});

test('quoted replies are stripped', () => {
  assert.equal(stripQuotedReply('yes\n\nOn Mon, 1 Jan 2026 at 10:00, OASIS <bot@x> wrote:\n> Approval needed'), 'yes');
  assert.equal(stripQuotedReply('allow 2\n> quoted\n-- \nsig'), 'allow 2');
  assert.equal(stripQuotedReply('ok\n-----Original Message-----\nFrom: x'), 'ok');
  assert.equal(stripQuotedReply('line one\nline two'), 'line one\nline two');
});

test('email requires servers, credentials and allowlist', () => {
  assert.throws(() => createEmailGateway({ env: {} }), /IMAP_HOST/);
  assert.throws(() => createEmailGateway({ env: { OASIS_EMAIL_IMAP_HOST: 'i', OASIS_EMAIL_SMTP_HOST: 's' } }), /OASIS_EMAIL_USER/);
  assert.throws(() => createEmailGateway({ env: { OASIS_EMAIL_IMAP_HOST: 'i', OASIS_EMAIL_SMTP_HOST: 's', OASIS_EMAIL_USER: 'u', OASIS_EMAIL_PASSWORD: 'p' } }), /ALLOWED_SENDERS/);
});

test('an authenticated email runs a turn, the reply stays in the thread and a reply answers the approval', async () => {
  const transport = fakeTransport();
  let approved;
  const turns = [];
  const agent = fakeAgent(async (_s, text, opts) => { turns.push(text); approved = await opts.approval('Run npm test?', false, {}); return { text: 'Fixed: the token expired.' }; });
  const gateway = createEmailGateway(options(agent, transport));
  const key = await gateway.handleRaw(raw());
  await flush();
  assert.equal(key, 'me@example.com <m1@example.com>');
  assert.equal(turns[0], 'Fix the login test\n\nIt fails on CI.');
  const ask = transport.sent[0];
  assert.equal(ask.to, 'me@example.com');
  assert.equal(ask.subject, 'Re: Fix the login test');
  assert.equal(ask.inReplyTo, '<m1@example.com>');
  assert.equal(ask.headers['Auto-Submitted'], 'auto-replied');
  assert.match(ask.text, /Approval needed[\s\S]*yes \/ no/);
  // The user's reply quotes the approval mail; only "yes" counts.
  const replyKey = await gateway.handleRaw(raw({ subject: 'Re: Fix the login test', id: '<m2@example.com>', extra: 'In-Reply-To: <reply1@oasis>\r\nReferences: <m1@example.com> <reply1@oasis>', body: 'yes\r\n\r\nOn Mon, OASIS wrote:\r\n> Approval needed' }));
  await flush();
  assert.equal(replyKey, key, 'same thread, same session');
  assert.equal(approved, true);
  const final = transport.sent.find((mail) => mail.text === 'Fixed: the token expired.');
  assert.ok(final);
  assert.match(final.references, /<m1@example.com>/);
});

test('forged, automated and stranger mail never runs', async () => {
  const transport = fakeTransport();
  const turns = [];
  const agent = fakeAgent(async (_s, text) => { turns.push(text); return { text: 'x' }; });
  const gateway = createEmailGateway(options(agent, transport));
  assert.equal(await gateway.handleRaw(raw({ auth: 'mx; spf=fail; dkim=none; dmarc=fail header.from=example.com' })), 'ignored-unauthenticated');
  assert.equal(await gateway.handleRaw(raw({ extra: 'Auto-Submitted: auto-replied' })), 'ignored-automated');
  assert.equal(await gateway.handleRaw(raw({ from: 'boss@else.com', auth: 'mx; dmarc=pass header.from=else.com' })), 'ignored-stranger');
  assert.equal(await gateway.handleRaw(raw({ from: 'bot@example.org' })), 'ignored-self');
  await flush();
  assert.equal(turns.length, 0);
  assert.equal(transport.sent.length, 0);
  // Without the auth requirement (private server) the same unauthenticated mail runs.
  const open = createEmailGateway(options(agent, transport, { requireAuth: false }));
  await open.handleRaw(raw({ auth: 'mx; none' }));
  await flush();
  assert.equal(turns.length, 1);
});

test('IMAP loop only processes mail that arrives after start and marks it seen', async () => {
  const transport = fakeTransport();
  const turns = [];
  const agent = fakeAgent(async (_s, text) => { turns.push(text); return { text: 'ok' }; });
  class FakeImap extends EventEmitter {
    constructor() { super(); this.mailbox = { uidNext: 11 }; this.flags = []; this.store = [{ uid: 10, source: Buffer.from(raw({ subject: 'old' })) }]; }
    async connect() {}
    async getMailboxLock() { return { release() {} }; }
    async *fetch() { for (const item of this.store) yield item; }
    async messageFlagsAdd(range, flags) { this.flags.push([range.uid, flags[0]]); }
    async logout() { this.emit('close'); }
  }
  const imap = new FakeImap();
  const gateway = createEmailGateway(options(agent, transport, { createImap: () => imap }));
  const running = gateway.run();
  await flush();
  imap.store.push({ uid: 11, source: Buffer.from(raw({ subject: 'Deploy the docs', body: 'please', id: '<m9@example.com>' })) });
  imap.emit('exists');
  await flush(); await flush();
  assert.deepEqual(turns, ['Deploy the docs\n\nplease']);
  assert.deepEqual(imap.flags, [[11, '\\Seen']]);
  gateway.stop();
  await running;
});

test('email routine delivery', async () => {
  assert.equal(parseDeliver('email:me@example.com'), 'email:me@example.com');
  await assert.rejects(() => deliverEmail('me@example.com', 'x', { env: {} }), /OASIS_EMAIL_SMTP_HOST/);
  const transport = fakeTransport();
  await deliverEmail('me@example.com', 'weekly audit\n\nall clear', { env: { OASIS_EMAIL_SMTP_HOST: 's', OASIS_EMAIL_USER: 'bot@example.org', OASIS_EMAIL_PASSWORD: 'p' }, transport });
  assert.equal(transport.sent[0].subject, 'weekly audit');
  assert.equal(transport.sent[0].headers['Auto-Submitted'], 'auto-generated');
  await assert.rejects(() => deliverOutput({ id: 'r', deliver: 'email:not-an-address' }, 'x', { env: { OASIS_EMAIL_SMTP_HOST: 's', OASIS_EMAIL_USER: 'u', OASIS_EMAIL_PASSWORD: 'p' } }), /needs an address/);
});
