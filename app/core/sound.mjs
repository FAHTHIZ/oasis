// Optional interface sounds. Off by default; turned on in Settings.
// Tones are synthesized with Web Audio (no audio files to download) and kept
// short and quiet: a soft rising chime when a task finishes, a low blip when a
// step fails, a tick when OASIS needs you.
const TONES = {
  done: [[660, 0, 0.09], [880, 0.08, 0.14]],
  fail: [[220, 0, 0.12], [185, 0.09, 0.16]],
  input: [[740, 0, 0.07], [740, 0.12, 0.07]],
  send: [[520, 0, 0.05]]
};

export function createSoundPlayer({ enabled = () => false, win = globalThis } = {}) {
  let context = null;
  let last = 0;
  return function play(kind) {
    const tones = TONES[kind];
    if (!tones || !enabled()) return false;
    const Ctx = win.AudioContext || win.webkitAudioContext;
    if (!Ctx) return false;
    const now = Date.now();
    if (now - last < 120) return false; // never stack sounds
    last = now;
    try {
      context = context || new Ctx();
      if (context.state === 'suspended') context.resume().catch(() => {});
      const start = context.currentTime + 0.01;
      for (const [frequency, offset, length] of tones) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.06, start + offset + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + length);
        osc.connect(gain).connect(context.destination);
        osc.start(start + offset);
        osc.stop(start + offset + length + 0.02);
      }
      return true;
    } catch { return false; }
  };
}

export const SOUND_KINDS = Object.keys(TONES);
