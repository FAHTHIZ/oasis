// Live preview for the web app: project files, or a dev server on this computer, shown in a
// panel beside the chat.
//
// Preview pages are the project's own code, so they never run with the app's privileges:
// - every response carries `Content-Security-Policy: sandbox …` without allow-same-origin,
//   so the page gets an opaque origin and cannot read the app's storage, key or API;
// - the URL carries a random preview key (not the access key) that only opens previews;
// - protected paths (.env, keys, .git) are refused, and symlinks out of the project too;
// - the dev-server proxy only reaches 127.0.0.1, never the OASIS port itself.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath, sensitivePath } from './tools.mjs';

export const PREVIEW_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';
const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.csv': 'text/plain; charset=utf-8'
};

const KEY = '[A-Za-z0-9_-]{32,64}';
const PREVIEW_PATH = new RegExp('^/preview/(' + KEY + ')/(?::(\\d{2,5})/)?(.*)$');

export function previewType(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Split `/preview/KEY/:5173/rest` or `/preview/KEY/rest`. */
export function parsePreviewPath(pathname) {
  const match = PREVIEW_PATH.exec(pathname);
  if (!match) return null;
  return { key: match[1], port: match[2] ? Number(match[2]) : null, rest: match[3] || '' };
}

/** Whether a preview path is one OASIS must not serve. */
export function protectedPreviewPath(relative) {
  const rel = String(relative || '').split(path.sep).join('/').replace(/^\/+/, '');
  if (/(^|\/)\.git(\/|$)/.test(rel)) return true;
  if (/^\.oasis(\/|$)/.test(rel) && !/^\.oasis\/recordings\//.test(rel)) return true;
  return sensitivePath(rel);
}

function baseHeaders(loopbackOnly) {
  return {
    'content-security-policy': PREVIEW_SANDBOX,
    'x-content-type-options': 'nosniff',
    // Loopback servers keep the full address in Referer so pages that load "/style.css"
    // still find their files. Otherwise the preview key must not reach other sites.
    'referrer-policy': loopbackOnly ? 'unsafe-url' : 'same-origin',
    'cache-control': 'no-store',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=()'
  };
}

/**
 * Point root paths ("/style.css", url(/img.png)) at the preview, since a sandboxed page
 * sends no Referer that could tell the server which preview asked.
 */
export function rewriteRootPaths(text, base, type) {
  const body = String(text);
  const css = (source) => source.replace(/url\(\s*(["']?)\/(?!\/)/g, (_m, quote) => 'url(' + quote + base);
  if (/^text\/css/.test(type)) return css(body);
  if (!/^text\/html/.test(type)) return body;
  return css(body)
    .replace(/(\s(?:src|href|action|poster|data|formaction)\s*=\s*)(["'])\/(?!\/)/gi, (_m, attr, quote) => attr + quote + base)
    .replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (_m, attr, quote, list) => attr + quote + list.replace(/(^|,\s*)\/(?!\/)/g, '$1' + base) + quote)
    .replace(/(\bfrom\s*["']|\bimport\s*\(\s*["']|\bimport\s*["'])\/(?!\/)/g, (_m, lead) => lead + base);
}

function notFoundPage(rel) {
  const safe = String(rel || '/').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font:15px system-ui;margin:3rem;color:#456">' +
    '<h1 style="font-size:18px">Nothing to show at ' + safe + '</h1><p>Ask OASIS to create it, or type another file in the preview address bar.</p></body>';
}

/**
 * @param {{ getRoot: () => string, loopbackOnly?: boolean, ownPort?: () => number|null, key?: string }} options
 */
export function createPreviewHandler({ getRoot, loopbackOnly = true, ownPort = () => null, key = randomBytes(24).toString('base64url') } = {}) {
  const base = (port) => '/preview/' + key + '/' + (port ? ':' + port + '/' : '');

  async function serveFile(req, res, rest) {
    const headers = baseHeaders(loopbackOnly);
    let rel = decodeURIComponent(rest || '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    if (protectedPreviewPath(rel)) { res.writeHead(403, { ...headers, 'content-type': 'text/plain; charset=utf-8' }); res.end('This path is protected.'); return; }
    let target;
    try {
      target = await resolveWorkspacePath(getRoot(), rel, { rejectSymlinks: true, workspaceOnly: true, allowIgnored: true });
      let info = await lstat(target.absolute);
      if (info.isDirectory()) {
        // A folder without a trailing slash: send the browser to the slash form so relative links work.
        res.writeHead(308, { ...headers, location: base(null) + rel.replace(/\/?$/, '/') });
        res.end();
        return;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (info.size > MAX_PREVIEW_FILE_BYTES) { res.writeHead(413, { ...headers, 'content-type': 'text/plain; charset=utf-8' }); res.end('Too large to preview.'); return; }
      info = await stat(target.absolute);
      const type = previewType(rel);
      let body = await readFile(target.absolute);
      if (/^text\/(html|css)/.test(type)) body = Buffer.from(rewriteRootPaths(body.toString('utf8'), base(null), type));
      res.writeHead(200, { ...headers, 'content-type': type, 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const status = error && error.code === 'ENOENT' ? 404 : 403;
      res.writeHead(status, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      res.end(status === 404 ? notFoundPage(rel) : 'This path is protected or outside the project.');
    }
  }

  function fromSamePort(req, port) {
    try {
      const from = parsePreviewPath(new URL(String(req.headers.referer || '')).pathname);
      return Boolean(from && from.key === key && from.port === port);
    } catch { return false; }
  }

  function proxy(req, res, port, rest, search) {
    const headers = baseHeaders(loopbackOnly);
    if (port < 1024 || port > 65535 || port === ownPort()) { res.writeHead(400, { ...headers, 'content-type': 'text/plain; charset=utf-8' }); res.end('Choose a dev server port between 1024 and 65535 (not the OASIS port).'); return; }
    const forward = { ...req.headers, host: '127.0.0.1:' + port, 'accept-encoding': 'identity' };
    for (const name of ['authorization', 'cookie', 'origin', 'referer', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) delete forward[name];
    // A dev app posting to its own server keeps working without an Origin, but a
    // page from another preview (an untrusted repo's HTML file, another port) must
    // not reach other local services (Ollama, Jupyter…) with their Origin check
    // removed: those requests keep the opaque `Origin: null` the browser sent.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase()) && !fromSamePort(req, port)) forward.origin = 'null';
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: '/' + rest + (search || ''), headers: forward }, (answer) => {
      const out = { ...answer.headers };
      for (const name of ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'set-cookie', 'strict-transport-security']) delete out[name];
      if (out.location) {
        const location = String(out.location);
        const local = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/.*)?$/i.exec(location);
        if (local && Number(local[1] || 80) === port) out.location = base(port) + String(local[2] || '/').replace(/^\//, '');
        else if (location.startsWith('/')) out.location = base(port) + location.slice(1);
      }
      const type = String(out['content-type'] || '');
      if (/^text\/(html|css)/.test(type) && !out['content-encoding']) {
        const chunks = [];
        answer.on('data', (chunk) => chunks.push(chunk));
        answer.on('end', () => {
          const body = Buffer.from(rewriteRootPaths(Buffer.concat(chunks).toString('utf8'), base(port), type));
          delete out['transfer-encoding'];
          res.writeHead(answer.statusCode || 502, { ...out, ...headers, 'content-length': body.length });
          res.end(req.method === 'HEAD' ? undefined : body);
        });
        answer.on('error', () => res.destroy());
        return;
      }
      res.writeHead(answer.statusCode || 502, { ...out, ...headers });
      answer.pipe(res);
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (error) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;margin:3rem;color:#456"><h1 style="font-size:18px">Nothing is running on port ' + port + '</h1><p>Start your dev server (for example <code>npm run dev</code>), then reload the preview.</p><p style="color:#899">' + String(error.code || error.message || '').replace(/[<>&]/g, '') + '</p></body>');
    });
    if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
    else req.pipe(upstream);
  }

  /** Handles preview requests. Returns true when the request was a preview request. */
  async function handle(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname;
    const parsed = parsePreviewPath(pathname);
    if (parsed) {
      if (parsed.key !== key) { res.writeHead(404, { ...baseHeaders(loopbackOnly), 'content-type': 'text/plain; charset=utf-8' }); res.end('This preview link has expired. Open the preview again from OASIS.'); return true; }
      if (parsed.port) proxy(req, res, parsed.port, parsed.rest, parsedUrl.search);
      else if (req.method === 'GET' || req.method === 'HEAD') await serveFile(req, res, parsed.rest);
      else { res.writeHead(405, baseHeaders(loopbackOnly)); res.end(); }
      return true;
    }
    // A preview page asked for "/style.css": send it to the same file inside the preview.
    const referer = String(req.headers.referer || '');
    if (!referer || pathname.startsWith('/preview/')) return false;
    let from;
    try { from = parsePreviewPath(new URL(referer).pathname); } catch { from = null; }
    if (!from || from.key !== key) return false;
    res.writeHead(307, { ...baseHeaders(loopbackOnly), location: base(from.port) + pathname.replace(/^\//, '') + (parsedUrl.search || '') });
    res.end();
    return true;
  }

  return { key, base, handle };
}
