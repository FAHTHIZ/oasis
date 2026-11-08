// Inline image previews in terminals that can draw pictures: the Kitty graphics
// protocol (kitty, Ghostty, WezTerm) and the iTerm2 inline-image protocol
// (iTerm2, WezTerm, VS Code's terminal, Warp). Shown for screenshots and image
// files the agent reads, and for images you attach with @. Elsewhere — tmux,
// screen, pipes, CI, plain terminals — nothing is drawn and output is unchanged.
//
// Turn off with OASIS_INLINE_IMAGES=0, force a protocol with
// OASIS_INLINE_IMAGES=kitty|iterm.

const MAX_BASE64 = 6 * 1024 * 1024; // ~4.5 MB of image; larger ones are skipped
const KITTY_CHUNK = 4096;

/** 'kitty' | 'iterm' | null for this terminal. */
export function inlineImageProtocol(env = process.env, stream = process.stdout) {
  const setting = String(env.OASIS_INLINE_IMAGES || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no', 'never'].includes(setting)) return null;
  if (!stream || !stream.isTTY) return null;
  if (setting === 'kitty' || setting === 'iterm') return setting;
  // Multiplexers swallow or garble image escapes unless specially configured.
  if (env.TMUX || /^screen/.test(String(env.TERM || '')) || env.ZELLIJ) return null;
  if (env.CI || env.OASIS_HEADLESS === '1') return null;
  const term = String(env.TERM || '');
  const program = String(env.TERM_PROGRAM || '');
  if (term === 'xterm-kitty' || env.KITTY_WINDOW_ID || term === 'xterm-ghostty' || program === 'ghostty') return 'kitty';
  if (program === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2' || program === 'WezTerm' || program === 'vscode' || program === 'WarpTerminal') return 'iterm';
  return null;
}

function cellSize(image, { columns = 80, maxRows = 16 } = {}) {
  const maxCols = Math.max(8, Math.min(Number(columns) || 80, 120) - 4);
  const width = Number(image.width) || 0;
  const height = Number(image.height) || 0;
  if (!width || !height) return { cols: Math.min(maxCols, 60), rows: 0 };
  // Terminal cells are about twice as tall as wide.
  let cols = Math.min(maxCols, Math.max(8, Math.round(width / 10)));
  let rows = Math.round(cols * (height / width) / 2);
  if (rows > maxRows) { rows = maxRows; cols = Math.max(8, Math.round(rows * 2 * width / height)); }
  return { cols, rows: Math.max(1, rows) };
}

/**
 * The escape sequence that draws `image` ({ mediaType, data: base64, width?,
 * height? }) inline, or '' when it cannot or should not be drawn.
 */
export function inlineImageSequence(image, protocol, options = {}) {
  if (!image || !protocol || typeof image.data !== 'string' || !image.data) return '';
  if (image.data.length > MAX_BASE64 || !/^[A-Za-z0-9+/=\s]+$/.test(image.data.slice(0, 4096))) return '';
  const data = image.data.replace(/\s+/g, '');
  const { cols, rows } = cellSize(image, options);
  if (protocol === 'iterm') {
    const size = Math.floor(data.length * 3 / 4);
    return '\x1b]1337;File=inline=1;size=' + size + ';width=' + cols + (rows ? ';height=' + rows : '') + ';preserveAspectRatio=1:' + data + '\x07';
  }
  if (protocol === 'kitty') {
    // Kitty decodes PNG itself (f=100); other formats need converting first.
    if (String(image.mediaType || '').toLowerCase() !== 'image/png') return '';
    let out = '';
    for (let i = 0; i < data.length; i += KITTY_CHUNK) {
      const chunk = data.slice(i, i + KITTY_CHUNK);
      const more = i + KITTY_CHUNK < data.length ? 1 : 0;
      const control = i === 0 ? 'a=T,f=100,q=2,c=' + cols + (rows ? ',r=' + rows : '') + ',m=' + more : 'm=' + more;
      out += '\x1b_G' + control + ';' + chunk + '\x1b\\';
    }
    return out;
  }
  return '';
}

/** Kitty only takes PNG: convert other formats with sharp when it is installed. */
async function asPng(image) {
  if (String(image.mediaType || '').toLowerCase() === 'image/png') return image;
  const sharp = await import('sharp').then((module) => module.default).catch(() => null);
  if (!sharp) return null;
  try {
    const { data, info } = await sharp(Buffer.from(image.data, 'base64')).png().toBuffer({ resolveWithObject: true });
    return { mediaType: 'image/png', data: data.toString('base64'), width: info.width, height: info.height };
  } catch { return null; }
}

/** Write a preview of each image to `stream`, with a blank line after. Never throws. */
export async function writeInlineImages(images, { stream = process.stdout, env = process.env, maxRows = 16 } = {}) {
  try {
    const protocol = inlineImageProtocol(env, stream);
    if (!protocol) return false;
    let wrote = false;
    for (const original of (Array.isArray(images) ? images : [images]).slice(0, 4)) {
      const image = protocol === 'kitty' ? await asPng(original || {}) : original;
      const sequence = inlineImageSequence(image, protocol, { columns: stream.columns, maxRows });
      if (!sequence) continue;
      stream.write('  ' + sequence + '\n');
      wrote = true;
    }
    return wrote;
  } catch {
    return false;
  }
}
