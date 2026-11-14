// Mid-turn steering: messages typed while OASIS works are delivered at the next model step.
// Extracted from agent.mjs, which re-exports the public names.

// Mid-turn steering. A message the user sends while a turn is running is
// delivered to the model at its next step, as a real user message, instead of
// waiting for the whole turn to finish. If the model was about to give its
// final answer, the turn continues so the message is handled, not dropped.
// Anything still undelivered when the turn ends is returned to the caller
// (takeSteering) so the interface can send it as the next prompt.
export const STEER_LIMIT = 20;
// Same bound as a web chat message: a steer is a user message too, and it
// used to be cut at 20,000 characters with no note.
export const MAX_STEER_CHARS = 200_000;
/**
 * Keep at most STEER_LIMIT carried notes without losing instructions: when
 * there are more, the oldest ones are merged into the first entry (newest
 * text kept if the merged note would pass MAX_STEER_CHARS).
 */
export const STEERING_CUT_NOTE = '[Older steering notes were shortened to fit.]\n';
export function foldSteering(notes) {
  const list = (Array.isArray(notes) ? notes : []).filter((note) => typeof note === 'string' && note.trim());
  if (list.length <= STEER_LIMIT) return list;
  let merged = list.slice(0, list.length - STEER_LIMIT + 1).join('\n\n');
  if (merged.length > MAX_STEER_CHARS) merged = STEERING_CUT_NOTE + merged.slice(merged.length - (MAX_STEER_CHARS - STEERING_CUT_NOTE.length));
  return [merged, ...list.slice(list.length - STEER_LIMIT + 1)];
}
export function steerSession(session, text) {
  const value = String(text == null ? '' : text).trim();
  if (!session || !value) return false;
  const queue = Array.isArray(session.steering) ? session.steering : (session.steering = []);
  if (queue.length >= STEER_LIMIT) return false;
  queue.push({ text: value.slice(0, MAX_STEER_CHARS), at: Date.now() });
  return true;
}
export function pendingSteering(session) {
  return session && Array.isArray(session.steering) ? session.steering.length : 0;
}
export function takeSteering(session) {
  if (!session || !Array.isArray(session.steering) || !session.steering.length) return [];
  return session.steering.splice(0).map((entry) => entry.text);
}
export function steeringMessage(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text || '').trim()).filter(Boolean);
  if (!list.length) return '';
  const body = list.length === 1 ? list[0] : list.map((text, index) => (index + 1) + '. ' + text).join('\n');
  return 'The user sent ' + (list.length === 1 ? 'this message' : 'these messages') + ' while you were working:\n\n' + body + '\n\n' +
    'This is their latest instruction and takes priority over earlier plans. Acknowledge it in one short sentence, adjust your plan, and keep going. ' +
    'Do not restart work that is already done, and stop only if they asked you to stop.';
}

/**
 * Move steering notes that the active turn could not consume into session
 * history, so the next turn still receives them after the session is saved.
 */
export function carryUndeliveredSteering(session) {
  const texts = takeSteering(session);
  if (!texts.length) return [];
  const existing = Array.isArray(session.pendingSteering) ? session.pendingSteering : [];
  const combined = [...existing, ...texts]
    .filter((text) => typeof text === 'string')
    .map((text) => text.trim().slice(0, MAX_STEER_CHARS))
    .filter(Boolean);
  // Keep every instruction (older ones merged) without changing or truncating the
  // existing conversation, which may contain an open tool-call sequence.
  session.pendingSteering = foldSteering(combined);
  return texts;
}
export function deliverSteering(session, options) {
  if (options.isSubagent) return 0;
  const texts = takeSteering(session);
  if (!texts.length) return 0;
  session.messages.push({ role: 'user', content: steeringMessage(texts) });
  if (typeof options.onSteer === 'function') { try { options.onSteer({ delivered: texts.length, texts }); } catch {} }
  return texts.length;
}
