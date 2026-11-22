// Keeps text from the model and from tools from driving the user's terminal.
//
// Terminal escape sequences in a reply or in command output can do more than
// colour text: OSC 52 writes the clipboard (the user later pastes a command
// they never saw), OSC 0/2 retitle the window, DCS strings reach terminal
// features, and cursor moves or carriage returns can hide what was printed.
// A prompt-injected page or file is enough to put them there.
//
// terminalSafe() is for text that should contain no control sequences at all
// (model replies). guardTerminalStream() wraps a TTY stream so the sequences
// with side effects outside the screen are dropped from everything written to
// it, except what Oasis itself writes through writeTrusted() (for example
// /copy falling back to OSC 52).

// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P_^X][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])?|[\x9b][0-?]*[ -/]*[@-~]|[\x9d\x90\x9e\x9f\x98][^\x07\x9c\x1b]*[\x07\x9c]?/g;
// eslint-disable-next-line no-control-regex
const OTHER_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Text with every terminal control sequence removed (tabs and newlines stay). */
export function terminalSafe(text) {
  if (typeof text !== 'string' || !text) return text;
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return text;
  return text.replace(/\r\n/g, '\n').replace(ESCAPE_SEQUENCE, '').replace(OTHER_CONTROLS, '');
}

// Sequences with effects beyond the visible screen: clipboard (OSC 52),
// window and icon titles (OSC 0, 1, 2), and device control strings (DCS, in
// 7-bit and 8-bit form). Colours, cursor moves, hyperlinks (OSC 8),
// notifications (OSC 9, 99) and inline images stay, because Oasis draws with
// them.
// eslint-disable-next-line no-control-regex
const SIDE_EFFECT_SEQUENCE = /(?:\x1b\]|\x9d)(?:52|[012])\s*;[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1bP|\x90)[^\x1b\x9c]*(?:\x1b\\|\x9c)?/g;
const TRUSTED = Symbol('oasis.trustedWrite');

export function stripSideEffectSequences(text) {
  if (typeof text !== 'string' || (!text.includes('\x1b') && !/[\x90\x9d]/.test(text))) return text;
  return text.replace(SIDE_EFFECT_SEQUENCE, '');
}

/** Filters everything written to a TTY stream; idempotent. */
export function guardTerminalStream(stream) {
  if (!stream || typeof stream.write !== 'function' || stream[TRUSTED]) return stream;
  const original = stream.write.bind(stream);
  stream[TRUSTED] = original;
  stream.write = (chunk, ...rest) => original(typeof chunk === 'string' ? stripSideEffectSequences(chunk) : chunk, ...rest);
  return stream;
}

/** Writes Oasis's own sequence (such as an OSC 52 copy) past the guard. */
export function writeTrusted(stream, text) {
  return (stream && stream[TRUSTED] ? stream[TRUSTED] : stream.write.bind(stream))(text);
}
