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
await writeFile(file, html);
console.log('Stamped homepage with ' + commits.length + ' commits' + (commits[0] ? ' (head ' + commits[0].sha.slice(0, 7) + ')' : '') + '.');
