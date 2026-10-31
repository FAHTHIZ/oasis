// Auto-test (Aider's --auto-test): after the agent edits files and is about to
// finish, Oasis itself runs the configured test command. On failure the output
// is handed back to the model so it can fix the problem, up to maxAttempts.
// The command comes from user settings, trusted project settings, or
// OASIS_AUTO_TEST, so a cloned repository cannot make Oasis run commands.
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 12000;

export function resolveAutoTest(settings, env = process.env) {
  const fromEnv = String(env.OASIS_AUTO_TEST || '').trim();
  if (fromEnv === '0' || fromEnv.toLowerCase() === 'off') return null;
  const configured = settings && settings.autoTest;
  const command = fromEnv || (configured && configured.command) || '';
  if (!command) return null;
  return {
    command,
    maxAttempts: configured && configured.maxAttempts || 3,
    timeoutMs: (configured && configured.timeoutSeconds || 600) * 1000
  };
}

export function normalizeAutoTestSetting(value) {
  if (typeof value === 'string') value = { command: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const command = typeof value.command === 'string' ? value.command.trim().slice(0, 4000) : '';
  if (!command) return null;
  const clamp = (raw, min, max, fallback) => { const n = Number.parseInt(raw, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
  return { command, maxAttempts: clamp(value.maxAttempts, 1, 10, 3), timeoutSeconds: clamp(value.timeoutSeconds, 5, 3600, 600) };
}

function tail(text) {
  return text.length > MAX_OUTPUT ? '[... ' + (text.length - MAX_OUTPUT) + ' earlier characters omitted ...]\n' + text.slice(-MAX_OUTPUT) : text;
}

export function runAutoTest(root, command, { timeoutMs = 600000, signal, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const windows = process.platform === 'win32';
    const child = spawn(windows ? (env.ComSpec || 'cmd.exe') : '/bin/sh', windows ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd: root, env: { ...env, CI: env.CI || '1', FORCE_COLOR: '0' }, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let timedOut = false;
    let cancelled = false;
    const append = (chunk) => { output += chunk.toString('utf8'); if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const kill = () => {
      try {
        if (windows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { cancelled = true; kill(); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const finish = (exitCode, error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ command, exitCode, passed: exitCode === 0 && !timedOut && !cancelled, timedOut, cancelled, durationMs: Date.now() - started, output: tail(error ? String(error.message || error) : output) });
    };
    child.on('error', (error) => finish(127, error));
    child.on('close', (code, sig) => finish(typeof code === 'number' ? code : (sig ? 128 : 1)));
  });
}

export function autoTestFailurePrompt(result, attempt, maxAttempts) {
  const status = result.timedOut ? 'timed out' : 'failed with exit code ' + result.exitCode;
  return [
    'Auto-test: Oasis ran the configured test command after your edits and it ' + status + ' (attempt ' + attempt + ' of ' + maxAttempts + ').',
    'Command: ' + result.command,
    'Output (tail):',
    '```',
    result.output.trim() || '(no output)',
    '```',
    'Fix the cause of the failure. Do not weaken, skip, or delete tests to make them pass unless the user asked for that. If the failure is unrelated to your change, say so plainly and stop.'
  ].join('\n');
}
