// Word-wrapping for plain terminal reports (oasis doctor and similar), so long
// "  label: value" lines break between words with a hanging indent instead of
// the terminal splitting a word across two lines. Widths and escape codes are
// handled by wrap-ansi and string-width (the wrapper and width behind Ink).
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';

const wrap = (text, columns) => wrapAnsi(text, columns, { hard: false, trim: true }).split('\n');

/** Wraps every line of text to columns; continuation lines get the line's indent plus two spaces. */
export function wrapTerminalText(text, columns) {
  const width = Number(columns) || 0;
  if (width < 20) return String(text);
  return String(text).split('\n').map((line) => {
    if (stringWidth(line) <= width) return line;
    const lead = line.slice(0, line.length - line.trimStart().length);
    const indent = ' '.repeat(Math.min(lead.length + 2, Math.floor(width / 2)));
    const [first, ...rest] = wrap(line.trimStart(), width - lead.length);
    const tail = rest.length ? wrap(rest.join(' '), width - indent.length).map((row) => indent + row) : [];
    return [lead + first, ...tail].join('\n');
  }).join('\n');
}
