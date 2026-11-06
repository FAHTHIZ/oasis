#!/usr/bin/env node
// OASIS token-efficiency benchmark: what the harness sends, with no model.
//
// A scripted provider (no network) answers the REAL runAgentTurn loop with a
// fixed sequence of tool calls on an evals/tasks fixture (bench/tokens/
// scenarios.mjs). Every request body OASIS builds is recorded and split into
// system prompt, tool schemas, tool results and the rest of the history, so a
// change to the runtime shows up as a change in bytes sent. The same scripted
// edits are then checked with the task's own verifier, so a saving that broke
// the run would be visible too.
//
//   node bench/tokens/run.mjs                 # summary table
//   node bench/tokens/run.mjs --verbose       # plus one row per request
//   node bench/tokens/run.mjs --json out.json # full report
//   node bench/tokens/run.mjs --dump DIR      # also write each scenario's last request body
//   node bench/tokens/run.mjs --check         # exit 1 if a scenario fails or
//                                             # input grows past the baseline
//
// Tokens are estimated as characters / 4, the same estimate OASIS uses.
// "Uncached" counts the characters after the longest prefix shared with the
// previous request: the part a provider with exact-prefix caching (OpenAI,
// DeepSeek, Anthropic with breakpoints) has to process again; "cache-weighted"
// adds the reused prefix at 10%, the usual cached-token price.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const checkMode = argv.includes('--check');
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : '';
const dumpArg = argv.includes('--dump') ? argv[argv.indexOf('--dump') + 1] : '';
const baselineArg = argv.includes('--baseline') ? argv[argv.indexOf('--baseline') + 1] : '';
const BASELINE = baselineArg || path.join(repoRoot, 'bench', 'results', 'tokens-baseline.json');
// Tool results contain timings (test durations, elapsed ms), so totals move by
// a few characters between runs. --check allows this much growth.
const CHECK_TOLERANCE = 0.02;
const MAX_REQUESTS = 40;

const tok = (chars) => Math.ceil(chars / 4);

// Fixed paths keep path-dependent tool output the same length on every run.
const benchRoot = path.join(os.tmpdir(), 'oasis-token-bench');
await rm(benchRoot, { recursive: true, force: true });
await mkdir(path.join(benchRoot, 'config'), { recursive: true });
await mkdir(path.join(benchRoot, 'home'), { recursive: true });
process.env.OASIS_CONFIG_DIR = path.join(benchRoot, 'config');
process.env.OASIS_NO_UPDATE_CHECK = '1';
process.env.OASIS_TELEMETRY = '0';
delete process.env.OASIS_CONTEXT_WINDOW;

// Nothing in this benchmark may reach the network.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error('token bench: unexpected network request to ' + String(url)); };

const { createSession, runAgentTurn, closeSession } = await import('../../src/agent.mjs');
const { evalAgentEnvironment } = await import('../../src/eval.mjs');

function sourceRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: repoRoot, encoding: 'utf8' });
  return { sha: result.status === 0 ? result.stdout.trim() : null, srcDirty: Boolean(dirty.stdout && dirty.stdout.trim()) };
}

async function prepareWorkspace(scenario) {
  const taskDir = path.join(repoRoot, 'evals', 'tasks', scenario.task);
  const pointer = path.join(taskDir, 'repo', 'BASE_SNAPSHOT');
  const source = existsSync(pointer)
    ? path.join(repoRoot, 'evals', 'snapshots', (await readFile(pointer, 'utf8')).trim())
    : path.join(taskDir, 'repo');
  const workspace = path.join(benchRoot, 'ws-' + scenario.id);
  await cp(source, workspace, { recursive: true });
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.invalid', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.invalid', GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' };
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'snapshot']]) {
    const result = spawnSync('git', args, { cwd: workspace, env: gitEnv, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + result.stderr);
  }
  return { workspace, taskDir };
}

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

// Splits one chat-completions request body into its parts.
function measureRequest(body, bodyText) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = (value) => typeof value === 'string' ? value.length : value == null ? 0 : JSON.stringify(value).length;
  let system = 0, toolResults = 0, user = 0, assistant = 0;
  for (const message of messages) {
    if (message.role === 'system') system += text(message.content);
    else if (message.role === 'tool') toolResults += text(message.content);
    else if (message.role === 'user') user += text(message.content);
    else if (message.role === 'assistant') {
      assistant += text(message.content);
      for (const c of message.tool_calls || []) assistant += String(c.function && c.function.name || '').length + String(c.function && c.function.arguments || '').length;
    }
  }
  const toolSchemas = body.tools ? JSON.stringify(body.tools).length : 0;
  // What a prefix cache sees: tools first, then the conversation in order.
  const prompt = JSON.stringify(body.tools || []) + JSON.stringify(messages);
  return {
    totalChars: bodyText.length,
    systemChars: system,
    toolSchemaChars: toolSchemas,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    toolResultChars: toolResults,
    userChars: user,
    assistantChars: assistant,
    framingChars: Math.max(0, bodyText.length - system - toolSchemas - toolResults - user - assistant),
    messages: messages.length,
    prompt
  };
}

function scriptedProvider(scenario) {
  const requests = [];
  let index = 0;
  let previousPrompt = '';
  const toolCalls = [];
  let lastBody = null;
  const fetchImpl = async (url, init = {}) => {
    const bodyText = String(init.body || '');
    const body = JSON.parse(bodyText);
    const measured = measureRequest(body, bodyText);
    const reused = commonPrefix(previousPrompt, measured.prompt);
    previousPrompt = measured.prompt;
    lastBody = body;
    const { prompt, ...row } = measured;
    row.reusedPrefixChars = reused;
    row.uncachedChars = prompt.length - reused;
    requests.push(row);
    if (requests.length > MAX_REQUESTS) throw new Error('token bench: more than ' + MAX_REQUESTS + ' requests; the loop did not finish');
    const step = scenario.steps[index++];
    let message;
    if (step) {
      message = {
        role: 'assistant',
        content: step.text || null,
        tool_calls: step.calls.map((c, i) => {
          const id = 'call_' + index + '_' + i;
          toolCalls.push({ id, name: c.name, step: index });
          return { id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } };
        })
      };
    } else {
      // Script exhausted: answer. If a verification gate asks again, answer again.
      message = { role: 'assistant', content: scenario.final };
    }
    row.reply = step ? step.calls.map((c) => c.name).join(',') : 'final';
    const completion = JSON.stringify(message).length;
    const usage = { prompt_tokens: tok(bodyText.length), completion_tokens: tok(completion), total_tokens: tok(bodyText.length) + tok(completion) };
    return new Response(JSON.stringify({ id: 'bench-' + requests.length, object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: step ? 'tool_calls' : 'stop' }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, requests, toolCalls, lastBody: () => lastBody };
}

function toolOutcomes(session, toolCalls) {
  const byId = new Map();
  for (const message of session.messages) if (message.role === 'tool') byId.set(message.tool_call_id, message);
  return toolCalls.map((c) => {
    const message = byId.get(c.id);
    const content = message ? String(message.content || '') : '';
    let ok = Boolean(message);
    try { const value = JSON.parse(content); if (value && (value.error || value.ok === false)) ok = false; } catch { if (/^(Error|Tool error)/i.test(content)) ok = false; }
    return { ...c, ok, chars: content.length };
  });
}

async function runScenario(scenario) {
  const { workspace, taskDir } = await prepareWorkspace(scenario);
  const provider = scriptedProvider(scenario);
  const config = { protocol: 'openai-compatible', baseURL: 'https://token-bench.invalid/v1', model: scenario.model, apiKey: 'bench-key', maxSteps: 40 };
  const usageEvents = [];
  const env = { ...evalAgentEnvironment(process.env), HOME: path.join(benchRoot, 'home') };
  const session = await createSession({ root: workspace, config, env });
  let result;
  let error = null;
  try {
    result = await runAgentTurn(session, (await readFile(path.join(taskDir, 'task.md'), 'utf8')).trim(), {
      autoApprove: true,
      env,
      maxSteps: 40,
      fetchImpl: provider.fetchImpl,
      onUsage: (entry) => usageEvents.push(entry)
    });
  } catch (caught) {
    error = caught && caught.message || String(caught);
  }
  const tools = toolOutcomes(session, provider.toolCalls);
  if (dumpArg) await writeFile(path.join(dumpArg, scenario.id + '-last-request.json'), JSON.stringify(provider.lastBody(), null, 2) + '\n');
  closeSession(session);
  const verify = spawnSync(process.execPath, [path.join(taskDir, 'verify.mjs'), workspace], { cwd: workspace, encoding: 'utf8', timeout: 120000 });
  const requests = provider.requests;
  const sum = (key) => requests.reduce((total, row) => total + row[key], 0);
  const totals = {
    requests: requests.length,
    inputChars: sum('totalChars'),
    inputTokens: tok(sum('totalChars')),
    systemTokens: tok(sum('systemChars')),
    toolSchemaTokens: tok(sum('toolSchemaChars')),
    toolResultTokens: tok(sum('toolResultChars')),
    userTokens: tok(sum('userChars')),
    assistantTokens: tok(sum('assistantChars')),
    framingTokens: tok(sum('framingChars')),
    uncachedTokens: tok(sum('uncachedChars')),
    // Billed-equivalent input on a provider that charges cached prefix
    // tokens at 10% (OpenAI, DeepSeek and Anthropic cache reads).
    cacheWeightedTokens: tok(sum('uncachedChars') + 0.1 * sum('reusedPrefixChars')),
    firstRequestTokens: requests.length ? tok(requests[0].totalChars) : 0,
    lastRequestTokens: requests.length ? tok(requests[requests.length - 1].totalChars) : 0
  };
  const reported = usageEvents.filter((entry) => entry.phase === undefined);
  const accounting = {
    usageEvents: reported.length,
    reportedInputTokens: reported.reduce((total, entry) => total + Number(entry.inputTokens || 0), 0),
    expectedInputTokens: requests.reduce((total, row) => total + tok(row.totalChars), 0),
    taskUsageInputTokens: result && result.taskUsage ? result.taskUsage.inputTokens : null,
    taskUsageRequests: result && result.taskUsage ? result.taskUsage.requests : null
  };
  accounting.matches = accounting.usageEvents === requests.length && accounting.reportedInputTokens === accounting.expectedInputTokens && accounting.taskUsageInputTokens === accounting.expectedInputTokens && accounting.taskUsageRequests === requests.length;
  const passed = !error && verify.status === 0 && tools.every((t) => t.ok) && tools.length === scenario.steps.reduce((n, s) => n + s.calls.length, 0);
  return {
    id: scenario.id,
    task: scenario.task,
    model: scenario.model,
    passed,
    error,
    finished: Boolean(result && result.finished),
    verifier: { exitCode: verify.status, output: verify.status === 0 ? '' : String(verify.stderr || verify.stdout || '').slice(-1500) },
    toolCalls: tools,
    totals,
    accounting,
    requests
  };
}

function printScenario(report) {
  const t = report.totals;
  console.log('\n' + report.id + ' (' + report.model + '): ' + (report.passed ? 'PASS' : 'FAIL') + (report.error ? ' - ' + report.error : '') + (report.verifier.exitCode !== 0 ? ' - verifier failed' : ''));
  const failedTools = report.toolCalls.filter((c) => !c.ok);
  if (failedTools.length) console.log('  failed tool calls: ' + failedTools.map((c) => c.name + '#' + c.step).join(', '));
  console.log('  requests ' + t.requests + ', input ~' + t.inputTokens.toLocaleString('en-US') + ' tok (uncached ~' + t.uncachedTokens.toLocaleString('en-US') + ', cache-weighted ~' + t.cacheWeightedTokens.toLocaleString('en-US') + '), first request ~' + t.firstRequestTokens.toLocaleString('en-US') + ', last ~' + t.lastRequestTokens.toLocaleString('en-US'));
  const share = (n) => (100 * n / Math.max(1, t.inputTokens)).toFixed(1) + '%';
  console.log('  system prompt ~' + t.systemTokens.toLocaleString('en-US') + ' (' + share(t.systemTokens) + '), tool schemas ~' + t.toolSchemaTokens.toLocaleString('en-US') + ' (' + share(t.toolSchemaTokens) + '), tool results ~' + t.toolResultTokens.toLocaleString('en-US') + ' (' + share(t.toolResultTokens) + '), user ~' + t.userTokens.toLocaleString('en-US') + ', assistant ~' + t.assistantTokens.toLocaleString('en-US') + ', JSON framing ~' + t.framingTokens.toLocaleString('en-US'));
  console.log('  usage accounting ' + (report.accounting.matches ? 'matches' : 'MISMATCH ' + JSON.stringify(report.accounting)));
  if (verbose) {
    console.log('  #   reply                 total  system  tools  results  msgs  uncached');
    report.requests.forEach((r, i) => console.log('  ' + String(i + 1).padStart(2) + '  ' + r.reply.padEnd(20).slice(0, 20) + ' ' + String(tok(r.totalChars)).padStart(6) + ' ' + String(tok(r.systemChars)).padStart(7) + ' ' + String(tok(r.toolSchemaChars)).padStart(6) + ' ' + String(tok(r.toolResultChars)).padStart(8) + ' ' + String(r.messages).padStart(5) + ' ' + String(tok(r.uncachedChars)).padStart(9)));
  }
}

const reports = [];
for (const scenario of scenarios) reports.push(await runScenario(scenario));
globalThis.fetch = realFetch;
for (const report of reports) printScenario(report);

const output = {
  benchmark: 'oasis-token-efficiency',
  version: 1,
  generatedAt: new Date().toISOString(),
  sourceRevision: sourceRevision(),
  node: process.version,
  tokenEstimate: 'characters / 4',
  scenarios: reports
};
if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify(output, null, 2) + '\n');
  console.log('\nWrote ' + jsonOut);
}

let failed = reports.some((report) => !report.passed || !report.accounting.matches);
if (checkMode) {
  if (!existsSync(BASELINE)) {
    console.log('\nNo baseline at ' + path.relative(repoRoot, BASELINE) + '; nothing to compare.');
  } else {
    const baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
    for (const report of reports) {
      const before = (baseline.scenarios || []).find((s) => s.id === report.id);
      if (!before) continue;
      const limit = Math.ceil(before.totals.inputTokens * (1 + CHECK_TOLERANCE));
      const ok = report.totals.inputTokens <= limit;
      console.log('\ncheck ' + report.id + ': input ~' + report.totals.inputTokens + ' tok vs baseline ~' + before.totals.inputTokens + ' (limit ' + limit + ') ' + (ok ? 'ok' : 'REGRESSION'));
      if (!ok) failed = true;
    }
  }
}
await rm(benchRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
