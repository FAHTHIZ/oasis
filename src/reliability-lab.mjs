// Reliability laboratory: run real agent turns against a deterministic,
// reactive model while src/fault-injection.mjs breaks the model API and the
// tools on schedule, then grade the workspace, not the transcript.
//
// The model stands in for a careful one: it works through a fixed plan of
// tool calls, retries a step whose result reports an error, and moves on
// when the runtime's result says the failed step already took effect. So a
// scenario fails only when OASIS itself loses work, repeats a side effect,
// gives up on a recoverable fault, or hides what happened.
//
// Each result: passed (the workspace is right), completed (the turn reached
// the model's final answer), duplicateEffects, modelRequests, faults injected
// and duration. `node scripts/reliability-lab.mjs` prints the scorecard.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { faultLog, resetFaults } from './fault-injection.mjs';

const APPEND_SCRIPT = "import { appendFileSync } from 'node:fs';\nappendFileSync('log.txt', 'entry\\n');\nconsole.log('appended');\n";
const write = (file, content) => ({ name: 'write_file', args: { path: file, content } });
const append = () => ({ name: 'run_command', args: { command: process.execPath, args: ['append.mjs'] } });

async function text(root, file) { return readFile(path.join(root, file), 'utf8').catch(() => null); }
const lines = (value) => String(value || '').split('\n').filter(Boolean).length;

// Model faults: transport and payload failures the provider layer must absorb.
// Tool faults: failures around actions, where repeating may duplicate effects.
export const SCENARIOS = [
  { id: 'baseline', faults: '', plan: [write('a.txt', 'alpha\n'), append()], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' && lines(await text(root, 'log.txt')) === 1 },
  { id: 'model-429-once', faults: 'model:429@1', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'model-503-burst', faults: 'model:503@1-2', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'model-529-overloaded', faults: 'model:529@2', plan: [write('a.txt', 'alpha\n'), write('b.txt', 'beta\n')], check: async (root) => (await text(root, 'b.txt')) === 'beta\n' },
  { id: 'model-connection-reset', faults: 'model:reset@1', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'model-truncated-body', faults: 'model:truncate@1', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'model-garbage-body', faults: 'model:garbage@1', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'model-empty-reply', faults: 'model:empty@1', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'model-malformed-arguments', faults: 'model:malformed-args@1', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'tool-error-before-write', faults: 'tool:write_file:error@1', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'tool-slow', faults: 'tool:write_file:slow@1', plan: [write('a.txt', 'alpha\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' },
  { id: 'lost-reply-idempotent-write', faults: 'tool:write_file:lost-reply@1', plan: [write('a.txt', 'alpha\n'), write('b.txt', 'beta\n')], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' && (await text(root, 'b.txt')) === 'beta\n' },
  { id: 'lost-reply-append-command', faults: 'tool:run_command:lost-reply@1', plan: [append()], check: async (root) => lines(await text(root, 'log.txt')) === 1, duplicates: async (root) => Math.max(0, lines(await text(root, 'log.txt')) - 1) },
  { id: 'tool-error-before-command', faults: 'tool:run_command:error@1', plan: [append()], check: async (root) => lines(await text(root, 'log.txt')) === 1, duplicates: async (root) => Math.max(0, lines(await text(root, 'log.txt')) - 1) },
  { id: 'mixed-storm', faults: 'model:503@1,model:reset@3,tool:write_file:error@2,tool:run_command:lost-reply@1', plan: [write('a.txt', 'alpha\n'), write('b.txt', 'beta\n'), append()], check: async (root) => (await text(root, 'a.txt')) === 'alpha\n' && (await text(root, 'b.txt')) === 'beta\n' && lines(await text(root, 'log.txt')) === 1, duplicates: async (root) => Math.max(0, lines(await text(root, 'log.txt')) - 1) }
];

// How the stand-in model reads a tool result.
export function judgeToolResult(content) {
  const body = String(content || '');
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  const inDoubt = parsed && parsed.afterFailure && ['applied', 'changed', 'partial', 'completed'].includes(parsed.afterFailure.state);
  if (inDoubt) return 'took-effect';
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.error === 'string' && parsed.error) return 'failed';
    if (Number.isInteger(parsed.exitCode) && parsed.exitCode !== 0) return 'failed';
    if (parsed.approved === false) return 'failed';
    return 'ok';
  }
  return /^(error|tool error|interrupted)\b/i.test(body.trim()) || /\berror\b/i.test(body.slice(0, 200)) ? 'failed' : 'ok';
}

// The next action for a plan, given the conversation so far.
export function nextAction(plan, messages, maxAttemptsPerStep = 4) {
  let step = 0;
  let attempts = 0;
  const calls = new Map();
  for (const message of messages || []) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) for (const call of message.tool_calls) calls.set(call.id, call);
    if (message.role === 'tool' && calls.has(message.tool_call_id)) {
      const verdict = judgeToolResult(message.content);
      if (verdict === 'ok' || verdict === 'took-effect') { step++; attempts = 0; }
      else attempts++;
      if (attempts >= maxAttemptsPerStep) return { done: true, gaveUp: true, step };
    }
  }
  if (step >= plan.length) return { done: true, step };
  return { done: false, step, call: plan[step] };
}

async function reactiveModel(plan) {
  const state = { requests: 0, gaveUp: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests++;
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const action = nextAction(plan, payload.messages || []);
      if (action.gaveUp) state.gaveUp = true;
      const message = action.done
        ? { role: 'assistant', content: action.gaveUp ? 'Stopped: a step kept failing.' : 'All steps done.' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + state.requests, type: 'function', function: { name: action.call.name, arguments: JSON.stringify(action.call.args) } }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message, finish_reason: action.done ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { state, server, baseURL: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

const LAB_SETTINGS = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

export async function runScenario(scenario, { env = process.env } = {}) {
  const { createSession, runAgentTurn } = await import('./agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-lab-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-lab-home-'));
  const model = await reactiveModel(scenario.plan);
  const started = Date.now();
  resetFaults();
  const runEnv = { ...env, OASIS_FAULTS: scenario.faults, OASIS_FAULTS_SEED: '1', OASIS_PROVIDER_RETRIES: '3', OASIS_CONFIG_DIR: home, OASIS_ENABLE_TELEMETRY: '', OASIS_EFFECT_CONTRACTS: env.OASIS_EFFECT_CONTRACTS ?? '' };
  if (!scenario.faults) delete runEnv.OASIS_FAULTS;
  let reply = '';
  let error = '';
  try {
    await writeFile(path.join(root, 'append.mjs'), APPEND_SCRIPT);
    // A git work tree, like the projects OASIS runs in (effect contracts
    // observe commands through git).
    const git = (...args) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'lab');
    const config = { protocol: 'openai-compatible', baseURL: model.baseURL, model: 'lab-model', apiKey: '', maxSteps: 16, maxCommandSeconds: 20 };
    const session = await createSession({ root, config, settings: LAB_SETTINGS, bare: true, env: runEnv });
    const result = await runAgentTurn(session, 'Carry out the plan.', { env: runEnv, autoApprove: true });
    reply = String(result && result.text || '');
  } catch (caught) {
    error = String(caught && caught.message || caught).slice(0, 300);
  } finally {
    model.server.close();
  }
  const faults = faultLog();
  resetFaults();
  const passed = await scenario.check(root).catch(() => false);
  const duplicateEffects = scenario.duplicates ? await scenario.duplicates(root).catch(() => 0) : 0;
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await rm(home, { recursive: true, force: true }).catch(() => {});
  return {
    id: scenario.id,
    faults: scenario.faults || '(none)',
    passed,
    completed: !error && /All steps done/.test(reply),
    gaveUp: model.state.gaveUp,
    duplicateEffects,
    modelRequests: model.state.requests,
    injected: faults.length,
    durationMs: Date.now() - started,
    ...(error ? { error } : {})
  };
}

export async function runLab({ only = null, env = process.env } = {}) {
  const results = [];
  for (const scenario of SCENARIOS) {
    if (only && !only.includes(scenario.id)) continue;
    results.push(await runScenario(scenario, { env }));
  }
  const passed = results.filter((result) => result.passed && result.completed).length;
  return { results, passed, total: results.length, duplicateEffects: results.reduce((sum, result) => sum + result.duplicateEffects, 0) };
}

export function formatScorecard(lab) {
  const rows = lab.results.map((r) => '| ' + [r.id, '`' + r.faults + '`', r.passed && r.completed ? 'pass' : 'FAIL', r.completed ? 'yes' : 'no', r.duplicateEffects, r.modelRequests, r.injected, r.durationMs + ' ms', r.error ? r.error.replace(/\|/g, '/').slice(0, 80) : ''].join(' | ') + ' |');
  return ['| Scenario | Faults | Result | Completed | Duplicate effects | Model requests | Faults injected | Time | Error |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, '', lab.passed + ' of ' + lab.total + ' scenarios passed; ' + lab.duplicateEffects + ' duplicated side effect(s).'].join('\n');
}
