// Within-turn context protection for coding sessions.
import { catalogContextWindow } from './model-catalog.mjs';
import { createHash } from 'node:crypto';
import { countTextTokens } from './tokens.mjs';
// Token estimates use a real BPE vocabulary (src/tokens.mjs); exact counts for a
// specific model are only known once its provider reports usage. Set
// OASIS_CONTEXT_WINDOW to the selected model's real limit.
const DEFAULT_CONTEXT_WINDOW = 32_768;
const MAX_CONTEXT_WINDOW = 2_000_000;
const MIN_PRUNABLE_CHARS = 600;

function validWindow(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 4_000 && parsed <= MAX_CONTEXT_WINDOW ? parsed : null;
}

const IMAGE_TOKENS = 1600;

// Estimated input tokens for one image: Anthropic's documented 28x28-pixel patch
// count, capped at the standard tier's ~1600. Provider-reported usage replaces
// this estimate once a response arrives.
export function imageTokenEstimate(image) {
  const width = Number(image && image.width);
  const height = Number(image && image.height);
  if (!(width > 0 && height > 0)) return IMAGE_TOKENS;
  return Math.max(1, Math.min(IMAGE_TOKENS, Math.ceil(width / 28) * Math.ceil(height / 28)));
}

// Counting a message is cached on the message object. Messages are replaced, not
// edited, when their content changes, and the cache also checks the fields it
// counted, so long histories are not re-tokenized on every step.
const messageTokenCache = new WeakMap();

function messageTokens(message) {
  const cached = messageTokenCache.get(message);
  if (cached && cached.content === message.content && cached.toolCalls === message.tool_calls && cached.responseItems === message.responseItems && cached.images === message.images) return cached.tokens;
  let tokens = 0;
  // Responses API output items may contain reasoning/tool metadata not represented in content.
  if (Array.isArray(message.responseItems)) {
    try { tokens = countTextTokens(JSON.stringify(message.responseItems)); }
    catch { tokens = countTextTokens(String(message.content || '')); }
  } else {
    if (Array.isArray(message.images)) for (const image of message.images) tokens += imageTokenEstimate(image);
    if (typeof message.content === 'string') tokens += countTextTokens(message.content);
    else if (Array.isArray(message.content)) {
      try { tokens += countTextTokens(JSON.stringify(message.content)); }
      catch { /* Ignore content that cannot be represented safely. */ }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        tokens += countTextTokens(String(call && call.function && call.function.name || ''));
        tokens += countTextTokens(String(call && call.function && call.function.arguments || ''));
      }
    }
  }
  messageTokenCache.set(message, { content: message.content, toolCalls: message.tool_calls, responseItems: message.responseItems, images: message.images, tokens });
  return tokens;
}

// An upper bound on estimateTokens without the tokenizer: every o200k token
// covers at least one UTF-8 byte, so a text has at most as many tokens as bytes.
// Images use the same estimate as messageTokens.
export function tokenUpperBound(messages) {
  let bytes = 0;
  const size = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (Array.isArray(message.responseItems)) {
      try { bytes += size(JSON.stringify(message.responseItems)); } catch { bytes += size(message.content || ''); }
      continue;
    }
    if (Array.isArray(message.images)) for (const image of message.images) bytes += imageTokenEstimate(image);
    if (typeof message.content === 'string') bytes += size(message.content);
    else if (Array.isArray(message.content)) { try { bytes += size(JSON.stringify(message.content)); } catch { /* not counted by messageTokens either */ } }
    if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) bytes += size(call && call.function && call.function.name || '') + size(call && call.function && call.function.arguments || '');
  }
  return bytes;
}

export function estimateTokens(messages) {
  let tokens = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    tokens += messageTokens(message);
  }
  return tokens;
}

// Remember the provider's own input-token count for the prompt that was just
// sent: the first sentLength messages (plus system prompt and tool schemas).
// Estimated usage (providers that report none) is never recorded.
export function recordContextAnchor(session, usage, sentLength, sentLast) {
  if (!session || !usage || usage.estimated) return;
  const inputTokens = Number(usage.inputTokens) || 0;
  if (inputTokens <= 0 || !Number.isInteger(sentLength) || sentLength < 1) return;
  session.contextAnchor = { inputTokens, length: sentLength, last: sentLast };
}

// Tokens the conversation occupies in the model's window. When the provider has
// reported usage for a prefix of the current history, that exact count is used and
// only the messages added since are estimated; otherwise the whole history is
// estimated. Compaction or rewinds that replace the prefix invalidate the anchor.
export function contextTokens(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  const anchor = session && session.contextAnchor;
  if (anchor && anchor.length <= messages.length && messages[anchor.length - 1] === anchor.last) {
    return { tokens: anchor.inputTokens + estimateTokens(messages.slice(anchor.length)), reported: true };
  }
  return { tokens: estimateTokens(messages), reported: false };
}

// Context windows come from the models.dev catalog (src/model-catalog.mjs), matched
// by provider (from baseURL) and model id, router prefixes and date suffixes
// included. Unknown and local models keep the conservative 32K default; set
// contextWindow in the provider config or OASIS_CONTEXT_WINDOW to override.
export function modelContextWindow(model, config = {}, env = process.env) {
  if (!model) return null;
  return catalogContextWindow(model, { baseURL: config && config.baseURL, provider: config && config.catalogProvider, env });
}

export function contextWindowSize(config = {}, env = process.env) {
  return validWindow(config.contextWindow) ||
    validWindow(env && env.OASIS_CONTEXT_WINDOW) ||
    modelContextWindow(config.model, config, env) ||
    DEFAULT_CONTEXT_WINDOW;
}

// History compaction threshold in characters. The default 32K window keeps the
// original 60,000-character trigger; larger windows compact at about 60% full.
export function compactionThresholdChars(config = {}, env = process.env) {
  const explicit = Number.parseInt(config.compactThresholdChars ?? (env && env.OASIS_COMPACT_THRESHOLD_CHARS), 10);
  if (Number.isInteger(explicit) && explicit >= 10_000 && explicit <= 8_000_000) return explicit;
  const windowTokens = contextWindowSize(config, env);
  // /autocompact PCT, or Claude Code's CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1-100).
  const pct = Number(config.autoCompactPercent ?? (env && (env.OASIS_AUTOCOMPACT_PCT || env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)));
  if (config.autoCompactPercent === 0 || (config.autoCompactPercent === undefined && env && String(env.OASIS_AUTOCOMPACT_PCT || '') === '0')) return 8_000_000;
  if (Number.isFinite(pct) && pct >= 1 && pct <= 100) return Math.max(10_000, Math.floor(windowTokens * 4 * pct / 100));
  // Windows smaller than the default (typically local models) compact at about
  // 45% full: tool schemas and the reply share the rest of the window.
  if (windowTokens < DEFAULT_CONTEXT_WINDOW) return Math.max(10_000, Math.floor(windowTokens * 4 * 0.45));
  if (windowTokens <= DEFAULT_CONTEXT_WINDOW) return 60_000;
  return Math.floor(windowTokens * 4 * 0.6);
}

function stubFor(message) {
  const size = typeof message.content === 'string' ? message.content.length : 0;
  return '[Older tool output compacted to protect context (' + String(message.name || 'tool').slice(0, 80) +
    ', ' + size + ' characters). Re-run the tool if the details are needed again.]';
}

/**
 * Replace old bulky tool outputs with explicit re-fetch instructions while preserving
 * message order and every assistant tool-call/tool-result pairing. Never mutates input.
 * Only runs after the estimate exceeds triggerRatio of the configured context window.
 */
export function microcompact(messages, options = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
  const windowTokens = validWindow(options.windowTokens) || DEFAULT_CONTEXT_WINDOW;
  const triggerRatio = Number.isFinite(options.triggerRatio) ? options.triggerRatio : 0.5;
  const targetRatio = Number.isFinite(options.targetRatio) ? options.targetRatio : 0.35;
  const keepRecentTokens = Math.max(0, Number.isFinite(options.keepRecentTokens)
    ? options.keepRecentTokens
    : Math.floor(windowTokens * 0.15));
  // The byte bound settles the common case (well under the trigger) without
  // the tokenizer; before/after are then counted only if a caller reads them.
  if (tokenUpperBound(messages) <= windowTokens * triggerRatio) {
    let counted;
    const count = () => (counted === undefined ? (counted = estimateTokens(messages)) : counted);
    return { messages, pruned: 0, get before() { return count(); }, get after() { return count(); } };
  }
  const before = estimateTokens(messages);
  if (before <= windowTokens * triggerRatio) {
    return { messages, pruned: 0, before, after: before };
  }

  let protectedFrom = messages.length;
  let recent = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    recent += estimateTokens([messages[i]]);
    protectedFrom = i;
    if (recent >= keepRecentTokens) break;
  }

  const output = messages.slice();
  let current = before;
  let pruned = 0;
  for (let i = 1; i < protectedFrom && current > windowTokens * targetRatio; i++) {
    const message = output[i];
    if (!message || message.role !== 'tool' || typeof message.content !== 'string') continue;
    if (message.name === 'todo_write' || message.content.length < MIN_PRUNABLE_CHARS ||
        message.content.startsWith('[Older tool output compacted')) continue;
    const stub = stubFor(message);
    current -= Math.max(0, countTextTokens(message.content) - countTextTokens(stub));
    output[i] = { ...message, content: stub };
    pruned++;
  }
  return { messages: output, pruned, before, after: Math.max(0, current) };
}


/**
 * Observation masking (Lindenbauer et al., "The Complexity Trap", arXiv
 * 2508.21433): tool outputs from more than `keepTurns` assistant turns ago are
 * replaced by re-run stubs, whatever the context size. Masking happens in
 * batches of `batch` outputs so the cached prompt prefix is invalidated once
 * per batch instead of on every turn. Never mutates input.
 */
export function maskObservations(messages, { keepTurns = 10, batch = 4 } = {}) {
  if (!Array.isArray(messages) || !(keepTurns > 0)) return { messages, masked: 0 };
  let turns = 0;
  let boundary = messages.length;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i] && messages[i].role === 'assistant' && ++turns >= keepTurns) { boundary = i; break; }
  }
  if (turns < keepTurns) return { messages, masked: 0 };
  const candidates = [];
  for (let i = 1; i < boundary; i++) {
    const message = messages[i];
    if (!message || message.role !== 'tool' || typeof message.content !== 'string') continue;
    if (message.name === 'todo_write' || message.content.length < MIN_PRUNABLE_CHARS ||
        message.content.startsWith('[Older tool output compacted')) continue;
    candidates.push(i);
  }
  if (candidates.length < Math.max(1, batch)) return { messages, masked: 0 };
  const output = messages.slice();
  for (const i of candidates) output[i] = { ...output[i], content: stubFor(output[i]) };
  return { messages: output, masked: candidates.length };
}

const MUST_PRESERVE_KINDS = new Set(['rule', 'goal', 'plan', 'path', 'constraint', 'error', 'verification']);
const MAX_MUST_PRESERVE_ITEMS = 20;
const MAX_MUST_PRESERVE_TEXT = 600;
const MAX_MUST_PRESERVE_TOTAL = 8000;

export function sanitizeMustPreserve(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const kind = MUST_PRESERVE_KINDS.has(String(item.kind || '').toLowerCase()) ? String(item.kind).toLowerCase() : 'rule';
    const text = String(item.text || '').trim().slice(0, MAX_MUST_PRESERVE_TEXT);
    if (!text) continue;
    const key = kind + '\0' + text.toLowerCase();
    if (out.some((entry) => entry.kind + '\0' + entry.text.toLowerCase() === key)) continue;
    if (out.length >= MAX_MUST_PRESERVE_ITEMS || total + text.length > MAX_MUST_PRESERVE_TOTAL) break;
    out.push({ kind, text });
    total += text.length;
  }
  return out;
}

export function addMustPreserve(session, kind, text) {
  if (!session || typeof session !== 'object') throw new TypeError('An active session is required.');
  const normalizedKind = MUST_PRESERVE_KINDS.has(String(kind || '').toLowerCase()) ? String(kind).toLowerCase() : 'rule';
  const normalizedText = String(text || '').trim();
  if (!normalizedText) throw new Error('Preserved context cannot be empty.');
  // Cutting the text would keep a rule without its end; say so instead.
  if (normalizedText.length > MAX_MUST_PRESERVE_TEXT) throw new Error('Preserved context is ' + normalizedText.length + ' characters; the limit is ' + MAX_MUST_PRESERVE_TEXT + '. Shorten it or split it into separate records.');
  const current = sanitizeMustPreserve(session.mustPreserve);
  const entry = { kind: normalizedKind, text: normalizedText.slice(0, MAX_MUST_PRESERVE_TEXT) };
  const next = sanitizeMustPreserve([...current, entry]);
  if (next.length === current.length && !next.some((item) => item.kind === entry.kind && item.text === entry.text)) {
    throw new Error('Must-preserve limit reached. Remove an old item before adding another.');
  }
  session.mustPreserve = next;
  return next;
}

function previewSafeText(value) {
  return String(value || '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 220);
}

function compactionFingerprint(messages) {
  // An in-memory freshness guard, not a storage or authenticity mechanism.
  const stable = (Array.isArray(messages) ? messages : []).map((message) => ({
    role: String(message && message.role || ''),
    name: String(message && message.name || ''),
    content: typeof (message && message.content) === 'string'
      ? message.content
      : message && message.content == null ? null : JSON.stringify(message.content),
    toolCalls: Array.isArray(message && message.tool_calls) ? message.tool_calls.map((call) => ({
      id: String(call && call.id || ''),
      name: String(call && call.function && call.function.name || ''),
      arguments: String(call && call.function && call.function.arguments || '')
    })) : [],
    responseItems: Array.isArray(message && message.responseItems) ? JSON.stringify(message.responseItems) : ''
  }));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function compactionPreviewIsCurrent(session, preview) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  return Boolean(preview && typeof preview.fingerprint === 'string' &&
    preview.messageCount === messages.length &&
    preview.fingerprint === compactionFingerprint(messages));
}

const PREVIEW_PATH = /(?<![\w./@:-])((?:\.?[\w-]+\/)*\.?[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w/-])/g;
const PREVIEW_BARE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'cs', 'php', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'json', 'yaml', 'yml', 'toml', 'md', 'html', 'css', 'scss', 'vue', 'svelte', 'sh', 'sql']);

export function createCompactionPreview(session, focus = '') {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  const history = messages.slice(1);
  const byRole = { user: 0, assistant: 0, tool: 0, other: 0 };
  const large = [];
  const paths = new Set();
  let errors = 0;
  let checks = 0;
  for (let i = 0; i < history.length; i++) {
    const message = history[i] || {};
    if (Object.prototype.hasOwnProperty.call(byRole, message.role)) byRole[message.role]++;
    else byRole.other++;
    const text = typeof message.content === 'string' ? message.content : '';
    const tokens = estimateTokens([message]);
    if (tokens > 500) large.push({ index: i + 2, role: String(message.role || 'unknown'), name: String(message.name || ''), tokens, preview: previewSafeText(text) });
    if (/\b(error|failed|exception|timed out|not found)\b/i.test(text)) errors++;
    if (/\b(test|type.?check|lint|build|diagnostic|verification)\b/i.test(text)) checks++;
    // Oasis's own reminders (open follow-ups, memory) are not paths the
    // conversation worked on. Dot-folders keep their dot (.oasis/x.json), and
    // a bare file name counts when its extension is a common source/doc one.
    const spoken = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
    for (const match of spoken.matchAll(PREVIEW_PATH)) {
      const found = match[1];
      if (!found.includes('/') && !PREVIEW_BARE_EXTENSIONS.has(found.slice(found.lastIndexOf('.') + 1).toLowerCase())) continue;
      if (paths.size < 30) paths.add(found);
    }
  }
  const mustPreserve = sanitizeMustPreserve(session && session.mustPreserve);
  const systemTokens = estimateTokens(messages.slice(0, 1));
  return {
    focus: String(focus || '').trim().slice(0, 1000),
    messageCount: messages.length,
    fingerprint: compactionFingerprint(messages),
    beforeTokens: estimateTokens(messages),
    systemTokens,
    historyMessages: history.length,
    summarizedMessages: history.length,
    retainedMessagesAfterCompaction: messages.length ? 3 : 0,
    byRole,
    largestMessages: large.sort((a, b) => b.tokens - a.tokens).slice(0, 5),
    recentPaths: [...paths].slice(-12),
    errorOrFailureMessages: errors,
    verificationRelatedMessages: checks,
    mustPreserve,
    note: 'Manual compaction summarizes all non-system messages into one digest. This preview is an estimate; the model-generated digest cannot be known in advance.'
  };
}


export function mustPreserveContextBlock(items) {
  const records = sanitizeMustPreserve(items);
  if (!records.length) return '';
  return '\n\nMUST-PRESERVE USER RECORDS (retain explicitly and verbatim unless contradictory or unsafe):\n' +
    records.map((item) => '[' + item.kind + '] ' + item.text).join('\n');
}

// sanitizeMustPreserve already bounds the records (20 items, 8000 characters),
// so neither the summary nor the records are cut here. Both used to be: a
// summary past ~12,000 characters lost its tail (often the next steps) as
// soon as any must-preserve record existed, and the block itself was cut at
// 8,000 characters including labels, clipping the last record.
export function appendMustPreserveContext(summary, items) {
  return String(summary || '') + mustPreserveContextBlock(items);
}
