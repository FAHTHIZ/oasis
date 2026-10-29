// Process-tree termination for commands and PTY sessions launched by OASIS.
//
// On POSIX, commands use their own process group and signals are sent to the group,
// so descendants can be stopped even after the original leader exits. Node's
// portable Windows child API has no equivalent process-group signal; taskkill /T /F
// is therefore used on Windows to stop the process tree on an explicit stop/timeout.
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

  // Windows has no Node.js API for signalling an entire process group. A direct
  // child can exit before a later escalation and leave descendants orphaned, so
  // cancellation/timeout uses taskkill immediately while the tree is discoverable.
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
