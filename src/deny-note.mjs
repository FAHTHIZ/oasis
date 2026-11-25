// "No, and do this instead": a note given with a denial goes to whoever asked.
// A subagent's request gets the note in that agent's own inbox (it sees it at
// its next step); otherwise it steers the main agent. Shared by the terminal
// and the web server. Seen live: a note on a subagent's request reached the
// parent as a top-priority steer, and the parent dropped the other agent's answer.
import { agentRegistry } from './agent-tasks.mjs';
import { steerSession } from './agent.mjs';

const LIVE = new Set(['running', 'queued', 'starting']);
export const MAX_DENY_NOTE = 2000;

export function noteToSubagent(session, description, note) {
  if (!session || !description || !note) return false;
  let registry;
  try { registry = agentRegistry(session); } catch { return false; }
  const record = [...registry.agents.values()].reverse().find((item) => item && item.description === description && item.child && LIVE.has(String(item.status)));
  if (!record) return false;
  (record.child.inbox || (record.child.inbox = [])).push({ text: 'The user denied your last request and said:\n' + note + '\n\nDo that instead; do not ask for the same thing again.' });
  return true;
}

// Returns 'agent', 'main' or '' (nobody could take it).
export function deliverDenyNote(session, { subagent = '', note = '' } = {}, { steer = (text) => steerSession(session, text) } = {}) {
  const text = String(note || '').trim().slice(0, MAX_DENY_NOTE);
  if (!text) return '';
  if (subagent && noteToSubagent(session, String(subagent), text)) return 'agent';
  return steer(text) ? 'main' : '';
}
