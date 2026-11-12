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

// Claude Code's spinnerVerbs setting as a pool for the generic label. null stands
// for the built-in word ("Thinking"/"Working"); an empty replace list keeps it.
export function spinnerVerbPool(setting) {
  if (!setting || !Array.isArray(setting.verbs) || !setting.verbs.length) return [];
  return setting.mode === 'replace' ? [...setting.verbs] : [null, ...setting.verbs];
}

// Words for the label; chosen by what the agent is waiting for, not at random.
// A spinnerVerbs word (info.verb) replaces only the generic Thinking/Working.
export function waitLabel(info = {}, elapsedMs = 0) {
  if (info.label) return String(info.label);
  const generic = waitLabelFor(info, elapsedMs);
  return info.verb && (generic === 'Thinking' || generic === 'Working') ? String(info.verb) : generic;
}

function waitLabelFor(info, elapsedMs) {
  if (Number(info.rateLimitMs) > elapsedMs) return 'Rate limited';
  const progress = info.promptProgress;
  if (progress && Number(progress.total) > 0) return Number(progress.processed) < Number(progress.total) ? 'Local model is reading the prompt' : 'Thinking';
  if (info.local && elapsedMs >= 15000 && Number(info.inputTokens || 0) > 2000) return 'Local model is reading the prompt';
  if (elapsedMs >= 45000) return 'Still waiting for the model';
  if (Number(info.step || 1) > 1) return 'Working';
  return 'Thinking';
}

// llama.cpp prompt_progress ({ total, cache, processed, time_ms }) as
// "54% of 7.7k tokens · about 2m 40s left". Cached tokens count as read; the
// estimate uses the rate for tokens actually processed so far.
// llama-server reports once per batch (2,048 tokens by default, over a minute
// on a slow CPU), so between reports the line moves on at the measured rate;
// ageMs is the time since the last report. It never claims the read is done.
export function promptProgressText(progress, ageMs = 0) {
  if (!progress) return '';
  const total = Number(progress.total) || 0;
  let processed = Math.min(total, Number(progress.processed) || 0);
  if (total <= 0 || processed >= total) return '';
  const cache = Math.min(processed, Number(progress.cache) || 0);
  const timeMs = Number(progress.time_ms ?? progress.timeMs) || 0;
  const done = processed - cache;
  const rate = timeMs >= 2000 && done > 0 ? done / timeMs : 0;
  if (rate > 0 && ageMs > 0) processed = Math.min(total - 1, processed + rate * ageMs);
  const parts = [Math.floor(processed / total * 100) + '% of ' + formatTokens(total) + ' tokens'];
  if (rate > 0) parts.push('about ' + formatElapsed(Math.max(1000, (total - processed) / rate)) + ' left');
  return parts.join(' · ');
}

// The status text without escape codes. Exported so it can be tested.
export function describeWait(info = {}, elapsedMs = 0) {
  // A rate-limit wait counts down in place instead of printing a line per retry.
  if (!info.label && Number(info.rateLimitMs) > elapsedMs) return 'Rate limited… · retrying in ' + formatElapsed(Number(info.rateLimitMs) - elapsedMs + 999) + ' · esc to stop';
  const parts = [waitLabel(info, elapsedMs) + '…', formatElapsed(elapsedMs)];
  const reading = promptProgressText(info.promptProgress, Number(info.promptProgressAgeMs) || 0);
  if (reading) parts.push(reading);
  else if (Number(info.inputTokens) > 0) parts.push(formatTokens(info.inputTokens) + ' tokens sent');
  if (info.step && Number(info.step) > 1) parts.push('step ' + info.step);
  // What you are typing while it works stays visible (Enter sends it to the
  // running task, Tab queues it for after the turn).
  const draft = String(info.draft || '').replace(/\s+/g, ' ').trim();
  parts.push(draft ? '› ' + (draft.length > 48 ? '…' + draft.slice(-47) : draft) : 'esc to stop');
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

export function createActivityIndicator({ stream = process.stdout, env = process.env, color = true, setting = null, verbs = null, random = Math.random, now = () => Date.now(), timers = { setInterval, clearInterval } } = {}) {
  const level = motionLevel({ env, stream, setting });
  let handle = null;
  let startedAt = 0;
  let info = {};
  let frame = 0;
  let lastLine = '';
  let visible = false;
  let lastWidth = 0;
  let progressAt = 0;

  const columns = () => Math.max(20, Number(stream.columns) || 80);
  const clip = (text) => {
    const max = columns() - 1;
    const chars = [...text];
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
  };

  function render() {
    const elapsed = now() - startedAt;
    const shown = progressAt ? { ...info, promptProgressAgeMs: now() - progressAt } : info;
    const plain = describeWait(shown, elapsed);
    const label = waitLabel(shown, elapsed) + '…';
    const rest = clip(plain).slice(label.length);
    let line;
    // Frames follow the clock, not the timer count: a late tick (a busy
    // event loop) skips ahead instead of slowing or stuttering the spinner.
    frame = Math.max(0, Math.floor(elapsed / (level === 'full' ? FULL_INTERVAL_MS : LITE_INTERVAL_MS)));
    if (level === 'full') {
      const glyph = FULL_FRAMES[frame % FULL_FRAMES.length];
      line = color ? '\x1b[36m' + glyph + '\x1b[0m ' + shimmer(label, frame) + '\x1b[2m' + rest + '\x1b[0m' : glyph + ' ' + clip(plain);
    } else {
      const dots = LITE_FRAMES[frame % LITE_FRAMES.length];
      line = color ? '\x1b[36m' + label + '\x1b[0m\x1b[2m' + rest + ' ' + dots + '\x1b[0m' : clip(plain) + ' ' + dots;
    }
    // Nothing changed since the last frame (the lite dots, a paused clock): no write.
    if (visible && line === lastLine) return;
    lastLine = line;
    try { stream.write('\r\x1b[2K' + line + '\x1b[?25l'); visible = true; lastWidth = plain.length; } catch {}
  }

  return {
    level,
    get active() { return Boolean(handle); },
    start(next = {}) {
      if (level === 'off') return false;
      info = { ...next };
      // One spinnerVerbs word per wait, picked at random like Claude Code's rotation.
      const pool = spinnerVerbPool(typeof verbs === 'function' ? verbs() : verbs);
      if (pool.length && !info.verb) info.verb = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] || '';
      progressAt = 0;
      startedAt = now();
      frame = 0;
      if (handle) return true;
      render();
      handle = timers.setInterval(render, level === 'full' ? FULL_INTERVAL_MS : LITE_INTERVAL_MS);
      if (handle && typeof handle.unref === 'function') handle.unref();
      return true;
    },
    update(next = {}) {
      if (next.promptProgress) progressAt = now();
      const draftChanged = 'draft' in next && next.draft !== info.draft;
      info = { ...info, ...next };
      // Typed characters show at once rather than at the next frame.
      if (draftChanged && handle) render();
    },
    stop() {
      if (handle) { timers.clearInterval(handle); handle = null; }
      if (visible) {
        try { stream.write('\r\x1b[2K\x1b[?25h'); } catch {}
        visible = false;
        lastLine = '';
      }
      return lastWidth;
    }
  };
}
