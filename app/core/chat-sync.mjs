// Browser-only chats (made without the computer) live in IndexedDB. When the app is
// connected to `oasis web`, each one is copied into the computer's session store with
// POST /api/sessions/import, so the terminal and other devices see it. A chat is sent
// again only after it changed; the server keeps one copy per key.

/** Text turns of a browser chat, as the import endpoint takes them. */
export function chatTurns(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 24000) }));
}

// The import endpoint takes up to 4 MiB; keep the newest turns that fit.
const IMPORT_BUDGET_BYTES = 3.5 * 1024 * 1024;
function newestThatFit(turns) {
  let used = 0;
  let start = turns.length;
  while (start > 0) {
    const size = new TextEncoder().encode(JSON.stringify(turns[start - 1].content)).length + 40;
    if (used + size > IMPORT_BUDGET_BYTES) break;
    used += size;
    start--;
  }
  return start ? turns.slice(start) : turns;
}

/**
 * Copies changed browser-only chats. `store` has listProjects/getValue/setValue,
 * `api(path, options)` calls the runtime, and chatIndex/chatKey are the app's own.
 * Returns { copied, failed }; stops early when the runtime rejects the key.
 */
export async function syncBrowserChats({ store, api, chatIndex, chatKey }) {
  let copied = 0;
  let failed = 0;
  let projects = [];
  try { projects = await store.listProjects(); } catch { projects = []; }
  for (const project of projects) {
    const index = await chatIndex(project.id);
    const items = index.list.some((item) => item.id === 'main') ? [...index.list] : [...index.list, { id: 'main', title: '', updatedAt: 0 }];
    for (const item of items) {
      const key = chatKey(project.id, item.id);
      const saved = await store.getValue(key).catch(() => null);
      // Chats made while connected hold a session pointer, not a message array.
      if (!saved || !Array.isArray(saved.messages) || !saved.messages.length) continue;
      const stamp = Number(item.updatedAt) || 0;
      if (saved.serverCopy && (!stamp || Number(saved.serverCopy.updatedAt) >= stamp)) continue;
      const messages = newestThatFit(chatTurns(saved.messages));
      const firstUser = messages.find((m) => m.role === 'user');
      if (!firstUser) continue;
      try {
        const result = await api('/api/sessions/import', { method: 'POST', body: { key: project.id + ':' + item.id, project: project.name || '', title: item.title || firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 80), messages } });
        await store.setValue(key, { ...saved, serverCopy: { id: result.id, updatedAt: stamp || Date.now() } });
        copied++;
      } catch (error) {
        failed++;
        if (error && error.status === 401) return { copied, failed };
      }
    }
  }
  return { copied, failed };
}
