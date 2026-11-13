// OpenTelemetry metrics, events (logs) and traces through the official
// OpenTelemetry JS SDK (sdk-metrics, sdk-logs, sdk-trace) and its OTLP/HTTP
// exporters. The SDK loads on first use, so nothing is imported when telemetry
// is off.
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
import { randomUUID } from 'node:crypto';
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

const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0'; } catch { return '0'; }
})();
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

// Attribute values the SDK accepts; empty values are dropped as before.
const cleanAttributes = (attrs = {}) => Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== ''));

function endpointFor(env, signal) {
  const specific = env['OTEL_EXPORTER_OTLP_' + signal.toUpperCase() + '_ENDPOINT'];
  if (specific) return specific;
  return String(env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, '') + '/v1/' + signal;
}

let sdkModules = null;
function loadSdk() {
  return (sdkModules ??= Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/sdk-logs'),
    import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/otlp-transformer'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/exporter-logs-otlp-http'),
    import('@opentelemetry/exporter-trace-otlp-http')
  ]).then(([api, resources, metrics, logs, trace, transformer, metricExporter, logExporter, traceExporter]) => ({ api, resources, metrics, logs, trace, transformer, metricExporter, logExporter, traceExporter })));
}

// The console exporter prints each batch as its OTLP/JSON request body.
function consoleExporter(signal, serializer, write, extra = {}) {
  return {
    ...extra,
    export(items, done) {
      try { write('[otel ' + signal + '] ' + new TextDecoder().decode(serializer.serializeRequest(items))); done({ code: 0 }); }
      catch (error) { done({ code: 1, error }); }
    },
    forceFlush: async () => {},
    shutdown: async () => {}
  };
}

export class Telemetry {
  constructor(env = process.env, options = {}) {
    this.env = env;
    this.write = options.write || ((line) => process.stderr.write(line + '\n'));
    this.exporters = {
      metrics: String(env.OTEL_METRICS_EXPORTER || 'otlp').toLowerCase(),
      logs: String(env.OTEL_LOGS_EXPORTER || 'otlp').toLowerCase(),
      traces: String(env.OTEL_TRACES_EXPORTER || 'otlp').toLowerCase()
    };
    this.sessionId = options.sessionId || randomUUID();
    this.resourceAttributes = cleanAttributes({
      'service.name': env.OTEL_SERVICE_NAME || 'oasis',
      'service.version': options.version || VERSION,
      'os.type': process.platform,
      'host.arch': process.arch,
      'host.name': truthy(env.OTEL_HOST_NAME) ? os.hostname() : undefined,
      ...parseKeyValues(env.OTEL_RESOURCE_ATTRIBUTES)
    });
    this.logPrompts = truthy(env.OTEL_LOG_USER_PROMPTS);
    this.logToolDetails = truthy(env.OTEL_LOG_TOOL_DETAILS);
    this.metricInterval = options.manual ? 2 ** 31 - 1 : Math.max(1000, Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 60000);
    this.logInterval = options.manual ? 2 ** 31 - 1 : Math.max(500, Number(env.OTEL_LOGS_EXPORT_INTERVAL) || 5000);
    this.instruments = new Map();
    this.pending = [];
    this.sdk = null;
    this.ready = loadSdk().then((modules) => this.start(modules));
    this.ready.catch(() => {});
  }

  start(modules) {
    const { resources, metrics, logs, trace, transformer, metricExporter, logExporter, traceExporter } = modules;
    const resource = resources.resourceFromAttributes(this.resourceAttributes);
    const exporterOptions = (signal) => ({
      url: endpointFor(this.env, signal),
      headers: { ...parseKeyValues(this.env.OTEL_EXPORTER_OTLP_HEADERS), ...parseKeyValues(this.env['OTEL_EXPORTER_OTLP_' + signal.toUpperCase() + '_HEADERS']) },
      timeoutMillis: 5000
    });
    const pick = (signal, otlp, serializer, extra) => this.exporters[signal] === 'otlp' ? otlp() : this.exporters[signal] === 'console' ? consoleExporter(signal, serializer, this.write, extra) : null;
    const cumulative = { selectAggregationTemporality: () => metrics.AggregationTemporality.CUMULATIVE, selectAggregation: () => ({ type: metrics.AggregationType.DEFAULT }) };
    const metricOut = pick('metrics', () => new metricExporter.OTLPMetricExporter(exporterOptions('metrics')), transformer.JsonMetricsSerializer, cumulative);
    const logOut = pick('logs', () => new logExporter.OTLPLogExporter(exporterOptions('logs')), transformer.JsonLogsSerializer);
    const traceOut = pick('traces', () => new traceExporter.OTLPTraceExporter(exporterOptions('traces')), transformer.JsonTraceSerializer);
    this.meterProvider = new metrics.MeterProvider({ resource, readers: metricOut ? [new metrics.PeriodicExportingMetricReader({ exporter: metricOut, exportIntervalMillis: this.metricInterval, exportTimeoutMillis: Math.min(30000, this.metricInterval) })] : [] });
    this.loggerProvider = new logs.LoggerProvider({ resource, processors: logOut ? [new logs.BatchLogRecordProcessor({ exporter: logOut, scheduledDelayMillis: this.logInterval })] : [] });
    this.tracerProvider = new trace.TracerProvider({ resource, spanProcessors: traceOut ? [new trace.BatchSpanProcessor({ exporter: traceOut, scheduledDelayMillis: this.logInterval })] : [] });
    this.meter = this.meterProvider.getMeter('oasis', VERSION);
    this.logger = this.loggerProvider.getLogger('oasis', VERSION);
    this.tracer = this.tracerProvider.getTracer('oasis', VERSION);
    this.sdk = modules;
    for (const call of this.pending.splice(0)) call();
  }

  // Calls made before the SDK has loaded run as soon as it has.
  whenReady(call) { if (this.sdk) call(); else this.pending.push(call); }

  baseAttributes() { return { 'session.id': this.sessionId }; }

  // Events carry the workspace's git branch (vcs.ref.head.name); metrics stay low-cardinality.
  eventAttributes() {
    const branch = truthy(this.env.OASIS_OTEL_NO_BRANCH) ? '' : gitBranchName(this.root);
    return { ...this.baseAttributes(), ...(branch ? { 'vcs.ref.head.name': branch } : {}) };
  }

  instrument(kind, name, unit, description, buckets = null) {
    const key = kind + '\u0000' + name;
    if (!this.instruments.has(key)) {
      const options = { unit, description, valueType: this.sdk.api.ValueType.DOUBLE, ...(buckets ? { advice: { explicitBucketBoundaries: buckets } } : {}) };
      this.instruments.set(key, kind === 'counter' ? this.meter.createCounter(name, options) : this.meter.createHistogram(name, options));
    }
    return this.instruments.get(key);
  }

  // Monotonic cumulative counter.
  add(name, value = 1, attrs = {}, unit = '1', description = '') {
    if (!Number.isFinite(Number(value)) || Number(value) === 0) return;
    const all = cleanAttributes({ ...this.baseAttributes(), ...attrs });
    this.whenReady(() => this.instrument('counter', name, unit, description).add(Number(value), all));
  }

  // Histogram with the SDK's default explicit bucket boundaries.
  record(name, value, attrs = {}, unit = 'ms', description = '') {
    if (!Number.isFinite(Number(value))) return;
    const all = cleanAttributes({ ...this.baseAttributes(), ...attrs });
    this.whenReady(() => this.instrument('histogram', name, unit, description).record(Number(value), all));
  }

  // OpenTelemetry GenAI metrics (gen_ai.*). They carry only the attributes the
  // conventions list (no session.id), so dashboards built on the conventions
  // aggregate across sessions. buckets: the boundaries the conventions advise.
  genAiCount(name, value, attrs = {}, description = '') {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return;
    const all = cleanAttributes(attrs);
    this.whenReady(() => this.instrument('counter', name, '{token}', description).add(Number(value), all));
  }

  genAiRecord(name, value, attrs = {}, unit = 's', buckets = GENAI_DURATION_BUCKETS, description = '') {
    if (!Number.isFinite(Number(value))) return;
    const all = cleanAttributes(attrs);
    this.whenReady(() => this.instrument('histogram', name, unit, description, buckets).record(Number(value), all));
  }

  event(name, attrs = {}) {
    const parent = spanContext.getStore();
    const attributes = cleanAttributes({ 'event.name': name, 'event.timestamp': new Date().toISOString(), ...this.eventAttributes(), ...attrs });
    const timestamp = Date.now();
    this.whenReady(() => {
      const { api } = this.sdk;
      this.logger.emit({
        timestamp,
        observedTimestamp: timestamp,
        severityNumber: 9,
        severityText: 'INFO',
        body: name,
        attributes,
        ...(parent ? { context: api.trace.setSpan(api.ROOT_CONTEXT, parent.otel) } : {})
      });
    });
  }

  // Runs fn inside a span; nested spans and events attach to it automatically.
  // options.kind: OTLP span kind (1 internal, 3 client for calls to a model API).
  // fn receives { traceId, spanId, attrs, error }; attrs and error set during fn
  // are applied when the span ends.
  async span(name, attrs, fn, options = {}) {
    await this.ready;
    const { api } = this.sdk;
    const kind = [1, 2, 3, 4, 5].includes(options.kind) ? options.kind - 1 : api.SpanKind.INTERNAL;
    const parent = spanContext.getStore();
    const otel = this.tracer.startSpan(name, { kind }, parent ? api.trace.setSpan(api.ROOT_CONTEXT, parent.otel) : api.ROOT_CONTEXT);
    const { traceId, spanId } = otel.spanContext();
    const span = { traceId, spanId, otel, attrs: { ...this.baseAttributes(), ...attrs } };
    let status = { code: api.SpanStatusCode.OK };
    try {
      return await spanContext.run(span, () => fn(span));
    } catch (error) {
      status = { code: api.SpanStatusCode.ERROR, message: String(error && error.message || error).slice(0, 500) };
      throw error;
    } finally {
      if (span.error) status = { code: api.SpanStatusCode.ERROR, message: String(span.error).slice(0, 500) };
      otel.setAttributes(cleanAttributes(span.attrs));
      otel.setStatus(status);
      otel.end();
    }
  }

  async flush() {
    try { await this.ready; } catch { return; }
    await Promise.all([this.meterProvider.forceFlush(), this.loggerProvider.forceFlush(), this.tracerProvider.forceFlush()].map((p) => p.catch(() => {})));
  }

  async shutdown() {
    try { await this.ready; } catch { return; }
    await Promise.all([this.tracerProvider.shutdown(), this.loggerProvider.shutdown(), this.meterProvider.shutdown()].map((p) => p.catch(() => {})));
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

export async function shutdownTelemetry(timeoutMs = 2000) {
  if (!active) return;
  const current = active;
  active = null; activeKey = '';
  let timer;
  await Promise.race([current.shutdown(), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
  clearTimeout(timer);
}

// process.exit skips 'beforeExit', so explicit exits (signals, Ctrl+C twice,
// `oasis web` shutdown) flush the last spans, metrics and logs first. Bounded
// so a dead collector never delays the exit by more than a couple of seconds.
export function exitAfterTelemetry(code) {
  shutdownTelemetry().catch(() => {}).finally(() => process.exit(code));
}

// Rough line counts for file-changing tools, for oasis.lines_of_code.count.
export function lineChanges(name, args = {}) {
  const lines = (text) => (typeof text === 'string' && text.length ? text.split('\n').length : 0);
  if (name === 'write_file') return { added: lines(args.content), removed: 0 };
  if (name === 'edit_file') return { added: lines(args.new_string), removed: lines(args.old_string) };
  if (name === 'multi_edit' && Array.isArray(args.edits)) return args.edits.reduce((sum, edit) => ({ added: sum.added + lines(edit && edit.new_string), removed: sum.removed + lines(edit && edit.old_string) }), { added: 0, removed: 0 });
  if (name === 'notebook_edit') return { added: lines(args.new_source), removed: 0 };
  return { added: 0, removed: 0 };
}

// OpenTelemetry GenAI semantic conventions (gen_ai.provider.name well-known values),
// so LLM-observability backends recognise OASIS spans without custom mapping.
const GENAI_HOSTS = [
  [/(^|\.)openai\.com$/, 'openai'], [/(^|\.)openai\.azure\.com$/, 'azure.ai.openai'], [/(^|\.)anthropic\.com$/, 'anthropic'],
  [/^generativelanguage\.googleapis\.com$/, 'gcp.gemini'], [/(^|\.)aiplatform\.googleapis\.com$/, 'gcp.vertex_ai'],
  [/(^|\.)mistral\.ai$/, 'mistral_ai'], [/(^|\.)groq\.com$/, 'groq'], [/(^|\.)x\.ai$/, 'x_ai'], [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/(^|\.)perplexity\.ai$/, 'perplexity'], [/(^|\.)openrouter\.ai$/, 'openrouter'], [/(^|\.)cohere\.(com|ai)$/, 'cohere']
];

// Bucket boundaries from the OpenTelemetry GenAI conventions
// (client-inference.md, execute-tool.md, gen-ai-token-metrics.md).
const GENAI_DURATION_BUCKETS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];
export const GENAI_TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];

// OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental (the standard
// opt-in used by OpenTelemetry instrumentations) switches span names to the
// GenAI conventions: "chat MODEL", "execute_tool TOOL", "invoke_agent AGENT".
// The default keeps OASIS's oasis.* names, which Claude Code-style dashboards use.
export function genAiSpanNames(env = process.env) {
  return String(env.OTEL_SEMCONV_STABILITY_OPT_IN || '').split(',').map((item) => item.trim()).includes('gen_ai_latest_experimental');
}

// server.address / server.port for the model endpoint, when OASIS knows it.
export function genAiServer(config = {}) {
  let url;
  try { url = new URL(String(config && (config.baseUrl || config.baseURL) || '')); } catch { return {}; }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return {};
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { 'server.address': url.hostname.replace(/^\[|\]$/g, ''), 'server.port': port };
}

// A low-cardinality error.type: the HTTP status, a Node error code, an
// exception class name, or the conventions' _OTHER fallback.
export function genAiErrorType(error) {
  if (!error) return '_OTHER';
  const status = Number(error.status || error.statusCode);
  if (Number.isInteger(status) && status >= 100 && status < 600) return String(status);
  if (error.name === 'AbortError') return 'cancelled';
  if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code)) return error.code;
  if (typeof error.name === 'string' && error.name && error.name !== 'Error' && /^[A-Za-z][A-Za-z0-9_.]{1,60}$/.test(error.name)) return error.name;
  return '_OTHER';
}

export function genAiProviderName(config = {}) {
  const protocol = String(config && config.protocol || '');
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'bedrock') return 'aws.bedrock';
  if (protocol === 'vertex') return 'gcp.vertex_ai';
  if (protocol === 'foundry') return 'azure.ai.inference';
  if (protocol === 'ollama') return 'ollama';
  let host = '';
  try { host = new URL(String(config && config.baseUrl || '')).hostname.toLowerCase(); } catch {}
  for (const [pattern, name] of GENAI_HOSTS) if (host && pattern.test(host)) return name;
  if (/^(localhost|127\.|\[?::1)/.test(host) && /11434/.test(String(config.baseUrl || ''))) return 'ollama';
  return protocol === 'openai-responses' && !host ? 'openai' : (protocol || 'openai');
}
