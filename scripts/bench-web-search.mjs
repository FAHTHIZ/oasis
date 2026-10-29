#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webSearch, webSearchLegacy, searchBackends } from '../src/web-search.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = JSON.parse(await readFile(path.join(root, 'evals', 'search', 'queries.json'), 'utf8'));
const args = process.argv.slice(2);
let outputPath = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) outputPath = path.resolve(args[++i]);
}
const configured = searchBackends(process.env);
const domainOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
const matches = (host, domains) => domains.some((domain) => host === domain || host.endsWith('.' + domain));
const measure = (result, fixture) => {
  const results = result.results || [];
  const rank = results.findIndex((item) => matches(domainOf(item.url), fixture.expectedDomains));
  const domains = new Set(results.map((item) => domainOf(item.url)).filter(Boolean));
  return {
    expectedDomainHit: rank >= 0,
    reciprocalRank: rank >= 0 ? 1 / (rank + 1) : 0,
    expectedDomainRank: rank >= 0 ? rank + 1 : null,
    resultCount: results.length,
    uniqueDomains: domains.size,
    providers: result.providers || [],
    providerErrors: result.providerErrors || [],
    backend: result.backend,
    elapsedMs: result.elapsedMs
  };
};
const summarize = (rows) => {
  const n = rows.length || 1;
  return {
    queryCount: rows.length,
    expectedDomainHitRate: Number((rows.filter((item) => item.metrics.expectedDomainHit).length / n).toFixed(4)),
    meanReciprocalRank: Number((rows.reduce((sum, item) => sum + item.metrics.reciprocalRank, 0) / n).toFixed(4)),
    meanResultCount: Number((rows.reduce((sum, item) => sum + item.metrics.resultCount, 0) / n).toFixed(2)),
    meanUniqueDomains: Number((rows.reduce((sum, item) => sum + item.metrics.uniqueDomains, 0) / n).toFixed(2)),
    meanLatencyMs: Math.round(rows.reduce((sum, item) => sum + item.metrics.elapsedMs, 0) / n),
    providerErrorCount: rows.reduce((sum, item) => sum + item.metrics.providerErrors.length, 0)
  };
};
async function runOne(fn, fixture) {
  const started = Date.now();
  try {
    const result = await fn({ query: fixture.query, max_results: 10 });
    result.elapsedMs = Date.now() - started;
    return { metrics: measure(result, fixture), result };
  } catch (error) {
    const result = { backend: 'error', results: [], providerErrors: [{ error: String(error && error.message || error).slice(0, 160) }] };
    result.elapsedMs = Date.now() - started;
    return { metrics: measure(result, fixture), result };
  }
}
const rows = [];
for (const fixture of fixtures) {
  const baseline = await runOne((query) => webSearchLegacy(query, { env: process.env }), fixture);
  const candidate = await runOne((query) => webSearch({ ...query, strategy: 'federated' }, { env: process.env }), fixture);
  rows.push({
    id: fixture.id, query: fixture.query, expectedDomains: fixture.expectedDomains,
    baseline: baseline.metrics, candidate: candidate.metrics,
    delta: {
      reciprocalRank: Number((candidate.metrics.reciprocalRank - baseline.metrics.reciprocalRank).toFixed(4)),
      expectedDomainHit: Number(candidate.metrics.expectedDomainHit) - Number(baseline.metrics.expectedDomainHit),
      latencyMs: candidate.metrics.elapsedMs - baseline.metrics.elapsedMs
    }
  });
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repo: 'FAHTHIZ/oasis',
  baselineDefinition: 'Pre-federation OASIS provider selection: Tavily, then Brave, then SearXNG, otherwise DuckDuckGo HTML.',
  candidateDefinition: 'OASIS federated search: configured Tavily, Brave, SearXNG, Exa, and Firecrawl adapters; reciprocal-rank fusion; local domain filtering; visible provider errors; DuckDuckGo fallback.',
  configuredProviders: configured,
  warnings: configured.length < 2
    ? ['Fewer than two API/self-hosted providers are configured. Candidate search may be the same single provider or DuckDuckGo fallback; this run cannot establish a multi-engine advantage.']
    : ['This benchmark measures expected-domain retrieval and ranking, not full factual correctness or research-report quality. Repeat with fixed provider/model versions and an agreed query set before making replacement decisions.'],
  baseline: summarize(rows.map((row) => ({ metrics: row.baseline }))),
  candidate: summarize(rows.map((row) => ({ metrics: row.candidate }))),
  queries: rows
};
const rendered = JSON.stringify(report, null, 2);
if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered + '\n', 'utf8');
  process.stdout.write('Search benchmark written to ' + outputPath + '\n');
} else {
  process.stdout.write(rendered + '\n');
}
