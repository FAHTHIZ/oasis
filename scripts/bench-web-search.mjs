#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webSearch, webSearchLegacy, searchBackends } from '../src/web-search.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'evals', 'search', 'queries.json');
const fixtureBytes = await readFile(fixturePath);
const fixtures = JSON.parse(fixtureBytes.toString('utf8'));
const args = process.argv.slice(2); let outputPath = ''; let trials = 1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) outputPath = path.resolve(args[++i]);
  else if (args[i] === '--trials' && args[i + 1] && !args[i + 1].startsWith('--')) trials = Number(args[++i]);
  else if (args[i] === '--help' || args[i] === '-h') { process.stdout.write('Usage: npm run bench:search -- [--trials 1-20] [--out report.json]\n\nMeasures expected-domain retrieval and rank on the fixed query list. It does not grade factual correctness.\n'); process.exit(0); }
  else throw new Error('Unknown or incomplete option: ' + args[i]);
}
if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('--trials must be an integer from 1 to 20.');
const configured = searchBackends(process.env);
const domainOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const matches = (host, domains) => domains.some((domain) => host === domain || host.endsWith('.' + domain));
const median = (values) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
const measure = (result, fixture) => { const results = result.results || []; const rank = results.findIndex((item) => matches(domainOf(item.url), fixture.expectedDomains)); const domains = new Set(results.map((item) => domainOf(item.url)).filter(Boolean)); return { expectedDomainHit: rank >= 0, reciprocalRank: rank >= 0 ? 1 / (rank + 1) : 0, expectedDomainRank: rank >= 0 ? rank + 1 : null, resultCount: results.length, uniqueDomains: domains.size, providers: result.providers || [], providerErrors: result.providerErrors || [], backend: result.backend, elapsedMs: result.elapsedMs }; };
async function runOne(fn, fixture) { const started = Date.now(); try { const result = await fn({ query: fixture.query, max_results: 10 }); result.elapsedMs = Date.now() - started; return measure(result, fixture); } catch (error) { const result = { backend: 'error', results: [], providerErrors: [{ error: String(error && error.message || error).slice(0, 160) }] }; result.elapsedMs = Date.now() - started; return measure(result, fixture); } }
function summarize(observations) { const n = observations.length; const mean = (values) => n ? values.reduce((sum, value) => sum + value, 0) / n : null; return { observationCount: n, expectedDomainHitRate: n ? Number(mean(observations.map((item) => Number(item.expectedDomainHit))).toFixed(4)) : null, meanReciprocalRank: n ? Number(mean(observations.map((item) => item.reciprocalRank)).toFixed(4)) : null, meanResultCount: n ? Number(mean(observations.map((item) => item.resultCount)).toFixed(2)) : null, meanUniqueDomains: n ? Number(mean(observations.map((item) => item.uniqueDomains)).toFixed(2)) : null, medianLatencyMs: median(observations.map((item) => item.elapsedMs)), providerErrorCount: observations.reduce((sum, item) => sum + item.providerErrors.length, 0), backends: [...new Set(observations.map((item) => item.backend).filter(Boolean))] }; }
const rows = [];
for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex++) {
  const fixture = fixtures[fixtureIndex], observations = [];
  for (let trial = 1; trial <= trials; trial++) {
    const order = (fixtureIndex + trial) % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']; const measured = {};
    for (const side of order) measured[side] = side === 'baseline' ? await runOne((query) => webSearchLegacy(query, { env: process.env }), fixture) : await runOne((query) => webSearch({ ...query, strategy: 'federated' }, { env: process.env }), fixture);
    observations.push({ trial, order: order.join(' then '), baseline: measured.baseline, candidate: measured.candidate });
  }
  const baseline = summarize(observations.map((item) => item.baseline)), candidate = summarize(observations.map((item) => item.candidate));
  rows.push({ id: fixture.id, query: fixture.query, expectedDomains: fixture.expectedDomains, observations, baseline, candidate, delta: { meanReciprocalRank: Number((candidate.meanReciprocalRank - baseline.meanReciprocalRank).toFixed(4)), expectedDomainHitRate: Number((candidate.expectedDomainHitRate - baseline.expectedDomainHitRate).toFixed(4)), medianLatencyMs: baseline.medianLatencyMs === null || candidate.medianLatencyMs === null ? null : candidate.medianLatencyMs - baseline.medianLatencyMs } });
}
const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const revText = String(process.env.OASIS_SOURCE_REVISION || process.env.GITHUB_SHA || (rev.status === 0 ? rev.stdout : '')).trim();
const sourceRevision = /^[a-f0-9]{40}$/i.test(revText) ? revText.toLowerCase() : null;
const flatten = (side) => rows.flatMap((row) => row.observations.map((observation) => observation[side]));
const warnings = ['Expected-domain hit rate and reciprocal rank are retrieval proxies. They do not grade factual correctness, source quality, answer completeness, or research-report quality.', 'Provider caches, rate limits, index freshness, and backend changes can affect results even with the same query set. Counterbalanced call order reduces one ordering bias but does not eliminate provider-side effects.', 'Latency is measured sequentially in this process and is not a production concurrency or end-user latency benchmark.'];
if (trials === 1) warnings.push('One trial per query is a smoke-test sample, not a stable estimate. Use repeated runs and retain every report before drawing conclusions.'); else warnings.push(trials + ' paired observation(s) per query are recorded; this small fixed query list still does not establish broad search quality.');
if (configured.length < 2) warnings.push('Fewer than two API/self-hosted providers are configured. Candidate search may be the same single provider or DuckDuckGo fallback; this run cannot establish a multi-engine advantage.');
const report = { schemaVersion: 2, measurement: 'expected-domain retrieval and ranking proxy', generatedAt: new Date().toISOString(), sourceRevision, fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'), runtime: { node: process.version, platform: process.platform, arch: process.arch }, trialCountPerQuery: trials, queryCount: fixtures.length, baselineDefinition: 'Pre-federation OASIS provider selection: Tavily, then Brave, then SearXNG, otherwise DuckDuckGo HTML.', candidateDefinition: 'OASIS federated search: configured Tavily, Brave, SearXNG, Exa, and Firecrawl adapters; reciprocal-rank fusion; local domain filtering; visible provider errors; DuckDuckGo fallback.', configuredProviders: configured, warnings, baseline: summarize(flatten('baseline')), candidate: summarize(flatten('candidate')), queries: rows };
const rendered = JSON.stringify(report, null, 2);
if (outputPath) { await mkdir(path.dirname(outputPath), { recursive: true }); await writeFile(outputPath, rendered + '\n', 'utf8'); process.stdout.write('Search benchmark written to ' + outputPath + '\n'); } else process.stdout.write(rendered + '\n');