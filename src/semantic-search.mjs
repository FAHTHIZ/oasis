// Semantic code search: local embeddings via a pluggable provider (Ollama
// /api/embeddings by default), fused with lexical and repo-map signals.
// Opt-in and offline-friendly: vectors are cached locally; no code leaves the
// machine unless the user explicitly configures a hosted embedding provider.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getBaseConfigDirectory } from './config.mjs';

const EMBED_TIMEOUT_MS = 10000;
const MAX_INDEX_FILES = 5000;
const MAX_CHUNK_CHARS = 2000;

export const SEMANTIC_SEARCH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'semantic_search',
    description: 'Semantic code search: find files/functions relevant to a natural-language query using local embeddings, fused with lexical and repo-map ranking. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of what to find.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results (default 10).' },
        path: { type: 'string', description: 'Optional subdirectory to restrict the search.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
};

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

function chunkText(text, maxLen = MAX_CHUNK_CHARS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return [clean];
  const chunks = [];
  for (let i = 0; i < clean.length; i += maxLen) chunks.push(clean.slice(i, i + maxLen));
  return chunks;
}

async function embedText(text, config, fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('semantic_search requires a fetch implementation.');
  const baseURL = String(config.baseURL || 'http://localhost:11434');
  const model = String(config.embeddingModel || 'nomic-embed-text');
  const url = baseURL.replace(/\/+$/, '') + '/api/embeddings';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error('embedding request failed: ' + response.status);
    const data = await response.json();
    const vector = data && (data.embedding || (data.embeddings && data.embeddings[0]));
    if (!Array.isArray(vector) || !vector.length) throw new Error('embedding response missing vector.');
    return vector;
  } finally { clearTimeout(timer); }
}

function cacheFile(root, env) {
  const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
  return path.join(getBaseConfigDirectory(env), 'cache', 'semantic-search', id + '.json');
}

async function loadCache(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return { entries: {} }; }
}

async function saveCache(file, state) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, file);
  } catch {}
}

// Build (or refresh) the local vector index for a workspace.
export async function buildSemanticIndex(root, files, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const config = options.config || {};
  const file = cacheFile(root, env);
  const state = await loadCache(file);
  const limited = files.slice(0, MAX_INDEX_FILES);
  for (const item of limited) {
    const key = item.path + ':' + (item.mtime || '');
    if (state.entries[item.path] && state.entries[item.path].key === key) continue;
    let text;
    try { text = await readFile(path.resolve(root, item.path), 'utf8'); } catch { continue; }
    const chunks = chunkText(text);
    const vectors = [];
    for (const chunk of chunks) vectors.push(await embedText(chunk, config, fetchImpl));
    state.entries[item.path] = { key, vectors, mtime: item.mtime || '' };
  }
  await saveCache(file, state);
  return state;
}

// Search: embed the query, score against cached vectors, optionally fuse with
// lexical hits and repo-map rank.
export async function searchSemantic(root, query, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const config = options.config || {};
  const limit = Math.min(50, Math.max(1, Number.parseInt(options.limit, 10) || 10));
  const file = cacheFile(root, env);
  const state = await loadCache(file);
  const queryVector = await embedText(query, config, fetchImpl);
  const results = [];
  for (const [filePath, entry] of Object.entries(state.entries)) {
    if (options.path && !filePath.startsWith(options.path)) continue;
    let best = 0;
    for (const vector of entry.vectors || []) {
      const score = cosineSimilarity(queryVector, vector);
      if (score > best) best = score;
    }
    if (best > 0) results.push({ path: filePath, semanticScore: best });
  }
  results.sort((a, b) => b.semanticScore - a.semanticScore);
  // Fuse with lexical and repo-map signals when provided.
  if (options.lexicalResults || options.repoMapRank) {
    const lexical = new Map((options.lexicalResults || []).map((r) => [r.path, r.score || 1]));
    const structural = options.repoMapRank || new Map();
    for (const result of results) {
      const lex = lexical.get(result.path) || 0;
      const structuralScore = structural.get(result.path) || 0;
      result.fusedScore = 0.6 * result.semanticScore + 0.25 * Math.min(1, lex) + 0.15 * structuralScore;
    }
    results.sort((a, b) => b.fusedScore - a.fusedScore);
  }
  return { query, results: results.slice(0, limit), indexedFiles: Object.keys(state.entries).length };
}

export function formatSemanticSearch(result) {
  if (!result.results.length) return 'No semantic matches for "' + result.query + '" (' + result.indexedFiles + ' file(s) indexed).';
  const lines = ['Semantic matches for "' + result.query + '":'];
  for (const item of result.results) {
    const score = item.fusedScore !== undefined ? item.fusedScore.toFixed(3) : item.semanticScore.toFixed(3);
    lines.push('- ' + item.path + ' (score ' + score + ')');
  }
  return lines.join('\n');
}

export async function runSemanticSearchTool(args = {}, context = {}) {
  const root = context.root || process.cwd();
  const query = String(args.query || '').slice(0, 500);
  if (!query) throw new Error('semantic_search needs a query.');
  const result = await searchSemantic(root, query, {
    env: context.env,
    fetchImpl: context.fetchImpl,
    config: context.embeddingConfig || {},
    limit: args.limit,
    path: args.path,
    lexicalResults: context.lexicalResults,
    repoMapRank: context.repoMapRank
  });
  return formatSemanticSearch(result);
}
