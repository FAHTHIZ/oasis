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
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 20) throw new Error('--trials must be 1-20.');
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30) throw new Error('--timeout-seconds must be at least 30.');
  return options;
}

/** Per-agent environment. With --router, every agent talks to the same OpenAI/Anthropic-compatible gateway (9Router, OmniRoute, LiteLLM, OpenRouter). */
export function agentEnvironment(agent, options, env = process.env) {
  const next = { ...env };
  const key = env.OASIS_BENCH_API_KEY || '';
  if (!options.router) return next;
  const openaiBase = /\/v1$/.test(options.router) ? options.router : options.router + '/v1';
  const anthropicBase = openaiBase.replace(/\/v1$/, '');
  if (agent === 'oasis') { next.OASIS_BASE_URL = openaiBase; next.OASIS_PROTOCOL = 'openai'; if (key) next.OASIS_API_KEY = key; }
  if (agent === 'claude') { next.ANTHROPIC_BASE_URL = anthropicBase; if (key) next.ANTHROPIC_AUTH_TOKEN = key; }
  if (agent === 'codex' || agent === 'opencode') { next.OPENAI_BASE_URL = openaiBase; if (key) next.OPENAI_API_KEY = key; }
  if (agent === 'aider') { next.OPENAI_API_BASE = openaiBase; if (key) next.OPENAI_API_KEY = key; }
  if (agent === 'gemini') { next.GOOGLE_GEMINI_BASE_URL = anthropicBase; if (key) next.GEMINI_API_KEY = key; }
  return next;
}

function modelFor(agent, options) {
  if (options.models[agent]) return options.models[agent];
  if (!options.model) return '';
  // Aider and OpenCode address OpenAI-compatible gateways with a provider prefix.
  if (options.router && agent === 'aider' && !options.model.startsWith('openai/')) return 'openai/' + options.model;
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
  const completed = runs.filter((run) => !run.skipped);
  const taskSets = completed.map((run) => new Set(run.results.map((row) => row.taskId)));
  const shared = taskSets.length ? [...taskSets[0]].filter((id) => taskSets.every((set) => set.has(id))).sort() : [];
  const fingerprints = {};
  for (const run of completed) for (const row of run.results) {
    if (!row.taskFingerprint) continue;
    (fingerprints[row.taskId] ||= new Set()).add(row.taskFingerprint);
  }
  const consistent = shared.filter((id) => !fingerprints[id] || fingerprints[id].size === 1);
  const agents = runs.map((run) => {
    if (run.skipped) return { agent: run.agent, name: run.name, skipped: run.skipped };
    const rows = run.results.filter((row) => consistent.includes(row.taskId));
    const perTask = Object.fromEntries(consistent.map((id) => {
      const trials = rows.filter((row) => row.taskId === id);
      return [id, trials.length ? trials.filter((row) => row.status === 'passed').length / trials.length : null];
    }));
    const values = Object.values(perTask).filter((value) => value !== null);
    const times = rows.map((row) => row.wallTimeMs).filter(Number.isFinite).sort((a, b) => a - b);
    const tokens = rows.map((row) => row.totalTokens).filter(Number.isFinite);
    const costs = rows.map((row) => row.costUSD);
    return {
      agent: run.agent, name: run.name, label: run.summary.label || run.name, file: run.file,
      passRate: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      passedTrials: rows.filter((row) => row.status === 'passed').length, trials: rows.length,
      medianTimeMs: times.length ? times[Math.floor(times.length / 2)] : null,
      totalTokens: tokens.length === rows.length && rows.length ? tokens.reduce((sum, value) => sum + value, 0) : null,
      totalCostUSD: rows.length && costs.every(Number.isFinite) ? Math.round(costs.reduce((sum, value) => sum + value, 0) * 1e6) / 1e6 : null,
      perTask
    };
  });
  return {
    date: now.toISOString(), oasisVersion: oasisVersion(), model: options.model || null, router: options.router ? new URL(options.router).host : null,
    trialsPerTask: options.trials, sharedTasks: consistent, excludedTasks: shared.filter((id) => !consistent.includes(id)), agents
  };
}

export function renderSummary(summary) {
  const lines = [];
  lines.push('# Head-to-head benchmark — ' + summary.date.slice(0, 10), '');
  lines.push('OASIS ' + summary.oasisVersion + ' · ' + summary.sharedTasks.length + ' shared tasks × ' + summary.trialsPerTask + ' trial(s)' + (summary.model ? ' · requested model `' + summary.model + '`' : '') + (summary.router ? ' · all agents through `' + summary.router + '`' : '') + '.', '');
  lines.push('Every agent got the same task text in a fresh copy of the same snapshot; pass/fail is decided by the task\'s own verifier after the agent exits, never by the agent. Pass rate averages each task\'s pass rate equally. With one trial per task, differences under about 10 points are noise.', '');
  lines.push('| Agent | Pass rate | Passed trials | Median time | Tokens | Cost |', '|---|---:|---:|---:|---:|---:|');
  const ranked = summary.agents.filter((item) => !item.skipped).sort((a, b) => (b.passRate ?? -1) - (a.passRate ?? -1));
  for (const item of ranked) lines.push('| ' + item.label + ' | ' + pct(item.passRate) + ' | ' + item.passedTrials + '/' + item.trials + ' | ' + seconds(item.medianTimeMs) + ' | ' + (item.totalTokens ?? 'n/a') + ' | ' + (item.totalCostUSD === null ? 'n/a' : '$' + item.totalCostUSD.toFixed(4)) + ' |');
  const skipped = summary.agents.filter((item) => item.skipped);
  if (skipped.length) {
    lines.push('', 'Not run:', '');
    for (const item of skipped) lines.push('- ' + item.name + ': ' + item.skipped);
  }
  if (summary.excludedTasks.length) lines.push('', 'Excluded because task fingerprints differed between runs: ' + summary.excludedTasks.join(', ') + '.');
  if (ranked.length && summary.sharedTasks.length) {
    lines.push('', '<details><summary>Per-task results</summary>', '', '| Task | ' + ranked.map((item) => item.name).join(' | ') + ' |', '|---|' + ranked.map(() => ':---:').join('|') + '|');
    for (const id of summary.sharedTasks) lines.push('| `' + id + '` | ' + ranked.map((item) => item.perTask[id] === null ? '–' : item.perTask[id] === 1 ? 'pass' : item.perTask[id] === 0 ? 'fail' : pct(item.perTask[id])).join(' | ') + ' |');
    lines.push('', '</details>');
  }
  lines.push('', 'Raw per-trial results (verifier output, changed files, tokens) are in the JSON files next to this summary. Reproduce with `npm run bench:live -- --yes` and the options shown in [bench/README.md](../../README.md).', '');
  return lines.join('\n');
}

async function main() {
  const options = parseBenchArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: npm run bench:live -- [options] --yes

  --agents LIST        comma-separated: ${ALL_AGENTS.join(',')} (default: all; missing CLIs are skipped)
  --model ID           model for every agent (e.g. cc/claude-opus-4-6 through 9Router)
  --model-for A=ID     per-agent model, e.g. --model-for claude=opus
  --router URL         send every agent through one OpenAI/Anthropic-compatible gateway
                       (9Router/OmniRoute http://localhost:20128/v1, LiteLLM, OpenRouter);
                       the key is read from OASIS_BENCH_API_KEY
  --trials N           trials per task (default 1; use 3+ for publishable numbers)
  --task ID            run one task
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
