// Gets your attention when a long turn finishes or waits for approval, so you
// can switch away while the agent works. Terminals that support desktop
// notifications get one (OSC 9: iTerm2, WezTerm, Ghostty, Windows Terminal;
// OSC 99: kitty); others get the bell. Quiet for short turns, CI and pipes.
//
//   OASIS_NOTIFY=auto|bell|osc|off      default auto
//   OASIS_NOTIFY_AFTER_SECONDS=15       only for turns at least this long

export const DEFAULT_NOTIFY_AFTER_SECONDS = 15;

const OSC9_TERMINALS = new Set(['iTerm.app', 'WezTerm', 'ghostty']);

export function attentionMode(env = process.env, stream = process.stdout) {
  const raw = String(env.OASIS_NOTIFY || 'auto').trim().toLowerCase();
  if (['off', '0', 'false', 'no', 'none'].includes(raw)) return 'off';
  if (!stream || !stream.isTTY) return 'off';
  if (raw === 'bell') return 'bell';
  const kitty = /kitty/i.test(String(env.TERM || '')) || Boolean(env.KITTY_WINDOW_ID);
  const osc9 = OSC9_TERMINALS.has(String(env.TERM_PROGRAM || '')) || Boolean(env.WT_SESSION);
  if (raw === 'osc') return kitty ? 'osc99' : 'osc9';
  if (env.CI || env.OASIS_REDUCED_MOTION === '1') return 'off';
  if (env.TMUX || /^screen/.test(String(env.TERM || ''))) return 'bell'; // multiplexers drop OSC 9 without passthrough
  if (kitty) return 'osc99';
  if (osc9) return 'osc9';
  return 'bell';
}

export function notifyAfterMs(env = process.env) {
  const seconds = Number(env.OASIS_NOTIFY_AFTER_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_NOTIFY_AFTER_SECONDS) * 1000;
}

function clean(text) {
  // No control characters: they could end the escape sequence early.
  return String(text == null ? '' : text).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 200);
}

export function attentionSequence(mode, message) {
  const text = clean(message) || 'OASIS';
  if (mode === 'osc9') return '\x1b]9;' + text + '\x07';
  if (mode === 'osc99') return '\x1b]99;;' + text + '\x1b\\';
  if (mode === 'bell') return '\x07';
  return '';
}

/** Writes a notification if the turn has run long enough. Returns what was written. */
export function notifyAttention(message, { elapsedMs = 0, env = process.env, stream = process.stdout, force = false } = {}) {
  const mode = attentionMode(env, stream);
  if (mode === 'off') return '';
  if (!force && Number(elapsedMs || 0) < notifyAfterMs(env)) return '';
  const sequence = attentionSequence(mode, message);
  if (sequence) {
    try { stream.write(sequence); } catch { return ''; }
  }
  return sequence;
}
