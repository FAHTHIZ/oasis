import { stdout } from 'node:process';
import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { listSessions, deleteSession, staleSessions, pruneSessions, setSessionArchived, unarchivedSessions } from './sessions.mjs';

// Complete lines appended to a log since byte `offset`. `logs --follow` used to
// re-read the whole log every 700 ms, so a long run cost more on every poll.
// Newline bytes never occur inside a UTF-8 sequence, so cutting there is safe.
export async function readCompleteLinesFrom(file, offset = 0) {
  let handle;
  try { handle = await open(file, 'r'); } catch { return { text: '', offset }; }
  try {
    const { size } = await handle.stat();
    if (size < offset) offset = 0;
    if (size === offset) return { text: '', offset };
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
    return { text: buffer.subarray(0, end).toString('utf8'), offset: offset + end };
  } finally { await handle.close(); }
}

// `oasis sessions` and `oasis bg` (background sessions) subcommands.
export async function backgroundCommand(rest, { approve, interactive } = {}) {
  const bg = await import('./background-sessions.mjs');
  const [sub = 'list', query, ...more] = rest;
  if (sub === 'list' || sub === 'ls') {
    const entries = await bg.listBackgroundSessions(process.env);
    const activity = await Promise.all(entries.map((entry) => (entry.status === 'running' ? bg.readActivity(entry) : Promise.resolve(''))));
    const interrupted = entries.filter((entry) => entry.status === 'interrupted').length;
    if (interrupted) stdout.write(interrupted + ' run(s) stopped unexpectedly (crash, kill or reboot). oasis respawn --interrupted resumes them with their conversations.\n');
    const waiting = entries.filter((entry) => entry.pendingApproval).length;
    if (waiting) stdout.write(waiting + ' run(s) are waiting for your approval. oasis bg approve ID [--always] or oasis bg deny ID [reason] answers.\n');
    stdout.write(entries.length ? entries.map((entry, index) => bg.describeEntry(entry, activity[index])).join('\n') + '\n' : 'No background sessions. Start one with oasis --bg "task" or /background in a session.\n');
    return;
  }
  if (sub === 'respawn' && (query === '--all' || more.includes('--all'))) {
    const running = (await bg.listBackgroundSessions(process.env)).filter((entry) => entry.status === 'running');
    for (const entry of running) { await bg.respawnBackgroundSession(entry.id, process.env); stdout.write('Respawned ' + entry.id + '.\n'); }
    if (!running.length) stdout.write('No running background sessions to respawn.\n');
    return;
  }
  if (sub === 'respawn' && (query === '--interrupted' || more.includes('--interrupted'))) {
    const interrupted = (await bg.listBackgroundSessions(process.env)).filter((entry) => entry.status === 'interrupted');
    for (const entry of interrupted) { await bg.respawnBackgroundSession(entry.id, process.env); stdout.write('Resumed ' + entry.id + (entry.name ? ' (' + entry.name + ')' : '') + '.\n'); }
    if (!interrupted.length) stdout.write('No interrupted background sessions.\n');
    return;
  }
  if (!query) throw new Error('Usage: oasis bg [list] | logs ID [--follow] | send ID "message" | approve ID [--always] | deny ID [reason] | attach ID | stop ID | rm ID | respawn ID|--all|--interrupted');
  const id = await bg.resolveBackgroundId(query, process.env);
  if (sub === 'respawn') {
    const entry = await bg.respawnBackgroundSession(id, process.env);
    stdout.write('Respawned ' + entry.id + (entry.kind === 'exec' ? ' (re-running ' + entry.command + ')' : ' with its conversation intact') + '.\n  oasis logs ' + entry.id + ' --follow   watch progress\n');
    return;
  }
  if (sub === 'logs') {
    const entry = await bg.readEntry(id, process.env);
    const follow = more.includes('--follow') || more.includes('-f');
    let offset = 0;
    for (;;) {
      const next = await readCompleteLinesFrom(entry.logFile, offset);
      offset = next.offset;
      if (next.text) { const out = bg.renderLog(next.text); if (out) stdout.write(out + '\n'); }
      if (!follow || (await bg.readEntry(id, process.env)).status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return;
  }
  if (sub === 'send' || sub === 'message' || sub === 'steer') {
    const text = more.join(' ').trim();
    if (!text) throw new Error('Usage: oasis bg send ID "message"');
    await bg.sendToBackgroundSession(id, text, process.env);
    stdout.write('Sent to ' + id + '. It reads the message at its next step; oasis bg logs ' + id + ' --follow shows the reply.\n');
    return;
  }
  if (sub === 'approve' || sub === 'allow' || sub === 'deny' || sub === 'reject') {
    const allow = sub === 'approve' || sub === 'allow';
    const always = more.includes('--always');
    const reason = more.filter((word) => word !== '--always').join(' ').trim();
    const pending = await bg.answerBackgroundApproval(id, allow ? 'allow' : 'deny', process.env, { always, reason });
    stdout.write((allow ? 'Approved' : 'Denied') + (always && allow ? ' (and allowed for the rest of that run)' : '') + ': ' + (pending.message || pending.tool || 'action').slice(0, 160) + '\n');
    if (!allow && reason) await bg.sendToBackgroundSession(id, 'I denied that action: ' + reason, process.env).catch(() => {});
    return;
  }
  if (sub === 'stop' || sub === 'kill') { const result = await bg.stopBackgroundSession(id, process.env); stdout.write(result.stopped ? 'Stopped ' + id + '.\n' : id + ' is not running (' + result.status + ').\n'); return; }
  if (sub === 'rm') { await bg.removeBackgroundSession(id, process.env); stdout.write('Removed ' + id + '.\n'); return; }
  if (sub === 'attach') {
    const entry = await bg.readEntry(id, process.env);
    if (entry.kind === 'exec') {
      stdout.write('Attaching to ' + id + ' (' + entry.command + '). Ctrl+C detaches; the job keeps running.\n');
      return await backgroundCommand(['logs', id, '--follow'], { approve, interactive });
    }
    if (entry.status === 'running') {
      if (!(await approve(id + ' is still running. Stop it and continue the conversation here?', true, false))) { stdout.write('Left it running. oasis bg logs ' + id + ' --follow shows progress.\n'); return; }
      await bg.stopBackgroundSession(id, process.env);
    }
    stdout.write('Attaching to ' + id + ' (session ' + entry.sessionId + ').\n' + (bg.renderLog(await readFile(entry.logFile, 'utf8').catch(() => '')).split('\n').slice(-12).join('\n')) + '\n');
    try { process.chdir(entry.root); } catch {}
    return await interactive(entry.root, false, { enabled: true, resumeId: entry.sessionId });
  }
  throw new Error('Unknown bg command ' + sub + '. Usage: oasis bg [list] | logs ID [--follow] | send ID "message" | approve ID [--always] | deny ID [reason] | attach ID | stop ID | rm ID | respawn ID|--all|--interrupted');
}

export async function manageSessions(root, rest, { approve } = {}) {
  const action = rest[0] || 'list';
  const sessions = await listSessions(root);
  if (action === 'list') {
    const archivedOnly = rest.includes('--archived');
    const shown = archivedOnly ? sessions.filter((item) => item.archived) : unarchivedSessions(sessions);
    stdout.write((archivedOnly ? 'Archived sessions for ' : 'Saved sessions for ') + path.resolve(root) + ':\n');
    if (!shown.length) { stdout.write(archivedOnly ? '  No archived sessions.\n' : '  No saved sessions. Use oasis --continue to save/resume a session.\n'); return; }
    for (const item of shown) stdout.write('  ' + item.id + '  ' + item.updatedAt + '  ' + item.messages + ' messages  ' + (item.model || 'unknown model') + (item.title ? '  ' + JSON.stringify(item.title.length > 60 ? item.title.slice(0, 59) + '…' : item.title) : '') + '\n');
    const hidden = sessions.length - shown.length;
    if (!archivedOnly && hidden) stdout.write('  (' + hidden + ' archived; oasis sessions list --archived shows them)\n');
    return;
  }
  if (action === 'archive' || action === 'unarchive') {
    const id = rest[1];
    if (!id) throw new Error('Usage: oasis sessions ' + action + ' SESSION_ID');
    if (!sessions.some((item) => item.id === id)) throw new Error('No saved session with ID ' + id + ' exists for this workspace.');
    await setSessionArchived(root, id, action === 'archive');
    stdout.write((action === 'archive' ? 'Archived ' : 'Unarchived ') + id + '.' + (action === 'archive' ? ' It is hidden from session lists but can still be resumed with oasis --resume ' + id + '.' : '') + '\n');
    return;
  }
  if (action === 'clear' || action === 'delete' || action === 'remove') {
    const id = rest[1];
    if (!id) throw new Error('Usage: oasis sessions clear SESSION_ID');
    if (!sessions.some((item) => item.id === id)) throw new Error('No saved session with ID ' + id + ' exists for this workspace.');
    if (!(await approve('Delete the locally saved conversation ' + id + '? This removes the saved history file.', true, false))) {
      stdout.write('Session deletion cancelled.\n');
      return;
    }
    await deleteSession(root, id);
    stdout.write('Deleted saved session ' + id + '.\n');
    return;
  }
  if (action === 'prune') {
    const flag = rest.indexOf('--older-than');
    const raw = flag >= 0 ? rest[flag + 1] : rest[1];
    const days = raw === undefined ? 30 : Number.parseInt(String(raw).replace(/d$/i, ''), 10);
    if (!Number.isInteger(days) || days < 1) throw new Error('Usage: oasis sessions prune [--older-than DAYS]   (default 30)');
    const stale = await staleSessions(root, days);
    if (!stale.length) { stdout.write('No saved sessions older than ' + days + ' days.\n'); return; }
    stdout.write(stale.length + ' saved session(s) last used more than ' + days + ' days ago:\n');
    for (const item of stale.slice(0, 20)) stdout.write('  ' + item.id + '  ' + item.updatedAt + '  ' + (item.title || '') + '\n');
    if (stale.length > 20) stdout.write('  ... and ' + (stale.length - 20) + ' more\n');
    if (!(await approve('Delete these ' + stale.length + ' saved conversation(s)? This removes their history files.', true, false))) { stdout.write('Nothing deleted.\n'); return; }
    const removed = await pruneSessions(root, days);
    stdout.write('Deleted ' + removed.length + ' saved session(s).\n');
    return;
  }
  if (action === 'export') {
    const { exportSessions } = await import('./trajectories.mjs');
    const count = await exportSessions(root, rest.slice(1));
    if (rest.includes('--out')) stdout.write('Exported ' + count + ' session(s).\n');
    return;
  }
  if (action === 'events' || action === 'audit') {
    const json = rest.includes('--json');
    const typeFlag = rest.indexOf('--type');
    const type = typeFlag >= 0 ? rest[typeFlag + 1] : '';
    const id = rest.slice(1).find((arg, index, list) => !arg.startsWith('--') && list[index - 1] !== '--type');
    if (!id) throw new Error('Usage: oasis sessions events SESSION_ID [--type tool_call|tool_result|approval|verification|recovery|session_saved] [--json]');
    if (!sessions.some((item) => item.id === id)) throw new Error('No saved session with ID ' + id + ' exists for this workspace.');
    const { readEvents } = await import('./event-stream.mjs');
    const events = (await readEvents(root, id)).filter((event) => !type || event.type === type);
    if (json) { stdout.write(JSON.stringify(events, null, 2) + '\n'); return; }
    if (!events.length) { stdout.write('No recorded events' + (type ? ' of type ' + type : '') + ' for ' + id + '.\n'); return; }
    for (const event of events) stdout.write(formatAuditEvent(event) + '\n');
    return;
  }
  if (action === 'search') {
    const json = rest.includes('--json');
    const all = rest.includes('--all');
    const query = rest.slice(1).filter((arg) => arg !== '--json' && arg !== '--all').join(' ').trim();
    if (!query) throw new Error('Usage: oasis sessions search QUERY [--all] [--json]');
    const { searchSessions, formatSessionSearch } = await import('./session-search.mjs');
    const result = await searchSessions(root, query, { scope: all ? 'all' : 'workspace', limit: 20 });
    stdout.write((json ? JSON.stringify(result, null, 2) : formatSessionSearch(result, query)) + '\n');
    return;
  }
  throw new Error('Unknown sessions action. Use oasis sessions list [--archived], oasis sessions archive|unarchive SESSION_ID, oasis sessions search QUERY, oasis sessions events SESSION_ID, oasis sessions clear SESSION_ID, or oasis sessions prune [--older-than DAYS].');
}

// One readable line per audit event, e.g. "#12 10:31:04 tool_result run_command failed (exit 1): ...".
export function formatAuditEvent(event) {
  const time = String(event.at || '').slice(11, 19);
  const head = '#' + event.seq + ' ' + time + ' ' + event.type;
  const one = (value, max = 160) => String(value === undefined ? '' : value).replace(/\s+/g, ' ').slice(0, max);
  switch (event.type) {
    case 'tool_call': return head + ' ' + event.tool + ' ' + one(event.input);
    case 'tool_result': return head + ' ' + event.tool + ' ' + (event.ok ? 'ok' : 'failed') + (event.exitCode !== undefined ? ' (exit ' + event.exitCode + ')' : '') + (event.output ? ': ' + one(event.output, 120) : '');
    case 'approval': return head + ' ' + event.tool + ' ' + (event.allowed ? 'allowed' : 'denied: ' + one(event.reason, 120)) + (event.mode ? ' [' + event.mode + ']' : '');
    case 'verification': return head + ' ' + (event.kind || 'check') + ' ' + (event.passed ? 'passed' : 'failed (exit ' + event.exitCode + ')') + ': ' + one(event.command, 120);
    case 'recovery': return head + ' ' + (event.action || '') + ' ' + (event.from ? event.from + ' -> ' + event.to : '') + (event.reason ? ' (' + one(event.reason, 100) + ')' : '');
    default: return head;
  }
}
