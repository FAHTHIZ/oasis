// Extra animated README artwork, built by scripts/readme-art.mjs: the prompt
// strip, the numbers strip, the quick start, the eight capability cards, the
// provider marquee, the interfaces orbit and the footer. Same rules as the rest
// of the README art: plain SVG with CSS keyframes and SMIL, no scripts, no web
// fonts, and every animation inside `prefers-reduced-motion: no-preference` so
// reduced motion shows a finished frame.
import { FEN, FEN_PALETTE } from '../src/mascot.mjs';

export const SANS = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
export const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const LIME = '#7CFF5E';
const GREEN = '#32E07A';
const EMERALD = '#0ED168';

const pct = (seconds, total) => +(Math.min(Math.max(seconds, 0), total) / total * 100).toFixed(2);
const motion = (css) => '@media (prefers-reduced-motion: no-preference) {\n' + css + '\n}';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function palette(theme) {
  return theme === 'dark'
    ? { dark: true, panel: '#0E1510', panel2: '#121B15', stroke: '#1F2E23', text: '#E6F5EA', sub: '#8FA597', faint: '#5E7064', hot: LIME, warm: GREEN, deep: EMERALD, chip: '#123A1F', chipText: LIME, add: '#14361F', del: '#3A1B1B', red: '#FF7A7A', amber: '#FBBF24', amberBg: '#3A2F12' }
    : { dark: false, panel: '#FFFFFF', panel2: '#F2FBF4', stroke: '#D5E5DA', text: '#0B1A10', sub: '#4A6352', faint: '#71877A', hot: '#0A7846', warm: '#18A957', deep: '#0A7846', chip: '#E3FBE6', chipText: '#0A7846', add: '#DDF6E3', del: '#FBE4E4', red: '#B42318', amber: '#9A5B00', amberBg: '#FFF1D6' };
}

// Fade and rise in at `at`, hold, fade out with the loop.
function reveal(name, at, T, hold = T - 0.9) {
  const a = pct(at, T), b = pct(at + 0.35, T), c = pct(hold, T), d = pct(hold + 0.5, T);
  return `.${name}{animation:${name} ${T}s linear infinite}
@keyframes ${name}{0%,${a}%{opacity:0;transform:translateY(5px)}${b}%,${c}%{opacity:1;transform:none}${d}%,100%{opacity:0;transform:none}}`;
}
// Visible only between `from` and `to`.
function window_(name, from, to, T) {
  return `.${name}{animation:${name} ${T}s linear infinite}
@keyframes ${name}{0%,${pct(from, T)}%{opacity:0}${pct(from + 0.25, T)}%,${pct(to, T)}%{opacity:1}${pct(to + 0.25, T)}%,100%{opacity:0}}`;
}

// Monospace text typed one character at a time: a cover in the background
// colour slides right in character steps, carrying a caret.
function typed(name, { x, y, text, at, dur, T, fs = 15, bg, fill, caret, weight = 400, caretEnd = true }) {
  const cw = fs * 0.62;
  const width = Math.ceil(text.length * cw) + 14;
  const n = text.length;
  const css = `.${name}{animation:${name} ${T}s infinite}
@keyframes ${name}{0%,${pct(at, T)}%{transform:translateX(0);opacity:1;animation-timing-function:steps(${n},end)}${pct(at + dur, T)}%,${pct(at + dur + 0.7, T)}%{transform:translateX(${width - 12}px);opacity:1}${pct(at + dur + 0.75, T)}%,100%{transform:translateX(${width - 12}px);opacity:0}}` +
    (caretEnd ? '' : `\n.${name}c{animation:${name}c ${T}s steps(1,end) infinite}\n@keyframes ${name}c{0%,${pct(at + dur + 0.6, T)}%{opacity:1}${pct(at + dur + 0.65, T)}%,100%{opacity:0}}`);
  const svg = `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${fs}" font-weight="${weight}" fill="${fill}" xml:space="preserve">${esc(text)}</text>
<g class="${name}"><rect x="${x - 1}" y="${y - fs}" width="${width + 4}" height="${fs + 7}" fill="${bg}"/><rect${caretEnd ? '' : ` class="${name}c"`} x="${x}" y="${y - fs + 2}" width="${Math.round(fs * 0.55)}" height="${fs + 2}" fill="${caret}" opacity=".9"/></g>`;
  return { svg, css };
}

function svgDoc(W, H, title, desc, css, body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<defs>${defs}</defs>
<style>
${motion(css)}
</style>
${body}
</svg>
`;
}

// The portal mark, drawn at 300×300 and scaled by the caller.
const portalMark = (grad) => `<path d="M18 151 C18 76 76 13 150 13 C224 13 282 76 282 151 L224 151 C224 101 194 63 150 63 C106 63 76 101 76 151 Z" fill="url(#${grad})"/>
<g fill="url(#${grad})"><path d="M18 151 H98 V160 H18 Z M202 151 H282 V160 H202 Z"/><path d="M21 168 H92 V176 H21 Z M208 168 H279 V176 H208 Z"/><path d="M27 185 H99 V193 H27 Z M201 185 H273 V193 H201 Z"/><path d="M36 202 H113 V210 H36 Z M187 202 H264 V210 H187 Z"/><path d="M46 219 H124 V227 H46 Z M176 219 H254 V227 H176 Z"/><path d="M58 236 H132 V244 H58 Z M168 236 H242 V244 H168 Z"/><path d="M73 253 H133 V260 H73 Z M167 253 H227 V260 H167 Z"/><path d="M91 269 H132 V275 H91 Z M168 269 H209 V275 H168 Z"/></g>`;
const portalGrad = (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B6FF83"/><stop offset=".5" stop-color="${LIME}"/><stop offset="1" stop-color="${EMERALD}"/></linearGradient>`;

// Fen from the sprite, one rect per pixel, at `px` pixels per sprite pixel.
function fen(px, { blinkClass } = {}) {
  let out = '';
  FEN.forEach((row, y) => [...row].forEach((k, x) => { if (k !== '.') out += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${FEN_PALETTE[k]}"/>`; }));
  if (blinkClass) {
    // Lids over the eye pixels (row 6 columns 3-4 and 9-10, row 7 the same).
    let lids = '';
    for (const x of [3, 4, 9, 10]) lids += `<rect x="${x * px}" y="${6 * px}" width="${px}" height="${px}" fill="${FEN_PALETTE.L}"/><rect x="${x * px}" y="${7 * px}" width="${px}" height="${px}" fill="${FEN_PALETTE.G}"/>`;
    out += `<g class="${blinkClass}" opacity="0">${lids}</g>`;
  }
  return out;
}

// --- Prompt strip: "One runtime for <typed word>" --------------------------
export function tagline(theme) {
  const c = palette(theme);
  const W = 1280, H = 96;
  const words = ['software', 'research', 'data analysis', 'writing', 'automation', 'computer use'];
  const slot = 3.2, T = slot * words.length;
  const fs = 30, x = 608, y = 58;
  const css = [];
  let body = '';
  words.forEach((word, i) => {
    const start = i * slot;
    const n = word.length;
    const cw = fs * 0.62;
    const w = Math.ceil(n * cw) + 10;
    // Each word types in, holds, then erases, inside its own slot.
    css.push(`.w${i}{animation:w${i} ${T}s infinite}
@keyframes w${i}{0%,${pct(start, T)}%{opacity:0}${pct(start + 0.01, T)}%,${pct(start + slot - 0.05, T)}%{opacity:1}${pct(start + slot, T)}%,100%{opacity:0}}
.k${i}{animation:k${i} ${T}s infinite}
@keyframes k${i}{0%,${pct(start, T)}%{transform:translateX(0);animation-timing-function:steps(${n},end)}${pct(start + 0.9, T)}%,${pct(start + slot - 0.75, T)}%{transform:translateX(${w - 10}px);animation-timing-function:steps(${n},end)}${pct(start + slot - 0.15, T)}%,100%{transform:translateX(0)}}`);
    body += `<g class="w${i}"><text x="${x}" y="${y}" font-family="${MONO}" font-size="${fs}" font-weight="700" fill="${c.hot}">${esc(word)}</text>
  <g class="k${i}"><rect x="${x - 2}" y="${y - fs - 2}" width="${w + 340}" height="${fs + 14}" fill="${c.panel}"/><rect class="caret" x="${x + 1}" y="${y - fs + 3}" width="15" height="${fs}" fill="${c.hot}"/></g></g>\n`;
  });
  css.push(`.caret{animation:blink 1s steps(1,end) infinite}@keyframes blink{50%{opacity:0}}
.glow{animation:glow 4s ease-in-out infinite alternate}@keyframes glow{from{opacity:.35}to{opacity:.9}}`);
  const defs = `<linearGradient id="edge" x1="0" x2="1"><stop offset="0" stop-color="${c.hot}" stop-opacity=".1"/><stop offset=".5" stop-color="${c.hot}" stop-opacity=".8"/><stop offset="1" stop-color="${c.hot}" stop-opacity=".1"/></linearGradient>`;
  const frame = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${(H - 2) / 2}" fill="${c.panel}" stroke="${c.stroke}" stroke-width="1.5"/>
<rect class="glow" x="200" y="${H - 2.5}" width="880" height="1.5" fill="url(#edge)"/>
<text x="252" y="${y}" font-family="${MONO}" font-size="${fs}" font-weight="700" fill="${c.hot}">❯</text>
<text x="${x - 14}" y="${y}" text-anchor="end" font-family="${SANS}" font-size="${fs}" font-weight="700" fill="${c.text}">One open runtime for</text>
${body}
<g font-family="${SANS}" font-size="15" font-weight="700"><rect x="${W - 228}" y="${H / 2 - 17}" width="164" height="34" rx="17" fill="${c.chip}"/><circle cx="${W - 206}" cy="${H / 2}" r="5" fill="${c.hot}" class="glow"/><text x="${W - 192}" y="${H / 2 + 5.5}" fill="${c.chipText}">with any model</text></g>`;
  return svgDoc(W, H, 'One open runtime for software, research, data analysis, writing, automation and computer use',
    'A prompt bar that types, in turn: software, research, data analysis, writing, automation and computer use, after the words One open runtime for. A chip on the right reads with any model.', css.join('\n'), frame, defs);
}

// --- Numbers strip: odometer counters ---------------------------------------
export function stats(theme) {
  const c = palette(theme);
  const W = 1280, H = 168, T = 14;
  const tiles = [
    { value: '3,700', suffix: '+', label: 'tests in the suite' },
    { value: '48', suffix: '', label: 'built-in app connectors' },
    { value: '8', suffix: '', label: 'chat app gateways' },
    { value: '0', suffix: '', label: 'hosted services required' }
  ];
  const gap = 20, tw = (W - gap * 3) / 4, fs = 54, lh = 64, cw = 34;
  const css = [], defs = [];
  let body = '';
  let col = 0;
  tiles.forEach((tile, i) => {
    const x0 = i * (tw + gap);
    const chars = [...tile.value, ...tile.suffix];
    const total = chars.reduce((s, ch) => s + (ch === ',' ? 16 : cw), 0);
    let cx = x0 + 32;
    const top = 30;
    body += `<g><rect x="${x0 + 1}" y="1" width="${tw - 2}" height="${H - 2}" rx="20" fill="${c.panel}" stroke="${c.stroke}" stroke-width="1.5"/>
  <rect class="bar${i}" x="${x0 + 32}" y="${H - 22}" width="${tw - 64}" height="3" rx="1.5" fill="${c.hot}"/>`;
    css.push(`.bar${i}{transform-box:fill-box;transform-origin:left;animation:bar${i} ${T}s ease-out infinite}@keyframes bar${i}{0%,${pct(0.3 + i * 0.25, T)}%{transform:scaleX(0)}${pct(2.2 + i * 0.25, T)}%,${pct(T - 0.6, T)}%{transform:scaleX(1)}100%{transform:scaleX(0)}}`);
    chars.forEach((ch, j) => {
      if (!/\d/.test(ch)) {
        body += `<text x="${cx + (ch === ',' ? 6 : cw / 2)}" y="${top + 52}" text-anchor="middle" font-family="${MONO}" font-size="${fs}" font-weight="800" fill="${ch === '+' ? c.hot : c.text}">${ch}</text>`;
        cx += ch === ',' ? 16 : cw;
        return;
      }
      const d = +ch;
      const id = 'col' + col;
      defs.push(`<clipPath id="${id}w"><rect x="${cx - 2}" y="${top}" width="${cw + 4}" height="${lh}"/></clipPath>`);
      let digits = '';
      for (let k = 0; k <= 10 + d; k++) digits += `<text x="${cx + cw / 2}" y="${top + 52 + k * lh}" text-anchor="middle">${k % 10}</text>`;
      const start = 0.3 + i * 0.25 + j * 0.12, end = start + 1.6 + j * 0.15;
      css.push(`.${id}{animation:${id} ${T}s infinite}@keyframes ${id}{0%,${pct(start, T)}%{transform:translateY(0);animation-timing-function:cubic-bezier(.2,.7,.1,1)}${pct(end, T)}%,${pct(T - 0.5, T)}%{transform:translateY(-${(10 + d) * lh}px)}100%{transform:translateY(0)}}`);
      body += `<g clip-path="url(#${id}w)"><g class="${id}" font-family="${MONO}" font-size="${fs}" font-weight="800" fill="${c.text}">${digits}</g></g>`;
      cx += cw;
      col++;
    });
    body += `<text x="${x0 + 32}" y="${top + 94}" font-family="${SANS}" font-size="17" font-weight="600" fill="${c.sub}">${esc(tile.label)}</text></g>\n`;
    void total;
  });
  return svgDoc(W, H, 'OASIS in numbers', 'Four counters roll up: more than 3,700 tests in the suite, 48 built-in app connectors, 8 chat app gateways, and 0 hosted services required.', css.join('\n'), body, defs.join(''));
}

// --- Quick start: install, connect, ask --------------------------------------
export function quickstart(theme) {
  const c = palette(theme);
  const W = 1280, H = 250, T = 12;
  const steps = [
    { n: '01', title: 'Install', cmd: 'curl -fsSL …/install.sh | sh', out: '✓ oasis doctor: ready', at: 0.4 },
    { n: '02', title: 'Connect a model', cmd: 'oasis connect', out: '✓ tested with a real tool call', at: 3.0 },
    { n: '03', title: 'Ask in plain words', cmd: 'oasis', out: '✓ checked · ready for review', at: 5.6 }
  ];
  const gap = 56, cw = (W - gap * 2) / 3;
  const css = [];
  let body = '';
  steps.forEach((s, i) => {
    const x = i * (cw + gap);
    const t = typed('ty' + i, { x: x + 52, y: 150, text: s.cmd, at: s.at + 0.4, dur: Math.max(0.5, s.cmd.length * 0.05), T, fs: 16, bg: c.panel2, fill: c.text, caret: c.hot, caretEnd: false });
    css.push(t.css);
    css.push(`.cd${i}{animation:cd${i} ${T}s ease-in-out infinite}@keyframes cd${i}{0%,${pct(s.at, T)}%{stroke:${c.stroke}}${pct(s.at + 0.3, T)}%,${pct(s.at + 2.3, T)}%{stroke:${c.hot}}${pct(s.at + 2.7, T)}%,100%{stroke:${c.stroke}}}`);
    css.push(reveal('o' + i, s.at + 0.6 + s.cmd.length * 0.05, T));
    body += `<g><rect class="cd${i}" x="${x + 1}" y="1" width="${cw - 2}" height="${H - 2}" rx="20" fill="${c.panel}" stroke="${c.stroke}" stroke-width="1.5"/>
  <text x="${x + 28}" y="46" font-family="${MONO}" font-size="14" font-weight="700" fill="${c.hot}" letter-spacing="2">${s.n}</text>
  <text x="${x + 28}" y="88" font-family="${SANS}" font-size="26" font-weight="800" fill="${c.text}">${esc(s.title)}</text>
  <rect x="${x + 24}" y="118" width="${cw - 48}" height="48" rx="12" fill="${c.panel2}" stroke="${c.stroke}"/>
  <text x="${x + 34}" y="150" font-family="${MONO}" font-size="16" font-weight="700" fill="${c.hot}">$</text>
  ${t.svg}
  <g class="o${i}"><text x="${x + 28}" y="204" font-family="${MONO}" font-size="15" fill="${c.warm}">${esc(s.out)}</text></g></g>\n`;
    if (i < 2) {
      const ax = x + cw + 8, ay = H / 2;
      css.push(`.ar${i}{animation:ar${i} ${T}s linear infinite}@keyframes ar${i}{0%,${pct(s.at + 2.0, T)}%{transform:translateX(0);opacity:0}${pct(s.at + 2.1, T)}%{opacity:1}${pct(s.at + 2.6, T)}%{transform:translateX(${gap - 16}px);opacity:1}${pct(s.at + 2.7, T)}%,100%{transform:translateX(${gap - 16}px);opacity:0}}`);
      body += `<path d="M${ax} ${ay} H${ax + gap - 16}" stroke="${c.stroke}" stroke-width="2" stroke-dasharray="4 5"/><path d="M${ax + gap - 22} ${ay - 6} L${ax + gap - 15} ${ay} L${ax + gap - 22} ${ay + 6}" fill="none" stroke="${c.faint}" stroke-width="2" stroke-linecap="round"/>
<circle class="ar${i}" cx="${ax}" cy="${ay}" r="5" fill="${c.hot}"/>\n`;
    }
  });
  return svgDoc(W, H, 'Quick start in three steps', 'Three cards light up in turn. 01 Install: curl the install script, oasis doctor reports ready. 02 Connect a model: oasis connect, tested with a real tool call. 03 Ask in plain words: oasis, checked and ready for review.', css.join('\n'), body);
}

// --- Capability cards ---------------------------------------------------------
// Each card is 640×360 with a kicker, a title and a small looping scene drawn
// in a 576×212 area.
function card(theme, kind, { kicker, title, desc, T, scene }) {
  const c = palette(theme);
  const { svg, css } = scene(c, T);
  const defs = `<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.hot}" stop-opacity="${c.dark ? '.55' : '.45'}"/><stop offset=".45" stop-color="${c.stroke}"/><stop offset="1" stop-color="${c.stroke}"/></linearGradient>
<radialGradient id="spot" cx="0" cy="0" r="1"><stop offset="0" stop-color="${c.hot}" stop-opacity="${c.dark ? '.10' : '.07'}"/><stop offset="1" stop-color="${c.hot}" stop-opacity="0"/></radialGradient>`;
  const body = `<rect x="1" y="1" width="638" height="358" rx="22" fill="${c.panel}" stroke="url(#rim)" stroke-width="1.5"/>
<rect x="1" y="1" width="638" height="358" rx="22" fill="url(#spot)"/>
<text x="32" y="46" font-family="${MONO}" font-size="13" font-weight="700" letter-spacing="2.5" fill="${c.hot}">${esc(kicker)}</text>
<text x="32" y="84" font-family="${SANS}" font-size="27" font-weight="800" fill="${c.text}">${esc(title)}</text>
<g transform="translate(32 116)" font-family="${SANS}">
${svg}
</g>`;
  return svgDoc(640, 360, kicker + ': ' + title, desc, css, body, defs);
}

const chip = (c, x, y, text, { cls = '', w, tone = 'ok', fs = 14 } = {}) => {
  const width = w || Math.ceil(text.length * fs * 0.6) + 28;
  const bg = tone === 'warn' ? c.amberBg : tone === 'plain' ? c.panel2 : c.chip;
  const fg = tone === 'warn' ? c.amber : tone === 'plain' ? c.sub : c.chipText;
  return `<g${cls ? ` class="${cls}"` : ''}><rect x="${x}" y="${y}" width="${width}" height="30" rx="15" fill="${bg}"${tone === 'plain' ? ` stroke="${c.stroke}"` : ''}/><text x="${x + 14}" y="${y + 20}" font-family="${MONO}" font-size="${fs}" font-weight="700" fill="${fg}">${esc(text)}</text></g>`;
};

const scenes = {
  software: {
    kicker: 'SOFTWARE', title: 'Fixes it, then proves it', T: 10,
    desc: 'A diff in cart.mjs: the line return total minus pct is removed and return total times one minus pct over 100 is typed in. Then npm test runs, a progress bar fills, and chips read 2 passed and checkpoint, rewind ready.',
    scene(c, T) {
      const css = [];
      const add = typed('ta', { x: 40, y: 104, text: 'return total * (1 - pct / 100);', at: 1.7, dur: 1.2, T, fs: 15, bg: c.add, fill: c.text, caret: c.hot });
      const cmd = typed('tc', { x: 34, y: 175, text: 'npm test', at: 3.3, dur: 0.45, T, fs: 15, bg: c.panel, fill: c.text, caret: c.hot });
      css.push(reveal('dl', 0.9, T), reveal('al', 1.5, T), add.css, cmd.css, reveal('pb', 3.9, T), reveal('pass', 5.4, T), reveal('ckp', 6.0, T));
      css.push(`.fill{transform-box:fill-box;transform-origin:left;animation:fill ${T}s ease-in-out infinite}@keyframes fill{0%,${pct(4.0, T)}%{transform:scaleX(0)}${pct(5.3, T)}%,100%{transform:scaleX(1)}}`);
      const svg = `<rect x="0" y="0" width="576" height="128" rx="12" fill="${c.panel2}" stroke="${c.stroke}"/>
<text x="16" y="24" font-family="${MONO}" font-size="13" fill="${c.faint}">src/cart.mjs</text>
<text x="16" y="52" font-family="${MONO}" font-size="15" fill="${c.sub}" xml:space="preserve">  const total = price * qty;</text>
<g class="dl"><rect x="1" y="61" width="574" height="24" fill="${c.del}"/><text x="16" y="78" font-family="${MONO}" font-size="15" fill="${c.red}" xml:space="preserve">-</text><text x="40" y="78" font-family="${MONO}" font-size="15" fill="${c.red}">return total - pct;</text></g>
<g class="al"><rect x="1" y="87" width="574" height="24" fill="${c.add}"/><text x="16" y="104" font-family="${MONO}" font-size="15" fill="${c.hot}" xml:space="preserve">+</text>${add.svg}</g>
<text x="16" y="175" font-family="${MONO}" font-size="15" font-weight="700" fill="${c.hot}">$</text>${cmd.svg}
<g class="pb"><rect x="130" y="164" width="190" height="10" rx="5" fill="${c.panel2}" stroke="${c.stroke}"/><rect class="fill" x="130" y="164" width="190" height="10" rx="5" fill="${c.warm}"/></g>
${chip(c, 340, 154, '✓ 2 passed', { cls: 'pass' })}
${chip(c, 0, 194 - 4, 'checkpoint · /rewind ready', { cls: 'ckp', tone: 'plain', fs: 13 })}`;
      return { svg, css: css.join('\n') };
    }
  },
  research: {
    kicker: 'RESEARCH', title: 'Cites only what it opened', T: 10,
    desc: 'A research question is typed. Three sources appear, each changes from fetching to opened with a check. A fourth citation that was never opened is flagged in amber.',
    scene(c, T) {
      const css = [];
      const q = typed('tq', { x: 34, y: 22, text: 'compare vector databases, cite sources', at: 0.3, dur: 1.4, T, fs: 15, bg: c.panel, fill: c.text, caret: c.hot });
      css.push(q.css);
      const rows = [['docs.qdrant.tech', 'opened'], ['milvus.io/docs', 'opened'], ['weaviate.io/developers', 'opened'], ['a page it never fetched', 'flagged']];
      let svg = `<text x="12" y="22" font-family="${MONO}" font-size="15" font-weight="700" fill="${c.hot}">❯</text>${q.svg}`;
      rows.forEach(([site, state], i) => {
        const y = 44 + i * 42, at = 2.0 + i * 0.5, sw = at + 1.2 + i * 0.15;
        const warn = state === 'flagged';
        css.push(reveal('r' + i, at, T), window_('f' + i, at, sw, T), reveal('s' + i, sw, T));
        svg += `<g class="r${i}"><rect x="0" y="${y}" width="576" height="34" rx="10" fill="${c.panel2}" stroke="${warn ? c.amber : c.stroke}" stroke-opacity="${warn ? '.6' : '1'}"/>
  <text x="14" y="${y + 22}" font-family="${MONO}" font-size="13" fill="${c.faint}">[${i + 1}]</text>
  <text x="50" y="${y + 22}" font-family="${MONO}" font-size="15" fill="${warn ? c.sub : c.text}">${esc(site)}</text>
  <g class="f${i}"><text x="560" y="${y + 22}" text-anchor="end" font-family="${MONO}" font-size="14" fill="${c.faint}">${warn ? 'cited…' : 'fetching…'}</text></g>
  <g class="s${i}"><text x="560" y="${y + 22}" text-anchor="end" font-family="${MONO}" font-size="14" font-weight="700" fill="${warn ? c.amber : c.hot}">${warn ? '⚠ flagged' : '✓ opened'}</text></g></g>\n`;
      });
      return { svg, css: css.join('\n') };
    }
  },
  data: {
    kicker: 'DATA ANALYSIS', title: 'Numbers come from code', T: 10,
    desc: 'A bar chart grows bar by bar while a chip reads python analyze.py exit 0, and a second chip confirms every number was printed by code.',
    scene(c, T) {
      const css = [];
      const hs = [52, 82, 66, 112, 96, 140];
      const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
      let svg = '';
      for (let g = 0; g < 4; g++) svg += `<path d="M40 ${200 - g * 45}H576" stroke="${c.stroke}" stroke-width="1" ${g ? 'stroke-dasharray="3 5"' : ''}/>`;
      hs.forEach((h, i) => {
        const x = 64 + i * 84, at = 0.8 + i * 0.3;
        css.push(`.b${i}{transform-box:fill-box;transform-origin:50% 100%;animation:b${i} ${T}s cubic-bezier(.2,.8,.2,1) infinite}@keyframes b${i}{0%,${pct(at, T)}%{transform:scaleY(0)}${pct(at + 0.8, T)}%,${pct(T - 0.6, T)}%{transform:scaleY(1)}100%{transform:scaleY(0)}}`);
        css.push(reveal('v' + i, at + 0.7, T));
        svg += `<rect class="b${i}" x="${x}" y="${200 - h}" width="48" height="${h}" rx="7" fill="url(#bar)"/>
<g class="v${i}"><text x="${x + 24}" y="${192 - h}" text-anchor="middle" font-family="${MONO}" font-size="13" font-weight="700" fill="${c.text}">${(h * 7.3).toFixed(0)}</text></g>
<text x="${x + 24}" y="218" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${c.faint}">${labels[i]}</text>`;
      });
      css.push(reveal('py', 0.2, T), reveal('ok', 3.4, T));
      svg = `<defs><linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.hot}"/><stop offset="1" stop-color="${c.deep}" stop-opacity=".55"/></linearGradient></defs>` + svg +
        chip(c, 0, -6, 'python analyze.py → exit 0', { cls: 'py', tone: 'plain', fs: 13 }) +
        chip(c, 290, -6, '✓ every number printed by code', { cls: 'ok', fs: 13 });
      return { svg, css: css.join('\n') };
    }
  },
  writing: {
    kicker: 'WRITING', title: 'Drafts you can review', T: 10,
    desc: 'A document page fills with lines of text one after another. Chips appear: summary.md saved, left out 2 items with the list, and undo the turn with Esc Esc.',
    scene(c, T) {
      const css = [];
      const lines = [[0, 210, 14, true], [1, 300], [2, 280], [3, 312], [4, 180], [5, 296], [6, 250], [7, 140]];
      let svg = `<rect x="0" y="0" width="356" height="212" rx="12" fill="${c.panel2}" stroke="${c.stroke}"/><text x="20" y="28" font-family="${MONO}" font-size="12" fill="${c.faint}">summary.md</text>`;
      lines.forEach(([i, w, hh = 8, head]) => {
        const y = 46 + i * 20 + (head ? 0 : 6), at = 0.6 + i * 0.42;
        css.push(`.l${i}{transform-box:fill-box;transform-origin:left;animation:l${i} ${T}s ease-out infinite}@keyframes l${i}{0%,${pct(at, T)}%{transform:scaleX(0)}${pct(at + 0.4, T)}%,${pct(T - 0.6, T)}%{transform:scaleX(1)}100%{transform:scaleX(0)}}`);
        svg += `<rect class="l${i}" x="20" y="${y}" width="${w}" height="${hh}" rx="${hh / 2}" fill="${head ? c.hot : c.faint}" opacity="${head ? 1 : 0.55}"/>`;
      });
      css.push(reveal('c1', 4.4, T), reveal('c2', 5.0, T), reveal('c3', 5.6, T));
      svg += chip(c, 376, 30, '✓ summary.md saved', { cls: 'c1', w: 200, fs: 13 }) + chip(c, 376, 82, 'left out: 2 items', { cls: 'c2', w: 200, tone: 'warn', fs: 13 }) + chip(c, 376, 134, 'undo turn: Esc Esc', { cls: 'c3', w: 200, tone: 'plain', fs: 13 });
      return { svg, css: css.join('\n') };
    }
  },
  automation: {
    kicker: 'AUTOMATION', title: 'Runs on a schedule', T: 10,
    desc: 'Five weekday tiles, Monday to Friday at 09:00, light up in turn with a pulse. A chat message from OASIS appears in team-updates: 12 new issues, 3 need a reply.',
    scene(c, T) {
      const css = [];
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      let svg = chip(c, 0, -6, 'every weekday at 9:00', { tone: 'plain', fs: 13 });
      days.forEach((d, i) => {
        const x = i * 117, at = 0.6 + i * 0.7;
        css.push(`.d${i}{animation:d${i} ${T}s ease-in-out infinite}@keyframes d${i}{0%,${pct(at, T)}%{stroke:${c.stroke};fill:${c.panel2}}${pct(at + 0.2, T)}%,${pct(T - 0.6, T)}%{stroke:${c.hot};fill:${c.chip}}100%{stroke:${c.stroke};fill:${c.panel2}}}
.p${i}{transform-box:fill-box;transform-origin:center;animation:p${i} ${T}s ease-out infinite}@keyframes p${i}{0%,${pct(at, T)}%{transform:scale(.6);opacity:0}${pct(at + 0.1, T)}%{opacity:.9}${pct(at + 0.9, T)}%,100%{transform:scale(2.4);opacity:0}}`);
        css.push(reveal('t' + i, at + 0.2, T));
        svg += `<rect class="d${i}" x="${x}" y="36" width="104" height="64" rx="12" fill="${c.panel2}" stroke="${c.stroke}" stroke-width="1.5"/>
<text x="${x + 16}" y="62" font-family="${SANS}" font-size="15" font-weight="700" fill="${c.text}">${d}</text>
<text x="${x + 16}" y="86" font-family="${MONO}" font-size="13" fill="${c.sub}">09:00</text>
<circle class="p${i}" cx="${x + 86}" cy="57" r="6" fill="none" stroke="${c.hot}" stroke-width="2"/>
<g class="t${i}"><circle cx="${x + 86}" cy="57" r="5" fill="${c.hot}"/></g>`;
      });
      css.push(reveal('m1', 4.4, T), reveal('m2', 5.1, T));
      svg += `<g class="m1"><rect x="0" y="118" width="576" height="94" rx="14" fill="${c.panel2}" stroke="${c.stroke}"/>
<rect x="16" y="134" width="30" height="30" rx="8" fill="${c.chip}"/><text x="31" y="155" text-anchor="middle" font-family="${MONO}" font-size="15" font-weight="800" fill="${c.chipText}">O</text>
<text x="58" y="146" font-family="${SANS}" font-size="15" font-weight="800" fill="${c.text}">OASIS <tspan font-weight="500" fill="${c.faint}">in #team-updates</tspan></text>
<text x="58" y="172" font-family="${SANS}" font-size="15" fill="${c.sub}">12 new issues since yesterday · 3 need a reply</text></g>
<g class="m2"><text x="58" y="198" font-family="${MONO}" font-size="13" font-weight="700" fill="${c.hot}">✓ posted · next run tomorrow 09:00</text></g>`;
      return { svg, css: css.join('\n') };
    }
  },
  computer: {
    kicker: 'BROWSER & COMPUTER USE', title: 'Sees the screen, clicks', T: 10,
    desc: 'A window with a form. A cursor moves to the title field and clicks, the text Quarterly report is typed, the cursor clicks Save, the button turns green and reads Saved, and a chip reads screenshot checked.',
    scene(c, T) {
      const css = [];
      const field = typed('tf', { x: 40, y: 109, text: 'Quarterly report', at: 2.3, dur: 0.9, T, fs: 15, bg: c.panel, fill: c.text, caret: c.hot });
      css.push(field.css);
      // Cursor path: start → field → button, with click ripples.
      const P = (x, y) => `transform:translate(${x}px,${y}px)`;
      css.push(`.cur{animation:cur ${T}s infinite}@keyframes cur{0%,${pct(0.6, T)}%{${P(500, 196)};animation-timing-function:cubic-bezier(.4,0,.2,1)}${pct(1.8, T)}%,${pct(3.4, T)}%{${P(240, 104)};animation-timing-function:cubic-bezier(.4,0,.2,1)}${pct(4.4, T)}%,${pct(T - 0.6, T)}%{${P(486, 168)}}100%{${P(500, 196)}}}
.rp1,.rp2{transform-box:fill-box;transform-origin:center}
.rp1{animation:rp1 ${T}s ease-out infinite}@keyframes rp1{0%,${pct(1.9, T)}%{transform:scale(.3);opacity:0}${pct(2.0, T)}%{opacity:.8}${pct(2.6, T)}%,100%{transform:scale(2.2);opacity:0}}
.rp2{animation:rp2 ${T}s ease-out infinite}@keyframes rp2{0%,${pct(4.5, T)}%{transform:scale(.3);opacity:0}${pct(4.6, T)}%{opacity:.8}${pct(5.2, T)}%,100%{transform:scale(2.2);opacity:0}}
.foc{animation:foc ${T}s linear infinite}@keyframes foc{0%,${pct(2.0, T)}%{stroke:${c.stroke}}${pct(2.1, T)}%,${pct(4.5, T)}%{stroke:${c.hot}}${pct(4.6, T)}%,100%{stroke:${c.stroke}}}`);
      css.push(window_('sv0', 0, 4.6, T), reveal('sv1', 4.6, T), reveal('shot', 5.4, T));
      const svg = `<rect x="0" y="0" width="576" height="212" rx="12" fill="${c.panel2}" stroke="${c.stroke}"/>
<path d="M1 30H575" stroke="${c.stroke}"/><circle cx="18" cy="15" r="5" fill="#FF5F57"/><circle cx="36" cy="15" r="5" fill="#FEBC2E"/><circle cx="54" cy="15" r="5" fill="#28C840"/>
<rect x="160" y="7" width="256" height="16" rx="8" fill="${c.panel}" stroke="${c.stroke}"/><text x="288" y="19" text-anchor="middle" font-family="${MONO}" font-size="11" fill="${c.faint}">localhost:3000/new</text>
<text x="28" y="66" font-family="${SANS}" font-size="13" font-weight="700" fill="${c.sub}">Title</text>
<rect class="foc" x="28" y="84" width="380" height="36" rx="8" fill="${c.panel}" stroke="${c.stroke}" stroke-width="1.5"/>${field.svg}
<g class="sv0"><rect x="428" y="150" width="120" height="38" rx="9" fill="${c.panel}" stroke="${c.stroke}" stroke-width="1.5"/><text x="488" y="174" text-anchor="middle" font-family="${SANS}" font-size="15" font-weight="700" fill="${c.text}">Save</text></g>
<g class="sv1"><rect x="428" y="150" width="120" height="38" rx="9" fill="${c.warm}"/><text x="488" y="174" text-anchor="middle" font-family="${SANS}" font-size="15" font-weight="800" fill="${c.dark ? '#0B0F0C' : '#FFFFFF'}">Saved ✓</text></g>
${chip(c, 28, 154, '✓ screenshot checked', { cls: 'shot', fs: 13 })}
<g class="cur"><circle class="rp1" cx="0" cy="0" r="10" fill="none" stroke="${c.hot}" stroke-width="2"/><circle class="rp2" cx="0" cy="0" r="10" fill="none" stroke="${c.hot}" stroke-width="2"/><path d="M0 0 L0 20 L5 15 L9 24 L13 22 L9 13 L16 13 Z" fill="${c.dark ? '#FFFFFF' : '#0B1A10'}" stroke="${c.dark ? '#0B0F0C' : '#FFFFFF'}" stroke-width="1.5" stroke-linejoin="round"/></g>`;
      return { svg, css: css.join('\n') };
    }
  },
  media: {
    kicker: 'MEDIA', title: 'Images and speech', T: 9,
    desc: 'On the left a generated picture of dunes under a sun is revealed from top to bottom by a scan line. On the right a waveform of bars moves as speech is generated, and a chip reads briefing.mp3 saved.',
    scene(c, T) {
      const css = [];
      css.push(`.cover{transform-box:fill-box;transform-origin:50% 100%;animation:cover ${T}s ease-in-out infinite}@keyframes cover{0%,${pct(0.5, T)}%{transform:scaleY(1)}${pct(3.2, T)}%,${pct(T - 0.6, T)}%{transform:scaleY(0)}100%{transform:scaleY(1)}}
.scan{animation:scan ${T}s ease-in-out infinite}@keyframes scan{0%,${pct(0.5, T)}%{transform:translateY(0);opacity:1}${pct(3.2, T)}%{transform:translateY(180px);opacity:1}${pct(3.4, T)}%,100%{transform:translateY(180px);opacity:0}}
.wv{transform-box:fill-box;transform-origin:center;animation:wv 1.1s ease-in-out infinite alternate}@keyframes wv{from{transform:scaleY(.25)}to{transform:scaleY(1)}}`);
      css.push(reveal('mp', 3.8, T), reveal('ig', 3.4, T));
      let bars = '';
      for (let i = 0; i < 18; i++) {
        const h = 24 + Math.round(70 * Math.abs(Math.sin(i * 1.7 + 0.5)));
        bars += `<rect class="wv" x="${330 + i * 13}" y="${92 - h / 2}" width="7" height="${h}" rx="3.5" fill="${i % 3 ? c.warm : c.hot}" style="animation-delay:-${((i * 0.37) % 1.1).toFixed(2)}s"/>`;
      }
      const svg = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.dark ? '#0F2A1A' : '#DFF7E5'}"/><stop offset="1" stop-color="${c.dark ? '#1C4A2C' : '#B9EBC7'}"/></linearGradient><clipPath id="pic"><rect x="0" y="0" width="290" height="180" rx="12"/></clipPath></defs>
<g clip-path="url(#pic)"><rect width="290" height="180" fill="url(#sky)"/><circle cx="210" cy="64" r="26" fill="${c.hot}" opacity=".9"/>
<path d="M0 132 C60 104 120 108 170 128 S260 120 290 112 V180 H0Z" fill="${c.deep}" opacity=".75"/><path d="M0 154 C70 132 150 146 210 156 S270 150 290 146 V180 H0Z" fill="${c.dark ? '#0A3A1F' : '#0A7846'}"/>
<rect class="cover" width="290" height="180" fill="${c.panel2}"/><g class="scan"><rect y="0" width="290" height="3" fill="${c.hot}"/><rect y="-10" width="290" height="10" fill="${c.hot}" opacity=".15"/></g></g>
<rect x="0" y="0" width="290" height="180" rx="12" fill="none" stroke="${c.stroke}"/>
${chip(c, 0, 186, 'generate_image', { cls: 'ig', tone: 'plain', fs: 13 })}
<rect x="310" y="0" width="266" height="180" rx="12" fill="${c.panel2}" stroke="${c.stroke}"/>
<path d="M326 92H560" stroke="${c.stroke}"/>${bars}
${chip(c, 310, 186, '✓ briefing.mp3 saved', { cls: 'mp', fs: 13 })}`;
      return { svg, css: css.join('\n') };
    }
  },
  memory: {
    kicker: 'MEMORY', title: 'Remembers what worked', T: 11,
    desc: 'A recall query is typed: how did we deploy last time. A graph of past sessions draws its links, the two matching sessions light up, and chips read found in 2 past sessions and proposed skill release.',
    scene(c, T) {
      const css = [];
      const q = typed('tm', { x: 34, y: 22, text: 'recall: how did we deploy last time?', at: 0.3, dur: 1.3, T, fs: 15, bg: c.panel, fill: c.text, caret: c.hot });
      css.push(q.css);
      const nodes = [[60, 110, 'Mon'], [170, 74, 'deploy notes', 1], [190, 168, 'Tue'], [300, 120, 'release run', 1], [420, 70, 'Thu'], [430, 176, 'skills'], [540, 120, 'today']];
      const links = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 5], [4, 6], [5, 6], [3, 6]];
      let svg = `<text x="12" y="22" font-family="${MONO}" font-size="15" font-weight="700" fill="${c.hot}">❯</text>${q.svg}`;
      links.forEach(([a, b], i) => {
        const at = 1.8 + i * 0.12;
        css.push(`.e${i}{stroke-dasharray:1;animation:e${i} ${T}s ease-out infinite}@keyframes e${i}{0%,${pct(at, T)}%{stroke-dashoffset:1}${pct(at + 0.6, T)}%,${pct(T - 0.6, T)}%{stroke-dashoffset:0}100%{stroke-dashoffset:1}}`);
        svg += `<path class="e${i}" d="M${nodes[a][0]} ${nodes[a][1]}L${nodes[b][0]} ${nodes[b][1]}" stroke="${c.stroke}" stroke-width="2" pathLength="1"/>`;
      });
      nodes.forEach(([x, y, label, hit], i) => {
        if (hit) css.push(`.h${i}{animation:h${i} ${T}s ease-in-out infinite}@keyframes h${i}{0%,${pct(3.4, T)}%{fill:${c.panel2};stroke:${c.faint}}${pct(3.7, T)}%,${pct(T - 0.6, T)}%{fill:${c.chip};stroke:${c.hot}}100%{fill:${c.panel2};stroke:${c.faint}}}`);
        const w = Math.max(54, label.length * 8 + 24);
        svg += `<rect${hit ? ` class="h${i}"` : ''} x="${x - w / 2}" y="${y - 14}" width="${w}" height="28" rx="14" fill="${c.panel2}" stroke="${c.faint}" stroke-width="1.5"/><text x="${x}" y="${y + 5}" text-anchor="middle" font-family="${MONO}" font-size="12.5" font-weight="700" fill="${c.text}">${esc(label)}</text>`;
      });
      css.push(reveal('fm', 4.0, T), reveal('sk', 4.8, T));
      svg += chip(c, 0, 198, '✓ found in 2 past sessions', { cls: 'fm', fs: 13 }) + chip(c, 300, 198, 'proposed skill: /release', { cls: 'sk', tone: 'plain', fs: 13 });
      return { svg, css: css.join('\n') };
    }
  }
};
export const CARD_KINDS = Object.keys(scenes);
export const capability = (kind, theme) => card(theme, kind, scenes[kind]);

// --- Provider marquee ----------------------------------------------------------
export function providers(theme) {
  const c = palette(theme);
  const W = 1280, H = 236;
  const rows = [
    { label: 'HOSTED', speed: 42, dir: -1, items: ['OpenAI', 'Anthropic', 'Google Gemini', 'Amazon Bedrock', 'Vertex AI', 'Azure AI Foundry', 'OpenRouter', 'Groq', 'DeepSeek', 'Mistral', 'xAI', 'any OpenAI-compatible API'] },
    { label: 'LOCAL', speed: 34, dir: 1, items: ['Ollama', 'LM Studio', 'llama.cpp', 'vLLM', 'OmniRoute', 'FreeLLMAPI', 'zero-budget mode', 'failover backups', 'prompt caching', 'spend limits'] },
    { label: 'PLUGS INTO', speed: 38, dir: -1, items: ['MCP servers', 'MCP Registry', '48 app connectors', 'Claude Code plugins', 'Codex plugins', 'Gemini CLI extensions', 'skills', 'hooks', 'GitHub Action', 'A2A agents'] }
  ];
  const lx = 168, rowH = 56, top = 24;
  const css = [], defs = [`<linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".06" stop-color="#fff"/><stop offset=".94" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="m"><rect x="${lx}" y="0" width="${W - lx - 24}" height="${H}" fill="url(#fade)"/></mask>`];
  let body = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="22" fill="${c.panel}" stroke="${c.stroke}" stroke-width="1.5"/>`;
  rows.forEach((row, r) => {
    const y = top + r * (rowH + 12);
    let x = 0, pills = '';
    const one = row.items.map((name, i) => {
      const w = Math.ceil(name.length * 9.4) + 46;
      const p = `<g transform="translate(${x} 0)"><rect x="0" y="0" width="${w}" height="${rowH - 8}" rx="${(rowH - 8) / 2}" fill="${c.panel2}" stroke="${c.stroke}"/><circle cx="22" cy="${(rowH - 8) / 2}" r="5" fill="${i % 2 ? c.warm : c.hot}"/><text x="36" y="${(rowH - 8) / 2 + 6}" font-family="${SANS}" font-size="17" font-weight="700" fill="${c.text}">${esc(name)}</text></g>`;
      x += w + 12;
      return p;
    }).join('');
    const span = x;
    pills = `<g>${one}</g><g transform="translate(${span} 0)">${one}</g>`;
    const dur = (span / row.speed).toFixed(1);
    css.push(`.row${r}{animation:row${r} ${dur}s linear infinite}@keyframes row${r}{from{transform:translateX(${row.dir < 0 ? 0 : -span}px)}to{transform:translateX(${row.dir < 0 ? -span : 0}px)}}`);
    body += `<text x="32" y="${y + rowH / 2 + 1}" font-family="${MONO}" font-size="13" font-weight="700" letter-spacing="2" fill="${c.hot}">${row.label}</text>
<g mask="url(#m)"><g transform="translate(${lx} ${y + 4})"><g class="row${r}">${pills}</g></g></g>`;
  });
  return svgDoc(W, H, 'Models, local servers and integrations OASIS works with',
    'Three scrolling rows. Hosted: ' + rows[0].items.join(', ') + '. Local: ' + rows[1].items.join(', ') + '. Plugs into: ' + rows[2].items.join(', ') + '.', css.join('\n'), body, defs.join(''));
}

// --- Interfaces orbit: one runtime, many front doors ---------------------------
export function orbit(theme) {
  const c = palette(theme);
  const W = 1280, H = 460, cx = 640, cy = 230, T = 12;
  const inner = ['Terminal', 'Web app', 'Desktop app', 'VS Code · Cursor', 'Zed · JetBrains', 'CI · GitHub Action'];
  const outer = ['Telegram', 'Slack', 'Discord', 'WhatsApp', 'Matrix · Signal', 'Email', 'A2A agents', 'MCP clients', 'Codex clients', 'Node.js SDK', 'Cloud runs', 'Cursor API'];
  const css = [], defs = [portalGrad('pg'), `<radialGradient id="halo"><stop offset="0" stop-color="${c.hot}" stop-opacity="${c.dark ? '.28' : '.18'}"/><stop offset="1" stop-color="${c.hot}" stop-opacity="0"/></radialGradient>`];
  const ring = (rx, ry, cls) => `<ellipse class="${cls}" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${c.stroke}" stroke-width="1.5" stroke-dasharray="2 10"/>`;
  css.push(`.ri{animation:ri 30s linear infinite}@keyframes ri{to{stroke-dashoffset:-240}}.ro{animation:ro 40s linear infinite}@keyframes ro{to{stroke-dashoffset:240}}
.halo{transform-box:fill-box;transform-origin:center;animation:halo 4s ease-in-out infinite alternate}@keyframes halo{from{transform:scale(.9);opacity:.7}to{transform:scale(1.1);opacity:1}}`);
  let body = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="24" fill="${c.panel}" stroke="${c.stroke}" stroke-width="1.5"/>
<ellipse class="halo" cx="${cx}" cy="${cy}" rx="240" ry="150" fill="url(#halo)"/>
${ring(300, 118, 'ri')}${ring(560, 196, 'ro')}`;
  const place = (list, rx, ry, offset) => list.map((name, i) => {
    const a = offset + i / list.length * Math.PI * 2;
    return [name, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
  const nodes = [...place(inner, 300, 118, -Math.PI / 2 + 0.3), ...place(outer, 560, 196, -Math.PI / 2 + 0.13)];
  let spokes = '', pills = '';
  nodes.forEach(([name, x, y], i) => {
    // Spokes start at the edge of the centre badge, not under the wordmark.
    const ang = Math.atan2(y - cy, x - cx);
    const sx = cx + Math.cos(ang) * 120, sy = cy + Math.sin(ang) * 84;
    const d = `M${sx.toFixed(1)} ${sy.toFixed(1)} L${x.toFixed(1)} ${y.toFixed(1)}`;
    const begin = (i * (T / nodes.length)).toFixed(2);
    spokes += `<path d="${d}" stroke="${c.stroke}" stroke-width="1" opacity=".7"/>
<circle r="3.5" fill="${c.hot}" opacity="0"><animateMotion dur="1.8s" begin="${begin}s" repeatCount="indefinite" path="${d}" keyPoints="1;0" keyTimes="0;1" calcMode="linear"/><animate attributeName="opacity" values="0;1;1;0" dur="1.8s" begin="${begin}s" repeatCount="indefinite"/></circle>`;
    const w = Math.ceil(name.length * 8.6) + 30;
    const on = +begin;
    css.push(`.n${i}{animation:n${i} ${T}s ease-in-out infinite}@keyframes n${i}{0%,${pct(on, T)}%{stroke:${c.stroke}}${pct(on + 0.2, T)}%,${pct(on + 1.6, T)}%{stroke:${c.hot}}${pct(on + 2.0, T)}%,100%{stroke:${c.stroke}}}`);
    pills += `<g><rect class="n${i}" x="${(x - w / 2).toFixed(1)}" y="${(y - 16).toFixed(1)}" width="${w}" height="32" rx="16" fill="${c.panel2}" stroke="${c.stroke}" stroke-width="1.5"/><text x="${x.toFixed(1)}" y="${(y + 5.5).toFixed(1)}" text-anchor="middle" font-family="${SANS}" font-size="15" font-weight="700" fill="${c.text}">${esc(name)}</text></g>`;
  });
  body += spokes + `<g transform="translate(${cx - 48} ${cy - 70}) scale(.32)">${portalMark('pg')}</g>
<text x="${cx}" y="${cy + 46}" text-anchor="middle" font-family="${SANS}" font-size="24" font-weight="800" letter-spacing="5" fill="${c.text}">OASIS</text>
<text x="${cx}" y="${cy + 68}" text-anchor="middle" font-family="${MONO}" font-size="12.5" fill="${c.sub}">one runtime · same sessions</text>` + pills;
  return svgDoc(W, H, 'Every place OASIS runs, around one runtime',
    'The OASIS portal mark in the centre with two orbits. Inner: ' + inner.join(', ') + '. Outer: ' + outer.join(', ') + '. Light travels from the centre to each one in turn.', css.join('\n'), body, defs.join(''));
}

// --- Footer: night dunes, a grounded portal and Fen ----------------------------
export function footer() {
  const W = 1280, H = 300;
  const css = [];
  const defs = [portalGrad('pg'),
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050806"/><stop offset=".7" stop-color="#0B1A10"/><stop offset="1" stop-color="#103A1F"/></linearGradient>`,
    `<radialGradient id="glow"><stop offset="0" stop-color="${LIME}" stop-opacity=".45"/><stop offset="1" stop-color="${LIME}" stop-opacity="0"/></radialGradient>`,
    `<clipPath id="pool"><ellipse cx="640" cy="236" rx="170" ry="18"/></clipPath>`,
    `<clipPath id="card"><rect width="${W}" height="${H}" rx="24"/></clipPath>`];
  // Deterministic stars.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let stars = '';
  for (let i = 0; i < 70; i++) stars += `<circle cx="${(rnd() * W).toFixed(0)}" cy="${(rnd() * 150).toFixed(0)}" r="${(0.6 + rnd() * 1.3).toFixed(1)}" style="animation-delay:-${(rnd() * 4).toFixed(1)}s"/>`;
  css.push(`.stars circle{animation:tw 4s ease-in-out infinite alternate}@keyframes tw{from{opacity:.15}to{opacity:1}}
.shoot{animation:shoot 9s linear infinite}@keyframes shoot{0%,70%{transform:translate(0,0);opacity:0}71%{opacity:1}78%{transform:translate(-260px,90px);opacity:0}100%{opacity:0;transform:translate(-260px,90px)}}
.pglow{transform-box:fill-box;transform-origin:center;animation:pglow 5s ease-in-out infinite alternate}@keyframes pglow{from{opacity:.6;transform:scale(.92)}to{opacity:1;transform:scale(1.08)}}
.far{animation:far 24s ease-in-out infinite alternate}@keyframes far{to{transform:translateX(-30px)}}
.near{animation:near 18s ease-in-out infinite alternate}@keyframes near{to{transform:translateX(24px)}}
.eyes{animation:eyes 4.5s steps(1,end) infinite}@keyframes eyes{0%,92%{opacity:0}93%,96%{opacity:1}97%,100%{opacity:0}}
.ripple path{animation:rip 3s ease-in-out infinite alternate}.ripple path:nth-child(2){animation-delay:-1s}.ripple path:nth-child(3){animation-delay:-2s}@keyframes rip{from{transform:translateX(-8px);opacity:.2}to{transform:translateX(8px);opacity:.9}}
.word{animation:word 9s ease-in-out infinite}.word1{animation-delay:.6s}.word2{animation-delay:1.2s}@keyframes word{0%,8%{fill:#6F8577}14%,40%{fill:${LIME}}50%,100%{fill:#6F8577}}`);
  const body = `<g clip-path="url(#card)">
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<g class="stars" fill="#CFFFC0">${stars}</g>
<g class="shoot"><path d="M1100 30 l40 -14" stroke="#E6F5EA" stroke-width="2" stroke-linecap="round" opacity=".9"/></g>
<ellipse class="pglow" cx="640" cy="190" rx="220" ry="90" fill="url(#glow)"/>
<g class="far"><path d="M-40 210 C120 170 260 168 420 196 S720 214 880 186 S1160 160 1340 200 V320 H-40Z" fill="#0C2A17"/></g>
<g transform="translate(592 132) scale(.32)">${portalMark('pg')}</g>
<path d="M0 222 C200 208 420 236 640 226 S1060 206 1280 222 V300 H0Z" fill="#0A2414"/>
<ellipse cx="640" cy="236" rx="170" ry="18" fill="#0D3320"/>
<g clip-path="url(#pool)" opacity=".38"><g transform="translate(592 308) scale(.32 -.32)">${portalMark('pg')}</g></g>
<g class="ripple" stroke="${LIME}" stroke-width="1.5" stroke-linecap="round" opacity=".5"><path d="M560 232H600"/><path d="M660 240H720"/><path d="M600 246H640"/></g>
<g class="near"><path d="M-40 260 C140 230 300 236 470 256 S820 286 1000 256 S1240 236 1340 252 V320 H-40Z" fill="#071A0E"/></g>
<g transform="translate(176 205)" shape-rendering="crispEdges">${fen(4, { blinkClass: 'eyes' })}</g>
<g font-family="${SANS}" font-size="15" font-weight="800" letter-spacing="6" text-anchor="middle"><text x="640" y="286"><tspan class="word">PLAN.</tspan> <tspan class="word word1">ACT.</tspan> <tspan class="word word2">VERIFY.</tspan></text></g>
</g>`;
  return svgDoc(W, H, 'Plan. Act. Verify.', 'A night desert under twinkling stars with a shooting star. The OASIS portal glows on the horizon and is reflected in the water below it. Fen the fennec fox sits on a dune at the left and blinks. The words Plan, Act, Verify light up in turn.', css.join('\n'), body, defs.join(''));
}
