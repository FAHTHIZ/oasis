// GitHub over its REST API, straight from the device: import a repository
// into the on-device workspace and commit changes back on a branch, with an
// optional pull request. No git binary or server needed.

const API = 'https://api.github.com';
const TEXT_LIMIT = 1024 * 1024;
const MAX_FILES = 4000;
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|mp3|mp4|mov|avi|mkv|webm|ogg|wav|flac|ttf|otf|woff2?|eot|sqlite|db|pyc|lock\.bin|keystore|jks|p12|der|heic|avif)$/i;

export function parseRepo(input) {
  const text = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const match = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/(.+))?$/i) || text.match(/^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], branch: match[3] || '' };
}

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function b64decode(data) {
  const binary = atob(String(data).replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export class GitHub {
  constructor({ token = '', fetchImpl } = {}) {
    this.token = token;
    this.fetchImpl = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  async api(path, { method = 'GET', body, signal } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetchImpl(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const message = data && data.message ? data.message : 'HTTP ' + response.status;
      const error = new Error('GitHub: ' + message + (response.status === 401 ? ' (check the token in Settings)' : response.status === 403 && !this.token ? ' (add a GitHub token in Settings to raise the rate limit)' : response.status === 404 && !this.token ? ' (private repositories need a token)' : ''));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async user() { return this.api('/user'); }

  /** Download a repository's text files. onProgress(done, total). */
  async importRepo(input, { onProgress, signal, concurrency = 8 } = {}) {
    const ref = parseRepo(input);
    if (!ref) throw new Error('Use owner/name or a github.com URL.');
    const info = await this.api('/repos/' + ref.owner + '/' + ref.repo, { signal });
    const branch = ref.branch || info.default_branch;
    const head = await this.api('/repos/' + ref.owner + '/' + ref.repo + '/commits/' + encodeURIComponent(branch), { signal });
    const tree = await this.api('/repos/' + ref.owner + '/' + ref.repo + '/git/trees/' + head.commit.tree.sha + '?recursive=1', { signal });
    const skipped = [];
    const entries = tree.tree.filter((entry) => {
      if (entry.type !== 'blob') return false;
      if (BINARY.test(entry.path) || entry.size > TEXT_LIMIT || /(^|\/)(node_modules|\.git)\//.test(entry.path)) { skipped.push(entry.path); return false; }
      return true;
    });
    if (entries.length > MAX_FILES) { skipped.push(...entries.slice(MAX_FILES).map((e) => e.path)); entries.length = MAX_FILES; }
    const files = [];
    let done = 0;
    let cursor = 0;
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const worker = async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        let bytes;
        if (!info.private) {
          const raw = await this.fetchImpl('https://raw.githubusercontent.com/' + ref.owner + '/' + ref.repo + '/' + head.sha + '/' + entry.path.split('/').map(encodeURIComponent).join('/'), { signal });
          if (raw.ok) bytes = new Uint8Array(await raw.arrayBuffer());
        }
        if (!bytes) {
          const blob = await this.api('/repos/' + ref.owner + '/' + ref.repo + '/git/blobs/' + entry.sha, { signal });
          bytes = b64decode(blob.content);
        }
        if (looksBinary(bytes)) skipped.push(entry.path);
        else files.push({ path: entry.path, content: decoder.decode(bytes), sha: entry.sha });
        done += 1;
        if (onProgress) onProgress(done, entries.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length || 1) }, worker));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      source: { type: 'github', owner: ref.owner, repo: ref.repo, branch, commit: head.sha, private: Boolean(info.private), truncated: Boolean(tree.truncated) },
      files,
      skipped
    };
  }

  /** Commit the workspace's changes to `branch`, creating it if needed. */
  async push(workspace, { branch, message, openPullRequest = false, title = '', body = '' } = {}) {
    const source = workspace.project.source;
    if (!source || source.type !== 'github') throw new Error('This project was not imported from GitHub, so there is nowhere to push. Export it as a zip instead.');
    if (!this.token) throw new Error('Add a GitHub token with repository write access in Settings first.');
    const target = String(branch || '').trim();
    if (!/^[\w./-]+$/.test(target) || target.includes('..')) throw new Error('Invalid branch name: ' + branch);
    const changes = await workspace.changes();
    if (!changes.length) return { summary: 'Nothing to push: no files changed since import.' };
    const repo = '/repos/' + source.owner + '/' + source.repo;
    let parentSha;
    let existed = true;
    try { parentSha = (await this.api(repo + '/git/ref/heads/' + target)).object.sha; }
    catch (error) {
      if (error.status !== 404) throw error;
      existed = false;
      parentSha = source.commit;
    }
    const parent = await this.api(repo + '/git/commits/' + parentSha);
    const files = await workspace.load();
    const tree = [];
    const shas = {};
    for (const change of changes) {
      if (change.status === 'deleted') { tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const blob = await this.api(repo + '/git/blobs', { method: 'POST', body: { content: b64encode(files.get(change.path).content), encoding: 'base64' } });
      shas[change.path] = blob.sha;
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await this.api(repo + '/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree } });
    const commit = await this.api(repo + '/git/commits', { method: 'POST', body: { message: String(message || 'Update from OASIS'), tree: newTree.sha, parents: [parentSha] } });
    if (existed) await this.api(repo + '/git/refs/heads/' + target, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    else await this.api(repo + '/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + target, sha: commit.sha } });
    await workspace.markClean(shas);
    workspace.project.source = { ...source, commit: commit.sha, workBranch: target };
    await workspace.touch();
    let summary = 'Pushed ' + changes.length + ' file' + (changes.length === 1 ? '' : 's') + ' to ' + source.owner + '/' + source.repo + ' on ' + target + ' (' + commit.sha.slice(0, 7) + ').';
    if (openPullRequest && target !== source.branch) {
      const pr = await this.api(repo + '/pulls', { method: 'POST', body: { title: String(title || message || 'Changes from OASIS').slice(0, 250), body: String(body || ''), head: target, base: source.branch } });
      summary += ' Opened pull request #' + pr.number + ': ' + pr.html_url;
    }
    return { summary, commit: commit.sha };
  }
}
