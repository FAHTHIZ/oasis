#!/usr/bin/env node
// Browser engine benchmark: Obscura against Chrome on the same work.
//   node scripts/bench-browser.mjs [--engines obscura,chrome] [--runs 3] [--parallel 4] [--live] [--json]
// Local runs use a generated page (text, links, a form, inline images) served on
// loopback, so the numbers do not depend on the network. --live adds a few public
// sites. Memory is the proportional set size (PSS) of the engine's whole process tree (Linux).
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { Browser, findChrome } from '../src/cdp.mjs';
import { findObscura } from '../src/browser-engine.mjs';
import { snapshotJs } from '../src/browser-tool.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const option = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const RUNS = Math.max(1, Number(option('runs', 3)));
const PARALLEL = Math.max(1, Number(option('parallel', 4)));
const LIVE = ['https://example.com/', 'https://en.wikipedia.org/wiki/Web_browser', 'https://news.ycombinator.com/', 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form'];
const PIXEL = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#4a7"/></svg>');

function fixtureHtml() {
  const rows = [];
  for (let i = 0; i < 120; i++) rows.push('<li><a href="/item/' + i + '">Item ' + i + '</a> <span>Lorem ipsum dolor sit amet, consectetur adipiscing elit ' + i + '.</span></li>');
  const images = Array.from({ length: 30 }, (_, i) => '<img alt="figure ' + i + '" src="' + PIXEL + '">').join('');
  return '<!doctype html><title>Bench page</title><style>body{font:15px sans-serif;max-width:900px;margin:auto}li{margin:4px 0}</style>' +
    '<h1>Benchmark page</h1><form action="/search"><label for=q>Search</label><input id=q name=q><select name=s><option>One</option><option>Two</option></select><button>Go</button></form>' +
    '<p>' + 'A paragraph of ordinary article text. '.repeat(80) + '</p><ul>' + rows.join('') + '</ul>' + images +
    '<script>document.querySelector("h1").dataset.ready = "1"; for (let i = 0; i < 2000; i++) document.body.appendChild(document.createComment(String(i)));</script>';
}

async function treePss(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  const children = new Map();
  for (const entry of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile('/proc/' + entry + '/stat', 'utf8').catch(() => '');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(entry));
  }
  let total = 0;
  const stack = [pid];
  while (stack.length) {
    const next = stack.pop();
    // Proportional set size: shared pages are split between the processes that
    // map them, so a multi-process engine is not counted several times over.
    const rollup = await readFile('/proc/' + next + '/smaps_rollup', 'utf8').catch(() => '');
    const match = /^Pss:\s+(\d+)/m.exec(rollup) || /VmRSS:\s+(\d+)/.exec(await readFile('/proc/' + next + '/status', 'utf8').catch(() => ''));
    if (match) total += Number(match[1]) * 1024;
    stack.push(...(children.get(next) || []));
  }
  return total;
}

const evaluate = async (page, expression) => {
  const out = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'evaluate failed');
  return out.result && out.result.value;
};

async function waitReady(page, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await evaluate(page, 'document.readyState').catch(() => 'loading');
    if (state === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function timed(fn) { const started = performance.now(); const value = await fn(); return { ms: performance.now() - started, value }; }

async function openPage(browser) {
  const page = await browser.newPage('about:blank');
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return page;
}

async function visit(page, url) {
  const nav = await timed(async () => { await page.send('Page.navigate', { url }, 60000); await waitReady(page); });
  const snap = await timed(() => evaluate(page, snapshotJs('__bench_refs')));
  const shot = await timed(() => page.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 60000));
  return { navigateMs: nav.ms, snapshotMs: snap.ms, screenshotMs: shot.ms, elements: snap.value && snap.value.elements ? snap.value.elements.length : 0, textChars: snap.value && snap.value.text ? snap.value.text.length : 0 };
}

const median = (list) => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };

async function benchEngine(engine, executable, url) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const launch = await timed(() => Browser.launch({ engine, executable, allowPrivateNetwork: true }));
    const browser = launch.value;
    try {
      const page = await openPage(browser);
      const idleRss = await treePss(browser.child && browser.child.pid);
      const cold = await visit(page, url);
      const warm = await visit(page, url);
      const loadedRss = await treePss(browser.child && browser.child.pid);
      runs.push({ launchMs: launch.ms, cold, warm, idleRss, loadedRss });
    } finally { await browser.close(); }
  }
  // Parallel: one browser, several tabs loading at once (agent fan-out).
  const browser = await Browser.launch({ engine, executable, allowPrivateNetwork: true });
  let parallel;
  try {
    const pages = await Promise.all(Array.from({ length: PARALLEL }, () => openPage(browser)));
    const all = await timed(() => Promise.all(pages.map((page) => visit(page, url))));
    parallel = { tabs: PARALLEL, wallMs: all.ms, rss: await treePss(browser.child && browser.child.pid) };
  } finally { await browser.close(); }
  // Sessions: one browser per agent, as separate Oasis sessions and subagents get,
  // all loading at once. Launch time is included.
  let sessions;
  {
    const all = await timed(() => Promise.all(Array.from({ length: PARALLEL }, async () => {
      const own = await Browser.launch({ engine, executable, allowPrivateNetwork: true });
      try { await visit(await openPage(own), url); return await treePss(own.child && own.child.pid); } finally { await own.close(); }
    })));
    sessions = { browsers: PARALLEL, wallMs: all.ms, rss: all.value.every((v) => v != null) ? all.value.reduce((a, b) => a + b, 0) : null };
  }
  let live = null;
  if (flag('live')) {
    const liveBrowser = await Browser.launch({ engine, executable });
    try {
      const page = await openPage(liveBrowser);
      live = [];
      for (const site of LIVE) {
        try { live.push({ url: site, ...(await visit(page, site)) }); }
        catch (error) { live.push({ url: site, error: error.message }); }
      }
    } finally { await liveBrowser.close(); }
  }
  return {
    engine,
    launchMs: median(runs.map((r) => r.launchMs)),
    coldNavigateMs: median(runs.map((r) => r.cold.navigateMs)),
    warmNavigateMs: median(runs.map((r) => r.warm.navigateMs)),
    snapshotMs: median(runs.map((r) => r.warm.snapshotMs)),
    screenshotMs: median(runs.map((r) => r.warm.screenshotMs)),
    elements: runs[0].warm.elements,
    idleRssMb: runs[0].idleRss == null ? null : median(runs.map((r) => r.idleRss)) / 1048576,
    loadedRssMb: runs[0].loadedRss == null ? null : median(runs.map((r) => r.loadedRss)) / 1048576,
    parallel: { ...parallel, rssMb: parallel.rss == null ? null : parallel.rss / 1048576 },
    sessions: { ...sessions, rssMb: sessions.rss == null ? null : sessions.rss / 1048576 },
    live
  };
}

const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fixtureHtml()); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/';
const wanted = option('engines', 'obscura,chrome').split(',').map((s) => s.trim()).filter(Boolean);
const found = { obscura: findObscura(process.env), chrome: findChrome(process.env) };
const results = [];
try {
  for (const engine of wanted) {
    if (!found[engine]) { results.push({ engine, skipped: 'not installed' }); continue; }
    results.push(await benchEngine(engine, found[engine], url));
  }
} finally { server.close(); }

if (flag('json')) {
  console.log(JSON.stringify({ runs: RUNS, parallel: PARALLEL, results }, null, 2));
} else {
  const fmt = (n, unit = 'ms') => (n == null ? 'n/a' : (unit === 'MB' ? n.toFixed(0) + ' MB' : Math.round(n) + ' ms'));
  console.log('Browser engines, median of ' + RUNS + ' runs (local page)\n');
  for (const r of results) {
    if (r.skipped) { console.log(r.engine + ': skipped (' + r.skipped + ')\n'); continue; }
    console.log(r.engine);
    console.log('  launch          ' + fmt(r.launchMs));
    console.log('  navigate cold   ' + fmt(r.coldNavigateMs) + '   warm ' + fmt(r.warmNavigateMs));
    console.log('  snapshot        ' + fmt(r.snapshotMs) + '   (' + r.elements + ' elements)');
    console.log('  screenshot      ' + fmt(r.screenshotMs));
    console.log('  memory          idle ' + fmt(r.idleRssMb, 'MB') + '   loaded ' + fmt(r.loadedRssMb, 'MB'));
    console.log('  ' + PARALLEL + ' tabs at once   ' + fmt(r.parallel.wallMs) + ' wall   ' + fmt(r.parallel.rssMb, 'MB'));
    console.log('  ' + PARALLEL + ' sessions      ' + fmt(r.sessions.wallMs) + ' wall   ' + fmt(r.sessions.rssMb, 'MB') + ' (one browser each, launch included)');
    for (const site of r.live || []) console.log('  live ' + site.url + '  ' + (site.error ? 'error: ' + site.error : fmt(site.navigateMs) + ', ' + site.elements + ' elements'));
    console.log('');
  }
}
