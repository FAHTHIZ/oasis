#!/usr/bin/env node
// Builds the animated README artwork in assets/readme/ from the static
// brand artwork. Everything is plain SVG with CSS keyframes and SMIL, so it
// animates inside GitHub's <img> sandbox (no scripts, no web fonts). Each
// animation is wrapped in `prefers-reduced-motion: no-preference`; with
// reduced motion the files show their final, fully drawn frame.
//
//   node scripts/readme-art.mjs           # write assets/readme/*.svg
//   node scripts/readme-art.mjs --check   # exit 1 if a file is out of date
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagline, stats, quickstart, capability, CARD_KINDS, providers, orbit, footer } from './readme-scenes.mjs';
import { badgeFiles } from './readme-badges.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets', 'readme');
const check = process.argv.includes('--check');

const SANS = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const LIME = '#7CFF5E';
const GREEN = '#32E07A';
const EMERALD = '#0ED168';

const pct = (seconds, total) => +(seconds / total * 100).toFixed(2);
const motion = (css) => '@media (prefers-reduced-motion: no-preference) {\n' + css + '\n}';

// A line that fades and rises in at `at` seconds, holds, and fades out with
// the rest of the loop.
function reveal(name, at, total, hold = total - 0.9) {
  const a = pct(at, total), b = pct(at + 0.35, total), c = pct(hold, total), d = pct(hold + 0.5, total);
  return `.${name}{animation:${name} ${total}s linear infinite}
@keyframes ${name}{0%,${a}%{opacity:0;transform:translateY(5px)}${b}%,${c}%{opacity:1;transform:none}${d}%,100%{opacity:0;transform:none}}`;
}

// --- Hero: the static hero with the terminal session played back ---------
function hero() {
  let svg = readFileSync(path.join(root, 'assets', 'oasis-readme-hero.svg'), 'utf8');
  const T = 16;
  // Terminal rows by baseline y, with the second they appear.
  const rows = [
    ['202', 3.0], ['236', 3.8], ['259', 4.2], ['266', 4.6], ['282', 4.6], ['289', 5.1], ['305', 5.1],
    ['339', 6.0], ['362', 8.2], ['396', 9.1], ['419', 9.4], ['453', 10.3]
  ];
  const css = [];
  rows.forEach(([y, at], index) => {
    const name = 'r' + index;
    css.push(reveal(name, at, T));
    svg = svg.replace(new RegExp('<(text|rect) x="(\\d+)" y="' + y + '"'), (m, tag, x) => `<${tag} class="${name}" x="${x}" y="${y}"`);
  });
  // The prompt is typed: a cover slides right in character steps, carrying the caret.
  const typeEnd = pct(2.4, T), fade = pct(T - 0.9, T), gone = pct(T - 0.4, T);
  css.push(`.typing{animation:typing ${T}s infinite}
@keyframes typing{0%{transform:translateX(0);animation-timing-function:steps(44,end)}${typeEnd}%,100%{transform:translateX(396px)}}
.caret1{animation:caret1 ${T}s infinite}
@keyframes caret1{0%,${pct(2.6, T)}%{opacity:1}${pct(2.7, T)}%,100%{opacity:0}}
.prompt{animation:prompt ${T}s linear infinite}
@keyframes prompt{0%,${fade}%{opacity:1}${gone}%,100%{opacity:0}}
.spin{animation:spin ${T}s linear infinite}
@keyframes spin{0%,${pct(6.4, T)}%{opacity:0}${pct(6.6, T)}%,${pct(8.0, T)}%{opacity:1}${pct(8.1, T)}%,100%{opacity:0}}
.dot{animation:dot .8s ease-in-out infinite alternate}
@keyframes dot{from{opacity:.25}to{opacity:1}}
.caret2{animation:blink 1.1s steps(1,end) infinite}
@keyframes blink{50%{opacity:0}}
.aura{animation:aura 6s ease-in-out infinite alternate;transform-origin:920px 330px}
@keyframes aura{from{opacity:.75;transform:scale(.96)}to{opacity:1;transform:scale(1.04)}}
.stars circle{animation:twinkle 3.2s ease-in-out infinite alternate}
.stars circle:nth-child(2n){animation-delay:-1.1s}.stars circle:nth-child(3n){animation-delay:-2.3s}
@keyframes twinkle{from{opacity:.15}to{opacity:1}}
.eyes{animation:eyes 5s steps(1,end) infinite}
@keyframes eyes{0%,93%{opacity:0}94%,97%{opacity:1}98%,100%{opacity:0}}
.halo{animation:halo 3s ease-in-out infinite alternate}
@keyframes halo{from{opacity:.25}to{opacity:.6}}`);
  svg = svg.replace('<text x="644" y="168"', '<text class="prompt" x="644" y="168"');
  svg = svg.replace('<ellipse cx="920" cy="330" rx="470" ry="300" fill="url(#aura)"/>', '<ellipse class="aura" cx="920" cy="330" rx="470" ry="300" fill="url(#aura)"/>');
  svg = svg.replace('<g fill="#A6FF83" opacity=".45">', '<g class="stars" fill="#A6FF83" opacity=".45">');
  svg = svg.replace('<ellipse cx="1110" cy="92" rx="60" ry="5" fill="#7CFF5E" opacity=".45"', '<ellipse class="halo" cx="1110" cy="92" rx="60" ry="5" fill="#7CFF5E" opacity=".45"');
  // Fen blinks: lids drawn over the eye pixels.
  const lids = [36, 48, 108, 120].map((x) => `<rect x="${x}" y="72" width="12" height="12" fill="${LIME}"/><rect x="${x}" y="84" width="12" height="12" fill="${GREEN}"/>`).join('');
  svg = svg.replace(/(<g transform="translate\(1068 34\) scale\(0\.5\)" shape-rendering="crispEdges">[\s\S]*?)(<\/g>)/, `$1<g class="eyes" opacity="0">${lids}</g>$2`);
  // Typing cover, spinner and the input caret, inside the window clip.
  const extra = `
    <g class="typing"><rect x="662" y="152" width="400" height="24" fill="#101712"/><rect class="caret1" x="662" y="155" width="8" height="18" fill="${LIME}"/></g>
    <text class="spin" x="662" y="362" font-family="${MONO}" font-size="14.5" xml:space="preserve"><tspan fill="#5E7064">⎿ </tspan><tspan class="dot" fill="#FBBF24">●</tspan><tspan fill="#9FB3A6"> running python chart.py…</tspan></text>
    <rect class="caret2" x="664" y="505" width="8" height="17" fill="${LIME}" opacity=".85"/>`;
  svg = svg.replace('<rect x="644" y="503" width="0" height="0"/>', extra.trim());
  svg = svg.replace('<text x="644" y="518"', '<text x="676" y="518"').replace('<tspan fill="#7CFF5E" font-weight="700">❯ </tspan><tspan fill="#5E7064">ask for anything', '<tspan fill="#5E7064">ask for anything');
  svg = svg.replace('ask for anything · / commands · @ files</tspan></text>', 'ask for anything · / commands · @ files</tspan></text><text x="644" y="518" font-family="' + MONO + '" font-size="14.5" fill="#7CFF5E" font-weight="700">❯</text>');
  svg = svg.replace('</defs>', '</defs>\n  <style>\n' + motion(css.join('\n')) + '\n  </style>');
  svg = svg.replace('<title id="title">OASIS: the open agent runtime for any model</title>', '<title id="title">OASIS: the open agent runtime for any model (animated)</title>');
  return svg;
}

// --- How a task runs: request → read → edit → verify → done -------------
function pipeline(theme) {
  const dark = theme === 'dark';
  const c = dark
    ? { bg: 'none', card: '#0E1510', stroke: '#1F2E23', text: '#E6F5EA', sub: '#8FA597', track: '#1F2E23' }
    : { bg: 'none', card: '#FFFFFF', stroke: '#D5E5DA', text: '#0B1A10', sub: '#4A6352', track: '#D5E5DA' };
  const hot = dark ? LIME : '#0A7846', warm = dark ? GREEN : '#18A957';
  const W = 1280, H = 300, T = 10;
  const steps = [
    ['01', 'Ask', 'plain words, any model'],
    ['02', 'Plan', 'steps, agents, budgets'],
    ['03', 'Act', 'tools, shell, web, apps'],
    ['04', 'Verify', 'tests, sources, numbers'],
    ['05', 'Done', 'only what it could check']
  ];
  const cw = 208, gap = (W - 80 - cw * steps.length) / (steps.length - 1), y = 70, ch = 132;
  const xs = steps.map((_, i) => 40 + i * (cw + gap));
  const css = [];
  const cards = steps.map(([n, title, sub], i) => {
    const x = xs[i];
    const on = 0.4 + i * 1.5;
    css.push(`.c${i}{animation:c${i} ${T}s ease-in-out infinite}
@keyframes c${i}{0%,${pct(on, T)}%{stroke:${c.stroke}}${pct(on + 0.3, T)}%,${pct(on + 1.4, T)}%{stroke:${i === 3 ? hot : warm}}${pct(on + 1.8, T)}%,100%{stroke:${c.stroke}}}
.n${i}{animation:n${i} ${T}s ease-in-out infinite}
@keyframes n${i}{0%,${pct(on, T)}%{fill:${c.sub}}${pct(on + 0.3, T)}%,${pct(on + 1.4, T)}%{fill:${hot}}${pct(on + 1.8, T)}%,100%{fill:${c.sub}}}`);
    const gate = i === 3 ? `<rect x="${x + cw - 74}" y="${y + 16}" width="58" height="20" rx="10" fill="${dark ? '#123A1F' : '#E3FBE6'}"/><text x="${x + cw - 45}" y="${y + 30}" text-anchor="middle" font-size="11" font-weight="700" fill="${dark ? LIME : '#0A7846'}">GATE</text>` : '';
    return `<g><rect class="c${i}" x="${x}" y="${y}" width="${cw}" height="${ch}" rx="16" fill="${c.card}" stroke="${c.stroke}" stroke-width="1.5"/>
  <text class="n${i}" x="${x + 20}" y="${y + 32}" font-family="${MONO}" font-size="13" font-weight="700" fill="${c.sub}">${n}</text>${gate}
  <text x="${x + 20}" y="${y + 78}" font-size="26" font-weight="800" fill="${c.text}">${title}</text>
  <text x="${x + 20}" y="${y + 106}" font-size="14" fill="${c.sub}">${sub}</text></g>`;
  }).join('\n  ');
  const track = `M${xs[0] + cw / 2} ${y + ch + 34} H${xs[4] + cw / 2}`;
  const loopBack = `M${xs[3] + cw / 2} ${y - 10} C ${xs[3] + cw / 2} ${y - 52}, ${xs[2] + cw / 2} ${y - 52}, ${xs[2] + cw / 2} ${y - 12}`;
  css.push(`.pulse{animation:pulse ${T}s linear infinite}
@keyframes pulse{0%{transform:translateX(0);opacity:0}4%{opacity:1}${pct(7.6, T)}%{transform:translateX(${xs[4] - xs[0]}px);opacity:1}${pct(8.4, T)}%,100%{transform:translateX(${xs[4] - xs[0]}px);opacity:0}}
.retry{stroke-dasharray:6 7;animation:dash 1.2s linear infinite}
@keyframes dash{to{stroke-dashoffset:-26}}`);
  const ticks = xs.map((x) => `<circle cx="${x + cw / 2}" cy="${y + ch + 34}" r="5" fill="${c.card}" stroke="${GREEN}" stroke-width="2"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">How an OASIS task runs</title>
<desc id="d">Five steps: ask in plain words with any model, plan the steps and any agents, act with tools such as the shell, the web and connected apps, verify at the gate with tests, the sources that were opened and numbers computed by code, and finish only with what it could check. A dashed arrow from Verify back to Act shows that a failed or skipped check sends the agent back.</desc>
<defs><linearGradient id="trk" x1="0" x2="1"><stop offset="0" stop-color="${GREEN}" stop-opacity=".15"/><stop offset=".5" stop-color="${LIME}"/><stop offset="1" stop-color="${EMERALD}" stop-opacity=".15"/></linearGradient>
<marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${hot}"/></marker>
<filter id="g" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4"/></filter></defs>
<style>
${motion(css.join('\n'))}
</style>
<g font-family="${SANS}">
  <path d="${loopBack}" class="retry" fill="none" stroke="${hot}" stroke-width="2" marker-end="url(#ah)" opacity=".8"/>
  <text x="${(xs[2] + xs[3]) / 2 + cw / 2}" y="${y - 46}" text-anchor="middle" font-size="12.5" font-weight="600" fill="${c.sub}">check failed or skipped → back to work</text>
  ${cards}
  <path d="${track}" stroke="${c.track}" stroke-width="2" fill="none"/>
  <path d="${track}" stroke="url(#trk)" stroke-width="2" fill="none" opacity=".7"/>
  ${ticks}
  <g class="pulse"><circle cx="${xs[0] + cw / 2}" cy="${y + ch + 34}" r="9" fill="${dark ? LIME : warm}" filter="url(#g)"/><circle cx="${xs[0] + cw / 2}" cy="${y + ch + 34}" r="5" fill="${dark ? LIME : hot}"/></g>
</g>
</svg>
`;
}

// --- Architecture: the static diagram with requests flowing through ---------
function architecture() {
  let svg = readFileSync(path.join(root, 'assets', 'oasis-architecture.svg'), 'utf8');
  const paths = [...svg.matchAll(/<path d="(M[\d.]+ [\d.]+ (?:C [^"]+|L [^"]+))" stroke="#32E07A"/g)].map((m) => m[1]);
  const dots = paths.map((d, i) => {
    const both = d.includes(' L ');
    const dur = both ? 2.6 : 2.2;
    const begin = (i * 0.37).toFixed(2);
    const ret = both ? `<circle r="3.5" fill="${LIME}" opacity="0"><animateMotion dur="${dur}s" begin="${(+begin + dur / 2).toFixed(2)}s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path="${d}"/><animate attributeName="opacity" values="0;1;1;0" dur="${dur}s" begin="${(+begin + dur / 2).toFixed(2)}s" repeatCount="indefinite"/></circle>` : '';
    return `<circle r="3.5" fill="${LIME}" opacity="0"><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${d}"/><animate attributeName="opacity" values="0;1;1;0" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/></circle>${ret}`;
  }).join('\n');
  const css = `.flow circle{filter:drop-shadow(0 0 4px ${LIME})}`;
  svg = svg.replace(/<\/svg>\s*$/, `<style>${css}</style>\n<g class="flow">\n${dots}\n</g>\n</svg>\n`);
  return svg;
}

// --- Feature icons (64×64), one animation each ---------------------------
function icon(kind, theme) {
  const dark = theme === 'dark';
  const base = dark ? '#0E1510' : '#F2FBF4';
  const edge = dark ? '#1F2E23' : '#CFE6D6';
  const L = dark ? LIME : '#18A957', G = dark ? GREEN : '#0A7846';
  let body = '', css = '';
  switch (kind) {
    case 'models': // three nodes, one active at a time, routing around
      body = [[20, 22], [44, 22], [32, 44]].map(([x, y], i) => `<circle class="m m${i}" cx="${x}" cy="${y}" r="7" fill="none" stroke="${G}" stroke-width="2.5"/>`).join('')
        + `<path d="M26 24L38 24M23 28L29 39M41 28L35 39" stroke="${edge}" stroke-width="2"/>`;
      css = `.m{animation:m 3s infinite}.m1{animation-delay:1s}.m2{animation-delay:2s}@keyframes m{0%,30%{fill:${L};stroke:${L}}34%,100%{fill:none;stroke:${G}}}`;
      break;
    case 'plugins': // puzzle piece snapping in
      body = `<rect x="14" y="14" width="22" height="22" rx="5" fill="none" stroke="${G}" stroke-width="2.5"/><g class="p"><rect x="30" y="30" width="20" height="20" rx="5" fill="${L}"/></g>`;
      css = `.p{animation:p 2.6s ease-in-out infinite}@keyframes p{0%,15%{transform:translate(8px,8px);opacity:.3}45%,85%{transform:none;opacity:1}100%{transform:translate(8px,8px);opacity:.3}}`;
      break;
    case 'verified': // a check drawn, then a ring pulse
      body = `<circle cx="32" cy="32" r="20" fill="none" stroke="${G}" stroke-width="2.5"/><circle class="ring" cx="32" cy="32" r="20" fill="none" stroke="${L}" stroke-width="2"/><path class="ck" d="M22 33L29 40L43 25" fill="none" stroke="${L}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>`;
      css = `.ck{stroke-dasharray:1;animation:ck 2.4s ease-out infinite}@keyframes ck{0%,10%{stroke-dashoffset:1}45%,100%{stroke-dashoffset:0}}.ring{transform-origin:32px 32px;animation:ring 2.4s ease-out infinite}@keyframes ring{0%,45%{transform:scale(1);opacity:0}50%{opacity:.8}100%{transform:scale(1.45);opacity:0}}`;
      break;
    case 'hosted': // a server with blinking lights
      body = [18, 32].map((y, i) => `<rect x="14" y="${y}" width="36" height="12" rx="3" fill="none" stroke="${G}" stroke-width="2.5"/><circle class="l l${i}" cx="22" cy="${y + 6}" r="2.5" fill="${L}"/><path d="M30 ${y + 6}H44" stroke="${edge}" stroke-width="2"/>`).join('') + `<path d="M32 44V50M22 50H42" stroke="${G}" stroke-width="2.5" stroke-linecap="round"/>`;
      css = `.l{animation:l 1.4s steps(1,end) infinite}.l1{animation-delay:-.7s}@keyframes l{50%{opacity:.2}}`;
      break;
    case 'agents': // a parent spawning two children
      body = `<path class="e" d="M32 20L18 44M32 20L46 44" stroke="${G}" stroke-width="2.5" pathLength="1"/><circle cx="32" cy="18" r="7" fill="${L}"/><circle class="k" cx="18" cy="46" r="6" fill="${G}"/><circle class="k k2" cx="46" cy="46" r="6" fill="${G}"/>`;
      css = `.e{stroke-dasharray:1;animation:e 3s ease-in-out infinite}@keyframes e{0%,10%{stroke-dashoffset:1}40%,85%{stroke-dashoffset:0}100%{stroke-dashoffset:1}}.k{transform-box:fill-box;transform-origin:center;animation:k 3s ease-in-out infinite}.k2{animation-delay:.15s}@keyframes k{0%,30%{transform:scale(0)}45%,85%{transform:scale(1)}100%{transform:scale(0)}}`;
      break;
    case 'safety': // a shield with a scanning line
      body = `<path d="M32 12L48 18V31C48 41 41 48 32 52C23 48 16 41 16 31V18Z" fill="none" stroke="${G}" stroke-width="2.5" stroke-linejoin="round"/><clipPath id="sh"><path d="M32 12L48 18V31C48 41 41 48 32 52C23 48 16 41 16 31V18Z"/></clipPath><g clip-path="url(#sh)"><rect class="scan" x="14" y="12" width="36" height="3" fill="${L}"/></g><path d="M26 32L30 36L38 27" fill="none" stroke="${L}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
      css = `.scan{animation:scan 2.2s ease-in-out infinite alternate}@keyframes scan{from{transform:translateY(0)}to{transform:translateY(38px)}}`;
      break;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
<style>${motion(css)}</style>
<rect x="1" y="1" width="62" height="62" rx="16" fill="${base}" stroke="${edge}" stroke-width="1.5"/>
${body}
</svg>
`;
}

// --- Divider: a thin line with light travelling along it -----------------
function divider(theme) {
  const dark = theme === 'dark';
  const line = dark ? '#1F2E23' : '#D5E5DA';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="24" viewBox="0 0 1280 24" aria-hidden="true">
<defs><linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="${LIME}" stop-opacity="0"/><stop offset=".5" stop-color="${LIME}"/><stop offset="1" stop-color="${LIME}" stop-opacity="0"/></linearGradient></defs>
<style>${motion('.sweep{animation:sweep 5s ease-in-out infinite}@keyframes sweep{from{transform:translateX(-320px)}to{transform:translateX(1280px)}}')}</style>
<path d="M0 12H1280" stroke="${line}" stroke-width="1.5"/>
<rect class="sweep" x="0" y="11" width="320" height="2" fill="url(#s)"/>
<g transform="translate(628 4)"><path d="M0 8C0 3.5 5 0 12 0S24 3.5 24 8H19C19 5 16 3 12 3S5 5 5 8Z" fill="${GREEN}"/><path d="M0 10H6V12H0ZM18 10H24V12H18ZM2 14H8V15.5H2ZM16 14H22V15.5H16Z" fill="${GREEN}" opacity=".8"/></g>
</svg>
`;
}

const files = { 'hero.svg': hero(), 'architecture.svg': architecture(), 'footer.svg': footer(), ...badgeFiles() };
for (const theme of ['dark', 'light']) {
  files[`tagline-${theme}.svg`] = tagline(theme);
  files[`stats-${theme}.svg`] = stats(theme);
  files[`quickstart-${theme}.svg`] = quickstart(theme);
  files[`providers-${theme}.svg`] = providers(theme);
  files[`orbit-${theme}.svg`] = orbit(theme);
  for (const kind of CARD_KINDS) files[`card-${kind}-${theme}.svg`] = capability(kind, theme);
  files[`pipeline-${theme}.svg`] = pipeline(theme);
  files[`divider-${theme}.svg`] = divider(theme);
  for (const kind of ['models', 'plugins', 'verified', 'hosted', 'agents', 'safety']) files[`icon-${kind}-${theme}.svg`] = icon(kind, theme);
}

mkdirSync(out, { recursive: true });
let stale = 0;
for (const [name, text] of Object.entries(files)) {
  const file = path.join(out, name);
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) { stale++; console.error('out of date: assets/readme/' + name); }
  } else writeFileSync(file, text);
}
if (check && stale) { console.error('Run: node scripts/readme-art.mjs'); process.exit(1); }
if (!check) console.log('Wrote ' + Object.keys(files).length + ' files to assets/readme/');
