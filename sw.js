// The old single-page workspace (index.html) was retired in OASIS 1.2. Browsers
// that installed its offline worker fetch this file on their next visit: it
// clears the old caches, unregisters itself and reloads open tabs, which the
// server then sends to the app at /app/.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('oasis-shell-')).map((key) => caches.delete(key)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.navigate(client.url).catch(() => {});
  })());
});
