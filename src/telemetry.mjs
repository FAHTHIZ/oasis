// OpenTelemetry metrics, events (logs) and traces with no dependencies.
//
// Off by default. Turn it on with OASIS_ENABLE_TELEMETRY=1 (Claude Code's
// CLAUDE_CODE_ENABLE_TELEMETRY=1 works too) and pick exporters with the standard
// variables:
//   OTEL_METRICS_EXPORTER / OTEL_LOGS_EXPORTER / OTEL_TRACES_EXPORTER = otlp | console | none
//   OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318), or the per-signal
//   OTEL_EXPORTER_OTLP_{METRICS,LOGS,TRACES}_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
//   OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME, OTEL_METRIC_EXPORT_INTERVAL (ms),
//   OTEL_LOGS_EXPORT_INTERVAL (ms). Payloads are OTLP/HTTP JSON.
// Prompt text is never exported unless OTEL_LOG_USER_PROMPTS=1; tool arguments only
// with OTEL_LOG_TOOL_DETAILS=1.
import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Current git branch for a workspace, read straight from .git/HEAD (cached for a few seconds).
const branchCache = new Map();
export function gitBranchName(root, now = Date.now()) {
  if (!root) return '';
  const hit = branchCache.get(root);
  if (hit && now - hit.at < 5000) return hit.name;
  let name = '';
  try {
    let gitDir = path.join(root, '.git');
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (pointer) gitDir = path.resolve(root, pointer[1].trim());
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    name = ref ? ref[1] : '';
  } catch {}
  branchCache.set(root, { at: now, name });
  return name;
}

const VERSION = '1';
const spanContext = new AsyncLocalStorage();
let active = null;
let activeKey = '';

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || ''));

export function telemetryEnabled(env = process.env) {
  return truthy(env.OASIS_ENABLE_TELEMETRY) || truthy(env.CLAUDE_CODE_ENABLE_TELEMETRY);
}

function parseKeyValues(raw) {
  const out = {};
  for (const part of String(raw || '').split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    try { out[decodeURIComponent(part.slice(0, index).trim())] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { out[part.slice(0, index).trim()] = part.slice(index + 1).trim(); }
  }
  return out;
}

function anyValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: String(value) };
}

const toAttributes = (attrs = {}) => Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([key, value]) => ({ key, value: anyValue(value) }));
const nowNanos = () => String(BigInt(Date.now()) * 1000000n);

function endpointFor(env, signal) {
  const specific = env['OTEL_EXPORTER_OTLP_' + signal.toUpperCase() + '_ENDPOINT'];
  if (specific) return specific;
  return String(env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, '') + '/v1/' + signal;
}

export class Telemetry {
  constructor(env = process.env, options = {}) {
    this.env = env;
    this.fetch = options.fetch || globalThis.fetch;
    this.write = options.write || ((line) => process.stderr.write(line + '\n'));
    this.exporters = {
      metrics: String(env.OTEL_METRICS_EXPORTER || 'otlp').toLowerCase(),
      logs: String(env.OTEL_LOGS_EXPORTER || 'otlp').toLowerCase(),
      traces: String(env.OTEL_TRACES_EXPORTER || 'otlp').toLowerCase()
    };
    this.headers = { 'content-type': 'application/json', ...parseKeyValues(env.OTEL_EXPORTER_OTLP_HEADERS) };
    this.sessionId = options.sessionId || randomUUID();
    this.resource = {
      attributes: toAttributes({
        'service.name': env.OTEL_SERVICE_NAME || 'oasis',
        'service.version': options.version || VERSION,
        'os.type': process.platform,
        'host.arch': process.arch,
        'host.name': truthy(env.OTEL_HOST_NAME) ? os.hostname() : undefined,
        ...parseKeyValues(env.OTEL_RESOURCE_ATTRIBUTES)
      })
    };
    this.logPrompts = truthy(env.OTEL_LOG_USER_PROMPTS);
    this.logToolDetails = truthy(env.OTEL_LOG_TOOL_DETAILS);
    this.startNanos = nowNanos();
    this.sums = new Map();
    this.histograms = new Map();
    this.logRecords = [];
    this.spans = [];
    this.errors = 0;
    const metricInterval = Math.max(1000, Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 60000);
    const logInterval = Math.max(500, Number(env.OTEL_LOGS_EXPORT_INTERVAL) || 5000);
    if (!options.manual) {
      this.metricTimer = setInterval(() => this.flushMetrics().catch(() => {}), metricInterval);
      this.logTimer = setInterval(() => { this.flushLogs().catch(() => {}); this.flushTraces().catch(() => {}); }, logInterval);
      this.metricTimer.unref?.();
      this.logTimer.unref?.();
    }
  }

  baseAttributes() { return { 'session.id': this.sessionId }; }

  // Events carry the workspace's git branch (vcs.ref.head.name); metrics stay low-cardinality.
  eventAttributes() {
    const branch = truthy(this.env.OASIS_OTEL_NO_BRANCH) ? '' : gitBranchName(this.root);
    return { ...this.baseAttributes(), ...(branch ? { 'vcs.ref.head.name': branch } : {}) };
  }

  // Monotonic cumulative counter.
  add(name, value = 1, attrs = {}, unit = '1', description = '') {
    if (!Number.isFinite(Number(value)) || Number(value) === 0) return;
    const all = { ...this.baseAttributes(), ...attrs };
    const key = name + '\u0000' + JSON.stringify(Object.entries(all).sort());
    const entry = this.sums.get(key) || { name, unit, description, attrs: all, value: 0 };
    entry.value += Number(value);
    this.sums.set(key, entry);
  }

  record(name, value, attrs = {}, unit = 'ms', description = '') {
    if (!Number.isFinite(Number(value))) return;
    const all = { ...this.baseAttributes(), ...attrs };
    const key = name + '\u0000' + JSON.stringify(Object.entries(all).sort());
    const entry = this.histograms.get(key) || { name, unit, description, attrs: all, count: 0, sum: 0, min: Infinity, max: -Infinity };
    entry.count += 1; entry.sum += Number(value); entry.min = Math.min(entry.min, value); entry.max = Math.max(entry.max, value);
    this.histograms.set(key, entry);
  }

  event(name, attrs = {}) {
    const span = spanContext.getStore();
    this.logRecords.push({
      timeUnixNano: nowNanos(),
      observedTimeUnixNano: nowNanos(),
      severityNumber: 9,
      severityText: 'INFO',
      body: { stringValue: name },
      attributes: toAttributes({ 'event.name': name, 'event.timestamp': new Date().toISOString(), ...this.eventAttributes(), ...attrs }),
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {})
    });
    if (this.logRecords.length >= 512) this.flushLogs().catch(() => {});
  }

  // Runs fn inside a span; nested spans and events attach to it automatically.
  async span(name, attrs, fn) {
    const parent = spanContext.getStore();
    const span = { traceId: parent ? parent.traceId : randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), parentSpanId: parent ? parent.spanId : undefined, name, start: nowNanos(), attrs: { ...this.baseAttributes(), ...attrs } };
    let status = { code: 1 };
    try {
      return await spanContext.run(span, () => fn(span));
    } catch (error) {
      status = { code: 2, message: String(error && error.message || error).slice(0, 500) };
      throw error;
    } finally {
      if (span.error) status = { code: 2, message: String(span.error).slice(0, 500) };
      this.spans.push({ traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}), name, kind: 1, startTimeUnixNano: span.start, endTimeUnixNano: nowNanos(), attributes: toAttributes(span.attrs), status });
      if (this.spans.length >= 512) this.flushTraces().catch(() => {});
    }
  }

  async send(signal, payload) {
    const exporter = this.exporters[signal];
    if (exporter === 'none' || !exporter) return;
    if (exporter === 'console') { this.write('[otel ' + signal + '] ' + JSON.stringify(payload)); return; }
    try {
      const headers = { ...this.headers, ...parseKeyValues(this.env['OTEL_EXPORTER_OTLP_' + signal.toUpperCase() + '_HEADERS']) };
      const response = await this.fetch(endpointFor(this.env, signal), { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
      if (!response.ok) this.errors++;
    } catch { this.errors++; }
  }

  metricsPayload() {
    const now = nowNanos();
    const metrics = [];
    const byName = new Map();
    for (const entry of this.sums.values()) {
      if (!byName.has(entry.name)) { const m = { name: entry.name, unit: entry.unit, description: entry.description, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [] } }; byName.set(entry.name, m); metrics.push(m); }
      byName.get(entry.name).sum.dataPoints.push({ attributes: toAttributes(entry.attrs), startTimeUnixNano: this.startNanos, timeUnixNano: now, asDouble: entry.value });
    }
    for (const entry of this.histograms.values()) {
      if (!byName.has(entry.name)) { const m = { name: entry.name, unit: entry.unit, description: entry.description, histogram: { aggregationTemporality: 2, dataPoints: [] } }; byName.set(entry.name, m); metrics.push(m); }
      byName.get(entry.name).histogram.dataPoints.push({ attributes: toAttributes(entry.attrs), startTimeUnixNano: this.startNanos, timeUnixNano: now, count: String(entry.count), sum: entry.sum, min: entry.min, max: entry.max, bucketCounts: [String(entry.count)], explicitBounds: [] });
    }
    return { resourceMetrics: [{ resource: this.resource, scopeMetrics: [{ scope: { name: 'oasis', version: VERSION }, metrics }] }] };
  }

  async flushMetrics() {
    if (!this.sums.size && !this.histograms.size) return;
    await this.send('metrics', this.metricsPayload());
  }

  async flushLogs() {
    if (!this.logRecords.length) return;
    const logRecords = this.logRecords.splice(0);
    await this.send('logs', { resourceLogs: [{ resource: this.resource, scopeLogs: [{ scope: { name: 'oasis', version: VERSION }, logRecords }] }] });
  }

  async flushTraces() {
    if (!this.spans.length) return;
    const spans = this.spans.splice(0);
    await this.send('traces', { resourceSpans: [{ resource: this.resource, scopeSpans: [{ scope: { name: 'oasis', version: VERSION }, spans }] }] });
  }

  async flush() { await Promise.all([this.flushMetrics(), this.flushLogs(), this.flushTraces()]); }

  async shutdown() {
    clearInterval(this.metricTimer); clearInterval(this.logTimer);
    await this.flush();
  }
}

// One shared instance per process (per distinct telemetry env). Null when disabled.
export function getTelemetry(env = process.env) {
  if (!telemetryEnabled(env)) return null;
  const key = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER', 'OTEL_TRACES_EXPORTER', 'OTEL_EXPORTER_OTLP_HEADERS'].map((name) => env[name] || '').join('|');
  if (active && activeKey === key) return active;
  if (active) active.shutdown().catch(() => {});
  active = new Telemetry(env);
  activeKey = key;
  process.once('beforeExit', () => { if (active) active.shutdown().catch(() => {}); });
  return active;
}

export async function shutdownTelemetry() {
  if (!active) return;
  const current = active;
  active = null; activeKey = '';
  await current.shutdown();
}

export function currentSpan() { return spanContext.getStore() || null; }

// Rough line counts for file-changing tools, for oasis.lines_of_code.count.
export function lineChanges(name, args = {}) {
  const lines = (text) => (typeof text === 'string' && text.length ? text.split('\n').length : 0);
  if (name === 'write_file') return { added: lines(args.content), removed: 0 };
  if (name === 'edit_file') return { added: lines(args.new_string), removed: lines(args.old_string) };
  if (name === 'multi_edit' && Array.isArray(args.edits)) return args.edits.reduce((sum, edit) => ({ added: sum.added + lines(edit && edit.new_string), removed: sum.removed + lines(edit && edit.old_string) }), { added: 0, removed: 0 });
  if (name === 'notebook_edit') return { added: lines(args.new_source), removed: 0 };
  return { added: 0, removed: 0 };
}
