// Fen, the OASIS mascot: a pixel-art fennec fox, the desert fox that finds water.
// One sprite drives the terminal banner (half-block characters, two pixels per
// cell), the web app's welcome screen and the SVG artwork in assets/.

// Palette keys. `.` is transparent.
export const FEN_PALETTE = {
  L: '#7CFF5E', // Portal Lime: fur
  G: '#32E07A', // Growth Green: shading
  E: '#0A7846', // ear interior
  N: '#0B0F0C', // Night: eyes and nose
  M: '#E6F5EA'  // Mist: muzzle and eye shine
};

export const FEN = [
  'L............L',
  'LL..........LL',
  'LEL........LEL',
  'LEEL......LEEL',
  'LEEELLLLLLEEEL',
  '.LELLLLLLLLEL.',
  '.LLMNLLLLNMLL.',
  'GLLNNLLLLNNLLG',
  '.GLLLMMMMLLLG.',
  '..GLMMNNMMLG..',
  '....GMMMMG....'
];

// Eyes closed: the blink frame.
export const FEN_BLINK = FEN.map((row, y) => (y === 6 ? row.replace(/[MN]/g, 'L') : y === 7 ? row.replace(/N/g, 'G') : row));

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Terminal rows: each character cell shows two sprite pixels using ▀ with a
// foreground (top) and background (bottom) color. Without color, shapes only.
export function fenLines({ color = true, blink = false, palette = FEN_PALETTE } = {}) {
  const sprite = blink ? FEN_BLINK : FEN;
  const rows = sprite.length % 2 ? [...sprite, '.'.repeat(sprite[0].length)] : sprite;
  const lines = [];
  for (let y = 0; y < rows.length; y += 2) {
    let out = '';
    for (let x = 0; x < rows[y].length; x += 1) {
      const top = rows[y][x];
      const bottom = rows[y + 1][x];
      if (!color) {
        // Eyes and nose read as holes in the silhouette.
        const a = top !== '.' && top !== 'N';
        const b = bottom !== '.' && bottom !== 'N';
        out += a && b ? '█' : a ? '▀' : b ? '▄' : ' ';
        continue;
      }
      if (top === '.' && bottom === '.') { out += '\x1b[0m '; continue; }
      if (top === '.') { out += '\x1b[0m\x1b[38;2;' + hexRgb(palette[bottom]).join(';') + 'm▄'; continue; }
      if (bottom === '.') { out += '\x1b[0m\x1b[38;2;' + hexRgb(palette[top]).join(';') + 'm▀'; continue; }
      out += '\x1b[38;2;' + hexRgb(palette[top]).join(';') + 'm\x1b[48;2;' + hexRgb(palette[bottom]).join(';') + 'm▀';
    }
    lines.push(out + (color ? '\x1b[0m' : ''));
  }
  return lines;
}

export const FEN_COLUMNS = FEN[0].length;
