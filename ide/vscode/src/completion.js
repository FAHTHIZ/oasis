// Inline (tab) completions for the editor: ghost text from the model you set up for OASIS.
// No VS Code APIs here, so it is testable with plain Node.
//
// - Ollama: native fill-in-the-middle through /api/generate with `suffix`
//   (qwen2.5-coder, codestral, deepseek-coder and starcoder2 all support it).
// - Other OpenAI-compatible servers: /chat/completions with a "return only the inserted code" prompt.
// - Anthropic: /v1/messages with the same prompt.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_PREFIX = 6000;
const MAX_SUFFIX = 2000;
const MAX_INSERT = 1200;

function configDirectory(env = process.env, home = os.homedir()) {
  if (env.OASIS_CONFIG_DIR) return path.resolve(env.OASIS_CONFIG_DIR);
  const base = env.OASIS_HOME ? path.resolve(env.OASIS_HOME)
    : process.platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'oasis')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'oasis');
  let profile = String(env.OASIS_PROFILE || '').trim();
  if (!profile && env.OASIS_PROFILE === undefined) {
    try { profile = fs.readFileSync(path.join(base, 'active-profile'), 'utf8').trim(); } catch { profile = ''; }
  }
  if (!profile || profile === 'default' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(profile)) return base;
  return path.join(base, 'profiles', profile);
}

function readOasisConfig(env = process.env, home = os.homedir()) {
  try { return JSON.parse(fs.readFileSync(path.join(configDirectory(env, home), 'config.json'), 'utf8')) || {}; } catch { return {}; }
}

function isOllama(baseURL) {
  try {
    const url = new URL(baseURL);
    return url.port === '11434' || /ollama/i.test(url.hostname);
  } catch { return false; }
}

/**
 * Which endpoint and model to use. VS Code settings win; otherwise the OASIS config is used,
 * so completions work with no extra setup.
 */
function resolveCompletionTarget(settings = {}, config = {}, env = process.env) {
  const baseURL = String(settings.baseUrl || config.baseURL || env.OPENAI_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
  const protocol = settings.protocol || (settings.baseUrl ? (isOllama(baseURL) ? 'ollama' : 'openai-compatible') : config.protocol === 'anthropic' ? 'anthropic' : isOllama(baseURL) ? 'ollama' : 'openai-compatible');
  const model = String(settings.model || config.completionModel || config.model || '').trim();
  const apiKey = settings.apiKey || (settings.baseUrl ? '' : config.apiKey) || (protocol === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) || '';
  return { protocol, baseURL, model, apiKey };
}

function clip(prefix, suffix) {
  return { prefix: String(prefix || '').slice(-MAX_PREFIX), suffix: String(suffix || '').slice(0, MAX_SUFFIX) };
}

function chatPrompt({ prefix, suffix, languageId, relativePath }) {
  return [
    'Complete the code at <CURSOR> in ' + (relativePath || 'this file') + (languageId ? ' (' + languageId + ')' : '') + '.',
    'Reply with only the text to insert at <CURSOR>: no explanation, no code fence, and do not repeat the code before or after it.',
    'If nothing useful fits, reply with nothing.',
    '',
    prefix + '<CURSOR>' + suffix
  ].join('\n');
}

function stripFence(text) {
  const match = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match ? match[1] : text;
}

/**
 * Tidy what the model returned: drop fences, text it repeated from before or after the
 * cursor, and anything past a blank line when the cursor is mid-line.
 */
function cleanCompletion(raw, { prefix = '', suffix = '' } = {}) {
  let text = stripFence(String(raw || '').replace(/\r\n/g, '\n'));
  text = text.replace(/<\|[a-z_]+\|>/gi, '').replace(/<CURSOR>/g, '');
  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lastLine.trim() && text.startsWith(lastLine)) text = text.slice(lastLine.length);
  const nextText = suffix.trimStart();
  if (nextText) {
    const probe = nextText.slice(0, 40);
    const at = probe.length >= 8 ? text.indexOf(probe) : -1;
    if (at >= 0) text = text.slice(0, at);
  }
  const restOfLine = suffix.slice(0, suffix.indexOf('\n') < 0 ? suffix.length : suffix.indexOf('\n'));
  // Text after the cursor on this line: suggest one line, ending it only if the model did.
  let endsLine = false;
  if (restOfLine.trim()) { endsLine = text.includes('\n') && !prefix.slice(prefix.lastIndexOf('\n') + 1).trim(); text = text.split('\n')[0]; }
  else {
    const blank = text.search(/\n[ \t]*\n/);
    if (blank > 0) text = text.slice(0, blank);
  }
  text = text.replace(/\s+$/, '');
  if (!text.trim()) return '';
  if (endsLine) text += '\n';
  return text.slice(0, MAX_INSERT);
}

async function postJson(fetchImpl, url, headers, body, signal) {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error('Completion request failed with HTTP ' + response.status + (detail ? ': ' + detail.slice(0, 160) : ''));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Ask the model for the text to insert at the cursor. Returns '' when there is nothing to suggest. */
async function requestCompletion(target, context, { fetchImpl = globalThis.fetch, signal, maxTokens = 128 } = {}) {
  if (!target.model) throw new Error('No model is set for completions. Run `oasis setup`, or set oasis.completions.model.');
  const { prefix, suffix } = clip(context.prefix, context.suffix);
  const ctx = { ...context, prefix, suffix };
  let raw = '';
  if (target.protocol === 'ollama') {
    const origin = target.baseURL.replace(/\/v1$/, '');
    const data = await postJson(fetchImpl, origin + '/api/generate', target.apiKey ? { authorization: 'Bearer ' + target.apiKey } : {}, {
      model: target.model, prompt: prefix, suffix, stream: false, keep_alive: '30m',
      options: { num_predict: maxTokens, temperature: 0.1, top_p: 0.9, stop: ['\n\n\n', '<|endoftext|>', '<|file_sep|>'] }
    }, signal);
    raw = data.response || '';
  } else if (target.protocol === 'anthropic') {
    const data = await postJson(fetchImpl, target.baseURL.replace(/\/v1$/, '') + '/v1/messages', { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: target.model, max_tokens: maxTokens, temperature: 0.1, messages: [{ role: 'user', content: chatPrompt(ctx) }]
    }, signal);
    raw = (data.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
  } else {
    const data = await postJson(fetchImpl, target.baseURL + '/chat/completions', target.apiKey ? { authorization: 'Bearer ' + target.apiKey } : {}, {
      model: target.model, max_tokens: maxTokens, temperature: 0.1, stream: false,
      messages: [{ role: 'system', content: 'You are a code completion engine. Output only code.' }, { role: 'user', content: chatPrompt(ctx) }]
    }, signal);
    raw = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : '';
  }
  return cleanCompletion(raw, ctx);
}

/** Skip requests where a suggestion is unlikely to help (inside a word, empty file, after a comment marker). */
function shouldSuggest({ prefix = '', suffix = '' } = {}) {
  if (!prefix.trim()) return false;
  const restOfLine = suffix.slice(0, suffix.indexOf('\n') < 0 ? suffix.length : suffix.indexOf('\n'));
  if (/^[A-Za-z0-9_]/.test(restOfLine)) return false;
  return true;
}

module.exports = { resolveCompletionTarget, readOasisConfig, requestCompletion, cleanCompletion, shouldSuggest };
