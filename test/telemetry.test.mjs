import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Telemetry, telemetryEnabled, getTelemetry, shutdownTelemetry, lineChanges } from '../src/telemetry.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

test('telemetry is off unless enabled', () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(telemetryEnabled({ OASIS_ENABLE_TELEMETRY: '1' }), true);
  assert.equal(telemetryEnabled({ CLAUDE_CODE_ENABLE_TELEMETRY: 'true' }), true);
  assert.equal(getTelemetry({}), null);
});

test('OTLP JSON payloads for metrics, logs and nested spans', async () => {
  const sent = [];
  const tel = new Telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'x-token=abc%20d,team=core', OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=test' }, { manual: true, fetch: async (url, init) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true }; } });
  tel.add('oasis.token.usage', 5, { type: 'input' }, 'tokens');
  tel.add('oasis.token.usage', 7, { type: 'input' }, 'tokens');
  tel.record('oasis.tool.duration', 12, { tool_name: 'grep' });
  await tel.span('outer', { a: 1 }, async () => {
    await tel.span('inner', {}, async () => { tel.event('oasis.tool_result', { success: true }); });
  });
  await assert.rejects(tel.span('broken', {}, async () => { throw new Error('boom'); }), /boom/);
  await tel.flush();
  const byUrl = Object.fromEntries(sent.map((s) => [s.url, s]));
  assert.deepEqual(Object.keys(byUrl).sort(), ['http://collector:4318/v1/logs', 'http://collector:4318/v1/metrics', 'http://collector:4318/v1/traces']);
  assert.equal(byUrl['http://collector:4318/v1/metrics'].headers['x-token'], 'abc d');
  const metrics = byUrl['http://collector:4318/v1/metrics'].body.resourceMetrics[0];
  assert.ok(metrics.resource.attributes.some((a) => a.key === 'deployment.environment' && a.value.stringValue === 'test'));
  const usage = metrics.scopeMetrics[0].metrics.find((m) => m.name === 'oasis.token.usage');
  assert.equal(usage.sum.isMonotonic, true);
  assert.equal(usage.sum.dataPoints[0].asDouble, 12);
  assert.ok(metrics.scopeMetrics[0].metrics.find((m) => m.name === 'oasis.tool.duration').histogram);
  const spans = byUrl['http://collector:4318/v1/traces'].body.resourceSpans[0].scopeSpans[0].spans;
  const outer = spans.find((s) => s.name === 'outer');
  const inner = spans.find((s) => s.name === 'inner');
  assert.equal(inner.parentSpanId, outer.spanId);
  assert.equal(inner.traceId, outer.traceId);
  assert.equal(spans.find((s) => s.name === 'broken').status.code, 2);
  const log = byUrl['http://collector:4318/v1/logs'].body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(log.spanId, inner.spanId);
  assert.ok(log.attributes.some((a) => a.key === 'event.name' && a.value.stringValue === 'oasis.tool_result'));
});

test('console exporter and none', async () => {
  const lines = [];
  const tel = new Telemetry({ OTEL_METRICS_EXPORTER: 'console', OTEL_LOGS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none' }, { manual: true, write: (l) => lines.push(l), fetch: async () => { throw new Error('should not fetch'); } });
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
  const metricNames = received.metrics.flatMap((p) => p.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name));
  for (const name of ['oasis.session.count', 'oasis.tool.count', 'oasis.api.duration', 'oasis.turn.duration']) assert.ok(metricNames.includes(name), name);
  const logs = JSON.stringify(received.logs);
  assert.match(logs, /oasis\.user_prompt/);
  assert.match(logs, /oasis\.tool_result/);
  assert.doesNotMatch(logs, /secret prompt text/);
});
