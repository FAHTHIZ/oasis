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
import http from 'node:http';
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

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

export function createGateway(options, { fetchImpl = fetch, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let chain = Promise.resolve();
  let lastStart = 0;
  let count = 0;
  const log = async (entry) => { if (options.log) await appendFile(options.log, JSON.stringify(entry) + '\n'); };
  // One request at a time, at least minIntervalMs apart, so a client that fires
  // parallel requests cannot push the shared upstream over its limit.
  const slot = () => {
    const turn = chain.then(async () => {
      const gap = lastStart + options.minIntervalMs - now();
      if (lastStart && gap > 0) await wait(gap);
      lastStart = now();
    });
    chain = turn.catch(() => {});
    return turn;
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    // The gateway spends the upstream key for whoever reaches it. Browsers send
    // Origin on cross-site POSTs (a text/plain POST needs no preflight), and a
    // DNS-rebinding page arrives with its own Host, so refuse both.
    if (req.headers.origin || (LOOPBACK_HOST.test(options.host || '127.0.0.1') && !LOOPBACK_HOST.test(String(req.headers.host || '')))) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Browser and non-local requests are refused.' } }));
      return;
    }
    if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'bench-model', object: 'model', owned_by: 'gateway' }] }));
      return;
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(url.pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Only POST /v1/chat/completions and GET /v1/models are served.' } }));
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
    await slot();
    const started = now();
    const headers = { 'content-type': 'application/json' };
    if (process.env.OASIS_GATEWAY_UPSTREAM_KEY) headers.authorization = 'Bearer ' + process.env.OASIS_GATEWAY_UPSTREAM_KEY;
    try {
      const upstream = await fetchImpl(completionsUrl(options.upstream), { method: 'POST', headers, body: JSON.stringify(body) });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      let text = '';
      const decoder = new TextDecoder();
      if (upstream.body) for await (const chunk of upstream.body) { text += decoder.decode(chunk, { stream: true }); res.write(chunk); }
      res.end();
      const usage = usageFrom(text);
      await log({ id, at: new Date(started).toISOString(), ms: now() - started, status: upstream.status, requestedModel, stream: Boolean(body.stream), messages: Array.isArray(body.messages) ? body.messages.length : null, tools: Array.isArray(body.tools) ? body.tools.length : 0, promptTokens: usage && usage.prompt_tokens != null ? usage.prompt_tokens : null, completionTokens: usage && usage.completion_tokens != null ? usage.completion_tokens : null, error: upstream.status >= 400 ? redactSecretText(text.slice(0, 2000)).slice(0, 300) : undefined });
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Gateway could not reach the upstream: ' + error.message } }));
      await log({ id, at: new Date(started).toISOString(), ms: now() - started, status: 502, requestedModel, error: redactSecretText(String(error.message)) });
    }
  });
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
