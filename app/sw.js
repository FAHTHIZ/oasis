// OASIS app offline support. The app shell and its modules are cached so the
// app opens with no connection; model and GitHub calls always go to the network.
const VERSION = 'oasis-app-__BUILD__';
const SHELL = [
  './', 'index.html', 'app.css', 'main.mjs', 'markdown.mjs', 'manifest.webmanifest', 'sandbox.html', 'sandbox-frame.js',
  'core/agent.mjs', 'core/providers.mjs', 'core/tools.mjs', 'core/workspace.mjs', 'core/command-palette.mjs', 'core/task-progress.mjs', 'core/sandbox.mjs', 'core/skills.mjs', 'core/github.mjs', 'core/zip.mjs', 'core/connect.mjs', 'core/plugins.mjs', 'core/think-tags.mjs', 'core/html-markdown.mjs',
  '../src/edit-match.mjs', '../src/tool-call-repair.mjs', '../src/tool-aliases.mjs', '../src/frontmatter.mjs',
  '../vendor/yaml/browser/index.js', '../vendor/jsonrepair/lib/esm/index.js', '../vendor/entities/dist/index.js', '../vendor/fflate/esm/browser.js', '../vendor/diff/libesm/index.js', '../vendor/marked/lib/marked.esm.js', '../vendor/eventsource-parser/dist/index.js', '../vendor/turndown/lib/turndown.browser.es.js', '../vendor/turndown-plugin-gfm/lib/turndown-plugin-gfm.browser.es.js',
  'icons/oasis-mark.svg', 'icons/oasis-192.png', 'icons/oasis-512.png', 'skills/index.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('oasis-app-') && key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // A local OASIS runtime's API is authenticated: never cache it.
  if (url.pathname.startsWith('/api/')) return;
  // Network first so updates arrive promptly; fall back to the cache offline.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return cached;
      if (request.mode === 'navigate') return cache.match('index.html');
      throw new Error('Offline');
    }
  })());
});
