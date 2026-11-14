#!/usr/bin/env node
// Logging gateway for live benchmarks: every agent talks to this local
// OpenAI-compatible endpoint, which forces one upstream model, spaces requests
// to stay inside a rate limit, and appends one JSON line per request (time,
// status, prompt/completion tokens) so reported usage can be checked against
// what was actually sent.
//
//   node scripts/bench-gateway.mjs --upstream https://text.pollinations.ai/openai \
//     --model openai --min-interval-ms 20000 --log /tmp/gateway.jsonl
//
// Then: npm run bench:live -- --router http://127.0.0.1:8788/v1 --model bench-model --yes
// The upstream key, if any, comes from OASIS_GATEWAY_UPSTREAM_KEY and is never logged.
//
// Same-model runs: `npm run bench:live -- --upstream https://openrouter.ai/api/v1
// --model ID` starts this gateway itself. Each agent gets its own path
// (/a/<agent>/v1), the gateway relays OpenAI chat completions, Anthropic
// Messages and OpenAI Responses calls, forces the one model on all of them,
// and records the model and provider the upstream says actually served each
// call, so the summary can verify the comparison instead of assuming it.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { appendFile } from 'node:fs/promises';
import { redactSecretText } from '../src/secret-shield.mjs';
import { fileURLToPath } from 'node:url';

export function parseGatewayArgs(argv) {
  const options = { upstream: '', model: '', port: 8788, host: '127.0.0.1', minIntervalMs: 0, log: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined || next.startsWith('--')) throw new Error(arg + ' needs a value.'); return next; };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--upstream') options.upstream = value().replace(/\/+$/, '');
    else if (arg === '--model') options.model = value();
    else if (arg === '--port') options.port = Number(value());
    else if (arg === '--min-interval-ms') options.minIntervalMs = Number(value());
    else if (arg === '--log') options.log = value();
    else throw new Error('Unknown option ' + arg + '.');
  }
  if (options.help) return options;
  let url;
  try { url = new URL(options.upstream); } catch { throw new Error('--upstream must be an HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--upstream must be an HTTP(S) URL.');
  if (!options.model.trim()) throw new Error('--model is required.');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port must be 0-65535.');
  if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) throw new Error('--min-interval-ms must be 0 or more.');
  return options;
}

/** Chat-completions URL for an upstream given either as a base (`.../v1`) or as the full endpoint. */
export function completionsUrl(upstream) {
  if (/\/chat\/completions$/.test(upstream)) return upstream;
  if (/\/v1$/.test(upstream)) return upstream + '/chat/completions';
  return upstream;
}

/** Usage from a JSON body or an SSE stream (last chunk that carries `usage`). */
export function usageFrom(text) {
  const pick = (object) => object && object.usage && typeof object.usage === 'object' ? object.usage : null;
  try { const found = pick(JSON.parse(text)); if (found) return found; } catch {}
  let usage = null;
  for (const line of String(text).split('\n')) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    try { usage = pick(JSON.parse(data)) || usage; } catch {}
  }
  return usage;
}

/** Pulls served model, provider and usage out of a JSON body or an SSE stream. */
export function inspectResponse(text) {
  const out = { servedModel: '', provider: '', usage: null, events: 0 };
  const take = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    out.events++;
    const holder = obj.response && typeof obj.response === 'object' ? obj.response : obj.message && typeof obj.message === 'object' ? obj.message : obj;
    if (!out.servedModel && typeof holder.model === 'string') out.servedModel = holder.model;
    if (!out.servedModel && typeof obj.modelVersion === 'string') out.servedModel = obj.modelVersion;
    if (!out.provider && typeof obj.provider === 'string') out.provider = obj.provider;
    const usage = holder.usage || obj.usage || obj.usageMetadata;
    if (usage && typeof usage === 'object') out.usage = { ...(out.usage || {}), ...usage };
  };
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { const parsed = JSON.parse(trimmed); (Array.isArray(parsed) ? parsed : [parsed]).forEach(take); return out; } catch {}
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { take(JSON.parse(data)); } catch {}
  }
  return out;
}

// Opens a CONNECT tunnel through an http:// or https:// proxy (credentials in
// the URL's userinfo) and returns the TLS socket to the target.
function tunnel(proxyUrl, target) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const raw = proxy.protocol === 'https:' ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname }) : net.connect({ host: proxy.hostname, port });
    const auth = proxy.username ? 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') + '\r\n' : '';
    const hostPort = target.hostname + ':' + (Number(target.port) || 443);
    raw.once('error', reject);
    raw.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => raw.write('CONNECT ' + hostPort + ' HTTP/1.1\r\nHost: ' + hostPort + '\r\n' + auth + '\r\n'));
    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) { if (head.length > 16384) reject(new Error('proxy CONNECT reply too large')); return; }
      raw.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(head)) { raw.destroy(); reject(new Error('proxy refused CONNECT: ' + head.split('\r\n')[0])); return; }
      const secure = tls.connect({ socket: raw, servername: target.hostname });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    };
    raw.on('data', onData);
  });
}

/**
 * fetch() that honours HTTPS_PROXY. Node's built-in fetch ignores proxy
 * variables, so behind a corporate or credential-injecting proxy the upstream
 * call would go out directly (and unauthenticated). Plain fetch is used when no
 * proxy is configured or for NO_PROXY hosts.
 */
export function proxyAwareFetch(env = process.env) {
  const proxyUrl = env.HTTPS_PROXY || env.https_proxy || '';
  const noProxy = String(env.NO_PROXY || env.no_proxy || '').split(',').map((h) => h.trim().replace(/^\./, '')).filter(Boolean);
  return async (url, init = {}) => {
    const target = new URL(url);
    if (!proxyUrl || target.protocol !== 'https:' || noProxy.some((h) => h === '*' || target.hostname === h || target.hostname.endsWith('.' + h))) return fetch(url, init);
    const socket = await tunnel(proxyUrl, target);
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: target.hostname, port: target.port || 443, path: target.pathname + target.search, method: init.method || 'GET', headers: init.headers || {}, createConnection: () => socket }, (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const v of [].concat(value)) headers.append(name, v);
        const empty = [101, 204, 205, 304].includes(res.statusCode) || init.method === 'HEAD';
        resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers }));
      });
      req.once('error', reject);
      if (init.signal) init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      if (init.body !== undefined && init.body !== null) req.write(init.body);
      req.end();
    });
  };
}

// Endpoints relayed to the upstream, relative to its /v1 base.
const RELAYED = /^\/(chat\/completions|messages|messages\/count_tokens|responses)$/;
const FORWARDED_HEADERS = ['accept', 'anthropic-version', 'anthropic-beta', 'openai-beta'];

/** Upstream URL for a relayed /v1 path: the configured endpoint for chat completions, else base + path. */
export function upstreamUrl(upstream, rest) {
  if (rest === '/chat/completions') return completionsUrl(upstream);
  const base = upstream.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
  return base + '/v1' + rest;
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

export function createGateway(options, { fetchImpl = proxyAwareFetch(), now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let chain = Promise.resolve();
  let lastEnd = 0;
  let count = 0;
  // Logging never fails a request; it is awaited before the reply ends so a
  // client that has its reply can read the matching log line.
  const log = async (entry) => { if (options.records) options.records.push(entry); if (options.log) await appendFile(options.log, JSON.stringify(entry) + '\n').catch(() => {}); };
  // One request at a time, and at least minIntervalMs from the end of the
  // previous reply to the next request: Pollinations counts its "1 reply every
  // 45 seconds" window from the reply, so spacing request starts was not
  // enough (a 5 s reply plus 47 s spacing got HTTP 402 "Retry after 43s").
  const slot = () => {
    let release;
    const finished = new Promise((resolve) => { release = resolve; });
    const turn = chain.then(async () => {
      const gap = lastEnd + options.minIntervalMs - now();
      if (lastEnd && gap > 0) await wait(gap);
    });
    chain = turn.then(() => finished).catch(() => {});
    return turn.then(() => () => { lastEnd = now(); release(); });
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    // /a/<agent>/v1/... tags the call with the agent that made it.
    const tagged = /^\/a\/([A-Za-z0-9_.-]+)(\/.*)?$/.exec(url.pathname);
    const agent = tagged ? tagged[1] : null;
    const pathname = tagged ? (tagged[2] || '/') : url.pathname;
    const rest = pathname.replace(/^\/v1(?=\/)/, '');
    // The gateway spends the upstream key for whoever reaches it. Browsers send
    // Origin on cross-site POSTs (a text/plain POST needs no preflight), and a
    // DNS-rebinding page arrives with its own Host, so refuse both.
    if (req.headers.origin || (LOOPBACK_HOST.test(options.host || '127.0.0.1') && !LOOPBACK_HOST.test(String(req.headers.host || '')))) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Browser and non-local requests are refused.' } }));
      return;
    }
    if (req.method === 'GET' && /\/models$/.test(pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'bench-model', object: 'model', owned_by: 'gateway' }] }));
      return;
    }
    if (req.method !== 'POST' || !RELAYED.test(rest)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Only POST /v1/chat/completions, /v1/messages, /v1/responses and GET /v1/models are served.' } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Request body is not JSON.' } }));
      return;
    }
    const id = ++count;
    const requestedModel = body.model;
    body.model = options.model;
    const release = await slot();
    const started = now();
    const headers = { 'content-type': 'application/json' };
    for (const name of FORWARDED_HEADERS) if (req.headers[name]) headers[name] = String(req.headers[name]);
    const key = process.env.OASIS_GATEWAY_UPSTREAM_KEY;
    if (key) { headers.authorization = 'Bearer ' + key; if (rest.startsWith('/messages')) headers['x-api-key'] = key; }
    try {
      const upstream = await fetchImpl(upstreamUrl(options.upstream, rest), { method: 'POST', headers, body: JSON.stringify(body) });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      let text = '';
      const decoder = new TextDecoder();
      if (upstream.body) for await (const chunk of upstream.body) { if (text.length < 8 * 1024 * 1024) text += decoder.decode(chunk, { stream: true }); res.write(chunk); }
      const seen = inspectResponse(text);
      const usage = seen.usage || {};
      const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? null;
      const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? null;
      await log({ id, agent, endpoint: rest, at: new Date(started).toISOString(), ms: now() - started, status: upstream.status, requestedModel, sentModel: options.model, servedModel: seen.servedModel || null, provider: seen.provider || null, stream: Boolean(body.stream), messages: Array.isArray(body.messages) ? body.messages.length : Array.isArray(body.input) ? body.input.length : null, tools: Array.isArray(body.tools) ? body.tools.length : 0, promptTokens, completionTokens, ...messageSizes(body), error: upstream.status >= 400 ? redactSecretText(text.slice(0, 2000)).slice(0, 300) : undefined, ...(quotaExhausted(upstream.status, upstream.headers, text) ? { quotaExhausted: true } : {}) });
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      await log({ id, agent, endpoint: rest, at: new Date(started).toISOString(), ms: now() - started, status: 502, requestedModel, sentModel: options.model, error: redactSecretText(String(error.message)) });
      res.end(JSON.stringify({ error: { message: 'Gateway could not reach the upstream: ' + error.message } }));
    } finally {
      release();
    }
  });
}

/** Starts a gateway on a free loopback port; records are also kept in memory. */
/**
 * Sizes, never contents: the largest message and the newest one, in characters, so a run can show
 * what grew an agent's prompt (a big file read, test output carried for many turns).
 */
export function messageSizes(body) {
  const list = Array.isArray(body && body.messages) ? body.messages : Array.isArray(body && body.input) ? body.input : null;
  if (!list || !list.length) return {};
  const size = (item) => { const c = item && (item.content ?? item.output ?? item.arguments); return typeof c === 'string' ? c.length : c ? JSON.stringify(c).length : 0; };
  // Which tool a result came from: names only, never arguments or output.
  const names = new Map();
  for (const item of list) {
    if (!item) continue;
    for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) if (call && call.id) names.set(call.id, call.function && call.function.name);
    if (item.type === 'function_call' && item.call_id) names.set(item.call_id, item.name);
    for (const block of Array.isArray(item.content) ? item.content : []) if (block && block.type === 'tool_use' && block.id) names.set(block.id, block.name);
  }
  const toolOf = (item) => {
    if (!item) return undefined;
    const id = item.tool_call_id || (item.type === 'function_call_output' ? item.call_id : undefined);
    if (id) return names.get(id) || undefined;
    const used = (Array.isArray(item.content) ? item.content : []).filter((block) => block && block.type === 'tool_result').map((block) => names.get(block.tool_use_id)).filter(Boolean);
    return used.length ? [...new Set(used)].join(',') : undefined;
  };
  const describe = (item, chars) => { const tool = toolOf(item); return { role: item && (item.role || item.type) || null, chars, ...(tool ? { tool } : {}) }; };
  let largest = { role: null, chars: -1 };
  let largestItem = null;
  for (const item of list) { const chars = size(item); if (chars > largest.chars) { largest = { chars }; largestItem = item; } }
  const last = list[list.length - 1];
  return { largestMessage: describe(largestItem, largest.chars), lastMessage: describe(last, size(last)) };
}

/**
 * A 429 that will not clear by retrying: the provider says so (x-should-retry: false, as Kilo
 * sends) or names a used-up quota. Every later trial would fail the same way, so the run stops.
 */
export function quotaExhausted(status, headers, text = '') {
  if (status !== 429) return false;
  const header = headers && typeof headers.get === 'function' ? headers.get('x-should-retry') : headers && headers['x-should-retry'];
  return String(header || '').toLowerCase() === 'false' || /LIMIT_REACHED|insufficient_quota|quota (?:exceeded|exhausted)|daily limit/i.test(String(text).slice(0, 4000));
}

export async function startGateway(options, deps) {
  const records = [];
  const server = createGateway({ host: '127.0.0.1', minIntervalMs: 0, ...options, records }, deps);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + server.address().port;
  return { url, records, agentUrl: (agent) => url + '/a/' + agent + '/v1', close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/** Per-agent view of the gateway record: calls, failures, models served, providers, tokens; and whether one model served everyone. */
export function gatewayReport(records) {
  const agents = {};
  for (const r of records) {
    const a = agents[r.agent || 'untagged'] ||= { calls: 0, errors: 0, servedModels: {}, providers: {}, inputTokens: 0, outputTokens: 0 };
    a.calls++;
    if (r.error || !(r.status >= 200 && r.status < 400)) a.errors++;
    if (r.servedModel) a.servedModels[r.servedModel] = (a.servedModels[r.servedModel] || 0) + 1;
    if (r.provider) a.providers[r.provider] = (a.providers[r.provider] || 0) + 1;
    a.inputTokens += Number(r.promptTokens) || 0;
    a.outputTokens += Number(r.completionTokens) || 0;
  }
  const served = Object.values(agents).map((a) => Object.keys(a.servedModels).sort());
  const providers = Object.values(agents).map((a) => Object.keys(a.providers).sort().join(','));
  const sameModel = served.length > 0 && served.every((list) => list.length === 1) && new Set(served.map((list) => list[0])).size === 1;
  const sameProvider = sameModel && providers.every((p) => p && !p.includes(',') && p === providers[0]);
  return { agents, sameModel, sameProvider, servedModel: sameModel ? served[0][0] : null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseGatewayArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/bench-gateway.mjs --upstream URL --model ID [--port 8788] [--min-interval-ms N] [--log FILE]\n');
  } else {
    const server = createGateway(options);
    server.listen(options.port, options.host, () => process.stdout.write('Gateway on http://' + options.host + ':' + server.address().port + '/v1 -> ' + completionsUrl(options.upstream) + ' (model ' + options.model + ')\n'));
  }
}
