import { stdout } from 'node:process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listSessions, deleteSession, staleSessions, pruneSessions } from './sessions.mjs';

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
    let shown = 0;
    for (;;) {
      const text = await readFile(entry.logFile, 'utf8').catch(() => '');
      const complete = text.slice(0, text.lastIndexOf('\n') + 1);
      if (complete.length > shown) { const out = bg.renderLog(complete.slice(shown)); if (out) stdout.write(out + '\n'); shown = complete.length; }
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
    stdout.write('Saved sessions for ' + path.resolve(root) + ':\n');
    if (!sessions.length) { stdout.write('  No saved sessions. Use oasis --continue to save/resume a session.\n'); return; }
    for (const item of sessions) stdout.write('  ' + item.id + '  ' + item.updatedAt + '  ' + item.messages + ' messages  ' + (item.model || 'unknown model') + '\n');
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
  throw new Error('Unknown sessions action. Use oasis sessions list, oasis sessions search QUERY, oasis sessions clear SESSION_ID, or oasis sessions prune [--older-than DAYS].');
}
