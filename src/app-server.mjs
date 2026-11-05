// `oasis app`: serve the universal app from this installation, with no build
// step and no server-side state. The app itself runs entirely in the browser
// that opens it (phone, tablet or computer), so the server only hands out
// static files: the app, the shared browser-safe modules it imports, and the
// bundled skills with a generated index.
import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { frontMatterValue } from './frontmatter.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

/** Shared src modules the app imports (transitively); refuses Node-only ones. */
export async function appSharedModules(root) {
  const appDir = path.join(root, 'app');
  const srcDir = path.join(root, 'src');
  const queue = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.mjs')) queue.push(full);
    }
  };
  await walk(appDir);
  const needed = new Set();
  while (queue.length) {
    const file = queue.shift();
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), match[1]);
      if (!target.startsWith(srcDir + path.sep) || needed.has(target)) continue;
      const source = await readFile(target, 'utf8');
      if (/from\s*['"]node:|require\(/.test(source)) throw new Error(path.relative(root, target) + ' imports Node modules and cannot ship in the app.');
      needed.add(target);
      queue.push(target);
    }
  }
  return [...needed].sort();
}

export async function skillsIndex(root) {
  const dir = path.join(root, 'skills');
  const index = [];
  let names = [];
  try { names = (await readdir(dir)).sort(); } catch { return index; }
  for (const name of names) {
    let text;
    try { text = await readFile(path.join(dir, name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const meta = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [null, ''])[1];
    index.push({ name: frontMatterValue(meta, 'name') || name, description: frontMatterValue(meta, 'description').replace(/\s+/g, ' ').trim(), path: name + '/SKILL.md' });
  }
  return index;
}

/** Map a request path to a file on disk, or null. Never leaves the allowed folders. */
export function resolveAppPath(root, urlPath, shared) {
  let pathname;
  try { pathname = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (pathname.includes('\0') || pathname.split('/').includes('..')) return null;
  if (pathname === '/' || pathname === '') return { redirect: '/app/' };
  if (pathname === '/app') return { redirect: '/app/' };
  const inside = (base, rel) => {
    const full = path.resolve(base, '.' + path.sep + rel);
    return full === base || full.startsWith(base + path.sep) ? full : null;
  };
  if (pathname.startsWith('/app/skills/')) {
    const rel = pathname.slice('/app/skills/'.length);
    if (rel === 'index.json') return { index: true };
    return { file: inside(path.join(root, 'skills'), rel) };
  }
  if (pathname.startsWith('/app/fonts/')) return { file: inside(path.join(root, 'site', 'assets', 'fonts'), pathname.slice('/app/fonts/'.length)) };
  if (pathname.startsWith('/app/')) {
    const rel = pathname.slice('/app/'.length) || 'index.html';
    return { file: inside(path.join(root, 'app'), rel.endsWith('/') ? rel + 'index.html' : rel) };
  }
  if (pathname.startsWith('/src/')) {
    const full = path.join(root, 'src', path.basename(pathname));
    return shared.has(full) ? { file: full } : null;
  }
  return null;
}

export async function startAppServer({ root, host = '127.0.0.1', port = 3920 } = {}) {
  const shared = new Set(await appSharedModules(root));
  let indexCache = null;
  const server = createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); res.end(); return; }
    const target = resolveAppPath(root, req.url || '/', shared);
    if (!target) { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    if (target.redirect) { res.writeHead(302, { ...headers, Location: target.redirect }); res.end(); return; }
    try {
      if (target.index) {
        indexCache = indexCache || JSON.stringify(await skillsIndex(root));
        res.writeHead(200, { ...headers, 'Content-Type': TYPES['.json'] });
        res.end(req.method === 'HEAD' ? undefined : indexCache);
        return;
      }
      if (!target.file || !(await stat(target.file)).isFile()) throw new Error('missing');
      let body = await readFile(target.file);
      if (target.file.endsWith(path.sep + 'sw.js')) body = Buffer.from(body.toString('utf8').replace('__BUILD__', 'local-' + Date.now().toString(36)));
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(target.file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
