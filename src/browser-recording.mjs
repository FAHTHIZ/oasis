// Browser recordings: while the agent drives the built-in browser, OASIS keeps a small
// screenshot after each step that changes the page (navigate, click, type, press, scroll)
// with a caption. `browser {action: "recording"}`, closing the browser, or the end of the
// session saves them as one self-contained HTML player under .oasis/recordings/, so you
// can replay what the agent saw and did (the same idea as Antigravity's browser
// recordings). Typed text is never written into captions, only its length.
// OASIS_BROWSER_RECORD=0 turns recording off.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

export const MAX_FRAMES = 120;
const FRAME_QUALITY = 55;
const FRAME_WIDTH = 960;

export function recordingEnabled(env = process.env) {
  return env.OASIS_BROWSER_RECORD !== '0';
}

export function newRecording() {
  return { frames: [], startedAt: Date.now(), dropped: 0 };
}

/** One line for a step, without the text that was typed. */
export function stepCaption(action, args = {}, result = {}) {
  switch (action) {
    case 'navigate': return 'Opened ' + String(result.url || args.url || '').slice(0, 200);
    case 'click': return 'Clicked ' + String(result.clicked || args.text || args.selector || ('ref ' + args.ref)).slice(0, 120);
    case 'type': return 'Typed ' + String(args.text || '').length + ' characters' + (args.submit ? ' and submitted' : '');
    case 'press': return 'Pressed ' + String(args.key || 'Enter').slice(0, 40);
    case 'scroll': return 'Scrolled ' + (args.direction === 'up' ? 'up' : 'down');
    case 'new_tab': return 'Opened a new tab' + (args.url ? ': ' + String(args.url).slice(0, 200) : '');
    case 'switch_tab': return 'Switched to tab ' + args.index;
    default: return String(action);
  }
}

export const RECORDED_ACTIONS = new Set(['navigate', 'click', 'type', 'press', 'scroll', 'new_tab', 'switch_tab']);

/**
 * Add a frame. `capture` returns { data (base64 JPEG), url }. Past MAX_FRAMES the
 * middle frames thin out, so the start and the latest steps both stay.
 */
export async function addFrame(recording, caption, capture) {
  if (!recording) return false;
  let shot;
  try { shot = await capture(); } catch { return false; }
  if (!shot || !shot.data) return false;
  recording.frames.push({ at: Date.now(), caption: String(caption || '').slice(0, 240), url: String(shot.url || '').slice(0, 300), data: shot.data });
  if (recording.frames.length > MAX_FRAMES) {
    // Drop every other frame from the middle half.
    const start = Math.floor(MAX_FRAMES / 4);
    const end = recording.frames.length - Math.floor(MAX_FRAMES / 4);
    const kept = recording.frames.slice(start, end).filter((_, index) => index % 2 === 0);
    recording.dropped += (end - start) - kept.length;
    recording.frames = [...recording.frames.slice(0, start), ...kept, ...recording.frames.slice(end)];
  }
  return true;
}

/** Capture the visible page of a CDP page as a scaled JPEG. */
export async function capturePage(page, evaluate) {
  const size = await evaluate(page, '({ w: innerWidth, h: innerHeight, url: location.href })');
  const scale = size && size.w > FRAME_WIDTH ? FRAME_WIDTH / size.w : 1;
  const shot = await page.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: FRAME_QUALITY,
    ...(size && size.w ? { clip: { x: 0, y: 0, width: size.w, height: size.h, scale } } : {})
  });
  return { data: shot.data, url: size && size.url || '' };
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A self-contained replay page: no network, no scripts from elsewhere. */
export function recordingHtml(recording, { title = 'Browser recording' } = {}) {
  const frames = recording.frames.map((frame) => ({ t: frame.at - recording.startedAt, caption: frame.caption, url: frame.url, src: 'data:image/jpeg;base64,' + frame.data }));
  const data = JSON.stringify(frames).replace(/</g, '\\u003c');
  const when = new Date(recording.startedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f8f4; --fg: #14201a; --muted: #5b6b62; --line: #d5ded7; --accent: #1f8a5b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1512; --fg: #e6efe9; --muted: #9db0a5; --line: #26332c; --accent: #3fbf86; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--fg); }
  header { padding: 16px 20px 8px; }
  h1 { margin: 0; font-size: 17px; }
  .meta { color: var(--muted); font-size: 13px; }
  main { padding: 0 20px 20px; max-width: 1100px; }
  .stage { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: #000; }
  .stage img { display: block; width: 100%; height: auto; }
  .caption { margin: 10px 0 2px; font-weight: 600; }
  .url { color: var(--muted); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .controls { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  input[type=range] { flex: 1; accent-color: var(--accent); }
  .count { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 70px; text-align: right; }
  ol { color: var(--muted); padding-left: 22px; font-size: 13px; }
  ol li { cursor: pointer; }
  ol li.on { color: var(--fg); font-weight: 600; }
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1><div class="meta">Recorded by OASIS on ${escapeHtml(when)} · ${frames.length} step${frames.length === 1 ? '' : 's'}${recording.dropped ? ' (' + recording.dropped + ' middle steps thinned out)' : ''}</div></header>
<main>
  <div class="stage"><img id="frame" alt=""></div>
  <div class="caption" id="caption"></div>
  <div class="url" id="url"></div>
  <div class="controls">
    <button type="button" id="prev" aria-label="Previous step">Prev</button>
    <button type="button" class="primary" id="play">Play</button>
    <button type="button" id="next" aria-label="Next step">Next</button>
    <input type="range" id="seek" min="0" value="0" aria-label="Step">
    <span class="count" id="count"></span>
  </div>
  <ol id="steps"></ol>
</main>
<script>
const frames = ${data};
let at = 0, timer = null;
const $ = (id) => document.getElementById(id);
$('seek').max = Math.max(0, frames.length - 1);
frames.forEach((frame, index) => { const li = document.createElement('li'); li.textContent = frame.caption; li.onclick = () => { stop(); show(index); }; $('steps').append(li); });
function show(index) {
  if (!frames.length) { $('caption').textContent = 'No steps were recorded.'; return; }
  at = Math.max(0, Math.min(frames.length - 1, index));
  const frame = frames[at];
  $('frame').src = frame.src; $('frame').alt = frame.caption;
  $('caption').textContent = frame.caption; $('url').textContent = frame.url;
  $('seek').value = at; $('count').textContent = (at + 1) + ' / ' + frames.length;
  [...$('steps').children].forEach((li, i) => li.classList.toggle('on', i === at));
}
function stop() { clearInterval(timer); timer = null; $('play').textContent = 'Play'; }
$('play').onclick = () => { if (timer) return stop(); if (at >= frames.length - 1) show(0); $('play').textContent = 'Pause'; timer = setInterval(() => { if (at >= frames.length - 1) stop(); else show(at + 1); }, 1200); };
$('prev').onclick = () => { stop(); show(at - 1); };
$('next').onclick = () => { stop(); show(at + 1); };
$('seek').oninput = () => { stop(); show(Number($('seek').value)); };
document.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft') $('prev').click(); if (event.key === 'ArrowRight') $('next').click(); if (event.key === ' ') { event.preventDefault(); $('play').click(); } });
show(0);
</script>
</body>
</html>
`;
}

/** Write the recording under <root>/.oasis/recordings/ and return its relative path. */
export async function saveRecording(root, recording, { title, now = new Date() } = {}) {
  if (!root || !recording || !recording.frames.length) return '';
  const dir = path.join(root, '.oasis', 'recordings');
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const name = 'browser-' + stamp + '.html';
  await writeFile(path.join(dir, name), recordingHtml(recording, { title: title || 'Browser recording' }));
  recording.frames = [];
  recording.dropped = 0;
  recording.startedAt = Date.now();
  return path.join('.oasis', 'recordings', name);
}
