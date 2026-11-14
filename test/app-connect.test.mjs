// Smart connect, model fallback and plugins for the universal app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  detectKey, isGitHubToken, maskSecret, interpretURL, parsePaste, looksLikeConnection,
  rankModels, scoreModel, smartConnect, classifyFailure, buildChain, nextInChain, configFor, scanLocal
} from '../app/core/connect.mjs';
import { PLUGINS, getPlugin, pluginsFor, suggestPlugins } from '../app/core/plugins.mjs';
import { Agent, buildSystemPrompt } from '../app/core/agent.mjs';
import { ProviderError, chat } from '../app/core/providers.mjs';

const OR_KEY = 'sk-or-v1-' + 'a1'.repeat(32);
const ANT_KEY = 'sk-ant-api03-' + 'b2'.repeat(20);
const GEMINI_KEY = 'AIzaSy' + 'C3d4'.repeat(8);
const GEMINI_AUTH_KEY = 'AQ.' + 'AbCdEfGhIjKlMnOpQrStUvWxYz_-'.repeat(2);
const HF_KEY = 'hf_' + 'Ab1'.repeat(10);
const GH_TOKEN = 'ghp_' + 'Z9y8'.repeat(9);

test('detectKey recognises each provider by key shape', () => {
  assert.deepEqual(detectKey(OR_KEY), ['openrouter']);
  assert.deepEqual(detectKey(ANT_KEY), ['anthropic']);
  assert.deepEqual(detectKey(GEMINI_KEY), ['gemini']);
  assert.deepEqual(detectKey(GEMINI_AUTH_KEY), ['gemini']);
  assert.deepEqual(detectKey(HF_KEY), ['huggingface']);
  assert.deepEqual(detectKey('gsk_' + 'x1'.repeat(20)), ['groq']);
  assert.deepEqual(detectKey('xai-' + 'q7'.repeat(20)), ['xai']);
  assert.deepEqual(detectKey('nvapi-' + 'n0'.repeat(20)), ['nvidia']);
  assert.deepEqual(detectKey('sk-proj-' + 'p4'.repeat(20)), ['openai']);
  assert.equal(detectKey('sk-' + 'ab12'.repeat(8))[0], 'deepseek', 'DeepSeek keys are 32 hex characters');
  assert.deepEqual(detectKey('hello world'), []);
  assert.deepEqual(detectKey(''), []);
  assert.equal(isGitHubToken(GH_TOKEN), true);
  assert.equal(isGitHubToken('github_pat_' + 'A1_'.repeat(15)), true);
  assert.equal(isGitHubToken(OR_KEY), false);
});

test('maskSecret never shows enough of a key to use it', () => {
  const masked = maskSecret(OR_KEY);
  assert.ok(masked.length < 16);
  assert.ok(masked.endsWith(OR_KEY.slice(-4)));
  assert.ok(!masked.includes(OR_KEY.slice(8, 20)));
  assert.equal(maskSecret('short'), '•••');
});

test('interpretURL understands model pages and servers', () => {
  assert.deepEqual(interpretURL('https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct'), { kind: 'huggingface', model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', gguf: false });
  assert.equal(interpretURL('hf.co/unsloth/Qwen3-Coder-GGUF').gguf, true);
  assert.equal(interpretURL('https://huggingface.co/spaces/foo/bar').kind, 'endpoint');
  assert.deepEqual(interpretURL('https://ollama.com/library/qwen3-coder'), { kind: 'ollama-library', model: 'qwen3-coder' });
  assert.deepEqual(interpretURL('ollama.com/library/llama3.2/3b'), { kind: 'ollama-library', model: 'llama3.2:3b' });
  assert.deepEqual(interpretURL('https://openrouter.ai/qwen/qwen3-coder:free'), { kind: 'openrouter', model: 'qwen/qwen3-coder:free' });
  assert.deepEqual(interpretURL('localhost:11434'), { kind: 'endpoint', url: 'http://localhost:11434', local: true });
  assert.equal(interpretURL('http://192.168.1.20:1234/v1').local, true);
  assert.equal(interpretURL('https://api.example.com/v1').local, false);
  assert.equal(interpretURL('not a url'), null);
});

test('parsePaste splits keys, links, model names and the task', () => {
  const both = parsePaste('here is my key ' + OR_KEY + ' now fix the failing tests');
  assert.equal(both.keys[0].value, OR_KEY);
  assert.equal(both.rest, 'fix the failing tests');
  const model = parsePaste(OR_KEY + ' qwen/qwen3-coder');
  assert.deepEqual(model.models, ['qwen/qwen3-coder']);
  assert.equal(model.rest, '');
  assert.equal(parsePaste('ollama').local, true);
  assert.equal(parsePaste('use LM Studio').local, true);
  assert.deepEqual(parsePaste(GH_TOKEN).githubTokens, [GH_TOKEN]);
  assert.equal(parsePaste('"' + ANT_KEY + '"').keys[0].value, ANT_KEY, 'quotes around a pasted key are dropped');
  assert.equal(parsePaste(GEMINI_AUTH_KEY).keys[0].value, GEMINI_AUTH_KEY, 'AQ. keys do not need a numeric character to be parsed');
  assert.equal(looksLikeConnection(GEMINI_AUTH_KEY), true);
});

test('looksLikeConnection keeps ordinary tasks as tasks', () => {
  assert.equal(looksLikeConnection(OR_KEY), true);
  assert.equal(looksLikeConnection('http://localhost:11434'), true);
  assert.equal(looksLikeConnection('https://ollama.com/library/qwen3-coder'), true);
  assert.equal(looksLikeConnection(GH_TOKEN), true);
  assert.equal(looksLikeConnection('Summarise https://example.com/blog/post'), false);
  assert.equal(looksLikeConnection('https://example.com/blog/post'), false);
  assert.equal(looksLikeConnection('Fix the login bug'), false);
  assert.equal(looksLikeConnection('Run ollama for me and explain the logs'), false);
});

test('rankModels puts the strongest coding models first and drops non-chat models', () => {
  const ranked = rankModels([
    'text-embedding-3-large', 'whisper-1', 'dall-e-3', 'gpt-4o-mini', 'gpt-5.1', 'claude-haiku-4-5', 'claude-opus-4-5',
    'llama3.2:1b', 'qwen3-coder:30b', 'gemini-2.5-flash', 'gemini-3-pro-preview', 'models/gemini-embedding-001', 'omni-moderation-latest'
  ]);
  assert.ok(!ranked.some((id) => /embed|whisper|dall-e|moderation/.test(id)));
  assert.ok(ranked.indexOf('claude-opus-4-5') < ranked.indexOf('claude-haiku-4-5'));
  assert.ok(ranked.indexOf('gpt-5.1') < ranked.indexOf('gpt-4o-mini'));
  assert.ok(ranked.indexOf('qwen3-coder:30b') < ranked.indexOf('llama3.2:1b'));
  assert.equal(ranked[ranked.length - 1], 'llama3.2:1b', 'a 1B model is the last resort');
  assert.equal(scoreModel('nomic-embed-text'), -Infinity);
  assert.deepEqual(rankModels(['a/x-1', 'a/x-1', '']), ['a/x-1']);
});

/** A fake provider for smartConnect: routes by URL. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) {
        const out = await handler(url, options);
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out.body ?? out), { status: out.status || 200, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new TypeError('fetch failed');
  };
  return { fetchImpl, calls };
}
const toolReply = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'record_ok', arguments: '{"ok":true}' } }] } }] };
const textReply = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };

test('smartConnect: an OpenRouter key lands on the best model that passes the tool test', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [/openrouter\.ai\/api\/v1\/models$/, () => ({ data: [{ id: 'anthropic/claude-opus-4.5' }, { id: 'qwen/qwen3-coder:free' }, { id: 'openai/text-embedding-3-small' }] })],
    [/chat\/completions$/, (url, options) => {
      const body = JSON.parse(options.body);
      if (body.model === 'anthropic/claude-opus-4.5') return { status: 402, body: { error: { message: 'Insufficient credits' } } };
      return toolReply;
    }]
  ]);
  const steps = [];
  const result = await smartConnect(OR_KEY, { fetchImpl, onStatus: (s) => steps.push(s.step) });
  assert.equal(result.connection.provider, 'openrouter');
  assert.equal(result.model, 'qwen/qwen3-coder:free', 'skips the model the key cannot pay for');
  assert.equal(result.toolCalling, true);
  assert.deepEqual(result.connection.models, ['qwen/qwen3-coder:free', 'anthropic/claude-opus-4.5']);
  assert.ok(steps.includes('detect') && steps.includes('ready'));
  assert.ok(calls.every((call) => !call.options.headers || !JSON.stringify(call.url).includes(OR_KEY)), 'the key goes in headers, never the URL');
});

test('smartConnect: a shared sk- prefix tries the providers in order', async () => {
  const key = 'sk-' + 'ab12'.repeat(8);
  const { fetchImpl } = fakeFetch([
    [/api\.deepseek\.com.*\/models$/, () => ({ status: 401, body: { error: { message: 'Authentication Fails' } } })],
    [/moonshot.*\/models$/, () => ({ data: [{ id: 'kimi-k2-turbo-preview' }, { id: 'kimi-k2-0905-preview' }] })],
    [/moonshot.*chat\/completions$/, () => toolReply]
  ]);
  const result = await smartConnect(key, { fetchImpl });
  assert.equal(result.connection.provider, 'moonshot');
});

test('smartConnect: a wrong key gives a plain answer', async () => {
  const { fetchImpl } = fakeFetch([[/models(\?|$)/, () => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } })]]);
  await assert.rejects(smartConnect(ANT_KEY, { fetchImpl }), (error) => error instanceof ProviderError && /did not accept|accepted this key/i.test(error.message) && error.status === 401);
});

test('smartConnect: a local server address is probed and a model without tool calls is still usable', async () => {
  const { fetchImpl } = fakeFetch([
    [/:11434\/api\/tags$/, () => ({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen3-coder:30b' }, { name: 'nomic-embed-text:latest' }] })],
    [/:11434\/v1\/chat\/completions$/, () => textReply]
  ]);
  const result = await smartConnect('http://localhost:11434', { fetchImpl, tries: 2 });
  assert.equal(result.connection.provider, 'ollama');
  assert.equal(result.connection.local, true);
  assert.equal(result.connection.baseURL, 'http://localhost:11434/v1');
  assert.equal(result.model, 'qwen3-coder:30b');
  assert.equal(result.toolCalling, false);
  assert.match(result.notes[0], /did not call tools/);
  assert.ok(!result.connection.models.includes('nomic-embed-text:latest'));
});

test('smartConnect: an Ollama library link downloads the model when missing', async () => {
  let pulled = false;
  const { fetchImpl } = fakeFetch([
    [/:11434\/api\/tags$/, () => ({ models: pulled ? [{ name: 'qwen3-coder:latest' }] : [] })],
    [/:11434\/api\/pull$/, () => { pulled = true; return new Response('{"status":"pulling","total":100,"completed":50}\n{"status":"success","total":100,"completed":100}\n'); }],
    [/:11434\/v1\/chat\/completions$/, () => toolReply]
  ]);
  const progress = [];
  const result = await smartConnect('https://ollama.com/library/qwen3-coder', { fetchImpl, onStatus: (s) => progress.push(s.text) });
  assert.equal(pulled, true);
  assert.equal(result.model, 'qwen3-coder:latest');
  assert.ok(progress.some((line) => /50%/.test(line)));
});

test('smartConnect: a Hugging Face link uses a stored hf_ token through the router', async () => {
  const { fetchImpl } = fakeFetch([
    [/localhost:11434|127\.0\.0\.1:11434/, () => { throw new TypeError('fetch failed'); }],
    [/router\.huggingface\.co\/v1\/models$/, () => ({ data: [{ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' }, { id: 'meta-llama/Llama-3.1-8B-Instruct' }] })],
    [/router\.huggingface\.co\/v1\/chat\/completions$/, () => toolReply]
  ]);
  const known = [{ provider: 'huggingface', apiKey: HF_KEY }];
  const result = await smartConnect('https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct', { fetchImpl, known });
  assert.equal(result.connection.provider, 'huggingface');
  assert.equal(result.model, 'meta-llama/Llama-3.1-8B-Instruct', 'the pasted model wins over the ranking');
  await assert.rejects(smartConnect('https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct', { fetchImpl }), /Hugging Face token/);
});

test('smartConnect: only a GitHub token is not a model', async () => {
  await assert.rejects(smartConnect(GH_TOKEN, { fetchImpl: async () => { throw new Error('no network'); } }), /GITHUB_ONLY/);
});

test('scanLocal finds running servers quietly', async () => {
  const { fetchImpl } = fakeFetch([
    [/localhost:11434\/api\/tags$/, () => ({ models: [{ name: 'qwen3:8b' }] })],
    [/localhost:1234\/v1\/models$/, () => ({ data: [{ id: 'qwen2.5-coder-7b-instruct' }] })]
  ]);
  const found = await scanLocal({ fetchImpl });
  assert.deepEqual(found.map((c) => c.provider).sort(), ['lmstudio', 'ollama']);
  assert.deepEqual(await scanLocal({ fetchImpl: async () => { throw new TypeError('down'); } }), []);
});

test('classifyFailure tells credit, rate, auth and model failures apart', () => {
  assert.equal(classifyFailure(new ProviderError('Insufficient credits', { status: 402 })), 'credits');
  assert.equal(classifyFailure(new ProviderError('You exceeded your current quota', { status: 429 })), 'credits');
  assert.equal(classifyFailure(new ProviderError('Rate limit reached', { status: 429 })), 'rate');
  assert.equal(classifyFailure(new ProviderError('bad key', { status: 401 })), 'auth');
  assert.equal(classifyFailure(new ProviderError('No endpoints found that support tool use', { status: 404 })), 'model');
  assert.equal(classifyFailure(new ProviderError('prompt is too long: 250000 tokens', { status: 400 })), 'context');
  assert.equal(classifyFailure(new ProviderError('upstream error', { status: 503 })), 'server');
  assert.equal(classifyFailure(new TypeError('Failed to fetch')), 'network');
  const aborted = new Error('aborted'); aborted.name = 'AbortError';
  assert.equal(classifyFailure(aborted), 'other');
  assert.equal(classifyFailure(new ProviderError('weird', { status: 418 })), 'other');
});

test('buildChain and nextInChain switch to the next best model, free ones first on credit errors', () => {
  const or = { id: 'or', provider: 'openrouter', label: 'OpenRouter', models: ['anthropic/claude-opus-4.5', 'openai/gpt-5.1', 'qwen/qwen3-coder:free'] };
  const local = { id: 'ol', provider: 'ollama', label: 'Ollama', local: true, models: ['qwen3-coder:30b'] };
  const settings = { connections: [or, local], activeConnection: 'or', activeModel: 'anthropic/claude-opus-4.5', autoSwitch: true };
  const chain = buildChain(settings);
  assert.deepEqual(chain.map((e) => e.model), ['anthropic/claude-opus-4.5', 'openai/gpt-5.1', 'qwen/qwen3-coder:free', 'qwen3-coder:30b']);
  const current = { connection: or, model: 'anthropic/claude-opus-4.5' };
  assert.equal(nextInChain(chain, current, new ProviderError('rate limited', { status: 429 })).model, 'openai/gpt-5.1');
  const credit = nextInChain(chain, current, new ProviderError('Insufficient credits', { status: 402 }));
  assert.equal(credit.model, 'qwen/qwen3-coder:free');
  assert.equal(credit.kind, 'credits');
  assert.equal(nextInChain(chain, current, new ProviderError('bad key', { status: 401 })).model, 'qwen3-coder:30b', 'a rejected key skips the rest of that provider');
  assert.equal(nextInChain(chain, current, new ProviderError('teapot', { status: 418 })), null);
  const failed = { 'or|openai/gpt-5.1': Date.now() };
  assert.equal(nextInChain(buildChain(settings, { failed }), current, new ProviderError('rate', { status: 429 }), { failed }).model, 'qwen/qwen3-coder:free', 'recently failed models are skipped');
  assert.deepEqual(buildChain({ ...settings, autoSwitch: false }).map((e) => e.model), ['anthropic/claude-opus-4.5']);
  assert.deepEqual(buildChain({ connections: [] }), []);
  const config = configFor(chain[0], { mode: 'auto' });
  assert.equal(config.connectionId, 'or');
  assert.equal(config.mode, 'auto');
});

test('agent switches models mid-task without losing the conversation', async () => {
  const seen = [];
  const chatImpl = async (config, request) => {
    seen.push({ model: config.model, messages: request.messages.length });
    if (config.model === 'big') throw new ProviderError('Insufficient credits', { status: 402 });
    return { content: 'Answer from ' + config.model, tool_calls: [], usage: { input: 1, output: 1 } };
  };
  const events = [];
  const failures = [];
  const agent = new Agent({
    getConfig: () => ({ model: 'big', connectionId: 'c', mode: 'ask' }),
    getContext: () => ({}),
    approve: async () => true,
    onEvent: (e) => events.push(e),
    chatImpl,
    onModelFailure: (error, config) => { failures.push([config.model, classifyFailure(error)]); return { ...config, model: 'small' }; }
  });
  assert.equal(await agent.send('hi'), 'Answer from small');
  assert.deepEqual(failures, [['big', 'credits']]);
  const sw = events.find((e) => e.type === 'model_switch');
  assert.deepEqual([sw.from, sw.to], ['big', 'small']);
  assert.equal(seen[0].messages, seen[1].messages, 'the same conversation is resent to the new model');
  // No fallback configured: the error reaches the caller.
  const plain = new Agent({ getConfig: () => ({ model: 'big' }), getContext: () => ({}), approve: async () => true, chatImpl });
  await assert.rejects(plain.send('hi'), /Insufficient credits/);
  // A fallback that loops back to a model already tried stops instead of spinning.
  const loop = new Agent({ getConfig: () => ({ model: 'big', connectionId: 'c' }), getContext: () => ({}), approve: async () => true, chatImpl, onModelFailure: (error, config) => ({ ...config }) });
  await assert.rejects(loop.send('hi'), /Insufficient credits/);
});

test('plugins: every plugin points at real skills and has starters', () => {
  assert.equal(PLUGINS.length, 9, "a short, curated catalog");
  const ids = new Set();
  for (const plugin of PLUGINS) {
    assert.ok(!ids.has(plugin.id), 'unique id ' + plugin.id);
    ids.add(plugin.id);
    assert.ok(plugin.name && plugin.description && plugin.icon);
    assert.ok(plugin.starters.length >= 1);
    for (const skill of plugin.skills) assert.ok(existsSync(new URL('../skills/' + skill + '/SKILL.md', import.meta.url)), plugin.id + ' -> ' + skill);
  }
  assert.equal(getPlugin('debug').name, 'Debugger');
  assert.equal(getPlugin('nope'), null);
  assert.deepEqual(pluginsFor(['web', 'debug', 'x']).map((p) => p.id), ['debug', 'web']);
});

test('plugins: suggestions follow what the user types', () => {
  assert.equal(suggestPlugins('the login page crashes with a TypeError')[0].id, 'debug');
  assert.ok(suggestPlugins('build a landing page with tailwind').some((p) => p.id === 'web'));
  assert.ok(suggestPlugins('write unit tests with vitest').some((p) => p.id === 'tests'));
  assert.ok(suggestPlugins('check for XSS and SQL injection').some((p) => p.id === 'security'));
  assert.deepEqual(suggestPlugins('hi'), []);
  assert.ok(!suggestPlugins('the app crashes', { active: ['debug'] }).some((p) => p.id === 'debug'), 'active plugins are not suggested again');
  assert.ok(suggestPlugins('x'.repeat(5000) + ' bug').length <= 2);
});

test('plugins load their skills into the system prompt', async () => {
  const skills = { load: async (name) => ({ name, body: 'BODY OF ' + name }), promptSection: async () => '' };
  const prompt = await buildSystemPrompt({ skills, plugins: pluginsFor(['debug']) });
  assert.match(prompt, /Active plugins: Debugger/);
  assert.match(prompt, /BODY OF debugging/);
  assert.match(prompt, /BODY OF diagnose/);
  const none = await buildSystemPrompt({ skills, plugins: [] });
  assert.doesNotMatch(none, /Active plugins/);
});


test('smartConnect accepts a Google AQ. authorization key through Gemini OpenAI compatibility', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [/generativelanguage\.googleapis\.com\/v1beta\/openai\/models$/, () => ({ data: [{ id: 'gemini-3.8-flash' }] })],
    [/generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/, () => toolReply]
  ]);
  const result = await smartConnect(GEMINI_AUTH_KEY, { fetchImpl });
  assert.equal(result.connection.provider, 'gemini');
  assert.equal(result.connection.apiKey, GEMINI_AUTH_KEY);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.options.headers.authorization === 'Bearer ' + GEMINI_AUTH_KEY));
});

test('OpenRouter retries an oversized credit reservation with a safe output cap and remembers it', async () => {
  const requests = [];
  const fetchImpl = async (_url, options = {}) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: 'This request requires more credits. You requested up to 4096 tokens, but can only afford 675.',
          metadata: { limit_source: 'openrouter_credits', remedy_hint: 'Lower max_tokens.' }
        }
      }), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const config = { provider: 'openrouter', protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free', apiKey: 'test', connectionId: 'openrouter-credit-retry-test' };
  const first = await chat(config, { messages: [{ role: 'user', content: 'hello' }], fetchImpl });
  assert.equal(first.content, 'ok');
  assert.equal(requests[0].max_tokens, 4096);
  assert.equal(requests[1].max_tokens, 512);
  const second = await chat(config, { messages: [{ role: 'user', content: 'again' }], fetchImpl });
  assert.equal(second.content, 'ok');
  assert.equal(requests[2].max_tokens, 512);
});

test('OpenRouter 402 explains credits instead of blaming the API key', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    error: {
      message: 'You requested up to 4096 tokens, but can only afford 32.',
      metadata: { limit_source: 'openrouter_credits' }
    }
  }), { status: 402, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    chat({ provider: 'openrouter', protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder', apiKey: 'test', connectionId: 'openrouter-credit-too-low-test' },
      { messages: [{ role: 'user', content: 'hello' }], fetchImpl }),
    (error) => error.status === 402 && /not an invalid API key/i.test(error.message) && /32 output tokens/i.test(error.message)
  );
});

// A free-tier Gemini key, as seen live on 2026-11-05: the Pro models have no
// quota (429, limit 0), the older ones are retired (404 naming a successor),
// the newest Flash is busy (503), and the working Flash models think before
// answering, so a 64-token probe comes back empty.
function freeTierGemini({ hang = '' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/models')) {
      return json(200, { data: ['gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-4-pro', 'gemini-3.8-flash', 'gemini-3.8-live', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'].map((id) => ({ id: 'models/' + id })) });
    }
    const body = JSON.parse(options.body);
    calls.push([body.model, body.max_tokens]);
    if (body.model === hang) {
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    if (/^gemini-2\.5/.test(body.model)) return json(404, [{ error: { code: 404, message: 'This model models/' + body.model + ' is no longer available to new users. Please update your code to use models/gemini-3.6-flash for the latest features and improvements.' } }]);
    if (/pro/.test(body.model)) return json(429, [{ error: { code: 429, message: 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0' } }]);
    if (body.model === 'gemini-3.8-flash') return json(503, [{ error: { code: 503, message: 'This model is currently experiencing high demand. Please try again later.' } }]);
    if ((body.max_tokens || 0) < 1000) return json(200, { choices: [{ finish_reason: 'length', message: { role: 'assistant' } }] });
    return json(200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'record_ok', arguments: '{"ok":true}' } }] } }] });
  };
  return { fetchImpl, calls };
}

test('smartConnect gets past quota-less, retired and busy models on a free Gemini key', async () => {
  const { fetchImpl, calls } = freeTierGemini();
  const result = await smartConnect(GEMINI_AUTH_KEY, { fetchImpl, retryDelayMs: 1 });
  assert.equal(result.model, 'gemini-3.6-flash', 'the retired model named its successor, which is tried next');
  assert.equal(result.toolCalling, true, 'an empty 64-token answer from a thinking model is retried with room to think');
  assert.ok(calls.some(([model, limit]) => model === 'gemini-3.6-flash' && limit >= 1000));
  assert.ok(!calls.some(([model]) => model === 'gemini-3.8-live'), 'live models are not chat models');
  assert.ok(result.unusable.includes('gemini-2.5-pro') && result.unusable.includes('gemini-4-pro'));
  const { runtimeConfigFromConnection } = await import('../src/provider-connect.mjs');
  const config = runtimeConfigFromConnection(result);
  assert.equal(config.model, 'gemini-3.6-flash');
  for (const dead of result.unusable) {
    assert.ok(!config.fallbackModel.split(',').includes(dead), dead + ' has no quota or is retired, so it is not a backup');
  }
});

test('a model that never answers is timed out instead of stalling setup', async () => {
  const { fetchImpl } = freeTierGemini({ hang: 'gemini-3.8-flash' });
  const { testProvider } = await import('../app/core/providers.mjs');
  await assert.rejects(testProvider({ protocol: 'openai', baseURL: 'https://x/v1', model: 'gemini-3.8-flash', apiKey: 'k', maxRetries: 0 }, fetchImpl, { timeoutMs: 30 }), (error) => error.status === 504 && error.timedOut === true && classifyFailure(error) === 'server');
});

test('suggestedModel reads the replacement a provider names, and nothing else', async () => {
  const { suggestedModel } = await import('../app/core/connect.mjs');
  assert.equal(suggestedModel('This model models/gemini-2.5-pro is no longer available. Please update your code to use models/gemini-3.1-pro-preview for the latest features'), 'gemini-3.1-pro-preview');
  assert.equal(suggestedModel('The model was decommissioned; use llama-3.3-70b-versatile instead.'), 'llama-3.3-70b-versatile');
  assert.equal(suggestedModel('Spikes in demand are usually temporary. Please try again later.'), '');
});

test('when every model fails, the error lists each one and a next step', async () => {
  const fetchImpl = async (url) => String(url).endsWith('/models')
    ? new Response(JSON.stringify({ data: [{ id: 'gemini-4-pro' }, { id: 'gemini-3.1-pro' }] }), { status: 200 })
    : new Response(JSON.stringify({ error: { message: 'You exceeded your current quota, limit: 0' } }), { status: 429 });
  await assert.rejects(smartConnect(GEMINI_AUTH_KEY, { fetchImpl, retryDelayMs: 1 }), (error) => /2 tried/.test(error.message) && /gemini-4-pro/.test(error.message) && /gemini-3\.1-pro/.test(error.message) && /quota/.test(error.message) && error.status === 402);
});

test('smartConnect: OmniRoute guarding /api/tags with 401 still connects with the pasted key', async () => {
  const key = 'sk-' + 'a1b2c3d4'.repeat(4);
  const { fetchImpl } = fakeFetch([
    [/:20128\/api\/tags$/, () => ({ status: 401, body: { error: { message: 'Authentication required' } } })],
    [/:20128\/v1\/models$/, (url, options) => (JSON.stringify(options.headers || {}).includes(key)
      ? { data: [{ id: 'dva/claude-fable-5-1-high' }, { id: 'dva/claude-fable-5-1-low' }, { id: 'dva/claude-fable-5-1-max' }, { id: 'aug/fable-5' }, { id: 'llm7/codestral-latest' }] }
      : { status: 401, body: { error: { message: 'Authentication required' } } })],
    [/:20128\/v1\/chat\/completions$/, (url, options) => {
      const body = JSON.parse(options.body);
      if (body.model.startsWith('dva/')) return { status: 503, body: { error: { message: '[503]: Devin agentic bridge is not configured' } } };
      if (body.model.startsWith('aug/')) return { status: 401, body: { error: { message: 'no credentials for auggie' } } };
      return toolReply;
    }]
  ]);
  const steps = [];
  const result = await smartConnect('http://localhost:20128/v1 ' + key, { fetchImpl, retryDelayMs: 0, onStatus: (s) => steps.push(s.text) });
  assert.equal(result.connection.provider, 'omniroute');
  assert.equal(result.connection.local, false, 'a localhost gateway forwards to the cloud');
  assert.equal(result.model, 'llm7/codestral-latest');
  assert.equal(steps.filter((s) => /^Testing dva\//.test(s)).length, 1, 'one failure rules out the whole unconnected upstream');
  assert.ok(['dva/claude-fable-5-1-low', 'dva/claude-fable-5-1-max', 'aug/fable-5'].every((id) => result.unusable.includes(id)));
  const { runtimeConfigFromConnection } = await import('../src/provider-connect.mjs');
  assert.equal(runtimeConfigFromConnection(result).fallbackModel, '', 'dead upstreams never become backups');
});

test('smartConnect: a pasted FreeLLMAPI key connects to the local gateway, timed as cloud', async () => {
  const key = 'freellmapi-' + 'a1b2c3d4'.repeat(6);
  assert.deepEqual(detectKey(key), ['freellmapi']);
  const { fetchImpl, calls } = fakeFetch([
    [/:3001\/v1\/models$/, (url, options) => (JSON.stringify(options.headers || {}).includes(key)
      ? { data: [{ id: 'auto', owned_by: 'freellmapi' }, { id: 'llama-3.3-70b', owned_by: 'freellmapi' }] }
      : { status: 401, body: { error: { message: 'Invalid API key' } } })],
    [/:3001\/v1\/chat\/completions$/, () => toolReply]
  ]);
  const result = await smartConnect(key, { fetchImpl, retryDelayMs: 0 });
  assert.equal(result.connection.provider, 'freellmapi');
  assert.equal(result.connection.baseURL, 'http://localhost:3001/v1');
  assert.equal(result.connection.local, false, 'a localhost gateway forwards to the cloud');
  assert.ok(calls.every((c) => /:3001\//.test(c.url)), 'the key is only sent to the gateway');
});

test('smartConnect: FreeLLMAPI alias slots and models it cannot serve do not become the main model or backups', async () => {
  const key = 'freellmapi-' + 'a1b2c3d4'.repeat(6);
  const tools = ['temperature', 'max_tokens', 'tools', 'tool_choice'];
  // The shape FreeLLMAPI's /v1/models returned on 14 November 2026.
  const models = [
    { id: 'claude-opus-4-5', owned_by: 'freellmapi', name: 'Opus slot (auto-routed to a free model)', available: true, unavailable_reason: null },
    { id: 'claude-sonnet-4-5', owned_by: 'freellmapi', name: 'Sonnet slot (auto-routed to a free model)', available: true, unavailable_reason: null },
    { id: 'gpt-5.6-luna', owned_by: 'freellmapi', name: 'GPT-5.6 Luna', available: false, unavailable_reason: 'no_key', execution_status: 'needsKey', supported_parameters: tools },
    { id: 'qwen3.8-max', owned_by: 'freellmapi', name: 'Qwen3.8 Max', available: false, unavailable_reason: 'no_key', execution_status: 'needsKey', supported_parameters: tools },
    { id: 'gpt-oss-120b', owned_by: 'freellmapi', name: 'GPT Oss 120B', available: true, execution_status: 'exhausted', supported_parameters: tools },
    { id: 'qwen3.5-397b', owned_by: 'freellmapi', name: 'Qwen3.5 397B', available: true, execution_status: 'ready', supported_parameters: tools },
    { id: 'llama-3.3-70b', owned_by: 'freellmapi', name: 'Llama 3.3 70B', available: true, execution_status: 'ready', supported_parameters: tools }
  ];
  const tested = [];
  const { fetchImpl } = fakeFetch([
    [/:3001\/v1\/models$/, () => ({ data: models })],
    [/:3001\/v1\/chat\/completions$/, (url, options) => { tested.push(JSON.parse(options.body).model); return toolReply; }]
  ]);
  const result = await smartConnect('http://localhost:3001/v1 ' + key, { fetchImpl, retryDelayMs: 0 });
  assert.equal(result.model, 'qwen3.5-397b', 'a named, available model beats an alias slot named after a model it is not');
  assert.ok(!result.connection.models.includes('gpt-5.6-luna') && !result.connection.models.includes('qwen3.8-max'), 'models with no upstream key are dropped');
  const order = result.connection.models;
  assert.ok(order.indexOf('llama-3.3-70b') < order.indexOf('gpt-oss-120b'), 'a used-up free tier goes behind ready models');
  assert.ok(order.indexOf('gpt-oss-120b') < order.indexOf('claude-opus-4-5'), 'alias slots go last');
  assert.ok(!tested.includes('gpt-5.6-luna') && !tested.includes('qwen3.8-max'));
  const { runtimeConfigFromConnection } = await import('../src/provider-connect.mjs');
  const backups = runtimeConfigFromConnection(result).fallbackModel.split(',').filter(Boolean);
  assert.ok(!backups.some((id) => ['gpt-5.6-luna', 'qwen3.8-max'].includes(id)), 'unservable models never become backups: ' + backups);
});

test('smartConnect: a rejected key at an address says so instead of asking for a key', async () => {
  const key = 'sk-' + 'a1b2c3d4'.repeat(4);
  const { fetchImpl } = fakeFetch([[/:20128\//, () => ({ status: 401, body: { error: { message: 'Invalid API key' } } })]]);
  await assert.rejects(smartConnect('http://localhost:20128/v1 ' + key, { fetchImpl }), (error) => /did not accept that key/.test(error.message));
  await assert.rejects(smartConnect('http://localhost:20128/v1', { fetchImpl }), (error) => /needs an API key/.test(error.message));
});

test('scoreModel: a digit in a provider prefix is not a model version', () => {
  assert.equal(scoreModel('llm7/codestral-latest'), scoreModel('codestral-latest'));
  assert.equal(scoreModel('01-ai/yi-large'), scoreModel('yi-large'));
});

test('runtimeConfigFromConnection: gateway backups prefer the chosen upstream', async () => {
  const { runtimeConfigFromConnection } = await import('../src/provider-connect.mjs');
  const config = runtimeConfigFromConnection({ model: 'llm7/codestral-latest', connection: { provider: 'omniroute', protocol: 'openai', baseURL: 'http://localhost:20128/v1', models: ['llm7/codestral-latest', 'cfp/glm', 'llm7/gpt-oss:20b'] } });
  assert.equal(config.fallbackModel, 'llm7/gpt-oss:20b,cfp/glm');
});

// Real run, 9 Nov 2026: `oasis connect https://api.llm7.io/v1` listed 61 models
// without a key, tried a paid "pro" model first, got 401 and gave up.
test('smartConnect: a keyless server skips models it marks as paid and keeps going after a per-model 401', async () => {
  const tried = [];
  const { fetchImpl } = fakeFetch([
    [/llm\.example\/v1\/models$/, () => ({ data: [
      { id: 'claude-opus-9', tier: 'pro', usage_based_only: true, tools_calling: true },
      { id: 'gpt-5.9', tier: 'pro', tools_calling: true },
      { id: 'mistral-small-3', tier: 'turbo', tools_calling: false },
      { id: 'gpt-oss:20b', tier: 'turbo', tools_calling: true },
      { id: 'codestral-latest', tier: 'turbo', tools_calling: true }
    ] })],
    [/chat\/completions$/, (url, options) => {
      const body = JSON.parse(options.body);
      tried.push(body.model);
      if (body.model === 'claude-opus-9' || body.model === 'gpt-5.9') return { status: 401, body: { error: { message: 'Missing API key.' } } };
      return toolReply;
    }]
  ]);
  const result = await smartConnect('https://llm.example/v1', { fetchImpl });
  assert.equal(result.toolCalling, true);
  assert.ok(['gpt-oss:20b', 'codestral-latest'].includes(result.model), result.model);
  assert.ok(!tried.includes('claude-opus-9') && !tried.includes('gpt-5.9'), 'paid models are not probed first: ' + tried.join(','));
  const { runtimeConfigFromConnection } = await import('../src/provider-connect.mjs');
  const config = runtimeConfigFromConnection(result);
  assert.equal(config.keyless, true);
  for (const id of config.fallbackModel.split(',')) assert.ok(!['claude-opus-9', 'gpt-5.9', 'mistral-small-3'].includes(id), 'no paid or tool-less backups: ' + config.fallbackModel);
});

test('smartConnect: a keyless server where every model needs a key says to paste one', async () => {
  const { fetchImpl } = fakeFetch([
    [/locked\.example\/v1\/models$/, () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] })],
    [/chat\/completions$/, () => ({ status: 401, body: { error: { message: 'Missing API key.' } } })]
  ]);
  await assert.rejects(smartConnect('https://locked.example/v1', { fetchImpl }), (error) => error instanceof ProviderError && /needs an API key to use them/.test(error.message) && error.status === 401);
});

test('smartConnect: a local thinking model too slow to finish says so instead of "busy"', async () => {
  const fetchImpl = async (url, options = {}) => {
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/\/api\/tags$/.test(String(url))) return json({ models: [{ name: 'qwen3:4b' }] });
    if (/\/v1\/models$/.test(String(url))) return json({ data: [{ id: 'qwen3:4b' }] });
    if (/\/api\/show$/.test(String(url))) return json({});
    const body = JSON.parse(options.body);
    if ((body.max_tokens || 0) < 1000) return json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning: 'Okay, let me think' } }] });
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  };
  await assert.rejects(smartConnect('http://localhost:11434', { fetchImpl, tries: 1, probeTimeoutMs: 50 }), (error) => /hidden thinking/.test(error.message) && !/busy/.test(error.message));
});
