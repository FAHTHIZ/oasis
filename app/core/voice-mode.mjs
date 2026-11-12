// Talk mode: a hands-free voice conversation with the agent. OASIS listens, sends what
// you said when you stop talking, works on it, reads the reply aloud and listens again.
// This module holds the parts that don't need a browser, so they can be tested.

/**
 * A chat reply made suitable for reading aloud: code blocks, link targets, URLs,
 * tables and Markdown markup are dropped or simplified, and long replies stop at a
 * sentence boundary. (Same rules as speakableText in src/tts.mjs.)
 */
export function speakable(markdown, limit = 900) {
  let text = String(markdown || '');
  text = text.replace(/```[\s\S]*?(```|$)/g, ' (code omitted) ');
  text = text.replace(/`([^`\n]+)`/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/https?:\/\/[^\s<>()]+?(?=[.,;:!?]*(\s|$))/g, 'a link');
  text = text.split('\n').filter((line) => !/^\s*\|.*\|\s*$/.test(line)).join('\n');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*>\s?/gm, '');
  text = text.replace(/(\*\*|__|\*|_|~~)(\S[^\n]*?\S|\S)\1/g, '$2');
  text = text.replace(/\s*\n\s*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  return (end > limit * 0.5 ? cut.slice(0, end + 1) : cut).trim() + ' The rest is on screen.';
}

/** Phrases that end the conversation instead of being sent. */
export function isStopPhrase(text) {
  return /^(?:ok(?:ay)?[, ]+)?(?:stop talking|stop listening|end (?:the )?(?:conversation|call|talk)|that'?s all|goodbye|bye(?: oasis)?)[.!]?$/i.test(String(text || '').trim());
}

/**
 * Decides when a spoken turn is over from microphone loudness samples (0..1 RMS),
 * for browsers without speech recognition that record and transcribe instead.
 * push(level, now) returns 'listening', 'done' (speech then silence, or too long)
 * or 'nothing' (no speech heard in time).
 */
export function turnDetector({ threshold = 0.035, silenceMs = 1300, noSpeechMs = 9000, maxMs = 45000, start = 0 } = {}) {
  let began = start;
  let heard = false;
  let quietSince = null;
  return {
    get heard() { return heard; },
    push(level, now) {
      if (began === null || began === undefined) began = now;
      if (now - began > maxMs) return heard ? 'done' : 'nothing';
      if (level >= threshold) { heard = true; quietSince = null; return 'listening'; }
      if (!heard) return now - began > noSpeechMs ? 'nothing' : 'listening';
      if (quietSince === null) quietSince = now;
      return now - quietSince >= silenceMs ? 'done' : 'listening';
    }
  };
}

/** Root-mean-square loudness of a time-domain sample buffer (bytes centred on 128). */
export function rmsLevel(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (const value of samples) { const centred = (value - 128) / 128; sum += centred * centred; }
  return Math.sqrt(sum / samples.length);
}

/** The text of the agent's last reply in this turn, from the chat's display entries. */
export function lastReply(display) {
  const entries = Array.isArray(display) ? display : [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.role === 'user') break;
    if (entry.role === 'assistant' && String(entry.content || '').trim()) return String(entry.content);
    if (entry.role === 'error' && String(entry.content || '').trim()) return 'Something went wrong: ' + String(entry.content);
  }
  return '';
}
