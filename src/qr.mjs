// QR codes for showing connection links in a terminal, so a phone can scan
// instead of typing a long token. Encoding is uqr (unjs, MIT, no dependencies,
// a port of Project Nayuki's reference generator); the matrices are checked
// against python-qrcode fingerprints in test/qr.test.mjs.
import { encode } from 'uqr';

const LEVELS = new Set(['L', 'M', 'Q', 'H']);

// Returns { version, size, mask, modules } where modules[y][x] is true for dark.
export function encodeQr(text, { ecl = 'M', minVersion = 1, maxVersion = 40, mask = -1 } = {}) {
  if (!LEVELS.has(ecl)) throw new Error('Unsupported QR error correction level: ' + ecl);
  let qr;
  try {
    qr = encode(String(text), { ecc: ecl, minVersion, maxVersion, maskPattern: mask, boostEcc: false, border: 0 });
  } catch (error) {
    if (/too long/i.test(String(error && error.message))) throw new Error('Text is too long for a QR code.');
    throw error;
  }
  return { version: qr.version, size: qr.size, mask: qr.maskPattern, modules: qr.data };
}

// Render with half-block characters (two module rows per text line) in fixed
// black-on-white colors, so it scans on dark and light terminals alike.
export function renderQrTerminal(text, { quiet = 2, color = true, ...options } = {}) {
  const { size, modules } = encodeQr(text, options);
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && modules[y][x];
  const lines = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < size + quiet; x += 1) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      // Foreground white paints light modules; the black background shows dark ones.
      line += !top && !bottom ? '█' : !top && bottom ? '▀' : top && !bottom ? '▄' : ' ';
    }
    lines.push(color ? '\x1b[97;40m' + line + '\x1b[0m' : line);
  }
  return lines.join('\n');
}
