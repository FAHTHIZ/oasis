// Lines added and removed by one edit: the "+12 −3" an activity feed shows
// next to "Edited src/app.mjs", and the totals in a turn's summary line.
//
// Common leading and trailing lines are set aside first (most edits touch a
// small middle), then the middle is diffed line by line with a longest
// common subsequence when it is small enough to do quickly. A huge middle
// counts every old line as removed and every new one as added, which is
// what a rewrite is anyway.

const LCS_CELLS = 4_000_000;

function splitLines(text) {
  const value = String(text ?? '');
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function lineStats(before, after) {
  const a = before == null ? [] : splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (!n || !m) return { added: m, removed: n };
  if (n * m > LCS_CELLS) return { added: m, removed: n };
  // One row of the LCS table at a time.
  let prev = new Uint32Array(m + 1);
  let row = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const line = a[start + i - 1];
    for (let j = 1; j <= m; j++) row[j] = line === b[start + j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    [prev, row] = [row, prev];
  }
  const common = prev[m];
  return { added: m - common, removed: n - common };
}

// "+12 −3" (or "+12" / "−3" alone), '' when nothing changed.
export function formatLineStats(stats) {
  if (!stats) return '';
  const added = Math.max(0, Number(stats.added) || 0);
  const removed = Math.max(0, Number(stats.removed) || 0);
  return [added ? '+' + added : '', removed ? '−' + removed : ''].filter(Boolean).join(' ');
}
