// Live "working" line shown while Oasis waits for the model's first token.
//
// Without it, a slow provider (or a local model reading a long prompt on a
// laptop) looks exactly like a hang. The line shows what is happening, how long
// it has taken, how much context was sent, and how to stop it.
//
// Motion adapts to the machine instead of assuming a fast desktop terminal:
//   full  smooth spinner (about 12 fps) with a shimmer across the label
//   lite  slow three-dot pulse (2 fps), no shimmer: low-power machines, SSH,
//         the Linux console, or a busy CPU
//   off   no animation at all: OASIS_MOTION=off, OASIS_REDUCED_MOTION=1,
//         NO_MOTION, screen-reader mode, CI, TERM=dumb or a non-TTY stream
// OASIS_MOTION=full|lite|off overrides detection.

import os from 'node:os';

export const MOTION_LEVELS = ['full', 'lite', 'off'];

const FULL_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LITE_FRAMES = ['·  ', '·· ', '···', ' ··', '  ·', '   '];
const FULL_INTERVAL_MS = 80;
const LITE_INTERVAL_MS = 500;
const GIB = 1024 ** 3;

function truthy(value) { return /^(1|true|yes|on)$/i.test(String(value || '').trim()); }

// Decide how much animation this terminal and machine can comfortably show.
export function motionLevel({ env = process.env, stream = process.stdout, setting = null, system = os } = {}) {
  const requested = String(env.OASIS_MOTION || setting || '').trim().toLowerCase();
  if (!stream || !stream.isTTY) return 'off';
  if (requested === 'off' || requested === 'none' || requested === '0') return 'off';
  if (truthy(env.OASIS_REDUCED_MOTION) || truthy(env.NO_MOTION) || truthy(env.OASIS_AX_SCREEN_READER) || truthy(env.CLAUDE_AX_SCREEN_READER)) return 'off';
  if (String(env.TERM || '') === 'dumb') return 'off';
  if (requested === 'full' || requested === 'lite') return requested;
  if (truthy(env.CI)) return 'off';
  if (lowPower({ env, system })) return 'lite';
  return 'full';
}

// A small machine, a remote session or a saturated CPU: keep redraws rare.
export function lowPower({ env = process.env, system = os } = {}) {
  try {
    const cpus = (system.availableParallelism ? system.availableParallelism() : (system.cpus() || []).length) || 1;
    if (cpus <= 2) return true;
    if (Number(system.totalmem()) > 0 && Number(system.totalmem()) < 4 * GIB) return true;
    const load = (system.loadavg() || [0])[0];
    if (process.platform !== 'win32' && load / cpus > 1.5) return true;
  } catch {}
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (String(env.TERM || '') === 'linux') return true;
  return false;
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  return minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
}

export function formatTokens(count) {
  const n = Math.max(0, Math.round(Number(count || 0)));
  if (n < 1000) return String(n);
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}

// Words for the label; chosen by what the agent is waiting for, not at random.
export function waitLabel(info = {}, elapsedMs = 0) {
  if (info.label) return String(info.label);
  if (info.local && elapsedMs >= 15000 && Number(info.inputTokens || 0) > 2000) return 'Local model is reading the prompt';
  if (elapsedMs >= 45000) return 'Still waiting for the model';
  if (Number(info.step || 1) > 1) return 'Working';
  return 'Thinking';
}

// The status text without escape codes. Exported so it can be tested.
export function describeWait(info = {}, elapsedMs = 0) {
  const parts = [waitLabel(info, elapsedMs) + '…', formatElapsed(elapsedMs)];
  if (Number(info.inputTokens) > 0) parts.push(formatTokens(info.inputTokens) + ' tokens sent');
  if (info.step && Number(info.step) > 1) parts.push('step ' + info.step);
  parts.push('esc to stop');
  return parts.join(' · ');
}

// Paint a moving highlight across the label (full motion only).
export function shimmer(text, frame, { base = '\x1b[36m', highlight = '\x1b[1;97m', reset = '\x1b[0m', width = 3 } = {}) {
  const chars = [...text];
  if (!chars.length) return '';
  const span = chars.length + width * 2;
  const center = (frame % span) - width;
  let out = '';
  let lit = null;
  chars.forEach((ch, i) => {
    const on = Math.abs(i - center) < width;
    if (on !== lit) { out += on ? highlight : base; lit = on; }
    out += ch;
  });
  return out + reset;
}

export function createActivityIndicator({ stream = process.stdout, env = process.env, color = true, setting = null, now = () => Date.now(), timers = { setInterval, clearInterval } } = {}) {
  const level = motionLevel({ env, stream, setting });
  let handle = null;
  let startedAt = 0;
  let info = {};
  let frame = 0;
  let visible = false;
  let lastWidth = 0;

  const columns = () => Math.max(20, Number(stream.columns) || 80);
  const clip = (text) => {
    const max = columns() - 1;
    const chars = [...text];
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
  };

  function render() {
    const elapsed = now() - startedAt;
    const plain = describeWait(info, elapsed);
    const label = waitLabel(info, elapsed) + '…';
    const rest = clip(plain).slice(label.length);
    let line;
    if (level === 'full') {
      const glyph = FULL_FRAMES[frame % FULL_FRAMES.length];
      line = color ? '\x1b[36m' + glyph + '\x1b[0m ' + shimmer(label, frame) + '\x1b[2m' + rest + '\x1b[0m' : glyph + ' ' + clip(plain);
    } else {
      const dots = LITE_FRAMES[frame % LITE_FRAMES.length];
      line = color ? '\x1b[36m' + label + '\x1b[0m\x1b[2m' + rest + ' ' + dots + '\x1b[0m' : clip(plain) + ' ' + dots;
    }
    frame += 1;
    try { stream.write('\r\x1b[2K' + line + '\x1b[?25l'); visible = true; lastWidth = plain.length; } catch {}
  }

  return {
    level,
    get active() { return Boolean(handle); },
    start(next = {}) {
      if (level === 'off') return false;
      info = { ...next };
      startedAt = now();
      frame = 0;
      if (handle) return true;
      render();
      handle = timers.setInterval(render, level === 'full' ? FULL_INTERVAL_MS : LITE_INTERVAL_MS);
      if (handle && typeof handle.unref === 'function') handle.unref();
      return true;
    },
    update(next = {}) { info = { ...info, ...next }; },
    stop() {
      if (handle) { timers.clearInterval(handle); handle = null; }
      if (visible) {
        try { stream.write('\r\x1b[2K\x1b[?25h'); } catch {}
        visible = false;
      }
      return lastWidth;
    }
  };
}
