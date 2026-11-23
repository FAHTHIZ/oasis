// `oasis rehearse`: run a command once in a throwaway copy-on-write view of the
// workspace and show what it would change (src/rehearsal.mjs).
//
//   oasis rehearse [--apply] [--network] [--timeout SECONDS] [--json] -- COMMAND [ARGS...]
//   oasis rehearse [...] --shell 'SHELL LINE'
//
// --apply copies the rehearsed changes into the workspace (after checking none of the
// touched paths changed meanwhile) instead of running the command a second time.
// Exits 0 when the rehearsed command exited 0, 1 otherwise, 2 when rehearsal is unavailable.

import { applyRehearsal, disposeRehearsal, formatRehearsal, publicRehearsal, rehearseCommand, rehearsalSupport } from './rehearsal.mjs';

const USAGE = [
  'Usage:',
  '  oasis rehearse [--apply] [--network] [--timeout SECONDS] [--json] -- COMMAND [ARGS...]',
  '  oasis rehearse [--apply] [--network] [--timeout SECONDS] [--json] --shell \'SHELL LINE\'',
  '',
  'Runs the command once against a copy-on-write view of this workspace (bubblewrap overlay):',
  'the rest of the system is read-only, /tmp is empty, there is no network unless --network,',
  'and nothing in the workspace changes. It prints the files the command created, modified and deleted.',
  '--apply then copies exactly those changes into the workspace instead of running the command again.',
  'Linux only (bubblewrap 0.11+ with unprivileged overlayfs).'
].join('\n');

export async function rehearseCliCommand(argv, workspace, { write = (text) => process.stdout.write(text), env = process.env } = {}) {
  const options = { apply: false, network: false, json: false, timeout: 30 };
  let command = null;
  let args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { write(USAGE + '\n'); return 0; }
    if (arg === '--apply') options.apply = true;
    else if (arg === '--network') options.network = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--timeout') options.timeout = Math.max(1, Math.min(600, Number(argv[++i]) || 30));
    else if (arg === '--shell') { command = '/bin/sh'; args = ['-c', String(argv[++i] || '')]; break; }
    else if (arg === '--') { command = argv[i + 1]; args = argv.slice(i + 2); break; }
    else { command = arg; args = argv.slice(i + 1); break; }
  }
  if (!command) { write(USAGE + '\n'); return 2; }
  const support = rehearsalSupport();
  if (!support.available) { write('Rehearsal is unavailable: ' + support.reason + '\n'); return 2; }
  const result = await rehearseCommand({ root: workspace, command, args, env, network: options.network, timeoutMs: options.timeout * 1000 });
  let applied = null;
  try {
    if (options.apply && (result.status === 'ok' || result.status === 'failed')) applied = await applyRehearsal(result);
  } finally {
    await disposeRehearsal(result);
  }
  if (options.json) write(JSON.stringify({ ...publicRehearsal(result), stdout: result.stdout, stderr: result.stderr, ...(applied ? { applied } : {}) }, null, 2) + '\n');
  else {
    if (result.stdout) write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
    if (result.stderr) write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
    write(formatRehearsal(result) + '\n');
    if (applied) write(applied.message + '\n');
    else if (!options.apply && (result.changes.created.length || result.changes.modified.length || result.changes.deleted.length)) write('Nothing was changed. Add --apply to keep these changes.\n');
  }
  if (applied && !applied.applied) return 1;
  return result.status === 'ok' ? 0 : 1;
}
