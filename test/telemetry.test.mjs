import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Telemetry, telemetryEnabled, getTelemetry, shutdownTelemetry, lineChanges, genAiProviderName, genAiErrorType, genAiServer, genAiSpanNames } from '../src/telemetry.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

// A local OTLP/HTTP collector that records each request.
async function collector(t) {
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { sent.push({ url: req.url, headers: req.headers, body: JSON.parse(body) }); res.setHeader('content-type', 'application/json'); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { sent, endpoint: 'http://127.0.0.1:' + server.address().port };
}

test('telemetry is off unless enabled', () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(telemetryEnabled({ OASIS_ENABLE_TELEMETRY: '1' }), true);
  assert.equal(telemetryEnabled({ CLAUDE_CODE_ENABLE_TELEMETRY: 'true' }), true);
  assert.equal(getTelemetry({}), null);
});

test('OTLP JSON payloads for metrics, logs and nested spans', async (t) => {
  const { sent, endpoint } = await collector(t);
  const tel = new Telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint + '/', OTEL_EXPORTER_OTLP_HEADERS: 'x-token=abc%20d,team=core', OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=test' }, { manual: true });
  tel.add('oasis.token.usage', 5, { type: 'input' }, 'tokens');
  tel.add('oasis.token.usage', 7, { type: 'input' }, 'tokens');
  tel.record('oasis.tool.duration', 12, { tool_name: 'grep' });
  await tel.span('outer', { a: 1 }, async () => {
    await tel.span('inner', {}, async () => { tel.event('oasis.tool_result', { success: true }); });
  });
  await assert.rejects(tel.span('broken', {}, async () => { throw new Error('boom'); }), /boom/);
  await tel.flush();
  const byUrl = Object.fromEntries(sent.map((s) => [s.url, s]));
  assert.deepEqual(Object.keys(byUrl).sort(), ['/v1/logs', '/v1/metrics', '/v1/traces']);
  assert.equal(byUrl['/v1/metrics'].headers['x-token'], 'abc d');
  const metrics = byUrl['/v1/metrics'].body.resourceMetrics[0];
  assert.ok(metrics.resource.attributes.some((a) => a.key === 'deployment.environment' && a.value.stringValue === 'test'));
  const usage = metrics.scopeMetrics[0].metrics.find((m) => m.name === 'oasis.token.usage');
  assert.equal(usage.sum.isMonotonic, true);
  assert.equal(usage.sum.dataPoints[0].asDouble, 12);
  const duration = metrics.scopeMetrics[0].metrics.find((m) => m.name === 'oasis.tool.duration').histogram.dataPoints[0];
  assert.equal(Number(duration.count), 1);
  assert.equal(duration.sum, 12);
  assert.ok(duration.explicitBounds.length > 1, 'histograms have real bucket boundaries');
  const spans = byUrl['/v1/traces'].body.resourceSpans[0].scopeSpans[0].spans;
  const outer = spans.find((s) => s.name === 'outer');
  const inner = spans.find((s) => s.name === 'inner');
  assert.equal(inner.parentSpanId, outer.spanId);
  assert.equal(inner.traceId, outer.traceId);
  assert.equal(spans.find((s) => s.name === 'broken').status.code, 2);
  const log = byUrl['/v1/logs'].body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(log.spanId, inner.spanId);
  assert.ok(log.attributes.some((a) => a.key === 'event.name' && a.value.stringValue === 'oasis.tool_result'));
});

test('console exporter and none', async () => {
  const lines = [];
  const tel = new Telemetry({ OTEL_METRICS_EXPORTER: 'console', OTEL_LOGS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none' }, { manual: true, write: (l) => lines.push(l) });
  tel.add('x', 1); tel.event('e');
  await tel.flush();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[otel metrics\] /);
});

test('lineChanges counts edits', () => {
  assert.deepEqual(lineChanges('edit_file', { old_string: 'a\nb', new_string: 'c' }), { added: 1, removed: 2 });
  assert.deepEqual(lineChanges('write_file', { content: 'x\ny\nz' }), { added: 3, removed: 0 });
  assert.deepEqual(lineChanges('grep', {}), { added: 0, removed: 0 });
});

test('an agent turn exports turn, model and tool spans plus metrics to a collector', async (t) => {
  const received = { metrics: [], logs: [], traces: [] };
  const collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received[req.url.split('/').pop()].push(JSON.parse(body)); res.end('{}'); });
  });
  await new Promise((r) => collector.listen(0, '127.0.0.1', r));
  t.after(() => collector.close());
  const env = { ...process.env, OASIS_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp', OTEL_LOGS_EXPORTER: 'otlp', OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: '', OTEL_EXPORTER_OTLP_LOGS_HEADERS: '', OTEL_EXPORTER_OTLP_METRICS_HEADERS: '', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:' + collector.address().port, OTEL_LOG_USER_PROMPTS: '' };
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-otel-'));
  const { config } = await scriptedModel(t, [
    toolCall('c1', 'list_files', { path: '.' }),
    { content: 'done' }
  ]);
  const session = await createSession({ root, config, settings, bare: true, env });
  const result = await runAgentTurn(session, 'secret prompt text', { env, autoApprove: true });
  assert.match(result.text, /done/);
  await shutdownTelemetry();
  const spans = received.traces.flatMap((p) => p.resourceSpans[0].scopeSpans[0].spans);
  const names = spans.map((s) => s.name);
  assert.ok(names.includes('oasis.turn'));
  assert.equal(names.filter((n) => n === 'oasis.llm_request').length, 2);
  assert.ok(names.includes('oasis.tool'));
  const turn = spans.find((s) => s.name === 'oasis.turn');
  assert.ok(spans.filter((s) => s.name !== 'oasis.turn').every((s) => s.parentSpanId === turn.spanId && s.traceId === turn.traceId));
  // OpenTelemetry GenAI semantic conventions, for LLM-observability backends.
  const attr = (span, key) => { const a = span.attributes.find((x) => x.key === key); return a && (a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue); };
  const llm = spans.find((s) => s.name === 'oasis.llm_request');
  assert.equal(llm.kind, 3, 'model calls are CLIENT spans');
  assert.equal(attr(llm, 'gen_ai.operation.name'), 'chat');
  assert.ok(attr(llm, 'gen_ai.provider.name'));
  assert.ok(attr(llm, 'gen_ai.request.model'));
  assert.notEqual(attr(llm, 'gen_ai.usage.input_tokens'), undefined);
  const finish = llm.attributes.find((x) => x.key === 'gen_ai.response.finish_reasons');
  assert.deepEqual(finish.value.arrayValue.values.map((v) => v.stringValue), ['tool_calls'], 'finish_reasons is a string[]');
  assert.equal(attr(llm, 'server.address'), '127.0.0.1');
  assert.ok(Number(attr(llm, 'server.port')) > 0);
  const tool = spans.find((s) => s.name === 'oasis.tool');
  assert.equal(attr(tool, 'gen_ai.operation.name'), 'execute_tool');
  assert.equal(attr(tool, 'gen_ai.tool.name'), 'list_files');
  assert.equal(attr(tool, 'gen_ai.tool.call.id'), 'c1');
  assert.equal(attr(turn, 'gen_ai.operation.name'), 'invoke_agent');
  assert.equal(attr(turn, 'gen_ai.agent.name'), 'oasis');
  const metricNames = received.metrics.flatMap((p) => p.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name));
  for (const name of ['oasis.session.count', 'oasis.tool.count', 'oasis.api.duration', 'oasis.turn.duration']) assert.ok(metricNames.includes(name), name);
  for (const name of ['gen_ai.client.inference.duration', 'gen_ai.client.inference.operation.input_tokens', 'gen_ai.client.inference.operation.output_tokens', 'gen_ai.execute_tool.duration']) assert.ok(metricNames.includes(name), name);
  const allMetrics = received.metrics.flatMap((p) => p.resourceMetrics[0].scopeMetrics[0].metrics);
  const inference = allMetrics.find((m) => m.name === 'gen_ai.client.inference.duration');
  assert.equal(inference.unit, 's');
  assert.deepEqual(inference.histogram.dataPoints[0].explicitBounds, [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]);
  const pointKeys = inference.histogram.dataPoints[0].attributes.map((a) => a.key);
  assert.ok(pointKeys.includes('gen_ai.operation.name') && pointKeys.includes('gen_ai.provider.name') && pointKeys.includes('server.port'));
  assert.equal(pointKeys.includes('session.id'), false, 'GenAI metrics stay low-cardinality');
  const tokens = allMetrics.find((m) => m.name === 'gen_ai.client.inference.operation.input_tokens');
  assert.equal(tokens.histogram.dataPoints[0].explicitBounds[1], 4);
  assert.equal(names.includes('chat fixture'), false, 'oasis.* span names stay the default');
  const logs = JSON.stringify(received.logs);
  assert.match(logs, /oasis\.user_prompt/);
  assert.match(logs, /oasis\.tool_result/);
  assert.doesNotMatch(logs, /secret prompt text/);
});

test('events carry the git branch as vcs.ref.head.name', async (t) => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { gitBranchName } = await import('../src/telemetry.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-otel-branch-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/login\n');
  assert.equal(gitBranchName(root), 'feature/login');
  const { sent, endpoint } = await collector(t);
  const tel = new Telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }, { manual: true });
  tel.root = root;
  tel.event('oasis.user_prompt', {});
  await tel.flush();
  const logs = sent.map((s) => s.body).find((body) => body.resourceLogs);
  const attrs = logs.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  assert.ok(attrs.some((a) => a.key === 'vcs.ref.head.name' && a.value.stringValue === 'feature/login'));
  const detached = await mkdtemp(path.join(os.tmpdir(), 'oasis-otel-detached-'));
  await mkdir(path.join(detached, '.git'));
  await writeFile(path.join(detached, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  assert.equal(gitBranchName(detached), '');
});

test('gen_ai.provider.name follows the OpenTelemetry well-known values', () => {
  assert.equal(genAiProviderName({ protocol: 'anthropic' }), 'anthropic');
  assert.equal(genAiProviderName({ protocol: 'bedrock' }), 'aws.bedrock');
  assert.equal(genAiProviderName({ protocol: 'vertex' }), 'gcp.vertex_ai');
  assert.equal(genAiProviderName({ protocol: 'foundry' }), 'azure.ai.inference');
  assert.equal(genAiProviderName({ protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(genAiProviderName({ protocol: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }), 'gcp.gemini');
  assert.equal(genAiProviderName({ protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' }), 'groq');
  assert.equal(genAiProviderName({ protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }), 'ollama');
  assert.equal(genAiProviderName({ protocol: 'openai-compatible', baseUrl: 'https://llm.internal.example/v1' }), 'openai-compatible');
});

test('GenAI helpers: error.type, server address, and the semconv opt-in for span names', () => {
  assert.equal(genAiErrorType(Object.assign(new Error('x'), { status: 429 })), '429');
  assert.equal(genAiErrorType(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), 'ETIMEDOUT');
  assert.equal(genAiErrorType(Object.assign(new Error('x'), { name: 'AbortError' })), 'cancelled');
  assert.equal(genAiErrorType(new TypeError('x')), 'TypeError');
  assert.equal(genAiErrorType(new Error('plain')), '_OTHER');
  assert.equal(genAiErrorType(null), '_OTHER');
  assert.deepEqual(genAiServer({ baseUrl: 'https://api.openai.com/v1' }), { 'server.address': 'api.openai.com', 'server.port': 443 });
  assert.deepEqual(genAiServer({ baseUrl: 'http://localhost:11434/v1' }), { 'server.address': 'localhost', 'server.port': 11434 });
  assert.deepEqual(genAiServer({ baseUrl: '' }), {});
  assert.equal(genAiSpanNames({}), false);
  assert.equal(genAiSpanNames({ OTEL_SEMCONV_STABILITY_OPT_IN: 'http, gen_ai_latest_experimental' }), true);
});

test('OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental names spans "invoke_agent", "chat MODEL" and "execute_tool TOOL"', async (t) => {
  await shutdownTelemetry();
  const received = { metrics: [], logs: [], traces: [] };
  const collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received[req.url.split('/').pop()].push(JSON.parse(body)); res.end('{}'); });
  });
  await new Promise((r) => collector.listen(0, '127.0.0.1', r));
  t.after(() => collector.close());
  const env = { ...process.env, OASIS_ENABLE_TELEMETRY: '1', OTEL_SEMCONV_STABILITY_OPT_IN: 'gen_ai_latest_experimental', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: '', OTEL_EXPORTER_OTLP_TRACES_HEADERS: '', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:' + collector.address().port };
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-otel-'));
  const { config } = await scriptedModel(t, [toolCall('c1', 'list_files', { path: '.' }), { content: 'done' }]);
  const session = await createSession({ root, config, settings, bare: true, env });
  await runAgentTurn(session, 'hi', { env, autoApprove: true });
  await shutdownTelemetry();
  const names = received.traces.flatMap((p) => p.resourceSpans[0].scopeSpans[0].spans).map((s) => s.name);
  assert.ok(names.includes('invoke_agent oasis'), names.join(', '));
  assert.ok(names.includes('chat ' + config.model), names.join(', '));
  assert.ok(names.includes('execute_tool list_files'), names.join(', '));
  assert.equal(names.some((n) => n.startsWith('oasis.')), false);
});

test('an explicit exit (signal, double Ctrl+C, web shutdown) still delivers the last spans', async (t) => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const paths = [];
  const collector = http.createServer((req, res) => { paths.push(req.url); req.resume(); req.on('end', () => res.end('{}')); });
  await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => collector.close(resolve)));
  const moduleUrl = new URL('../src/telemetry.mjs', import.meta.url).href;
  const script = "const t = await import(" + JSON.stringify(moduleUrl) + "); const tel = t.getTelemetry(process.env); await tel.span('last', {}, async () => {}); t.exitAfterTelemetry(3);";
  const env = { ...process.env, OASIS_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: '', OTEL_EXPORTER_OTLP_TRACES_HEADERS: '', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:' + collector.address().port };
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: 'ignore' });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 3, 'the requested exit code is kept');
  assert.ok(paths.some((p) => p.includes('/v1/traces')), 'the span reached the collector before exit: ' + paths.join(','));
});
