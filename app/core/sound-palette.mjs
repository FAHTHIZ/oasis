// One sound palette for the terminal and the web app, so a finished task
// sounds the same everywhere. Small FM-style bells: a sine carrier with a
// softly decaying modulator gives a rounded, glassy attack that settles into
// a pure tone, then a gentle low-pass takes the edge off. Quiet by design.
//
// Each note: [frequency Hz, start s, length s, level 0-1].
//   ratio   modulator frequency as a multiple of the note
//   index   modulation depth at the attack (decays to 0 over `bright` s)
//   partials extra sine partials [multiple, level] for warmth
//   cutoff  low-pass cutoff in Hz

export const SOUND_PALETTE = {
  // A task finished: a rising perfect fifth, the second note ringing longer.
  done: { notes: [[659.25, 0, 0.32, 0.5], [987.77, 0.09, 0.62, 0.46]], ratio: 2, index: 1.2, bright: 0.09, partials: [[2, 0.1]], cutoff: 5200 },
  // OASIS needs you (approval, question): two soft taps on the same note.
  attention: { notes: [[880, 0, 0.18, 0.46], [880, 0.16, 0.28, 0.4]], ratio: 3, index: 0.9, bright: 0.05, partials: [[2, 0.08]], cutoff: 4800 },
  // The turn failed: a low falling minor third, muted.
  error: { notes: [[392, 0, 0.24, 0.5], [329.63, 0.13, 0.42, 0.46]], ratio: 1, index: 0.8, bright: 0.12, partials: [[2, 0.1], [3, 0.04]], cutoff: 2600 },
  // A checklist item was completed: one tiny, high tick.
  task: { notes: [[1318.51, 0, 0.11, 0.3]], ratio: 2, index: 0.6, bright: 0.03, partials: [], cutoff: 6000 },
  // A message was sent (web only, when sounds are on): a short soft pop.
  send: { notes: [[587.33, 0, 0.07, 0.28]], ratio: 1, index: 0.4, bright: 0.03, partials: [], cutoff: 3800 }
};

// Web names map onto the shared palette.
export const SOUND_ALIASES = { fail: 'error', input: 'attention' };

export function soundDesign(name) {
  return SOUND_PALETTE[SOUND_ALIASES[name] || name] || null;
}

// Samples in [-1, 1] for one sound (peak `peak`), as a Float32Array.
// The same maths runs in Node (cached WAV files) and could run in a browser.
export function renderSound(name, { sampleRate = 22050, peak = 0.35 } = {}) {
  const design = soundDesign(name);
  if (!design) throw new Error('Unknown sound: ' + name);
  const end = Math.max(...design.notes.map(([, start, length]) => start + length)) + 0.03;
  const samples = new Float32Array(Math.ceil(end * sampleRate));
  const attack = Math.max(1, Math.floor(0.005 * sampleRate));
  for (const [frequency, start, length, level] of design.notes) {
    const first = Math.floor(start * sampleRate);
    const count = Math.floor(length * sampleRate);
    const fade = Math.max(1, Math.floor(0.012 * sampleRate));
    for (let i = 0; i < count && first + i < samples.length; i++) {
      const t = i / sampleRate;
      const envelope = (i < attack ? i / attack : 1) * Math.exp(-5.5 * (t / length)) * Math.min(1, (count - i) / fade);
      const mod = design.index * Math.exp(-t / Math.max(0.005, design.bright)) * Math.sin(2 * Math.PI * frequency * design.ratio * t);
      let value = Math.sin(2 * Math.PI * frequency * t + mod);
      for (const [multiple, amount] of design.partials) value += amount * Math.sin(2 * Math.PI * frequency * multiple * t);
      samples[first + i] += value * envelope * level;
    }
  }
  // One-pole low-pass, run forward: softens the attack without dulling the tone.
  const rc = 1 / (2 * Math.PI * design.cutoff);
  const alpha = (1 / sampleRate) / (rc + 1 / sampleRate);
  let y = 0;
  for (let i = 0; i < samples.length; i++) { y += alpha * (samples[i] - y); samples[i] = y; }
  let max = 0;
  for (const value of samples) max = Math.max(max, Math.abs(value));
  const scale = max > 0 ? peak / max : 0;
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  return samples;
}
