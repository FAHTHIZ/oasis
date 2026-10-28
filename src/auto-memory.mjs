// Auto memory: durable notes the agent keeps across sessions.
//
// Ideas borrowed from two open-source projects:
// - OpenViking (volcengine/OpenViking): memory is a plain filesystem of Markdown
//   files grouped by category, with tiered loading. Each memory has a one-line
//   abstract (L0) that goes into the system prompt index, and a full body (L2)
//   that is read only when relevant.
// - agentmemory (rohitg00/agentmemory): BM25 recall of relevant memories for each
//   prompt under a token budget, secret and <private> redaction before anything
//   is written, deduplication by merging near-identical memories, and
//   strengthening memories that keep being recalled.
//
// Layout (all local, human-editable):
//   <config>/memory/user/<category>/<slug>.md        across all projects
//   <config>/memory/projects/<key>/<category>/<slug>.md  one workspace
//   each directory also gets MEMORY.md, a generated index of abstracts.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

export const MEMORY_CATEGORIES = ['preferences', 'project', 'decisions', 'lessons', 'people', 'reference'];
const MAX_MEMORIES = 500;
const MAX_BODY = 8000;
const INDEX_BUDGET_CHARS = 8000; // about 2000 tokens, the agentmemory default budget
const RECALL_BUDGET_CHARS = 4000;

export function autoMemoryEnabled(settings = {}, env = process.env) {
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_AUTO_MEMORY || ''))) return false;
  if (settings && settings.autoMemory === false) return false;
  return true;
}

export function memoryRoots(root, env = process.env) {
  const base = path.join(getConfigDirectory(env), 'memory');
  const key = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 20);
  return { user: path.join(base, 'user'), project: path.join(base, 'projects', key) };
}

// ---------- privacy ----------
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b((?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*)["']?[^\s"']{6,}/gi,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi
];

export function redactSecrets(text) {
  let out = String(text || '').replace(/<private>[\s\S]*?<\/private>/gi, '[private]');
  let redacted = out !== String(text || '');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => {
      redacted = true;
      return typeof prefix === 'string' && prefix && match.startsWith(prefix) ? prefix + '[redacted]' + (match.endsWith('@') ? '@' : '') : '[redacted]';
    });
  }
  return { text: out, redacted };
}

// ---------- files ----------
function slugify(name) {
  const slug = String(name || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'memory-' + Date.now().toString(36);
}

function oneLine(text, max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function serialize(memory) {
  const meta = {
    name: memory.name,
    description: memory.description,
    category: memory.category,
    created: memory.created,
    updated: memory.updated,
    recalls: memory.recalls || 0,
    ...(memory.lastRecalled ? { lastRecalled: memory.lastRecalled } : {}),
    ...(memory.source ? { source: memory.source } : {})
  };
  const header = Object.entries(meta).map(([key, value]) => key + ': ' + (typeof value === 'number' ? value : JSON.stringify(String(value)))).join('\n');
  return '---\n' + header + '\n---\n' + String(memory.content || '').trim() + '\n';
}

function parse(source, file, scope) {
  const match = String(source).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (match) {
    for (const line of match[1].split('\n')) {
      const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
      if (!kv) continue;
      let value = kv[2].trim();
      if (value.startsWith('"')) { try { value = JSON.parse(value); } catch {} }
      meta[kv[1]] = /^\d+$/.test(String(value)) && kv[1] === 'recalls' ? Number(value) : value;
    }
  }
  const content = (match ? match[2] : String(source)).trim();
  const category = MEMORY_CATEGORIES.includes(meta.category) ? meta.category : path.basename(path.dirname(file));
  return {
    name: meta.name || path.basename(file, '.md'),
    description: meta.description || oneLine(content, 160),
    category,
    created: meta.created || null,
    updated: meta.updated || meta.created || null,
    recalls: Number(meta.recalls) || 0,
    lastRecalled: meta.lastRecalled || null,
    source: meta.source || null,
    content,
    scope,
    file,
    id: scope + ':' + category + '/' + path.basename(file, '.md')
  };
}

export async function listMemories(root, { env = process.env, scope = null } = {}) {
  const roots = memoryRoots(root, env);
  const all = [];
  for (const [name, dir] of Object.entries(roots)) {
    if (scope && scope !== name) continue;
    for (const category of MEMORY_CATEGORIES) {
      let entries = [];
      try { entries = await readdir(path.join(dir, category)); } catch { continue; }
      for (const entry of entries.filter((item) => item.endsWith('.md')).sort()) {
        const file = path.join(dir, category, entry);
        try {
          const info = await stat(file);
          if (!info.isFile() || info.size > 64 * 1024) continue;
          all.push(parse(await readFile(file, 'utf8'), file, name));
        } catch {}
        if (all.length >= MAX_MEMORIES * 2) return all;
      }
    }
  }
  return all;
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

async function writeIndex(root, scope, env) {
  const dir = memoryRoots(root, env)[scope];
  const memories = await listMemories(root, { env, scope });
  if (!memories.length) { await rm(path.join(dir, 'MEMORY.md'), { force: true }).catch(() => {}); return; }
  const lines = ['# Oasis ' + scope + ' memory', '', 'Generated index. Edit or delete the files next to it; the index rebuilds on the next save.', ''];
  for (const category of MEMORY_CATEGORIES) {
    const group = memories.filter((memory) => memory.category === category);
    if (!group.length) continue;
    lines.push('## ' + category, '');
    for (const memory of group) lines.push('- [' + memory.name + '](' + category + '/' + path.basename(memory.file) + '): ' + memory.description);
    lines.push('');
  }
  await atomicWrite(path.join(dir, 'MEMORY.md'), lines.join('\n'));
}

// ---------- search (BM25) ----------
const STOP = new Set('a an and are as at be by for from has have i in is it its of on or that the this to was we were will with you your our not do does use using'.split(' '));

export function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map((word) => word.length > 4 ? word.replace(/(ing|ed|es|s)$/, '') : word);
}

export function rankMemories(memories, query, { limit = 5 } = {}) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !memories.length) return [];
  const docs = memories.map((memory) => {
    // Name and abstract count twice: they are the curated summary.
    const terms = tokenize(memory.name + ' ' + memory.description + ' ' + memory.name + ' ' + memory.description + ' ' + memory.content);
    const tf = new Map();
    for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
    return { memory, tf, length: terms.length };
  });
  const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const df = new Map(queryTerms.map((term) => [term, docs.filter((doc) => doc.tf.has(term)).length]));
  const k1 = 1.2;
  const b = 0.75;
  const now = Date.now();
  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of queryTerms) {
      const freq = doc.tf.get(term) || 0;
      if (!freq) continue;
      const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * doc.length / avg));
    }
    if (!score) return { memory: doc.memory, score: 0 };
    // Gentle boosts: recently updated and frequently recalled memories rank higher.
    const updated = Date.parse(doc.memory.updated || '') || 0;
    const ageDays = updated ? (now - updated) / 86400000 : 365;
    score *= 1 + 0.2 * Math.exp(-ageDays / 30) + Math.min(0.2, 0.02 * (doc.memory.recalls || 0));
    return { memory: doc.memory, score };
  });
  return scored.filter((item) => item.score > 0).sort((a, b2) => b2.score - a.score).slice(0, limit);
}

function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// ---------- write ----------
export async function saveMemory(root, input = {}, { env = process.env, source = null } = {}) {
  const scope = input.scope === 'user' ? 'user' : 'project';
  const category = MEMORY_CATEGORIES.includes(input.category) ? input.category : (scope === 'user' ? 'preferences' : 'project');
  const name = oneLine(redactSecrets(input.name).text, 80);
  const description = oneLine(redactSecrets(input.description || input.content).text, 200);
  const cleaned = redactSecrets(String(input.content || input.description || '').slice(0, MAX_BODY));
  if (!name) throw new Error('A memory needs a short name.');
  if (!cleaned.text.trim()) throw new Error('A memory needs content.');
  const existing = await listMemories(root, { env, scope });
  if (existing.length >= MAX_MEMORIES) throw new Error('This memory store has ' + MAX_MEMORIES + ' memories. Delete outdated ones first (oasis memory forget).');
  const now = new Date().toISOString();
  const slug = slugify(name);
  // Merge into an existing memory with the same name, or one that says nearly the same thing.
  let target = existing.find((memory) => path.basename(memory.file, '.md') === slug && memory.category === category)
    || existing.find((memory) => slugify(memory.name) === slug)
    || existing.find((memory) => similarity(memory.name + ' ' + memory.description, name + ' ' + description) >= 0.75);
  if (target) {
    const body = target.content.includes(cleaned.text.trim()) ? target.content
      : input.replace ? cleaned.text.trim()
      : similarity(target.content, cleaned.text) >= 0.85 ? cleaned.text.trim()
      : (target.content + '\n\n' + cleaned.text.trim()).slice(-MAX_BODY);
    if (body === target.content && (!input.description || description === target.description)) return { action: 'unchanged', id: target.id, file: target.file, redacted: cleaned.redacted };
    const merged = { ...target, description: input.description ? description : target.description, content: body, updated: now, source: source || target.source };
    await atomicWrite(target.file, serialize(merged));
    await writeIndex(root, scope, env);
    return { action: 'updated', id: target.id, file: target.file, redacted: cleaned.redacted };
  }
  const dir = path.join(memoryRoots(root, env)[scope], category);
  let file = path.join(dir, slug + '.md');
  for (let n = 2; await stat(file).then(() => true, () => false); n += 1) file = path.join(dir, slug + '-' + n + '.md');
  await atomicWrite(file, serialize({ name, description, category, created: now, updated: now, recalls: 0, source, content: cleaned.text }));
  await writeIndex(root, scope, env);
  return { action: 'created', id: scope + ':' + category + '/' + path.basename(file, '.md'), file, redacted: cleaned.redacted };
}

export async function findMemory(root, id, { env = process.env } = {}) {
  const memories = await listMemories(root, { env });
  const wanted = String(id || '').trim();
  return memories.find((memory) => memory.id === wanted)
    || memories.find((memory) => memory.id.endsWith(':' + wanted) || memory.id.endsWith('/' + wanted))
    || memories.find((memory) => memory.name.toLowerCase() === wanted.toLowerCase())
    || null;
}

export async function deleteMemory(root, id, { env = process.env } = {}) {
  const memory = await findMemory(root, id, { env });
  if (!memory) throw new Error('No memory matches ' + id + '. Use oasis memory list to see ids.');
  await rm(memory.file, { force: true });
  await writeIndex(root, memory.scope, env);
  return { deleted: memory.id, file: memory.file };
}

async function markRecalled(memories) {
  const now = new Date().toISOString();
  for (const memory of memories) {
    try { await atomicWrite(memory.file, serialize({ ...memory, recalls: (memory.recalls || 0) + 1, lastRecalled: now })); } catch {}
  }
}

// ---------- prompt integration ----------
// L0: the index of abstracts that goes into the system prompt.
export async function memoryIndexPrompt(root, { env = process.env, budget = INDEX_BUDGET_CHARS } = {}) {
  const memories = await listMemories(root, { env });
  const intro = [
    'Auto memory: you keep durable notes across sessions with memory_save, and look them up with memory_search.',
    'Save a memory when the user states a preference or corrects you, when a decision is made with a reason, when you learn a non-obvious fact about this project (how to build, test, deploy; where things live; gotchas), or when a fix only worked after several attempts (save the lesson). Use scope "user" for preferences that apply to every project.',
    'Do not save secrets, one-off task details, or facts that are obvious from the code. Update an existing memory instead of adding a near-duplicate. Memories can be outdated: verify against the code before relying on one, and fix or delete it when it is wrong.'
  ].join(' ');
  if (!memories.length) return intro + '\nNo memories saved yet.';
  const sorted = memories.slice().sort((a, b) => (b.scope === 'user') - (a.scope === 'user') || String(b.updated).localeCompare(String(a.updated)));
  const lines = [];
  let used = 0;
  let omitted = 0;
  for (const memory of sorted) {
    const line = '- ' + memory.id + ' (' + memory.name + '): ' + memory.description;
    if (used + line.length > budget) { omitted += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  return intro + '\nSaved memories (one-line abstracts; read the full note with memory_search or memory_read when relevant):\n' + lines.join('\n') + (omitted ? '\n(' + omitted + ' more not shown; search for them with memory_search)' : '');
}

// L2: full bodies of the few memories most relevant to this prompt.
export async function recallForPrompt(root, prompt, { env = process.env, limit = 3, budget = RECALL_BUDGET_CHARS, exclude = new Set() } = {}) {
  if (String(prompt || '').trim().length < 8) return { text: '', ids: [] };
  const memories = (await listMemories(root, { env })).filter((memory) => !exclude.has(memory.id));
  const ranked = rankMemories(memories, prompt, { limit: limit * 2 });
  if (!ranked.length) return { text: '', ids: [] };
  const top = ranked[0].score;
  const chosen = ranked.filter((item) => item.score >= Math.max(0.2, top * 0.45)).slice(0, limit);
  if (!chosen.length) return { text: '', ids: [] };
  const per = Math.floor(budget / chosen.length);
  const blocks = chosen.map(({ memory }) => '<memory id="' + memory.id + '" updated="' + String(memory.updated || '').slice(0, 10) + '">\n' + memory.name + ': ' + (memory.content.length > per ? memory.content.slice(0, per) + '\n[truncated; memory_read ' + memory.id + ' for the rest]' : memory.content) + '\n</memory>');
  await markRecalled(chosen.map((item) => item.memory));
  return { text: '<recalled-memories note="Saved notes that may be relevant. They can be outdated; check against the code.">\n' + blocks.join('\n') + '\n</recalled-memories>', ids: chosen.map((item) => item.memory.id) };
}

// ---------- tools ----------
export const MEMORY_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: 'Save or update a durable memory that later sessions will see (a preference, decision, project fact, or lesson). Near-duplicates are merged automatically; secrets are redacted. Use replace=true to rewrite a memory that is wrong.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short title, e.g. "Test command" or "Prefers tabs"' },
          description: { type: 'string', description: 'One-line abstract shown in every future system prompt' },
          content: { type: 'string', description: 'The full note: the fact, and why it matters or how to apply it' },
          category: { type: 'string', enum: MEMORY_CATEGORIES },
          scope: { type: 'string', enum: ['project', 'user'], description: 'project (default) or user for every project' },
          replace: { type: 'boolean', description: 'Replace the body instead of appending to it' }
        },
        required: ['name', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Search saved memories (keyword ranking) and return the best matches with their full text. Read-only.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_read',
      description: 'Read one memory by id (for example project:decisions/use-postgres) or name. Read-only.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: 'Delete a memory that is wrong or no longer useful.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
    }
  }
];

export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOL_DEFINITIONS.map((tool) => tool.function.name));

export async function runMemoryTool(name, args = {}, { root, env = process.env, session = null } = {}) {
  if (name === 'memory_save') {
    const saved = await saveMemory(root, args, { env, source: session && session.sessionId || null });
    return { ...saved, note: saved.redacted ? 'Secrets or <private> text were redacted before saving.' : undefined };
  }
  if (name === 'memory_search') {
    const ranked = rankMemories(await listMemories(root, { env }), args.query, { limit: Math.min(20, Number(args.limit) || 5) });
    return { results: ranked.map(({ memory, score }) => ({ id: memory.id, name: memory.name, description: memory.description, updated: memory.updated, score: Math.round(score * 100) / 100, content: memory.content.slice(0, 3000) })) };
  }
  if (name === 'memory_read') {
    const memory = await findMemory(root, args.id, { env });
    if (!memory) throw new Error('No memory matches ' + args.id + '.');
    return { id: memory.id, name: memory.name, description: memory.description, category: memory.category, updated: memory.updated, content: memory.content };
  }
  if (name === 'memory_delete') return await deleteMemory(root, args.id, { env });
  throw new Error('Unknown memory tool: ' + name);
}
