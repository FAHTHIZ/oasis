// Best-effort process-tree termination for commands launched by OASIS.
//
// On POSIX, commands are started in their own process group and signals are sent
// to that group so grandchildren cannot keep inherited pipes alive after a timeout
// or cancellation. On Windows, taskkill /T is used for the forced-stop phase;
// direct child termination remains the graceful first attempt.
import { spawn } from 'node:child_process';

export function processTreeSpawnOptions() {
  return process.platform === 'win32' ? {} : { detached: true };
}

export function signalProcessTree(child, signal = 'SIGTERM') {
  if (!child) return false;
  const pid = Number(child.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    try { return Boolean(child.kill(signal)); } catch { return false; }
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      // The process group may already have exited. Fall back to the direct child
      // for platforms or process types where a negative-PID group signal fails.
      if (error && error.code !== 'ESRCH') {
        try { return Boolean(child.kill(signal)); } catch { return false; }
      }
      try { return Boolean(child.kill(signal)); } catch { return false; }
    }
  }

  if (signal === 'SIGKILL') {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.on('error', () => { try { child.kill(signal); } catch {} });
      killer.unref();
      return true;
    } catch {
      try { return Boolean(child.kill(signal)); } catch { return false; }
    }
  }

  try { return Boolean(child.kill(signal)); } catch { return false; }
}
