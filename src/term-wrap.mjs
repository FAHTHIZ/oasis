// Word-wrapping for plain terminal reports (oasis doctor and similar), so long
// "  label: value" lines break between words with a hanging indent instead of
// the terminal splitting a word across two lines.

const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (text) => text.replace(ANSI, '').length;

/** Wraps every line of text to columns; continuation lines get the line's indent plus two spaces. */
export function wrapTerminalText(text, columns) {
  const width = Number(columns) || 0;
  if (width < 20) return String(text);
  return String(text).split('\n').map((line) => {
    if (visible(line) <= width) return line;
    const indent = ' '.repeat(Math.min((line.match(/^ */) || [''])[0].length + 2, Math.floor(width / 2)));
    const words = line.trimStart().split(/ +/);
    const lead = line.slice(0, line.length - line.trimStart().length);
    const out = [];
    let current = lead;
    let length = lead.length;
    for (const word of words) {
      const size = visible(word);
      const fresh = current === lead || current === indent;
      if (!fresh && length + 1 + size > width) { out.push(current); current = indent + word; length = indent.length + size; continue; }
      current += (fresh ? '' : ' ') + word;
      length += (fresh ? 0 : 1) + size;
    }
    out.push(current);
    return out.join('\n');
  }).join('\n');
}
