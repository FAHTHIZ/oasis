// Long foreground sleeps ("sleep 120 && gh run view") hold the turn while doing
// nothing and often hit the command timeout. Like Claude Code, a command that
// *starts* with a long sleep is refused with a pointer to the tools that wait
// properly: run_in_background + command_output, or monitor (which reports each
// new line as it appears). Short sleeps, sleeps later in a pipeline, and
// background runs are untouched. OASIS_ALLOW_LONG_SLEEP=1 turns the check off.
const LONG_SLEEP_SECONDS = 10;

const UNIT = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/** Seconds of the sleep a shell command starts with, or 0. */
export function leadingSleepSeconds(command, flavor = 'sh') {
  const text = String(command || '').trimStart();
  if (flavor === 'powershell') {
    const m = text.match(/^(?:Start-Sleep|sleep)\s+(?:-(?:Seconds|s)\s+)?(\d+(?:\.\d+)?)\s*(?:$|[;|&\n])/i)
      || text.match(/^(?:Start-Sleep|sleep)\s+-(?:Milliseconds|m)\s+(\d+)\s*(?:$|[;|&\n])/i);
    if (!m) return 0;
    return /-(?:Milliseconds|m)\s/i.test(m[0]) ? Number(m[1]) / 1000 : Number(m[1]);
  }
  const m = text.match(/^sleep\s+((?:\d+(?:\.\d+)?[smhd]?\s*)+)(?:$|;|&&|\|\||\n|&(?!&))/);
  if (!m) return 0;
  return [...m[1].matchAll(/(\d+(?:\.\d+)?)([smhd]?)/g)].reduce((sum, [, n, u]) => sum + Number(n) * UNIT[u], 0);
}

/** Seconds for run_command's argv form (command "sleep", args ["60"]), or 0. */
export function argvSleepSeconds(command, args = []) {
  const name = String(command || '').split(/[\\/]/).pop().toLowerCase();
  if (name !== 'sleep' && name !== 'sleep.exe') return 0;
  return leadingSleepSeconds('sleep ' + (Array.isArray(args) ? args : []).map(String).join(' '));
}

export function longSleepError(seconds, env = process.env) {
  if (env.OASIS_ALLOW_LONG_SLEEP === '1' || !(seconds >= LONG_SLEEP_SECONDS)) return '';
  return 'Not run: this command starts with a ' + Math.round(seconds) + '-second sleep, which blocks the turn while doing nothing. '
    + 'To wait for something, use monitor (it reports each new output line, e.g. a status-polling loop with a pattern), '
    + 'or start the work with run_in_background=true and check it with command_output. '
    + 'If you only need a short pause, sleep under ' + LONG_SLEEP_SECONDS + ' seconds.';
}
