#!/usr/bin/env node
// Head-to-head benchmark: runs OASIS and other coding agents on the same
// evaluation tasks, checks every result with the same external verifier, and
// writes a dated results folder (per-agent JSON + SUMMARY.md) that can be
// committed under bench/results/.
//
//   npm run bench:live -- --model cc/claude-opus-4-6 --router http://localhost:20128/v1 --yes
//
// API keys are read from the environment (OASIS_BENCH_API_KEY, or each agent's
// usual variables) and are never written to the results.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvalCommand, EXTERNAL_AGENTS } from '../src/eval.mjs';
import { oasisVersion } from '../src/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_AGENTS = ['oasis', 'claude', 'codex', 'gemini', 'opencode', 'aider'];
const DISPLAY = { oasis: 'OASIS', ...Object.fromEntries(Object.entries(EXTERNAL_AGENTS).map(([id, adapter]) => [id, adapter.name])) };

export function parseBenchArgs(argv) {
  const options = { agents: ALL_AGENTS.slice(), model: '', models: {}, trials: 1, task: null, router: '', outDir: '', yes: false, timeoutSeconds: 600, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined || next.startsWith('--')) throw new Error(arg + ' needs a value.'); return next; };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--agents') options.agents = value().split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg === '--model') options.model = value();
    else if (arg === '--model-for') { const [agent, ...rest] = value().split('='); options.models[agent] = rest.join('='); }
    else if (arg === '--trials') options.trials = Number(value());
    else if (arg === '--task') options.task = value();
    else if (arg === '--router') options.router = value().replace(/\/+$/, '');
    else if (arg === '--out') options.outDir = value();
    else if (arg === '--timeout-seconds') options.timeoutSeconds = Number(value());
    else throw new Error('Unknown option ' + arg + '. Run with --help.');
  }
  for (const agent of options.agents) if (!ALL_AGENTS.includes(agent)) throw new Error('Unknown agent "' + agent + '". Choose from ' + ALL_AGENTS.join(', ') + '.');
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 10) throw new Error('--trials must be 1-10, matching oasis eval.');
  if (!options.agents.length) throw new Error('--agents must name at least one agent.');
  for (const [agent, model] of Object.entries(options.models)) { if (!ALL_AGENTS.includes(agent)) throw new Error('Unknown agent in --model-for: ' + agent + '.'); if (!model.trim()) throw new Error('--model-for needs a non-empty model ID.'); }
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30 || options.timeoutSeconds > 3600) throw new Error('--timeout-seconds must be 30-3600.');
  if (options.router) { let parsed; try { parsed = new URL(options.router); } catch { throw new Error('--router must be a valid HTTP(S) URL.'); } if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('--router must be a valid HTTP(S) URL.'); }
  return options;
}

/** Per-agent environment. With --router, every agent talks to the same OpenAI/Anthropic-compatible gateway (a self-hosted proxy or OpenRouter). */
export function agentEnvironment(agent, options, env = process.env) {
  const next = { ...env };
  const key = env.OASIS_BENCH_API_KEY || '';
  if (!options.router) return next;
  const openaiBase = /\/v1$/.test(options.router) ? options.router : options.router + '/v1';
  const anthropicBase = openaiBase.replace(/\/v1$/, '');
  if (agent === 'oasis') { next.OASIS_BASE_URL = openaiBase; next.OASIS_PROTOCOL = 'openai-compatible'; if (key) next.OASIS_API_KEY = key; }
  // Claude Code 2.1.3xx answers "Not logged in" in -p mode when only
  // ANTHROPIC_AUTH_TOKEN is set; ANTHROPIC_API_KEY (x-api-key) is what makes it
  // send the request. Set both so gateways that check either header work.
  if (agent === 'claude') { next.ANTHROPIC_BASE_URL = anthropicBase; if (key) { next.ANTHROPIC_API_KEY = key; next.ANTHROPIC_AUTH_TOKEN = key; } }
  if (agent === 'codex') { next.OPENAI_BASE_URL = openaiBase; next.OASIS_CODEX_BASE_URL = openaiBase; if (key) next.OPENAI_API_KEY = key; }
  // OpenCode ignores OPENAI_BASE_URL and needs a provider entry for a custom
  // gateway; without one it fails before sending a request.
  if (agent === 'opencode' && !env.OPENCODE_CONFIG) next.OPENCODE_CONFIG_CONTENT = JSON.stringify(openCodeGatewayConfig(openaiBase, options.models.opencode || options.model, key));
  if (agent === 'aider') { next.OPENAI_API_BASE = openaiBase; if (key) next.OPENAI_API_KEY = key; }
  if (agent === 'gemini') { next.GOOGLE_GEMINI_BASE_URL = anthropicBase; if (key) next.GEMINI_API_KEY = key; }
  return next;
}

export function openCodeGatewayConfig(baseURL, model, key = '') {
  const id = String(model || '').replace(/^bench\//, '');
  return { $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', provider: { bench: { npm: '@ai-sdk/openai-compatible', name: 'Benchmark gateway', options: { baseURL, apiKey: key || 'gateway' }, models: { [id]: { name: id, tool_call: true } } } } };
}

function modelFor(agent, options) {
  if (options.models[agent]) return options.models[agent];
  if (!options.model) return '';
  // Aider and OpenCode address OpenAI-compatible gateways with a provider prefix.
  if (options.router && agent === 'aider' && !options.model.startsWith('openai/')) return 'openai/' + options.model;
  if (options.router && agent === 'opencode' && !process.env.OPENCODE_CONFIG) return 'bench/' + options.model;
  return options.model;
}

const quietOutput = (prefix) => ({ write(text) { for (const line of String(text).split('\n')) if (line.trim()) process.stdout.write(prefix + line + '\n'); return true; } });

export async function runBenchmark(options, { env = process.env, runner = runEvalCommand, now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10);
  const outDir = path.resolve(options.outDir || path.join(ROOT, 'bench', 'results', 'live-' + day));
  await mkdir(outDir, { recursive: true });
  const rawDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-live-'));
  const runs = [];
  try {
  for (const agent of options.agents) {
    const model = modelFor(agent, options);
    const args = [...(agent === 'oasis' ? [] : [EXTERNAL_AGENTS[agent].flag]), '--trials', String(options.trials), '--timeout-seconds', String(options.timeoutSeconds)];
    if (options.task) args.push('--task', options.task);
    if (model && agent !== 'oasis') args.push('--model', model);
    const agentEnv = agentEnvironment(agent, options, env);
    if (agent === 'oasis' && model) agentEnv.OASIS_MODEL = model;
    process.stdout.write('\n== ' + DISPLAY[agent] + (model ? ' (' + model + ')' : '') + '\n');
    try {
      const result = await runner(args, { autoApprove: true, env: agentEnv, output: quietOutput('  '), resultsDir: rawDir });
      // An agent that never got going (not signed in, bad model, gateway down) has not
      // been measured; scoring it 0% would be misleading.
      if (result.results.length && result.results.every((row) => row.error)) throw new Error('every trial ended in an agent error before verification (first: ' + String(result.results[0].error).split('\n')[0].slice(0, 200) + ')');
      const file = path.join(outDir, agent + '.json');
      await copyFile(result.resultsPath, file);
      runs.push({ agent, name: DISPLAY[agent], file: path.basename(file), summary: result.summary, results: result.results });
    } catch (error) {
      const message = String(error && error.message || error).split('\n')[0].slice(0, 300);
      process.stdout.write('  skipped: ' + message + '\n');
      runs.push({ agent, name: DISPLAY[agent], skipped: message });
    }
  }
  } finally {
    await rm(rawDir, { recursive: true, force: true }).catch(() => {});
  }
  const summary = summarize(runs, options, now);
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(path.join(outDir, 'SUMMARY.md'), renderSummary(summary));
  return { outDir, summary };
}

const pct = (value) => value === null || value === undefined ? 'n/a' : Math.round(value * 1000) / 10 + '%';
const seconds = (ms) => ms === null || ms === undefined ? 'n/a' : (ms / 1000).toFixed(1) + ' s';

export function summarize(runs, options, now = new Date()) {
  const completed = runs.filter((run) => !run.skipped && Array.isArray(run.results));
  const taskSets = completed.map((run) => new Set(run.results.map((row) => row.taskId)));
  const shared = taskSets.length ? [...taskSets[0]].filter((id) => taskSets.every((set) => set.has(id))).sort() : [];
  const rowsFor = (run, id) => run.results.filter((row) => row.taskId === id);
  const fingerprintFor = (rows) => {
    if (!rows.length || rows.some((row) => typeof row.taskFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.taskFingerprint))) return null;
    const values = [...new Set(rows.map((row) => row.taskFingerprint))];
    return values.length === 1 ? values[0] : 'inconsistent';
  };
  const metadataFor = (rows) => {
    const categories = [...new Set(rows.map((row) => row.category || null))];
    const difficulties = [...new Set(rows.map((row) => row.difficulty || null))];
    if (!rows.length || categories.length !== 1 || difficulties.length !== 1 || !categories[0] || !['small', 'medium', 'large'].includes(difficulties[0])) return null;
    return { category: categories[0], difficulty: difficulties[0] };
  };
  const verifiedTasks = [], unverifiedTasks = [], fingerprintMismatchTasks = [], metadataMismatchTasks = [], incompleteTasks = [], taskMetadata = {};
  for (const id of shared) {
    const groups = completed.map((run) => rowsFor(run, id));
    if (groups.some((rows) => rows.length !== options.trials || new Set(rows.map((row) => row.trial)).size !== options.trials || rows.some((row) => !Number.isInteger(row.trial) || row.trial < 1 || row.trial > options.trials))) { incompleteTasks.push(id); continue; }
    const fingerprints = groups.map(fingerprintFor);
    if (fingerprints.some((value) => value === null)) { unverifiedTasks.push(id); continue; }
    if (fingerprints.some((value) => value === 'inconsistent') || new Set(fingerprints).size !== 1) { fingerprintMismatchTasks.push(id); continue; }
    const metadata = groups.map(metadataFor);
    if (metadata.some((value) => value === null) || metadata.some((value) => value.category !== metadata[0].category || value.difficulty !== metadata[0].difficulty)) { metadataMismatchTasks.push(id); continue; }
    taskMetadata[id] = metadata[0]; verifiedTasks.push(id);
  }
  const median = (values) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : Math.round((sorted[i - 1] + sorted[i]) / 2); };
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const agents = runs.map((run) => {
    if (run.skipped) return { agent: run.agent, name: run.name, skipped: run.skipped };
    const rows = run.results.filter((row) => verifiedTasks.includes(row.taskId));
    const perTask = Object.fromEntries(verifiedTasks.map((id) => { const trials = rowsFor(run, id); return [id, trials.filter((row) => row.status === 'passed').length / trials.length]; }));
    const provider = run.summary && run.summary.provider || {};
    const tokens = rows.map((row) => row.totalTokens), costs = rows.map((row) => row.costUSD);
    return { agent: run.agent, name: run.name, label: run.summary && run.summary.label || run.name, file: run.file || null,
      requestedModel: modelFor(run.agent, options) || null, reportedModel: provider.model || run.summary && run.summary.model || null,
      cliVersion: provider.cliVersion || (run.agent === 'oasis' ? oasisVersion() : null), sourceRevision: run.summary && run.summary.sourceRevision || null, ...(run.summary && run.summary.sourceChangedDuringRun ? { sourceRevisionAtEnd: run.summary.sourceRevisionAtEnd, sourceChangedDuringRun: true } : {}), runtime: run.summary && run.summary.runtime || null,
      passRate: mean(Object.values(perTask)), passedTrials: rows.filter((row) => row.status === 'passed').length, trials: rows.length,
      medianTrialTimeMs: median(rows.map((row) => row.wallTimeMs)),
      totalTokens: rows.length && tokens.every(Number.isFinite) ? tokens.reduce((sum, value) => sum + value, 0) : null,
      totalReportedCostUSD: rows.length && costs.every(Number.isFinite) ? Math.round(costs.reduce((sum, value) => sum + value, 0) * 1e6) / 1e6 : null, perTask };
  });
  const requestedModels = Object.fromEntries(options.agents.map((agent) => [agent, modelFor(agent, options) || null]));
  const distinctModels = [...new Set(Object.values(requestedModels).filter(Boolean))];
  const caveats = [
    'Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.',
    'A shared gateway URL and requested model ID do not prove that every client was served the same underlying model or model version. Verify gateway/provider logs before calling this a same-model harness comparison.',
    'Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.'
  ];
  if (completed.length < 2) caveats.push('Fewer than two agents completed a run; this is not a head-to-head comparison.');
  if (verifiedTasks.length < 50) caveats.push('Only ' + verifiedTasks.length + ' task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.');
  if (options.trials < 3) caveats.push('Only ' + options.trials + ' trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.');
  if (!verifiedTasks.some((id) => taskMetadata[id].difficulty === 'large')) caveats.push('No verified matched task is labeled large; this run does not test larger repository-level work.');
  if (unverifiedTasks.length) caveats.push(unverifiedTasks.length + ' shared task(s) lacked valid SHA-256 fingerprints in at least one agent report and were excluded.');
  if (fingerprintMismatchTasks.length) caveats.push(fingerprintMismatchTasks.length + ' shared task(s) had inconsistent or different fingerprints and were excluded.');
  if (metadataMismatchTasks.length) caveats.push(metadataMismatchTasks.length + ' shared task(s) had missing or conflicting category/difficulty metadata and were excluded.');
  if (incompleteTasks.length) caveats.push(incompleteTasks.length + ' shared task(s) did not have exactly ' + options.trials + ' distinct trial rows for every completed agent and were excluded.');
  if (!options.router) caveats.push('No shared gateway was configured. Model/provider differences mean results describe each product as configured, not a controlled same-model harness comparison.');
  if (distinctModels.length !== 1 || options.agents.some((agent) => !requestedModels[agent])) caveats.push('The selected agents do not all have one identical, explicitly requested model ID.');
  return { date: now.toISOString(), oasisVersion: oasisVersion(), requestedModels, router: options.router ? new URL(options.router).host : null, trialsPerTask: options.trials, requestedAgents: options.agents, sharedTaskIds: shared, sharedTasks: verifiedTasks, excludedTasks: [...new Set([...unverifiedTasks, ...fingerprintMismatchTasks, ...metadataMismatchTasks, ...incompleteTasks])].sort(), unverifiedTasks, fingerprintMismatchTasks, metadataMismatchTasks, incompleteTasks, taskMetadata, caveats, agents };
}
export function renderSummary(summary) {
  const lines = [];
  const completed = summary.agents.filter((item) => !item.skipped);
  const heading = completed.length >= 2 ? 'Cross-agent task benchmark' : 'Agent evaluation run';
  lines.push('# ' + heading + ' — ' + summary.date.slice(0, 10), '');
  lines.push('OASIS ' + summary.oasisVersion + ' · ' + summary.sharedTasks.length + ' verified matched tasks × ' + summary.trialsPerTask + ' requested trial(s)' + (summary.router ? ' · shared endpoint `' + summary.router + '`' : ' · no shared endpoint') + '.', '');
  lines.push('Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.', '');
  lines.push('| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |', '|---|---|---|---:|---:|---:|---:|---:|');
  for (const item of summary.agents) {
    if (item.skipped) { lines.push('| ' + item.name + ' | — | — | not run | — | — | — | — |'); continue; }
    lines.push('| ' + item.label + ' | ' + (item.requestedModel || 'CLI default') + ' | ' + (item.reportedModel || 'not reported') + ' | ' + pct(item.passRate) + ' | ' + item.passedTrials + '/' + item.trials + ' | ' + seconds(item.medianTrialTimeMs) + ' | ' + (item.totalTokens ?? 'n/a') + ' | ' + (item.totalReportedCostUSD === null ? 'n/a' : '$' + item.totalReportedCostUSD.toFixed(4)) + ' |');
  }
  if (summary.caveats.length) { lines.push('', '## Interpretation limits', ''); for (const caveat of summary.caveats) lines.push('- ' + caveat); }
  const skipped = summary.agents.filter((item) => item.skipped);
  if (skipped.length) { lines.push('', '## Agents not run', ''); for (const item of skipped) lines.push('- ' + item.name + ': ' + item.skipped); }
  lines.push('', '## Run provenance', '', '| Agent | CLI version | Source revision | Runtime |', '|---|---|---|---|');
  for (const item of summary.agents) { if (item.skipped) continue; lines.push('| ' + item.name + ' | ' + (item.cliVersion || 'not reported') + ' | ' + (item.sourceRevision || 'unavailable') + (item.sourceChangedDuringRun ? ' (HEAD moved to ' + item.sourceRevisionAtEnd + ' during the run; the loaded code is the first revision)' : '') + ' | ' + (item.runtime ? [item.runtime.node, item.runtime.platform, item.runtime.arch].filter(Boolean).join(' / ') : 'not reported') + ' |'); }
  lines.push('', '## Task coverage', '');
  lines.push('Shared task IDs: ' + (summary.sharedTaskIds.length ? summary.sharedTaskIds.join(', ') : 'none') + '.');
  lines.push('Verified matched tasks: ' + (summary.sharedTasks.length ? summary.sharedTasks.join(', ') : 'none') + '.');
  if (summary.excludedTasks.length) lines.push('Excluded task IDs: ' + summary.excludedTasks.join(', ') + '.');
  if (summary.sharedTasks.length && completed.length) {
    lines.push('', '<details><summary>Per-task results</summary>', '', '| Task | Category | Difficulty | ' + completed.map((item) => item.name).join(' | ') + ' |', '|---|' + Array(completed.length + 2).fill('---:').join('|') + '|');
    for (const id of summary.sharedTasks) lines.push('| `' + id + '` | ' + summary.taskMetadata[id].category + ' | ' + summary.taskMetadata[id].difficulty + ' | ' + completed.map((item) => item.perTask[id] === null ? 'n/a' : pct(item.perTask[id])).join(' | ') + ' |');
    lines.push('', '</details>');
  }
  lines.push('', 'Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.', '');
  return lines.join('\n');
}
async function main() {
  const options = parseBenchArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: npm run bench:live -- [options] --yes

  --agents LIST        comma-separated: ${ALL_AGENTS.join(',')} (default: all; missing CLIs are skipped)
  --model ID           model for every agent (e.g. qwen/qwen3-coder through OpenRouter)
  --model-for A=ID     per-agent model, e.g. --model-for claude=opus
  --router URL         send every agent through one OpenAI/Anthropic-compatible gateway
                       (a self-hosted proxy, OpenRouter);
                       the key is read from OASIS_BENCH_API_KEY
  --trials N           trials per task (default 1; use 3+ for publishable numbers)
  --task ID[,ID...]    run only these tasks
  --timeout-seconds N  per-task timeout (default 600)
  --out DIR            results folder (default bench/results/live-YYYY-MM-DD)

Each agent edits disposable copies of the task snapshots with its own tools and
auto-approval. Run only on a machine where that is acceptable.
`);
    return;
  }
  if (!options.yes) throw new Error('This runs coding agents with auto-approval on disposable task copies. Re-run with --yes to start. See --help.');
  const { outDir, summary } = await runBenchmark(options);
  process.stdout.write('\n' + renderSummary(summary).split('\n').filter((line) => line.startsWith('|')).join('\n') + '\n\nResults: ' + path.join(outDir, 'SUMMARY.md') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { process.stderr.write('bench:live: ' + error.message + '\n'); process.exitCode = 1; });
