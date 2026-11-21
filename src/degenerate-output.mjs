// Small local models (seen live: qwen2.5-coder:3b on Ollama, CPU) sometimes
// fall into a loop and emit the same text until max_tokens: 4,333 tokens at
// 4 t/s held one step for 16 minutes. This spots a reply whose tail is one
// unit repeated over and over, so the request can be cut and retried.
//
// Thresholds are deliberately high: at least MIN_RUN characters and
// MIN_REPEATS copies of a unit of at most MAX_PERIOD characters. Real output
// with structure (tables, data literals, ruled lines) rarely runs 2,000+
// characters of an exact repeat; a runaway loop passes that in seconds.

const MAX_PERIOD = 500;
const MIN_RUN = 2000;
const MIN_REPEATS = 10;
const WINDOW = 8000;

/**
 * If the end of `text` is one unit repeated, return { unit, repeats, start }:
 * `start` is where the repetition begins (keep text before it plus one unit).
 * Otherwise null.
 */
export function detectRepetition(text, options = {}) {
  const value = String(text || '');
  const minRun = options.minRun || MIN_RUN;
  const minRepeats = options.minRepeats || MIN_REPEATS;
  const maxPeriod = options.maxPeriod || MAX_PERIOD;
  if (value.length < minRun) return null;
  const offset = Math.max(0, value.length - (options.window || WINDOW));
  const tail = value.slice(offset);
  const n = tail.length;
  for (let period = 1; period <= maxPeriod && period * minRepeats <= n; period++) {
    // Length of the suffix in which every character equals the one `period` back.
    let i = n - 1;
    while (i >= period && tail.charCodeAt(i) === tail.charCodeAt(i - period)) i--;
    const run = n - 1 - i + period; // the first copy plus the matched part
    if (run < Math.max(minRun, period * minRepeats)) continue;
    // Shorter periods are tried first, so the unit found is the smallest one.
    const start = offset + n - run;
    const unit = value.slice(start, start + period);
    return { unit, repeats: Math.floor(run / period), start };
  }
  return null;
}

/** The reply with the loop collapsed to one copy and a note of what was cut. */
export function collapseRepetition(text, found) {
  const value = String(text || '');
  if (!found) return value;
  return value.slice(0, found.start + found.unit.length) + '\n[... the same text repeated ' + (found.repeats - 1) + ' more times; cut off]';
}

export const DEGENERATE_OUTPUT_NUDGE = '<system-reminder>Your last reply got stuck repeating the same text, so it was cut off and nothing in it ran. Do not repeat it. Make the next tool call the task needs, or give a short final answer.</system-reminder>';
