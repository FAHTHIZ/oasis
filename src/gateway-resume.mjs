// Cross-platform continuity: /resume in a gateway chat continues a session
// saved by the terminal, the web app or another chat. The chat keeps saving
// to the same session ID, so `oasis --resume ID` picks it up again later.

import { driftLines } from './world-drift.mjs';

const LIST = 6;

/** What moved in the workspace since the resumed session was saved, for the chat reply. */
export function resumeDriftText(drift) {
  if (!drift) return '';
  return 'The workspace changed since then: ' + driftLines(drift).join(' ') + ' OASIS will tell the model before your next message.';
}

function age(updatedAt, now) {
  const ms = now - Date.parse(updatedAt || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago';
}

/**
 * Parses /resume arguments against this workspace's saved sessions.
 * Returns { text } to reply with, or { restore, text } when a session was loaded.
 */
export async function resumeCommand(args, { root, env = process.env, sessions, currentId = null, now = () => Date.now() } = {}) {
  const store = sessions || await import('./sessions.mjs');
  const all = (await store.listSessions(root, { env })).filter((item) => !item.archived && item.messages > 0);
  const choice = String(args[0] || '').trim();
  if (!choice) {
    if (!all.length) return { text: 'No saved sessions in ' + root + ' yet.' };
    const rows = all.slice(0, LIST).map((item, index) => (index + 1) + '. ' + (item.title || '(untitled)').slice(0, 60) + ' — ' + item.messages + ' messages, ' + (age(item.updatedAt, now()) || item.updatedAt) + ' [' + item.id.slice(0, 8) + ']' + (item.id === currentId ? ' (this chat)' : ''));
    return { text: 'Saved sessions in this workspace:\n' + rows.join('\n') + '\n\nSend /resume 1 (a number), /resume last, or /resume ID-PREFIX to continue one here.' };
  }
  let match = null;
  if (choice === 'last') match = all[0];
  else if (/^\d{1,2}$/.test(choice)) match = all[Number(choice) - 1];
  else {
    const hits = all.filter((item) => item.id.startsWith(choice.toLowerCase()));
    if (hits.length > 1) return { text: 'More than one session starts with ' + choice + '; send a longer prefix.' };
    match = hits[0];
  }
  if (!match) return { text: 'No saved session matches ' + choice + '. Send /resume to list them.' };
  const restore = await store.loadSession(root, match.id, { env });
  return {
    restore,
    text: 'Resumed "' + (match.title || match.id).slice(0, 80) + '" (' + restore.messages.length + ' messages). Carry on here; `oasis --resume ' + match.id + '` continues it in the terminal later.'
      + (restore.turnInProgress ? ' Its last turn stopped before finishing, so check the files before relying on it.' : '')
  };
}
