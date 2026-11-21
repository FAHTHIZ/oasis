// Interface sounds for the web app, from the same palette as the terminal
// (soft FM bells, see sound-palette.mjs): a rising chime when a task
// finishes, two taps when OASIS needs you, a low falling tone when a step
// fails, a tiny pop when a message is sent.
//
// enabled(kind) decides per sound. By default (no choice saved) only the
// moments worth hearing play, and only while the tab is in the background:
// "done" and "input" (needs you). Settings can turn every sound on or off.
// Each sound is rendered once into an AudioBuffer, so playing it costs one
// buffer source node: no oscillator graph, no stutter on slow machines.
import { renderSound, soundDesign } from './sound-palette.mjs';

export const SOUND_KINDS = ['done', 'fail', 'input', 'send'];
const SAMPLE_RATE = 22050;

export function createSoundPlayer({ enabled = () => false, win = globalThis, volume = () => 0.5, clock = () => Date.now() } = {}) {
  let context = null;
  let output = null;
  let last = 0;
  const buffers = new Map();
  const bufferFor = (kind) => {
    if (buffers.has(kind)) return buffers.get(kind);
    const samples = renderSound(kind, { sampleRate: SAMPLE_RATE, peak: 0.9 });
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    if (typeof buffer.copyToChannel === 'function') buffer.copyToChannel(samples, 0);
    else buffer.getChannelData(0).set(samples);
    buffers.set(kind, buffer);
    return buffer;
  };
  return function play(kind) {
    if (!soundDesign(kind) || !SOUND_KINDS.includes(kind) || !enabled(kind)) return false;
    const Ctx = win.AudioContext || win.webkitAudioContext;
    if (!Ctx) return false;
    const now = clock();
    if (now - last < 120) return false; // never stack sounds
    last = now;
    try {
      context = context || new Ctx();
      if (context.state === 'suspended') context.resume().catch(() => {});
      if (!output) { output = context.createGain(); output.connect(context.destination); }
      output.gain.value = Math.max(0, Math.min(1, Number(volume()) || 0)) * 0.22;
      const source = context.createBufferSource();
      source.buffer = bufferFor(kind);
      source.connect(output);
      source.start(context.currentTime + 0.005);
      return true;
    } catch { return false; }
  };
}

// The default policy: with no saved choice, play "done" and "input" while the
// page is hidden or not focused; true plays all, false none.
export function soundAllowed(setting, kind, doc = globalThis.document) {
  if (setting === true) return true;
  if (setting === false) return false;
  if (kind !== 'done' && kind !== 'input') return false;
  return Boolean(doc && (doc.hidden || (typeof doc.hasFocus === 'function' && !doc.hasFocus())));
}
