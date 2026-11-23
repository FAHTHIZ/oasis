// Rounded README badges, built by scripts/readme-art.mjs. Each badge is a
// pill: an icon and a small label on the left, the value in an inset pill on
// the right. One dark design is used for both GitHub themes (it reads well on
// white and on dark), a soft light sweep crosses it now and then, and like the
// rest of the README art it is plain SVG: no scripts, no web fonts, motion only
// inside `prefers-reduced-motion: no-preference`.
//
// Values are written in here on purpose (no version numbers, star counts or
// build results that would go stale): the badges link to the live pages.

const SANS = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const LIME = '#7CFF5E';
const GREEN = '#32E07A';
const EMERALD = '#0ED168';
const NIGHT = '#0B0F0C';
const ELEVATED = '#1A1F1B';
const MIST = '#E6F5EA';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Icons on a 24-unit grid, drawn as 2px strokes.
const ICONS = {
  tag: '<path d="M12 2H3v9l9.3 9.3a1 1 0 0 0 1.4 0l7.6-7.6a1 1 0 0 0 0-1.4Z"/><circle cx="7.5" cy="6.5" r="1.4"/>',
  scale: '<path d="M12 3v18M6 21h12M4 7h16M7 7l-3 7a3 3 0 0 0 6 0ZM17 7l-3 7a3 3 0 0 0 6 0Z"/>',
  flask: '<path d="M9 3h6M10 3v6l-5.4 9.4A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.6L14 9V3M7.5 15h9"/>',
  check: '<circle cx="12" cy="12" r="9.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  hexagon: '<path d="M12 2.5 20.2 7.2v9.6L12 21.5l-8.2-4.7V7.2Z"/><path d="M12 8v8"/>',
  monitor: '<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 16.5V21"/>',
  server: '<rect x="3" y="3" width="18" height="7.5" rx="2"/><rect x="3" y="13.5" width="18" height="7.5" rx="2"/><path d="M7 6.8h.01M7 17.3h.01"/>',
  terminal: '<path d="m4.5 17 6-5-6-5M12.5 18.5h7"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5a14 14 0 0 1 0 19M12 2.5a14 14 0 0 0 0 19"/>',
  window: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M2.5 8.5h19M6 6.3h.01M9 6.3h.01"/>',
  layers: '<path d="M12 2.5 2.5 7.5 12 12.5l9.5-5ZM2.5 12 12 17l9.5-5M2.5 16.5 12 21.5l9.5-5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9.5 2.5v3.5M14.5 2.5v3.5M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
  plug: '<path d="M12 21.5V17M9 7.5V2.5M15 7.5V2.5M18 7.5v4a6 6 0 0 1-12 0v-4Z"/>',
  network: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4.5M12 12l-5.2 5.2M12 12l5.2 5.2"/>',
  puzzle: '<path d="M4 4h5.5v1.5a2.5 2.5 0 0 0 5 0V4H20v5.5h-1.5a2.5 2.5 0 0 0 0 5H20V20h-5.5v-1.5a2.5 2.5 0 0 0-5 0V20H4Z"/>',
  box: '<path d="M21 7.5 12 2.5l-9 5v9l9 5 9-5ZM3 7.5l9 5 9-5M12 12.5v9"/>',
  pr: '<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7.5l-4.5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="M8 9h8M8 12.5h5"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5M12 14.5v2.5"/>',
  star: '<path d="M12 2.8 14.8 8.6l6.3.9-4.6 4.5 1.1 6.3L12 17.3l-5.6 3 1.1-6.3-4.6-4.5 6.3-.9Z"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5C2 10.8 3.5 12.5 5 14l7 7Z"/>',
  book: '<path d="M4 19.5V5a2.5 2.5 0 0 1 2.5-2.5H20v17H6.5A2.5 2.5 0 0 0 4 22M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
  agents: '<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9.5" r="2.5"/><path d="M2.5 20a5.5 5.5 0 0 1 11 0M13.5 19.5a4.5 4.5 0 0 1 8 0"/>',
};

// Approximate advance widths (in em) of a bold UI sans, used to size each pill.
// textLength then fits the text exactly, so a wider or narrower system font
// never spills out of its pill.
function textWidth(text, size, bold = true) {
  let em = 0;
  for (const ch of text) {
    if ('iljI.,:;\'|!'.includes(ch)) em += 0.29;
    else if (' ·'.includes(ch)) em += 0.3;
    else if ('frt'.includes(ch)) em += 0.4;
    else if ('mwMW'.includes(ch)) em += 0.86;
    else if (/[A-Z]/.test(ch)) em += 0.69;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else em += 0.57;
  }
  return Math.ceil(em * size * (bold ? 1.04 : 1));
}

const H = 30;

// A single badge. `accent` fills the value pill with the brand gradient.
export function badge({ id, icon, label, value, accent = false, delay = 0 }) {
  const iconW = icon ? 26 : 0;
  const labelW = textWidth(label.toUpperCase(), 10.5);
  const valueW = textWidth(value, 12.5);
  const left = 12 + iconW + labelW + 10;
  const inner = valueW + 24;
  const W = left + inner + 3;
  const title = `${label}: ${value}`;
  const sweepAt = (delay % 7) + 1;
  const css = `@media (prefers-reduced-motion: no-preference) {
.sw{animation:sw 8s ${sweepAt}s cubic-bezier(.4,0,.2,1) infinite}
@keyframes sw{0%{transform:translateX(-70px)}18%,100%{transform:translateX(${W + 70}px)}}
.ic{animation:ic 8s ${sweepAt}s ease-in-out infinite;transform-origin:${12 + 9}px ${H / 2}px}
@keyframes ic{0%,100%{transform:scale(1)}6%{transform:scale(1.14)}12%{transform:scale(1)}}
}`;
  const iconSvg = icon
    ? `<g class="ic"><g transform="translate(12 ${(H - 18) / 2}) scale(.75)" fill="none" stroke="${LIME}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</g></g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs>
<linearGradient id="${id}-edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${LIME}" stop-opacity=".55"/><stop offset=".5" stop-color="${GREEN}" stop-opacity=".18"/><stop offset="1" stop-color="${EMERALD}" stop-opacity=".5"/></linearGradient>
<linearGradient id="${id}-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121A14"/><stop offset="1" stop-color="${NIGHT}"/></linearGradient>
<linearGradient id="${id}-val" x1="0" y1="0" x2="1" y2="1">${accent
    ? `<stop offset="0" stop-color="#B6FF83"/><stop offset=".55" stop-color="${LIME}"/><stop offset="1" stop-color="${EMERALD}"/>`
    : `<stop offset="0" stop-color="#243028"/><stop offset="1" stop-color="${ELEVATED}"/>`}</linearGradient>
<linearGradient id="${id}-shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="${id}-clip"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>
</defs>
<style>
${css}
</style>
<g clip-path="url(#${id}-clip)">
<rect width="${W}" height="${H}" fill="url(#${id}-bg)"/>
<rect x="${left}" y="3" width="${inner}" height="${H - 6}" rx="${(H - 6) / 2}" fill="url(#${id}-val)"/>
${accent ? '' : `<rect x="${left + .5}" y="3.5" width="${inner - 1}" height="${H - 7}" rx="${(H - 7) / 2}" fill="none" stroke="${GREEN}" stroke-opacity=".22"/>`}
<rect class="sw" x="-60" y="0" width="46" height="${H}" fill="url(#${id}-shine)" transform="translate(-70 0)"/>
</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="${(H - 1) / 2}" fill="none" stroke="url(#${id}-edge)"/>
${iconSvg}
<text x="${12 + iconW}" y="${H / 2 + 3.8}" font-family="${esc(SANS)}" font-size="10.5" font-weight="700" fill="#9DB5A5" textLength="${labelW}" lengthAdjust="spacingAndGlyphs">${esc(label.toUpperCase())}</text>
<text x="${left + 12}" y="${H / 2 + 4.4}" font-family="${esc(SANS)}" font-size="12.5" font-weight="700" fill="${accent ? NIGHT : MIST}" textLength="${valueW}" lengthAdjust="spacingAndGlyphs">${esc(value)}</text>
</svg>
`;
}

// A small status pill for the capability table: a dot and a word.
export function statusPill({ id, text, color, glow }) {
  const tw = textWidth(text, 11.5);
  const W = 30 + tw + 14;
  const Hs = 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hs}" viewBox="0 0 ${W} ${Hs}" role="img" aria-label="${esc(text)}">
<title>${esc(text)}</title>
<style>
@media (prefers-reduced-motion: no-preference) {
.p{animation:p 2.6s ease-in-out infinite;transform-origin:15px 12px}
@keyframes p{0%,100%{opacity:.35;transform:scale(1)}50%{opacity:0;transform:scale(2.1)}}
}
</style>
<rect x=".5" y=".5" width="${W - 1}" height="${Hs - 1}" rx="${(Hs - 1) / 2}" fill="${NIGHT}" stroke="${color}" stroke-opacity=".55"/>
${glow ? `<circle class="p" cx="15" cy="12" r="4" fill="${color}" opacity=".35"/>` : ''}
<circle cx="15" cy="12" r="4" fill="${color}"/>
<text x="26" y="16" font-family="${esc(SANS)}" font-size="11.5" font-weight="700" fill="${MIST}" textLength="${tw}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>
</svg>
`;
}

// The README badge rows. `href` is used by the README, not by the SVG.
export const BADGE_ROWS = [
  [
    { id: 'release', icon: 'tag', label: 'release', value: 'stable', accent: true, href: 'https://github.com/FAHTHIZ/oasis/releases/latest' },
    { id: 'license', icon: 'scale', label: 'license', value: 'Apache 2.0', accent: true, href: 'LICENSE' },
    { id: 'tests', icon: 'flask', label: 'tests', value: '3,700+', accent: true, href: 'https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml' },
    { id: 'ci', icon: 'check', label: 'checks', value: 'every push', accent: true, href: 'https://github.com/FAHTHIZ/oasis/actions' },
  ],
  [
    { id: 'node', icon: 'hexagon', label: 'node', value: '≥ 22.19', accent: true, href: 'docs/FIRST-RUN.md' },
    { id: 'platforms', icon: 'monitor', label: 'runs on', value: 'Windows · macOS · Linux', href: 'docs/RELEASES.md' },
    { id: 'terminal', icon: 'terminal', label: 'interface', value: 'terminal', href: 'docs/TERMINAL.md' },
    { id: 'web', icon: 'globe', label: 'interface', value: 'web app', href: 'docs/INTERFACES.md' },
  ],
  [
    { id: 'desktop', icon: 'window', label: 'interface', value: 'desktop app', href: 'docs/DESKTOP.md' },
    { id: 'hosted', icon: 'server', label: 'self-hosted', value: 'your machine', href: 'docs/REMOTE-ACCESS.md' },
    { id: 'ollama', icon: 'cpu', label: 'local', value: 'Ollama', href: 'docs/INFERENCE.md' },
    { id: 'models', icon: 'layers', label: 'models', value: 'hosted or local', href: 'docs/INFERENCE.md' },
  ],
  [
    { id: 'mcp', icon: 'plug', label: 'protocol', value: 'MCP', href: 'docs/EXTENDING.md' },
    { id: 'a2a', icon: 'network', label: 'protocol', value: 'A2A', href: 'docs/A2A.md' },
    { id: 'agents', icon: 'agents', label: 'agents', value: 'parallel teams', href: 'docs/SUBAGENTS.md' },
    { id: 'plugins', icon: 'puzzle', label: 'plugins', value: 'Claude Code', href: 'docs/EXTENDING.md' },
  ],
  [
    { id: 'sandbox', icon: 'box', label: 'sandbox', value: 'Docker · bubblewrap', href: 'docs/EXECUTION-BACKENDS.md' },
    { id: 'security', icon: 'lock', label: 'security', value: 'policy', href: 'SECURITY.md' },
    { id: 'docs', icon: 'book', label: 'docs', value: 'user guide', href: 'docs/USER-GUIDE.md' },
    { id: 'stars', icon: 'star', label: 'star', value: 'on GitHub', href: 'https://github.com/FAHTHIZ/oasis/stargazers' },
  ],
  [
    { id: 'prs', icon: 'pr', label: 'pull requests', value: 'welcome', href: 'CONTRIBUTING.md' },
    { id: 'discussions', icon: 'chat', label: 'community', value: 'Discussions', href: 'https://github.com/FAHTHIZ/oasis/discussions' },
    { id: 'conduct', icon: 'heart', label: 'conduct', value: 'be kind', href: 'CODE_OF_CONDUCT.md' },
  ],
];

export const STATUS_PILLS = [
  { id: 'stable', text: 'stable', color: GREEN, glow: true },
  { id: 'lightly-tested', text: 'released, lightly tested', color: LIME },
  { id: 'unreleased', text: 'unreleased (main)', color: '#FBBF24' },
  { id: 'not-claimed', text: 'not claimed', color: '#6B7D71' },
];

export function badgeFiles() {
  const files = {};
  BADGE_ROWS.flat().forEach((b, i) => { files[`badge-${b.id}.svg`] = badge({ ...b, delay: i * 1.3 }); });
  for (const s of STATUS_PILLS) files[`status-${s.id}.svg`] = statusPill(s);
  return files;
}
