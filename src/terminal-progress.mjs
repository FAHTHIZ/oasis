// Terminal progress (OSC 9;4, ConEmu's progress sequence): while a turn runs,
// the tab or taskbar shows a busy indicator; it switches to "paused" while
// OASIS waits for your approval and to "error" when a turn fails. Claude Code
// does the same (terminalProgressBarEnabled).
//
// Only terminals known to implement it get the sequence, because older ones
// show OSC 9 as a desktop notification: Windows Terminal, ConEmu, Ghostty
// 1.2+, iTerm2 3.6.6+. Multiplexers, CI and pipes are skipped.
//
//   OASIS_TERMINAL_PROGRESS=auto|on|off   default auto

const STATES = { clear: 0, error: 2, busy: 3, paused: 4 };

function versionAtLeast(raw, minimum) {
  const have = String(raw || '').match(/\d+/g);
  if (!have) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const part = Number(have[index] || 0);
    if (part !== minimum[index]) return part > minimum[index];
  }
  return true;
}

export function terminalProgressEnabled(env = process.env, stream = process.stdout) {
  const raw = String(env.OASIS_TERMINAL_PROGRESS || 'auto').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(raw)) return false;
  if (!stream || !stream.isTTY) return false;
  if (['on', '1', 'true', 'yes'].includes(raw)) return true;
  if (env.CI || env.TMUX || env.STY || env.ZELLIJ || /^screen/.test(String(env.TERM || ''))) return false;
  if (env.WT_SESSION || env.ConEmuANSI === 'ON') return true;
  const program = String(env.TERM_PROGRAM || '');
  if (program === 'ghostty') return versionAtLeast(env.TERM_PROGRAM_VERSION, [1, 2, 0]);
  if (program === 'iTerm.app') return versionAtLeast(env.TERM_PROGRAM_VERSION, [3, 6, 6]);
  return false;
}

export function terminalProgressSequence(state) {
  const code = STATES[state];
  if (code === undefined) return '';
  return '\x1b]9;4;' + code + (code === 2 ? ';100' : ';') + '\x07';
}

/** A per-stream reporter; every method is a no-op when the terminal lacks support. */
export function createTerminalProgress({ env = process.env, stream = process.stdout } = {}) {
  const enabled = terminalProgressEnabled(env, stream);
  let current = 'clear';
  const set = (state) => {
    if (!enabled || state === current) return;
    current = state;
    try { stream.write(terminalProgressSequence(state)); } catch { /* closed stream */ }
  };
  return { enabled, set, get state() { return current; } };
}
