import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Telemetry, parseTraceparent, formatTraceparent, environmentTraceContext, currentTraceContext, withTraceEnv, withTraceMeta, shutdownTelemetry } from '../src/telemetry.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { McpServerClient } from '../src/mcp.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const CALLER = '00f067aa0ba902b7';
const INBOUND = '00-' + TRACE + '-' + CALLER + '-01';
const OTEL_CLEAR = { OTEL_EXPORTER_OTLP_HEADERS: '', OTEL_EXPORTER_OTLP_TRACES_HEADERS: '', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '', OTEL_LOG_USER_PROMPTS: '', OASIS_OTEL_ENV_CONTEXT: '', TRACESTATE: '' };

// OTLP/HTTP collector that keeps every exported span.
async function collector(t) {
  const spans = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/v1/traces')) {
        for (const resource of JSON.parse(body).resourceSpans || []) for (const scope of resource.scopeSpans || []) spans.push(...scope.spans);
      }
      res.setHeader('content-type', 'application/json'); res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { spans, endpoint: 'http://127.0.0.1:' + server.address().port };
}

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-trace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('traceparent parsing follows W3C Trace Context', () => {
  assert.deepEqual(parseTraceparent(INBOUND), { traceId: TRACE, spanId: CALLER, traceFlags: 1, sampled: true });
  assert.equal(parseTraceparent('00-' + TRACE + '-' + CALLER + '-00').sampled, false);
  assert.equal(parseTraceparent(''), null);
  assert.equal(parseTraceparent('ff-' + TRACE + '-' + CALLER + '-01'), null, 'version ff is invalid');
  assert.equal(parseTraceparent('00-' + '0'.repeat(32) + '-' + CALLER + '-01'), null, 'all-zero trace id');
  assert.equal(parseTraceparent('00-' + TRACE + '-' + '0'.repeat(16) + '-01'), null, 'all-zero parent id');
  assert.equal(parseTraceparent('00-' + TRACE.toUpperCase() + '-' + CALLER + '-01'), null, 'upper case is invalid');
  assert.equal(parseTraceparent(INBOUND + '-extra'), null, 'version 00 has exactly four fields');
  assert.equal(parseTraceparent('01-' + TRACE + '-' + CALLER + '-01-future').traceId, TRACE, 'a later version may add fields');
  assert.equal(formatTraceparent({ traceId: TRACE, spanId: CALLER, traceFlags: 1 }), INBOUND);
  assert.equal(formatTraceparent({ traceId: 'x', spanId: CALLER }), '');
  assert.equal(environmentTraceContext({ TRACEPARENT: INBOUND }).mode, 'parent');
  assert.equal(environmentTraceContext({ TRACEPARENT: INBOUND, OASIS_OTEL_ENV_CONTEXT: 'link' }).mode, 'link');
  assert.equal(environmentTraceContext({ TRACEPARENT: INBOUND, OASIS_OTEL_ENV_CONTEXT: 'off' }), null);
  assert.equal(environmentTraceContext({ TRACEPARENT: INBOUND, TRACESTATE: 'vendor=\u00e9' }).tracestate, '', 'non-ASCII tracestate is dropped');
});

test('outside a span nothing is injected and an inherited TRACEPARENT passes through', () => {
  const env = { TRACEPARENT: INBOUND, PATH: '/bin' };
  assert.deepEqual(currentTraceContext(), {});
  assert.equal(withTraceEnv(env), env);
  assert.equal(withTraceMeta(undefined), undefined);
  const meta = { progressToken: 1 };
  assert.equal(withTraceMeta(meta), meta);
});

test('root spans continue TRACEPARENT as parent, as a link, or not at all', async (t) => {
  for (const mode of ['parent', 'link', 'off']) {
    const { spans, endpoint } = await collector(t);
    const tel = new Telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none', TRACEPARENT: INBOUND, TRACESTATE: 'congo=t61rcWkgMzE', OASIS_OTEL_ENV_CONTEXT: mode }, { manual: true });
    let inside = null;
    await tel.span('turn', {}, async () => {
      await tel.span('tool', {}, async () => {
        inside = { context: currentTraceContext(), env: withTraceEnv({ KEEP: '1', TRACESTATE: 'stale=1' }), meta: withTraceMeta({ progressToken: 7 }) };
      });
    });
    await tel.flush();
    const turn = spans.find((s) => s.name === 'turn');
    const tool = spans.find((s) => s.name === 'tool');
    assert.equal(tool.parentSpanId, turn.spanId, mode);
    if (mode === 'parent') {
      assert.equal(turn.traceId, TRACE);
      assert.equal(turn.parentSpanId, CALLER);
      assert.equal(turn.traceState, 'congo=t61rcWkgMzE');
    } else if (mode === 'link') {
      assert.notEqual(turn.traceId, TRACE);
      assert.ok(!turn.parentSpanId);
      assert.deepEqual(turn.links.map((l) => [l.traceId, l.spanId]), [[TRACE, CALLER]]);
    } else {
      assert.notEqual(turn.traceId, TRACE);
      assert.ok(!turn.parentSpanId && !(turn.links || []).length);
    }
    // Children are told about the innermost span, not the inbound caller.
    assert.equal(inside.context.traceparent, '00-' + tool.traceId + '-' + tool.spanId + '-01');
    assert.equal(inside.env.TRACEPARENT, inside.context.traceparent);
    assert.equal(inside.env.KEEP, '1');
    if (mode === 'parent') assert.equal(inside.env.TRACESTATE, 'congo=t61rcWkgMzE');
    else assert.equal(inside.env.TRACESTATE, undefined, 'a stale tracestate is not forwarded with a new traceparent');
    assert.deepEqual(inside.meta, { progressToken: 7, ...inside.context });
    await tel.shutdown();
  }
});

test('an agent turn under TRACEPARENT: model header and command environment name the right spans', async (t) => {
  const { spans, endpoint } = await collector(t);
  const root = await tmp(t);
  await writeFile(path.join(root, 'show.mjs'), 'process.stdout.write("TP=" + (process.env.TRACEPARENT || "none"));\n');
  const seenHeaders = [];
  const replies = [
    { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: process.execPath, args: ['show.mjs'] }) } }] },
    { content: 'done' }
  ];
  const model = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seenHeaders.push(req.headers);
      const message = replies[Math.min(seenHeaders.length - 1, replies.length - 1)];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  t.after(() => model.close());
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4, maxCommandSeconds: 20 };
  const env = { ...process.env, ...OTEL_CLEAR, OASIS_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_SEMCONV_STABILITY_OPT_IN: 'gen_ai_latest_experimental', TRACEPARENT: INBOUND };
  const session = await createSession({ root, config, settings, bare: true, env });
  const result = await runAgentTurn(session, 'show the trace', { env, autoApprove: true });
  assert.match(result.text, /done/);
  await shutdownTelemetry();
  const turn = spans.find((s) => s.name.startsWith('invoke_agent'));
  const chats = spans.filter((s) => s.name.startsWith('chat'));
  const tool = spans.find((s) => s.name === 'execute_tool run_command');
  assert.ok(turn && tool && chats.length === 2, spans.map((s) => s.name).join(', '));
  assert.equal(turn.traceId, TRACE, 'the turn joins the caller\'s trace');
  assert.equal(turn.parentSpanId, CALLER);
  for (const span of [...chats, tool]) assert.equal(span.traceId, TRACE);
  // Each model request carries its own chat span as traceparent.
  assert.deepEqual(seenHeaders.map((h) => h.traceparent).sort(), chats.map((s) => '00-' + TRACE + '-' + s.spanId + '-01').sort());
  // The command saw the tool span, so a nested `oasis -p` lands under it.
  const output = JSON.stringify(session.messages);
  assert.match(output, new RegExp('TP=00-' + TRACE + '-' + tool.spanId + '-01'));
});

test('MCP: _meta.traceparent carries the trace into `oasis mcp serve` and on to its commands', async (t) => {
  const { spans, endpoint } = await collector(t);
  const root = await tmp(t);
  const home = await tmp(t);
  await writeFile(path.join(root, 'show.mjs'), 'process.stdout.write("TP=" + (process.env.TRACEPARENT || "none"));\n');
  const otel = { OASIS_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: endpoint };
  const client = new McpServerClient({ name: 'oasis', command: process.execPath, args: [CLI, 'mcp', 'serve', '--allow-commands'], passEnv: [], enabled: true, cwd: root, extraEnv: { OASIS_CONFIG_DIR: home, HOME: home, ...otel } }, { root, env: { ...process.env, OASIS_CONFIG_DIR: home, HOME: home } });
  await client.start();
  const tel = new Telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' }, { manual: true });
  let result;
  await tel.span('execute_tool mcp', {}, async () => {
    result = await client.callTool('run_command', { command: process.execPath, args: ['show.mjs'] }, { autoApprove: true });
  }, { kind: 3 });
  await tel.flush();
  await client.close();
  // The server process flushes its spans as it exits.
  const deadline = Date.now() + 10000;
  while (!spans.some((s) => s.name === 'tools/call run_command') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const caller = spans.find((s) => s.name === 'execute_tool mcp');
  const served = spans.find((s) => s.name === 'tools/call run_command');
  assert.ok(served, 'the server exported its span: ' + spans.map((s) => s.name).join(', '));
  assert.equal(served.traceId, caller.traceId);
  assert.equal(served.parentSpanId, caller.spanId);
  assert.equal(served.kind, 2, 'a SERVER span');
  assert.match(JSON.stringify(result.content), new RegExp('TP=00-' + caller.traceId + '-' + served.spanId + '-01'));
  await tel.shutdown();
});
