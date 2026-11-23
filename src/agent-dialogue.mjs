// Agent dialogue: typed messages between agents, with obligations.
//
// Free-text messages between agents lose track of who asked what. A worker
// asks a sibling for an interface decision, the sibling finishes without
// answering, and the asker waits or guesses; a challenge to a finding is read
// and ignored; "I'll handle the migration" is never delivered. Here every
// team_send_message carries a speech act, and the acts that expect something
// create an obligation the runtime tracks:
//
//   inform     share something; expects nothing
//   request    ask the recipient for something    -> recipient owes a reply
//   propose    suggest a plan or decision          -> recipient owes accept/reject
//   challenge  dispute something the recipient said or posted
//                                                  -> recipient owes a reply
//   commit     promise to deliver something        -> sender owes delivery
//   answer / accept / reject
//              reply to one of the above (reply_to: m_N)
//
// A message with reply_to m_N from the obligated party discharges m_N (for a
// commit, the sender's own follow-up delivers it). The obligations are then
// enforced where agents meet the runtime:
//
//   - the recipient's copy says what is expected and how to reply
//   - team_status lists open threads
//   - an agent that finishes with obligations outstanding returns them to
//     its parent (open_obligations), and every agent left waiting on it is
//     told the thread lapsed, so nobody waits for a reply that cannot come
//
// One ledger per session tree, on the shared agent registry, capped at 500
// messages.

export const SPEECH_ACTS = Object.freeze(['inform', 'request', 'propose', 'challenge', 'commit', 'answer', 'accept', 'reject']);
const OPENING = new Set(['request', 'propose', 'challenge', 'commit']);
const REPLIES = new Set(['answer', 'accept', 'reject']);
const MAX_MESSAGES = 500;
const MESSAGE_ID = /^m_[1-9]\d{0,8}$/;

const EXPECTS = {
  request: 'a reply: act "answer" (or "reject" if you cannot do it)',
  propose: 'a decision: act "accept" or "reject", with your reason',
  challenge: 'a response: act "answer" with your evidence, or "accept" if the challenge is right'
};

export function dialogueLedger(registry) {
  if (!registry.dialogue || !Array.isArray(registry.dialogue.messages)) registry.dialogue = { next: 1, messages: [] };
  return registry.dialogue;
}

function clean(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Who owes what for a message: the recipient for request/propose/challenge, the sender for commit. */
function obligated(message) {
  return message.act === 'commit' ? message.from : message.to;
}

function waiting(message) {
  return message.act === 'commit' ? message.to : message.from;
}

/**
 * Record one message. Validates the act and reply_to, and closes what the
 * reply discharges. Returns { message, closes, expects }.
 */
export function recordDialogue(registry, { from, to, act = 'inform', text, replyTo = '', about = '' }) {
  const ledger = dialogueLedger(registry);
  const kind = String(act || 'inform').trim().toLowerCase();
  if (!SPEECH_ACTS.includes(kind)) throw new Error('act must be one of ' + SPEECH_ACTS.join(', ') + '.');
  const reply = clean(replyTo, 20);
  if (reply && !MESSAGE_ID.test(reply)) throw new Error('reply_to must be a message id such as m_3.');
  if (REPLIES.has(kind) && !reply) throw new Error('act "' + kind + '" replies to a message: give reply_to (the m_N id in the message you are answering).');
  let target = null;
  if (reply) {
    target = ledger.messages.find((item) => item.id === reply);
    if (!target) throw new Error('No message ' + reply + ' in this session.');
    if (target.from !== from && target.to !== from) throw new Error(reply + ' is between ' + target.from + ' and ' + target.to + '; you can only reply to your own threads.');
    if ((kind === 'accept' || kind === 'reject') && !['request', 'propose', 'challenge'].includes(target.act)) throw new Error('"' + kind + '" answers a request, proposal or challenge; ' + reply + ' is ' + target.act + '.');
  }
  const message = { id: 'm_' + ledger.next++, from, to, act: kind, text: clean(text, 600), at: Date.now(), ...(reply ? { replyTo: reply } : {}), ...(clean(about, 200) ? { about: clean(about, 200) } : {}), ...(OPENING.has(kind) ? { open: true } : {}) };
  let closes = null;
  // The obligated party replying discharges the obligation.
  if (target && target.open && obligated(target) === from) {
    target.open = false;
    target.closedBy = message.id;
    target.outcome = kind === 'accept' ? 'accepted' : kind === 'reject' ? 'rejected' : target.act === 'commit' ? 'delivered' : 'answered';
    closes = target.id;
  }
  ledger.messages.push(message);
  if (ledger.messages.length > MAX_MESSAGES) {
    // Drop the oldest closed messages first; open ones are what matter.
    const index = ledger.messages.findIndex((item) => !item.open);
    ledger.messages.splice(index >= 0 ? index : 0, 1);
  }
  return { message, closes, expects: EXPECTS[kind] || null };
}

/** The header the recipient sees above the message body. */
export function dialogueHeader(message) {
  const expects = EXPECTS[message.act];
  return '[' + message.act + ' ' + message.id + (message.replyTo ? ', replying to ' + message.replyTo : '') + (message.about ? ', about ' + message.about : '') + ']'
    + (expects ? ' ' + message.from + ' expects ' + expects + ': team_send_message to "' + message.from + '", reply_to "' + message.id + '".' : '')
    + (message.act === 'commit' ? ' ' + message.from + ' has committed to this; it will reply_to ' + message.id + ' when delivered.' : '');
}

/** An agent's open threads: what it owes others and what it is waiting for. */
export function openObligations(registry, agentId) {
  const messages = dialogueLedger(registry).messages.filter((item) => item.open);
  const view = (item) => ({ id: item.id, act: item.act, from: item.from, to: item.to, text: item.text.slice(0, 200), ...(item.about ? { about: item.about } : {}) });
  return {
    owes: messages.filter((item) => obligated(item) === agentId).map(view),
    awaiting: messages.filter((item) => waiting(item) === agentId).map(view)
  };
}

/** Every open thread in the session (for team_status), optionally limited to a set of agents. */
export function openThreads(registry, members = null) {
  return dialogueLedger(registry).messages
    .filter((item) => item.open && (!members || members.has(item.from) || members.has(item.to)))
    .map((item) => ({ id: item.id, act: item.act, from: item.from, to: item.to, owed_by: obligated(item), text: item.text.slice(0, 160), ...(item.about ? { about: item.about } : {}), age_s: Math.round((Date.now() - item.at) / 1000) }));
}

/**
 * An agent finished: everything it still owed lapses. Returns the lapsed
 * messages so the caller can tell its parent and whoever was waiting.
 */
export function lapseObligations(registry, agentId) {
  const lapsed = [];
  for (const item of dialogueLedger(registry).messages) {
    if (!item.open || obligated(item) !== agentId) continue;
    item.open = false;
    item.outcome = 'lapsed';
    lapsed.push(item);
  }
  return lapsed;
}

export function describeLapse(item) {
  return item.act === 'commit'
    ? item.from + ' finished without delivering what it committed to in ' + item.id + ' ("' + item.text.slice(0, 160) + '"). Do it yourself or ask the coordinator.'
    : item.to + ' finished without replying to your ' + item.act + ' ' + item.id + ' ("' + item.text.slice(0, 160) + '"). Do not wait for it: decide yourself, or ask the coordinator.';
}
