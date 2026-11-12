// Shared browser-safe module graph and path resolver for the host-connected
// workspace. The static server below remains a test harness; the standalone
// browser-app CLI command and public PWA deployment have been retired.
import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { frontMatterValue, splitFrontMatter } from './frontmatter.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

// npm packages that shared src modules may import in the browser, with the ESM entry
// each ships. The app's import map (app/index.html) points the bare names at
// /vendor/<package>/<entry>; everything under the entry's folder is served.
export const APP_PACKAGES = Object.freeze({
  yaml: 'browser/index.js',
  jsonrepair: 'lib/esm/index.js',
  entities: 'dist/index.js',
  fflate: 'esm/browser.js',
  diff: 'libesm/index.js',
  marked: 'lib/marked.esm.js',
  'highlight.js': 'es/highlight.min.js',
  dompurify: 'dist/purify.es.mjs',
  'eventsource-parser': 'dist/index.js',
  turndown: 'lib/turndown.browser.es.js',
  'turndown-plugin-gfm': 'lib/turndown-plugin-gfm.browser.es.js'
});

// Bare names whose browser build ships in another npm package. highlight.js's own
// es/ entries wrap CommonJS; its pre-built ES module (common languages) is in
// @highlightjs/cdn-assets. Node keeps resolving the real highlight.js package.
const APP_PACKAGE_SOURCES = Object.freeze({ 'highlight.js': '@highlightjs/cdn-assets' });

/** Shared src modules and npm packages the app imports (transitively); refuses Node-only ones. */
export async function appModuleGraph(root) {
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
  const packages = new Set();
  while (queue.length) {
    const file = queue.shift();
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) {
        if (specifier.startsWith('node:')) continue; // caught below for src modules
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        if (!Object.hasOwn(APP_PACKAGES, name) || specifier !== name) throw new Error(path.relative(root, file) + ' imports ' + specifier + ', which has no browser build listed in APP_PACKAGES.');
        packages.add(name);
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier);
      if (!target.startsWith(srcDir + path.sep) || needed.has(target)) continue;
      const source = await readFile(target, 'utf8');
      if (/from\s*['"]node:|require\(/.test(source)) throw new Error(path.relative(root, target) + ' imports Node modules and cannot ship in the app.');
      needed.add(target);
      queue.push(target);
    }
  }
  return { modules: [...needed].sort(), packages: [...packages].sort() };
}

export async function appSharedModules(root) {
  return (await appModuleGraph(root)).modules;
}

/** Folder of a browser package that may be served, e.g. node_modules/yaml/browser. */
function appPackageDir(root, name) {
  return path.join(root, 'node_modules', APP_PACKAGE_SOURCES[name] || name, path.dirname(APP_PACKAGES[name]));
}

export async function skillsIndex(root) {
  const dir = path.join(root, 'skills');
  const index = [];
  let names = [];
  try { names = (await readdir(dir)).sort(); } catch { return index; }
  for (const name of names) {
    let text;
    try { text = await readFile(path.join(dir, name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const meta = splitFrontMatter(text).data;
    index.push({ name: frontMatterValue(meta, 'name') || name, description: frontMatterValue(meta, 'description').replace(/\s+/g, ' ').trim(), path: name + '/SKILL.md' });
  }
  return index;
}

/** Map a request path to a file on disk, or null. Never leaves the allowed folders. */
export function resolveAppPath(root, urlPath, shared, packages = null) {
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
  if (pathname.startsWith('/app/')) {
    const rel = pathname.slice('/app/'.length) || 'index.html';
    return { file: inside(path.join(root, 'app'), rel.endsWith('/') ? rel + 'index.html' : rel) };
  }
  if (pathname.startsWith('/vendor/')) {
    const [name, ...rest] = pathname.slice('/vendor/'.length).split('/');
    if (!packages || !packages.has(name)) return null;
    const entryDir = path.dirname(APP_PACKAGES[name]);
    const rel = rest.join('/');
    if (entryDir !== '.' && !(rel === entryDir || rel.startsWith(entryDir + '/'))) return null;
    return { file: inside(appPackageDir(root, name), path.relative(entryDir, rel)) };
  }
  if (pathname.startsWith('/src/')) {
    const full = path.join(root, 'src', path.basename(pathname));
    return shared.has(full) ? { file: full } : null;
  }
  return null;
}

export async function startAppServer({ root, host = '127.0.0.1', port = 3920 } = {}) {
  const graph = await appModuleGraph(root);
  const shared = new Set(graph.modules);
  const packages = new Set(graph.packages);
  let indexCache = null;
  const server = createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); res.end(); return; }
    const target = resolveAppPath(root, req.url || '/', shared, packages);
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
