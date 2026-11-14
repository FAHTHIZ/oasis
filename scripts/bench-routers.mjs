#!/usr/bin/env node
// Router comparison: the same model reached directly and through local
// gateways (OmniRoute, FreeLLMAPI, LiteLLM, ...), checked for what an agent
// depends on: tool calls arriving intact, streaming, usage reporting, honest
// errors, and the latency each hop adds.
//
//   node scripts/bench-routers.mjs \
//     --route direct=https://oai.endpoints.kepler.ai.cloud.ovh.net/v1,gpt-oss-20b \
//     --route freellmapi=http://127.0.0.1:3001/v1,gpt-oss-20b,FREELLMAPI_API_KEY \
//     --route omniroute=http://127.0.0.1:20128/v1,ovh/gpt-oss-20b,OMNIROUTE_API_KEY \
//     --rounds 3 --interval-ms 31000 --json bench/results/routers.json
//
// A route is name=baseUrl,model[,KEY_ENV]. Keys are read from the named
// environment variable and never printed or written. Rounds interleave the
// routes so a slow minute upstream affects every route alike, and
// --interval-ms spaces model requests to respect a provider's rate limit
// (OVH anonymous: 2 requests per minute per IP and model). Each round sends
// two model requests per route (a tool call and a streamed answer); the
// unknown-model and /models probes are not counted against that spacing.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { redactSecretText } from '../src/secret-shield.mjs';

export function parseRouterArgs(argv) {
  const options = { routes: [], rounds: 3, intervalMs: 0, timeoutMs: 120000, json: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined || next.startsWith('--')) throw new Error(arg + ' needs a value.'); return next; };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--route') options.routes.push(parseRoute(value()));
    else if (arg === '--rounds') options.rounds = positive(value(), arg);
    else if (arg === '--interval-ms') options.intervalMs = positive(value(), arg, true);
    else if (arg === '--timeout-ms') options.timeoutMs = positive(value(), arg);
    else if (arg === '--json') options.json = value();
    else throw new Error('Unknown option ' + arg + '.');
  }
  if (!options.help && !options.routes.length) throw new Error('Give at least one --route name=baseUrl,model[,KEY_ENV].');
  return options;
}

function positive(text, arg, allowZero = false) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(arg + ' needs a whole number' + (allowZero ? '' : ' above 0') + '.');
  return n;
}

export function parseRoute(text) {
  const eq = text.indexOf('=');
  const name = eq > 0 ? text.slice(0, eq) : '';
  const [baseUrl, model, keyEnv = ''] = text.slice(eq + 1).split(',');
  if (!name || !/^https?:\/\//.test(baseUrl || '') || !model) throw new Error('Route "' + text + '" must look like name=https://host/v1,model[,KEY_ENV].');
  if (keyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new Error('Route "' + name + '": KEY_ENV must be an environment variable name, not a key.');
  return { name, baseUrl: baseUrl.replace(/\/+$/, ''), model, keyEnv };
}

const TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from the project.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

async function call(route, path, body, timeoutMs, method = 'POST') {
  const headers = { 'content-type': 'application/json' };
  const key = route.keyEnv ? process.env[route.keyEnv] : '';
  if (route.keyEnv && !key) throw new Error('Route ' + route.name + ': ' + route.keyEnv + ' is not set.');
  if (key) headers.authorization = 'Bearer ' + key;
  const started = performance.now();
  const response = await fetch(route.baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  return { response, started };
}

// Error text can echo request details; keep a short, redacted excerpt only.
const excerpt = (text) => redactSecretText(String(text || '').replace(/\s+/g, ' ').slice(0, 160));

export async function probeToolCall(route, timeoutMs) {
  const result = { kind: 'tool', ok: false };
  try {
    const { response, started } = await call(route, '/chat/completions', {
      model: route.model,
      messages: [{ role: 'user', content: 'Use the read_file tool to read package.json. Do not answer in text.' }],
      tools: [TOOL],
      tool_choice: 'auto',
      max_tokens: 400,
    }, timeoutMs);
    const text = await response.text();
    result.ms = Math.round(performance.now() - started);
    result.status = response.status;
    result.routedVia = response.headers.get('x-routed-via') || '';
    if (!response.ok) { result.error = excerpt(text); return result; }
    const json = JSON.parse(text);
    const tc = json.choices?.[0]?.message?.tool_calls?.[0];
    result.toolName = tc?.function?.name || '';
    try { result.argsPath = JSON.parse(tc?.function?.arguments || 'null')?.path ?? null; } catch { result.argsPath = null; result.argsInvalid = true; }
    result.finishReason = json.choices?.[0]?.finish_reason || '';
    result.usage = json.usage ? { prompt: json.usage.prompt_tokens, completion: json.usage.completion_tokens } : null;
    result.servedModel = json.model || '';
    result.ok = result.toolName === 'read_file' && typeof result.argsPath === 'string' && /package\.json$/.test(result.argsPath);
  } catch (error) { result.error = excerpt(error.message); }
  return result;
}

export async function probeStream(route, timeoutMs) {
  const result = { kind: 'stream', ok: false };
  try {
    const { response, started } = await call(route, '/chat/completions', {
      model: route.model,
      messages: [{ role: 'user', content: 'Count from 1 to 20, separated by spaces.' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 400,
    }, timeoutMs);
    result.status = response.status;
    if (!response.ok) { result.error = excerpt(await response.text()); result.ms = Math.round(performance.now() - started); return result; }
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let chunks = 0;
    for await (const piece of response.body) {
      buffer += decoder.decode(piece, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { result.done = true; continue; }
        let event;
        try { event = JSON.parse(data); } catch { result.badEvents = (result.badEvents || 0) + 1; continue; }
        chunks++;
        const delta = event.choices?.[0]?.delta || {};
        const token = delta.content || delta.reasoning || delta.reasoning_content || '';
        if (token && result.ttftMs === undefined) result.ttftMs = Math.round(performance.now() - started);
        content += delta.content || '';
        if (event.usage) result.usage = { prompt: event.usage.prompt_tokens, completion: event.usage.completion_tokens };
      }
    }
    result.ms = Math.round(performance.now() - started);
    result.chunks = chunks;
    result.counted = /\b1\b[\s\S]*\b20\b/.test(content);
    result.ok = Boolean(result.done && result.counted);
  } catch (error) { result.error = excerpt(error.message); }
  return result;
}

// An unknown model must fail fast with a clear 4xx, not hang, 200 with an
// empty answer, or quietly answer from a different model.
export async function probeUnknownModel(route, timeoutMs) {
  const result = { kind: 'unknown-model', ok: false };
  try {
    const { response, started } = await call(route, '/chat/completions', { model: 'oasis-no-such-model-0', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }, timeoutMs);
    const text = await response.text();
    result.ms = Math.round(performance.now() - started);
    result.status = response.status;
    let message = '';
    try { const json = JSON.parse(text); message = json.error?.message || json.message || json.detail || ''; } catch {}
    result.message = excerpt(message || text);
    result.ok = response.status >= 400 && response.status < 500 && Boolean(message);
  } catch (error) { result.error = excerpt(error.message); }
  return result;
}

export async function probeModels(route, timeoutMs) {
  const result = { kind: 'models', ok: false };
  try {
    const { response, started } = await call(route, '/models', null, timeoutMs, 'GET');
    const text = await response.text();
    result.ms = Math.round(performance.now() - started);
    result.status = response.status;
    if (response.ok) {
      const ids = (JSON.parse(text).data || []).map((m) => m.id);
      result.count = ids.length;
      result.listsModel = ids.includes(route.model);
      result.ok = result.listsModel;
    } else result.error = excerpt(text);
  } catch (error) { result.error = excerpt(error.message); }
  return result;
}

export function summarizeRoute(route, rows) {
  const of = (kind) => rows.filter((r) => r.kind === kind);
  const tool = of('tool');
  const stream = of('stream');
  return {
    route: route.name,
    model: route.model,
    toolCalls: tool.filter((r) => r.ok).length + '/' + tool.length,
    toolMedianMs: median(tool.filter((r) => r.status === 200).map((r) => r.ms)),
    usageReported: tool.concat(stream).filter((r) => r.usage).length + '/' + (tool.length + stream.length),
    streams: stream.filter((r) => r.ok).length + '/' + stream.length,
    ttftMedianMs: median(stream.map((r) => r.ttftMs)),
    streamMedianMs: median(stream.filter((r) => r.ok).map((r) => r.ms)),
    statuses: [...new Set(rows.filter((r) => r.kind === 'tool' || r.kind === 'stream').map((r) => r.status || 'error'))].join(' '),
    unknownModel: of('unknown-model').map((r) => (r.status || 'error') + (r.ok ? '' : ' (unclear)')).join(' '),
    listsModel: of('models').map((r) => (r.ok ? 'yes' : r.status === 200 ? 'no' : String(r.status || 'error'))).join(' '),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runRouterBench(options, log = console.log) {
  const rows = Object.fromEntries(options.routes.map((r) => [r.name, []]));
  for (const route of options.routes) {
    rows[route.name].push(await probeModels(route, options.timeoutMs));
    rows[route.name].push(await probeUnknownModel(route, options.timeoutMs));
  }
  let first = true;
  for (let round = 1; round <= options.rounds; round++) {
    for (const probe of [probeToolCall, probeStream]) {
      for (const route of options.routes) {
        if (!first && options.intervalMs) await sleep(options.intervalMs);
        first = false;
        const row = { round, ...(await probe(route, options.timeoutMs)) };
        rows[route.name].push(row);
        log(`round ${round} ${route.name} ${row.kind}: ${row.ok ? 'ok' : 'FAIL'} ${row.status || ''} ${row.ms ?? ''} ms${row.error ? ' ' + row.error : ''}`);
      }
    }
  }
  return { rows, summary: options.routes.map((route) => summarizeRoute(route, rows[route.name])) };
}

async function main() {
  const options = parseRouterArgs(process.argv.slice(2));
  if (options.help) { console.log(readHelp()); return; }
  const startedAt = new Date().toISOString();
  const { rows, summary } = await runRouterBench(options);
  console.table(summary);
  if (options.json) {
    await writeFile(options.json, JSON.stringify({
      startedAt, finishedAt: new Date().toISOString(), node: process.version,
      rounds: options.rounds, intervalMs: options.intervalMs,
      routes: options.routes.map(({ name, baseUrl, model, keyEnv }) => ({ name, baseUrl, model, keyEnv })),
      summary, rows,
    }, null, 2) + '\n');
    console.log('Wrote ' + options.json);
  }
}

function readHelp() {
  return 'Usage: node scripts/bench-routers.mjs --route name=baseUrl,model[,KEY_ENV] [--route ...] [--rounds 3] [--interval-ms 0] [--timeout-ms 120000] [--json FILE]';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(redactSecretText(error.message)); process.exit(1); });
}
