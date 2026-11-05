// Short, soft sound effects for the moments that matter, and nothing else:
//
//   done       a turn of 3 s or more finished: a rising two-note chime
//   attention  OASIS needs you (approval, question): two gentle taps
//   error      the turn failed: a low, falling two-note tone
//   task       a checklist item was completed: one tiny tick (rate-limited)
//
// Sounds are synthesized here (no audio assets), written once to a small WAV
// cache and played by the system player without blocking: afplay on macOS,
// pw-play / paplay / aplay / ffplay on Linux, PowerShell's SoundPlayer on
// Windows. They stay off in CI, in pipes, and over SSH (the sound would play on
// the remote machine), unless OASIS_SOUNDS=on.
//
//   settings: "sounds": true|false, "soundVolume": 0-100 (default 50)
//   env:      OASIS_SOUNDS=on|off, OASIS_SOUND_VOLUME=0-100
//   /sounds on|off|test|volume N

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SOUND_NAMES = ['done', 'attention', 'error', 'task'];
export const DEFAULT_SOUND_VOLUME = 50;
// Turns shorter than this finish silently: instant replies do not chime.
export const DONE_SOUND_AFTER_MS = 3000;

const SAMPLE_RATE = 22050;
const SYNTH_VERSION = 1;

// Each note: frequency (Hz), start (s), length (s), level (0-1). Partials add
// a little warmth so a sine does not sound like a test tone.
const DESIGNS = {
  done: { notes: [[783.99, 0, 0.34, 0.55], [1174.66, 0.1, 0.55, 0.5]], partials: [[2, 0.18], [3, 0.05]] },
  attention: { notes: [[880, 0, 0.16, 0.5], [880, 0.17, 0.24, 0.45]], partials: [[2, 0.12]] },
  error: { notes: [[392, 0, 0.22, 0.55], [311.13, 0.14, 0.36, 0.5]], partials: [[2, 0.1], [3, 0.08]] },
  task: { notes: [[1567.98, 0, 0.1, 0.32]], partials: [[2, 0.08]] }
};

/** Samples in [-1, 1] for one sound at a volume of 0-100. */
export function synthesize(name, volume = DEFAULT_SOUND_VOLUME) {
  const design = DESIGNS[name];
  if (!design) throw new Error('Unknown sound: ' + name);
  const end = Math.max(...design.notes.map(([, start, length]) => start + length)) + 0.02;
  const samples = new Float32Array(Math.ceil(end * SAMPLE_RATE));
  for (const [frequency, start, length, level] of design.notes) {
    const first = Math.floor(start * SAMPLE_RATE);
    const count = Math.floor(length * SAMPLE_RATE);
    const attack = Math.floor(0.004 * SAMPLE_RATE);
    for (let i = 0; i < count && first + i < samples.length; i++) {
      const t = i / SAMPLE_RATE;
      // Quick attack, exponential decay to about -50 dB, short fade so nothing clicks.
      const envelope = (i < attack ? i / attack : 1) * Math.exp(-6 * (t / length)) * Math.min(1, (count - i) / (0.01 * SAMPLE_RATE));
      let value = Math.sin(2 * Math.PI * frequency * t);
      for (const [multiple, amount] of design.partials) value += amount * Math.sin(2 * Math.PI * frequency * multiple * t);
      samples[first + i] += value * envelope * level;
    }
  }
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const target = 0.7 * clampVolume(volume) / 100;
  const scale = peak > 0 ? target / peak : 0;
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  return samples;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function clampVolume(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : DEFAULT_SOUND_VOLUME;
}

function cacheDirectory(env) {
  const base = env.OASIS_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.oasis');
  return path.join(base, 'cache', 'sounds');
}

/** Path of the cached WAV for a sound, writing it on first use. */
export function soundFile(name, volume, env = process.env) {
  const dir = cacheDirectory(env);
  const file = path.join(dir, name + '-v' + clampVolume(volume) + '-s' + SYNTH_VERSION + '.wav');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    writeFileSync(temp, encodeWav(synthesize(name, volume)));
    renameSync(temp, file);
  }
  return file;
}

function onPath(command, env, platform) {
  const dirs = String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = platform === 'win32' ? [command + '.exe', command] : [command];
  for (const dir of dirs) for (const name of names) {
    try { accessSync(path.join(dir, name), constants.X_OK); return path.join(dir, name); } catch {}
  }
  return null;
}

/** The command that plays a WAV file here, or null. */
export function detectPlayer(env = process.env, platform = process.platform) {
  if (platform === 'darwin') { const bin = onPath('afplay', env, platform) || (existsSync('/usr/bin/afplay') ? '/usr/bin/afplay' : null); return bin ? { command: bin, args: (file) => [file] } : null; }
  if (platform === 'win32') {
    const bin = onPath('powershell', env, platform) || onPath('pwsh', env, platform);
    return bin ? { command: bin, args: (file) => ['-NoProfile', '-NonInteractive', '-Command', "(New-Object Media.SoundPlayer '" + file.replace(/'/g, "''") + "').PlaySync()"] } : null;
  }
  const candidates = [
    ['pw-play', (file) => [file]],
    ['paplay', (file) => [file]],
    ['aplay', (file) => ['-q', file]],
    ['ffplay', (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]]
  ];
  for (const [name, args] of candidates) { const bin = onPath(name, env, platform); if (bin) return { command: bin, args }; }
  // WSL usually has no Linux audio player, but Windows PowerShell is reachable through interop.
  if (env.WSL_DISTRO_NAME) {
    const bin = onPath('powershell.exe', env, platform);
    if (bin) return { command: bin, args: (file) => ['-NoProfile', '-NonInteractive', '-Command', "(New-Object Media.SoundPlayer '" + windowsPathForWsl(file, env).replace(/'/g, "''") + "').PlaySync()"] };
  }
  return null;
}

/** A WSL path as Windows sees it: /mnt/c/x -> C:\x, anything else via \\wsl.localhost\<distro>. */
export function windowsPathForWsl(file, env = process.env) {
  const drive = String(file).match(/^\/mnt\/([a-z])(\/.*)?$/i);
  if (drive) return drive[1].toUpperCase() + ':' + (drive[2] || '\\').replace(/\//g, '\\');
  return '\\\\wsl.localhost\\' + (env.WSL_DISTRO_NAME || 'Ubuntu') + String(file).replace(/\//g, '\\');
}

const state = { enabled: null, volume: null, last: new Map(), lastAny: 0, player: undefined };

/** Applies settings ("sounds", "soundVolume"); /sounds changes them at runtime. */
export function configureSounds({ enabled, volume } = {}) {
  if (typeof enabled === 'boolean') state.enabled = enabled;
  if (volume !== undefined && volume !== null) state.volume = clampVolume(volume);
}

export function soundVolume(env = process.env) {
  if (env.OASIS_SOUND_VOLUME !== undefined && env.OASIS_SOUND_VOLUME !== '') return clampVolume(env.OASIS_SOUND_VOLUME);
  return state.volume ?? DEFAULT_SOUND_VOLUME;
}

/** Why sounds are off, or '' when they will play. */
export function soundsOffReason({ env = process.env, stream = process.stdout, platform = process.platform, player } = {}) {
  const flag = String(env.OASIS_SOUNDS || '').trim().toLowerCase();
  if (['off', '0', 'false', 'no', 'none'].includes(flag)) return 'OASIS_SOUNDS is off';
  const forced = ['on', '1', 'true', 'yes'].includes(flag);
  if (!forced) {
    if (state.enabled === false) return 'turned off (/sounds on turns them back on)';
    if (env.CI) return 'running in CI';
    if (env.SSH_CONNECTION || env.SSH_TTY) return 'connected over SSH, so sound would play on the remote machine (OASIS_SOUNDS=on plays anyway)';
    if (!stream || !stream.isTTY) return 'output is not a terminal';
    if (soundVolume(env) === 0) return 'volume is 0';
  }
  const found = player !== undefined ? player : playerFor(env, platform);
  if (!found) return platform === 'linux' ? 'no audio player found (install pipewire, pulseaudio-utils or alsa-utils)' : 'no audio player found';
  return '';
}

function playerFor(env, platform) {
  if (state.player === undefined || env !== process.env) {
    const found = detectPlayer(env, platform);
    if (env !== process.env) return found;
    state.player = found;
  }
  return state.player;
}

const MIN_GAP_MS = { task: 1500, done: 400, attention: 800, error: 400 };

/**
 * Plays a sound without waiting for it. Returns true if it started. Sounds are
 * rate-limited (a tick never stacks on a chime), and failures are silent.
 */
export function playSound(name, options = {}) {
  if (!DESIGNS[name]) return false;
  const env = options.env || process.env;
  const now = options.now ?? Date.now();
  if (soundsOffReason({ ...options, env })) return false;
  if (now - (state.last.get(name) || -Infinity) < (MIN_GAP_MS[name] || 300)) return false;
  if (name === 'task' && now - state.lastAny < 400) return false;
  const player = options.player !== undefined ? options.player : playerFor(env, options.platform || process.platform);
  if (!player) return false;
  let file;
  try { file = soundFile(name, soundVolume(env), env); } catch { return false; }
  state.last.set(name, now);
  state.lastAny = now;
  const launch = options.spawn || spawn;
  try {
    const child = launch(player.command, player.args(file), { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

/** Lets the next sound play at once (after a volume change). */
export function resetRateLimits() { state.last.clear(); state.lastAny = 0; }

/** For tests: forget rate limits and runtime overrides. */
export function resetSoundState() {
  state.enabled = null; state.volume = null; state.last.clear(); state.lastAny = 0; state.player = undefined;
}

/** Number of completed items in a todo list. */
export function completedTodoCount(todos) {
  return Array.isArray(todos) ? todos.filter((todo) => todo && todo.status === 'completed').length : 0;
}
