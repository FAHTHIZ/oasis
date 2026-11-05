// On-device project storage. Projects and their text files live in IndexedDB,
// which every modern browser supports (including iOS Safari), so the app works
// offline and keeps work across restarts. Tests use the in-memory store.

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Normalise a workspace path; throws on anything that escapes the project. */
export function cleanPath(raw) {
  const text = String(raw ?? '').replace(/\\/g, '/').trim();
  if (text === '' || text === '.' || text === './' || text === '/') return '';
  const parts = [];
  for (const part of text.replace(/^\.?\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('Paths must stay inside the project: ' + raw);
    if (/[\0]/.test(part)) throw new Error('Invalid path: ' + raw);
    parts.push(part);
  }
  return parts.join('/');
}

export class MemoryStore {
  constructor() { this.projects = new Map(); this.files = new Map(); }
  async listProjects() { return [...this.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  async getProject(id) { return this.projects.get(id) || null; }
  async putProject(project) { this.projects.set(project.id, { ...project }); }
  async deleteProject(id) {
    this.projects.delete(id);
    for (const key of [...this.files.keys()]) if (key.startsWith(id + '\u0000')) this.files.delete(key);
  }
  async listFiles(projectId) {
    const out = [];
    for (const [key, value] of this.files) if (key.startsWith(projectId + '\u0000')) out.push(value);
    return out;
  }
  async getFile(projectId, path) { return this.files.get(projectId + '\u0000' + path) || null; }
  async putFile(projectId, file) { this.files.set(projectId + '\u0000' + file.path, { ...file }); }
  async deleteFile(projectId, path) { this.files.delete(projectId + '\u0000' + path); }
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDBStore {
  constructor(name = 'oasis-universal') { this.name = name; this.db = null; }
  async open() {
    if (this.db) return this.db;
    const req = indexedDB.open(this.name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) {
        const files = db.createObjectStore('files', { keyPath: ['projectId', 'path'] });
        files.createIndex('project', 'projectId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    this.db = await request(req);
    return this.db;
  }
  async tx(stores, mode, fn) {
    const db = await this.open();
    const tx = db.transaction(stores, mode);
    const result = await fn(tx);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    return result;
  }
  async listProjects() { return (await this.tx(['projects'], 'readonly', (tx) => request(tx.objectStore('projects').getAll()))).sort((a, b) => b.updatedAt - a.updatedAt); }
  async getProject(id) { return (await this.tx(['projects'], 'readonly', (tx) => request(tx.objectStore('projects').get(id)))) || null; }
  async putProject(project) { await this.tx(['projects'], 'readwrite', (tx) => request(tx.objectStore('projects').put(project))); }
  async deleteProject(id) {
    await this.tx(['projects', 'files'], 'readwrite', async (tx) => {
      tx.objectStore('projects').delete(id);
      const keys = await request(tx.objectStore('files').index('project').getAllKeys(id));
      for (const key of keys) tx.objectStore('files').delete(key);
    });
  }
  async listFiles(projectId) {
    const rows = await this.tx(['files'], 'readonly', (tx) => request(tx.objectStore('files').index('project').getAll(projectId)));
    return rows.map(({ projectId: _p, ...file }) => file);
  }
  async getFile(projectId, path) {
    const row = await this.tx(['files'], 'readonly', (tx) => request(tx.objectStore('files').get([projectId, path])));
    if (!row) return null;
    const { projectId: _p, ...file } = row;
    return file;
  }
  async putFile(projectId, file) { await this.tx(['files'], 'readwrite', (tx) => request(tx.objectStore('files').put({ ...file, projectId }))); }
  async deleteFile(projectId, path) { await this.tx(['files'], 'readwrite', (tx) => request(tx.objectStore('files').delete([projectId, path]))); }
  async getValue(key) { return this.tx(['kv'], 'readonly', (tx) => request(tx.objectStore('kv').get(key))); }
  async setValue(key, value) { await this.tx(['kv'], 'readwrite', (tx) => request(tx.objectStore('kv').put(value, key))); }
}

function newId() {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * A project's files with change tracking against the imported baseline, so the
 * app can show what the agent changed and push only those files.
 */
export class Workspace {
  constructor(store, project) {
    this.store = store;
    this.project = project;
    this.cache = null;
  }

  static async create(store, { name, source = null, files = [] } = {}) {
    const project = { id: newId(), name: String(name || 'Untitled project').slice(0, 80), source, createdAt: Date.now(), updatedAt: Date.now() };
    await store.putProject(project);
    const ws = new Workspace(store, project);
    for (const file of files) await ws.write(file.path, file.content, { baseline: true, sha: file.sha });
    return ws;
  }

  async load() {
    if (!this.cache) {
      this.cache = new Map();
      for (const file of await this.store.listFiles(this.project.id)) this.cache.set(file.path, file);
    }
    return this.cache;
  }

  async touch() {
    this.project.updatedAt = Date.now();
    await this.store.putProject(this.project);
  }

  async paths() { return [...(await this.load()).keys()].filter((p) => !(this.cache.get(p).deleted)).sort(); }

  async exists(path) {
    const file = (await this.load()).get(cleanPath(path));
    return Boolean(file && !file.deleted);
  }

  async read(path) {
    const clean = cleanPath(path);
    const file = (await this.load()).get(clean);
    if (!file || file.deleted) throw new Error('No such file: ' + clean);
    return file.content;
  }

  async write(path, content, { baseline = false, sha = null } = {}) {
    const clean = cleanPath(path);
    if (!clean) throw new Error('A file path is required.');
    const text = String(content ?? '');
    if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) throw new Error('Files are limited to ' + (MAX_FILE_BYTES >> 20) + ' MB in the app.');
    const files = await this.load();
    const previous = files.get(clean);
    const file = {
      path: clean,
      content: text,
      original: baseline ? text : previous ? (previous.original ?? null) : null,
      sha: baseline ? sha : previous ? previous.sha : null,
      deleted: false,
      updatedAt: Date.now()
    };
    files.set(clean, file);
    await this.store.putFile(this.project.id, file);
    if (!baseline) await this.touch();
    return { created: !previous || previous.deleted };
  }

  async remove(path) {
    const clean = cleanPath(path);
    const files = await this.load();
    const file = files.get(clean);
    if (!file || file.deleted) throw new Error('No such file: ' + clean);
    if (file.original === null) {
      files.delete(clean);
      await this.store.deleteFile(this.project.id, clean);
    } else {
      const tomb = { ...file, content: '', deleted: true, updatedAt: Date.now() };
      files.set(clean, tomb);
      await this.store.putFile(this.project.id, tomb);
    }
    await this.touch();
  }

  /** Files that differ from the imported baseline: added, modified, deleted. */
  async changes() {
    const out = [];
    for (const file of (await this.load()).values()) {
      if (file.deleted) out.push({ path: file.path, status: 'deleted' });
      else if (file.original === null) out.push({ path: file.path, status: 'added' });
      else if (file.original !== file.content) out.push({ path: file.path, status: 'modified' });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Make the current state the new baseline (after a successful push). */
  async markClean(shas = {}) {
    const files = await this.load();
    for (const [path, file] of [...files]) {
      if (file.deleted) { files.delete(path); await this.store.deleteFile(this.project.id, path); continue; }
      const next = { ...file, original: file.content, sha: shas[path] || file.sha };
      files.set(path, next);
      await this.store.putFile(this.project.id, next);
    }
  }

  async revert(path) {
    const clean = cleanPath(path);
    const file = (await this.load()).get(clean);
    if (!file) throw new Error('No such file: ' + clean);
    if (file.original === null) return this.remove(clean);
    const next = { ...file, content: file.original, deleted: false, updatedAt: Date.now() };
    this.cache.set(clean, next);
    await this.store.putFile(this.project.id, next);
  }
}

/** Minimal line diff (LCS on lines, bounded) for showing changes. */
export function lineDiff(before, after, maxLines = 4000) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  if (a.length > maxLines || b.length > maxLines) return [{ type: 'note', text: 'File too large to diff in the app (' + a.length + ' → ' + b.length + ' lines).' }];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const n = midA.length;
  const m = midB.length;
  const out = [];
  for (let i = Math.max(0, start - 3); i < start; i++) out.push({ type: 'same', text: a[i], line: i + 1 });
  if (n * m > 4_000_000) {
    for (const text of midA) out.push({ type: 'del', text });
    for (const text of midB) out.push({ type: 'add', text });
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { out.push({ type: 'same', text: midA[i] }); i++; j++; }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ type: 'add', text: midB[j] }); j++; }
      else { out.push({ type: 'del', text: midA[i] }); i++; }
    }
  }
  for (let i = endA + 1; i < Math.min(a.length, endA + 4); i++) out.push({ type: 'same', text: a[i] });
  return out;
}
