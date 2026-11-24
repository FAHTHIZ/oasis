// Everyday browsing on every installed engine (Obscura and Chrome): sign in,
// fill and submit a form, follow links, go back, download, and refuse a page.
// Each engine is skipped when it is not installed (`oasis browser install`
// adds Obscura; OASIS_OBSCURA_PATH / OASIS_CHROME_PATH point at a binary).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import '../src/tools.mjs';
import { findChrome } from '../src/cdp.mjs';
import { findObscura } from '../src/browser-engine.mjs';
import { executeBrowserTool, closeBrowser } from '../src/browser-tool.mjs';

const engines = { obscura: findObscura(process.env), chrome: findChrome(process.env) };

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function site(otherUrl) {
  const state = { submissions: 0, logins: 0 };
  const handler = (req, res) => {
    const cookie = String(req.headers.cookie || '');
    const html = (body, title = 'Site') => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>' + title + '</title>' + body); };
    if (req.url === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        state.logins += 1;
        if (form.get('user') === 'amina' && form.get('pass') === 'open sesame') {
          res.statusCode = 303; res.setHeader('set-cookie', 'sid=s3cret; Path=/; HttpOnly; SameSite=Lax'); res.setHeader('location', '/account'); res.end();
        } else html('<p>Wrong password</p>', 'Login failed');
      });
      return;
    }
    if (req.url === '/account') return cookie.includes('sid=s3cret') ? html('<h1>Hello amina</h1><a href="/report.csv">Monthly report</a> <a href="/next">Next page</a> <a href="' + otherUrl + '">Elsewhere</a> <a href="data:text/html,&lt;title&gt;Injected&lt;/title&gt;">Inline page</a>', 'Account') : html('<p>Please sign in</p>', 'Signed out');
    if (req.url === '/report.csv') { res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename="report.csv"'); return res.end('month,total\njan,' + (cookie.includes('sid=s3cret') ? '42' : 'denied') + '\n'); }
    if (req.url === '/next') return html('<p>Second page</p><a href="/account">Back to account</a>', 'Next');
    if (req.url.startsWith('/search')) { state.submissions += 1; return html('<h1>Results</h1><p>for ' + new URL(req.url, 'http://x').searchParams.get('q') + '</p>', 'Results'); }
    return html('<form method="post" action="/login"><label>User <input name="user"></label><label>Password <input name="pass" type="password"></label><button>Sign in</button></form>' +
      '<form action="/search"><input name="q" aria-label="Search"></form>', 'Home');
  };
  return { state, handler };
}

for (const [engine, executable] of Object.entries(engines)) {
  test('everyday browsing on ' + engine, { skip: executable ? false : engine + ' is not installed', timeout: 180000 }, async (t) => {
    const other = await listen((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Elsewhere</title>elsewhere'); });
    const otherUrl = 'http://127.0.0.1:' + other.address().port + '/';
    const { state, handler } = site(otherUrl);
    const home = await listen(handler);
    t.after(() => { home.close(); other.close(); });
    const homeUrl = 'http://127.0.0.1:' + home.address().port + '/';
    const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-engines-'));
    const session = { root };
    t.after(() => closeBrowser(session));
    const asked = [];
    const allow = (message) => !message.includes(otherUrl.slice(0, -1)) && !message.includes('data:');
    const env = { ...process.env, OASIS_BROWSER_ENGINE: engine, OASIS_BROWSER_FALLBACK: '0', OASIS_CHROME_HEADLESS: '1', ...(engine === 'obscura' ? { OASIS_OBSCURA_PATH: executable } : { OASIS_CHROME_PATH: executable }) };
    const context = { session, env, approval: async (message) => { asked.push(message); return allow(message); } };
    const run = (args) => executeBrowserTool(args, context);

    const opened = await run({ action: 'navigate', url: homeUrl });
    assert.equal(opened.title, 'Home', JSON.stringify(opened));
    assert.equal((await run({ action: 'engine' })).engine, engine);

    // Sign in: typing into labelled fields, a POST and a redirect that sets a cookie.
    const snap = await run({ action: 'snapshot' });
    const ref = (name) => snap.elements.find((e) => e.name === name).ref;
    await run({ action: 'type', ref: ref('User'), text: 'amina' });
    await run({ action: 'type', ref: ref('Password'), text: 'open sesame' });
    const signedIn = await run({ action: 'click', text: 'Sign in' });
    assert.match(signedIn.url, /\/account$/, JSON.stringify(signedIn));
    assert.match((await run({ action: 'read' })).markdown, /Hello amina/);

    // A download link saves the file once, with the session cookie, and the tab stays put.
    const downloaded = await run({ action: 'click', text: 'Monthly report' });
    const saved = downloaded.download || (downloaded.downloads && downloaded.downloads[0]);
    assert.ok(saved && saved.saved, 'download reported: ' + JSON.stringify(downloaded));
    const files = await readdir(path.join(root, '.oasis', 'downloads'));
    assert.deepEqual(files, ['report.csv']);
    assert.match(await readFile(path.join(root, '.oasis', 'downloads', 'report.csv'), 'utf8'), /jan,42/);
    assert.match(downloaded.url, /\/account$/);

    // Links and history.
    assert.match((await run({ action: 'click', text: 'Next page' })).url, /\/next$/);
    const back = await run({ action: 'back' });
    assert.match(back.url, /\/account$/, JSON.stringify(back));

    // Two calls at once run one after the other on the same tab.
    const [first, second] = await Promise.all([run({ action: 'navigate', url: homeUrl }), run({ action: 'snapshot' })]);
    assert.equal(first.title, 'Home');
    assert.equal(second.title, 'Home', 'the snapshot waited for the navigation');

    // Enter submits a search form exactly once.
    const box = (await run({ action: 'snapshot' })).elements.find((e) => e.name === 'Search');
    const searched = await run({ action: 'type', ref: box.ref, text: 'tea', submit: true });
    assert.match(searched.url, /\/search\?q=tea$/, JSON.stringify(searched));
    assert.equal(state.submissions, 1, 'one submission, no duplicate fallback submit');

    // A refused cross-origin page leaves the tab where it was, and relative links
    // still resolve against that page afterwards.
    await run({ action: 'navigate', url: homeUrl + 'account' });
    const refused = await run({ action: 'click', text: 'Elsewhere' });
    assert.ok(refused.blockedNavigations && refused.blockedNavigations.length, JSON.stringify(refused));
    assert.match(refused.url, /\/account$/, JSON.stringify(refused));
    assert.ok(asked.some((m) => m.includes(otherUrl.slice(0, -1))), 'the cross-origin page was asked about');
    assert.match((await run({ action: 'click', text: 'Next page' })).url, new RegExp('^' + homeUrl.replace(/[.:/]/g, '\\$&') + 'next$'));

    // A refused data: page does not stay loaded under the old address.
    await run({ action: 'navigate', url: homeUrl + 'account' });
    const inline = await run({ action: 'click', text: 'Inline page' });
    // Chrome refuses link navigations to data: itself; Obscura relies on the guard.
    if (engine === 'obscura') assert.ok(inline.blockedNavigations && inline.blockedNavigations.length, JSON.stringify(inline));
    assert.match(inline.url, /\/account$/);
    const clean = await run({ action: 'snapshot' });
    assert.notEqual(clean.title, 'Injected');
    assert.match(clean.url, /\/account$/);
    assert.match(clean.text, /Hello amina/);
  });
}
