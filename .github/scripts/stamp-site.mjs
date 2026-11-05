// Stamps the public homepage with the commit it was built from and the latest
// commits on main, so the deployed site visibly tracks the repository.
// Runs in the Pages workflow after checkout (fetch-depth > 1). Safe to run
// locally: it only rewrites the marked regions of site/index.html.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const file = new URL('../../site/index.html', import.meta.url);
const repo = 'https://github.com/FAHTHIZ/oasis';
const limit = Number(process.env.OASIS_SITE_COMMITS || 8);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let commits = [];
try {
  const raw = git(['log', '-n', String(limit), '--no-merges', '--format=%H%x1f%s%x1f%cI']);
  commits = raw.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, date] = line.split('\x1f');
    return { sha, subject, date };
  });
} catch (error) {
  console.warn('git log unavailable; leaving the fallback changes list:', error.message);
}

const fmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const replaceRegion = (html, name, body) => {
  const pattern = new RegExp('(<!--OASIS:' + name + '-->)[\\s\\S]*?(<!--/OASIS:' + name + '-->)');
  if (!pattern.test(html)) throw new Error('site/index.html is missing the OASIS:' + name + ' region.');
  return html.replace(pattern, (_, open, close) => open + body + close);
};

let html = await readFile(file, 'utf8');
if (commits.length) {
  const items = commits.map((c) => '<li><a class="sha" href="' + repo + '/commit/' + c.sha + '">' + c.sha.slice(0, 7) + '</a><span class="msg">' + esc(c.subject) + '</span><time datetime="' + esc(c.date) + '">' + fmt(c.date) + '</time></li>').join('');
  html = replaceRegion(html, 'CHANGES', items);
  const head = commits[0];
  html = replaceRegion(html, 'BUILD', 'Built from <a href="' + repo + '/commit/' + head.sha + '">' + head.sha.slice(0, 7) + '</a> · ' + fmt(head.date));
}
// Direct installer links from the latest published release (deploy-time, so they always match real assets).
try {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'oasis-pages-stamp' };
  if (process.env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const res = await fetch('https://api.github.com/repos/FAHTHIZ/oasis/releases/latest', { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const release = await res.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const pick = (re) => assets.find((a) => re.test(a.name));
  // One row per installer and CPU type. data-os is "<os>-<arch>" so the page can
  // highlight (and the hero button can link straight to) the right file.
  const rows = [
    ['win-x64', 'Windows x64', pick(/(x64|amd64)\.exe$/i) || pick(/^(?!.*arm64).*\.exe$/i)],
    ['win-arm64', 'Windows ARM64', pick(/arm64\.exe$/i)],
    ['mac-arm64', 'macOS Apple silicon', pick(/arm64\.dmg$/i)],
    ['mac-x64', 'macOS Intel', pick(/x64\.dmg$/i)],
    ['linux-x64', 'Linux AppImage x86_64', pick(/(x86_64|x64|amd64)\.AppImage$/i)],
    ['linux-arm64', 'Linux AppImage ARM64', pick(/(arm64|aarch64)\.AppImage$/i)],
    ['linux-deb-x64', 'Debian/Ubuntu .deb x86_64', pick(/amd64\.deb$/i)],
    ['linux-deb-arm64', 'Debian/Ubuntu .deb ARM64', pick(/arm64\.deb$/i)],
    ['sums', 'SHA256SUMS', pick(/^SHA256SUMS$/)]
  ].filter((r) => r[2]);
  const mb = (n) => (n / 1048576).toFixed(0) + ' MB';
  if (rows.length) {
    html = replaceRegion(html, 'DOWNLOADS', '<ul class="dl-list" aria-label="' + esc(release.tag_name || 'Latest release') + ' downloads">' + rows.map(([os, label, a]) => '<li data-os="' + os + '"><a href="' + esc(a.browser_download_url) + '" data-file="' + esc(a.name) + '">' + esc(label) + (os === 'sums' ? '' : ' <small>' + mb(a.size) + '</small>') + '</a></li>').join('') + '</ul>');
    console.log('Stamped ' + rows.length + ' download links from ' + release.tag_name + '.');
  }
} catch (error) {
  console.warn('Latest release unavailable; keeping the releases-page link only:', error.message);
}
await writeFile(file, html);
console.log('Stamped homepage with ' + commits.length + ' commits' + (commits[0] ? ' (head ' + commits[0].sha.slice(0, 7) + ')' : '') + '.');
