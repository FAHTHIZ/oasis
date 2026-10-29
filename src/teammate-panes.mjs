// --teammate-mode tmux: each agent-team member gets its own tmux pane that follows its
// activity live (text, tool calls, results). Teammates still run inside this process,
// so messaging, permissions and the shared task list work exactly as in-process mode.
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';

export const TEAMMATE_MODES = ['auto', 'in-process', 'tmux'];

// auto (the default) uses tmux panes only when this session is already inside tmux.
export function resolveTeammateMode(value, env = process.env) {
  const mode = String(value || 'auto').toLowerCase();
  if (mode === 'in-process') return 'in-process';
  if (mode === 'tmux') return env.TMUX ? 'tmux' : 'in-process';
  return env.TMUX ? 'tmux' : 'in-process';
}

const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const clip = (value, max) => { const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); return text.length > max ? text.slice(0, max - 1) + '…' : text; };

export function openTeammatePane(session, record, { env = process.env, team = '' } = {}) {
  const dir = path.join(env.OASIS_TEAM_PANE_DIR || os.tmpdir(), 'oasis-teams');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = path.join(dir, process.pid + '-' + String(record.id).replace(/[^\w-]/g, '_') + '.log');
  const title = (team ? team + ' / ' : '') + (record.description || record.id);
  writeFileSync(log, '== ' + title + ' (' + record.id + ') ==\n', { mode: 0o600 });
  const run = (args) => spawnSync('tmux', args, { env, encoding: 'utf8', timeout: 5000 });
  const split = run(['split-window', '-d', '-h', '-P', '-F', '#{pane_id}', 'tail -n +1 -f ' + quote(log)]);
  if (split.status !== 0) return null;
  const paneId = String(split.stdout || '').trim();
  if (paneId) run(['select-pane', '-t', paneId, '-T', title.slice(0, 60)]);
  run(['select-layout', 'tiled']);
  const pane = {
    paneId, log,
    write(line) { try { appendFileSync(log, line.endsWith('\n') ? line : line + '\n'); } catch {} },
    close() { if (paneId) run(['kill-pane', '-t', paneId]); }
  };
  (session.teammatePanes ||= []).push(pane);
  return pane;
}

// Wraps a teammate's run options so its activity also streams into its pane.
export function mirrorToPane(pane, runOptions) {
  if (!pane) return runOptions;
  const wrap = (original, render) => (event) => { try { const line = render(event); if (line) pane.write(line); } catch {} if (original) return original(event); };
  return {
    ...runOptions,
    onText: wrap(runOptions.onText, (text) => '\n' + String(text).trim() + '\n'),
    onToolStart: wrap(runOptions.onToolStart, (event) => '● ' + (event && event.name) + (event && event.args ? ' ' + clip(JSON.stringify(event.args), 160) : '')),
    onToolResult: wrap(runOptions.onToolResult, (event) => {
      const result = event && event.result;
      if (result && result.error) return '  ✗ ' + clip(result.error, 300);
      if (result && result.exitCode !== undefined) return '  ↳ exit ' + result.exitCode;
      return '';
    })
  };
}

export function closeTeammatePanes(session) {
  for (const pane of session.teammatePanes || []) pane.close();
  session.teammatePanes = [];
}
