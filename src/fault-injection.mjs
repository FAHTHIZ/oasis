// Fault injection for the reliability laboratory. OASIS_FAULTS makes the
// runtime itself misbehave at chosen moments, so recovery can be measured
// instead of assumed:
//
//   OASIS_FAULTS="model:429@1,model:reset@2,tool:run_command:lost-reply@1"
//   OASIS_FAULTS_SEED=7            (for probabilistic schedules, @p0.25)
//
// Targets and faults
//   model:<fault>              every model API request
//     429 | 500 | 502 | 503 | 529   an HTTP error with retry-after-ms: 1
//     reset                    the connection drops before a response
//     truncate                 a 200 whose body is cut in half
//     garbage                  a 200 whose body is not JSON
//     empty                    a 200 with no choices / no content
//     malformed-args           tool call arguments arrive as broken JSON
//   tool:<name|*>:<fault>      built-in and MCP tool calls
//     error                    fails before running (EIO)
//     lost-reply               runs, then the result is lost: the action
//                              happened but the agent is told it failed.
//                              The classic duplicate-side-effect trap.
//     slow                     waits 1.5 s, then runs
//
// Schedules (1-based call number for that target)
//   @3   the third call     @2-4  calls 2 to 4     @every3  every third call
//   @p0.25  each call with probability 0.25 (seeded, reproducible)
//   none: every call.
//
// Nothing changes unless OASIS_FAULTS is set. Each injected fault is recorded
// in faultLog() and, with telemetry on, as an oasis.fault_injected event.
import { getTelemetry } from './telemetry.mjs';

const MODEL_FAULTS = new Set(['429', '500', '502', '503', '529', 'reset', 'truncate', 'garbage', 'empty', 'malformed-args']);
const TOOL_FAULTS = new Set(['error', 'lost-reply', 'slow']);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseSchedule(text) {
  if (!text) return { kind: 'always' };
  let match;
  if ((match = /^(\d+)$/.exec(text))) return { kind: 'range', from: Number(match[1]), to: Number(match[1]) };
  if ((match = /^(\d+)-(\d+)$/.exec(text))) return { kind: 'range', from: Number(match[1]), to: Number(match[2]) };
  if ((match = /^every(\d+)$/.exec(text)) && Number(match[1]) > 0) return { kind: 'every', n: Number(match[1]) };
  if ((match = /^p(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(text))) return { kind: 'probability', p: Number(match[1]) };
  throw new Error('OASIS_FAULTS: unknown schedule "@' + text + '". Use @N, @N-M, @everyN or @pX.');
}

/** Parse OASIS_FAULTS into rules; throws on anything it does not understand. */
export function parseFaultSpec(spec) {
  const rules = [];
  for (const raw of String(spec || '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [body, schedule = ''] = raw.split('@');
    const parts = body.split(':');
    if (parts[0] === 'model' && parts.length === 2 && MODEL_FAULTS.has(parts[1])) rules.push({ target: 'model', tool: null, fault: parts[1], schedule: parseSchedule(schedule), text: raw });
    else if (parts[0] === 'tool' && parts.length === 3 && /^[\w.*-]+$/.test(parts[1]) && TOOL_FAULTS.has(parts[2])) rules.push({ target: 'tool', tool: parts[1], fault: parts[2], schedule: parseSchedule(schedule), text: raw });
    else throw new Error('OASIS_FAULTS: cannot read "' + raw + '". Expected model:<' + [...MODEL_FAULTS].join('|') + '> or tool:<name|*>:<' + [...TOOL_FAULTS].join('|') + '>, optionally @schedule.');
  }
  return rules;
}

// One plan per distinct spec+seed, so call counters persist across requests
// within a process (a run) and a new spec starts fresh.
let activePlan = null;

export function faultPlan(env = process.env) {
  const spec = String(env && env.OASIS_FAULTS || '').trim();
  if (!spec) return null;
  const seed = Number.parseInt(env.OASIS_FAULTS_SEED || '1', 10) || 1;
  const key = spec + '|' + seed;
  if (activePlan && activePlan.key === key) return activePlan;
  activePlan = { key, rules: parseFaultSpec(spec), counters: new Map(), random: mulberry32(seed), log: [], env };
  return activePlan;
}

export function resetFaults() { activePlan = null; }

/** Every fault injected by the current plan, in order. */
export function faultLog() { return activePlan ? activePlan.log.slice() : []; }

function due(plan, rule, count) {
  const s = rule.schedule;
  if (s.kind === 'always') return true;
  if (s.kind === 'range') return count >= s.from && count <= s.to;
  if (s.kind === 'every') return count % s.n === 0;
  return plan.random() < s.p;
}

function pick(plan, target, toolName) {
  const key = target === 'model' ? 'model' : 'tool:' + toolName;
  const count = (plan.counters.get(key) || 0) + 1;
  plan.counters.set(key, count);
  // Tool rules for "*" count every tool call together.
  let anyCount = 0;
  if (target === 'tool') { anyCount = (plan.counters.get('tool:*') || 0) + 1; plan.counters.set('tool:*', anyCount); }
  for (const rule of plan.rules) {
    if (rule.target !== target) continue;
    if (target === 'tool' && rule.tool !== '*' && rule.tool !== toolName) continue;
    if (due(plan, rule, target === 'tool' && rule.tool === '*' ? anyCount : count)) return { rule, count };
  }
  return null;
}

function record(plan, entry) {
  plan.log.push({ ...entry, at: new Date().toISOString() });
  const tel = getTelemetry(plan.env);
  if (tel) tel.event('oasis.fault_injected', { target: entry.target, fault: entry.fault, call: entry.call, ...(entry.tool ? { tool_name: entry.tool } : {}) });
}

const jsonResponse = (status, body, extra = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '1', ...extra } });

function corruptArguments(payload) {
  let changed = false;
  for (const choice of payload && payload.choices || []) {
    for (const call of choice.message && choice.message.tool_calls || []) {
      if (call.function && typeof call.function.arguments === 'string') { call.function.arguments = call.function.arguments.slice(0, Math.max(1, Math.floor(call.function.arguments.length / 2))); changed = true; }
    }
  }
  for (const block of payload && payload.content || []) {
    if (block && block.type === 'tool_use') { block.input = '{"broken'; changed = true; }
  }
  return changed;
}

/** fetch for model requests, with the plan's model faults applied. */
export function wrapModelFetch(fetchImpl, env = process.env) {
  const plan = faultPlan(env);
  if (!plan || !plan.rules.some((rule) => rule.target === 'model')) return fetchImpl;
  return async (url, init) => {
    const hit = pick(plan, 'model');
    if (!hit) return fetchImpl(url, init);
    const { fault } = hit.rule;
    record(plan, { target: 'model', fault, call: hit.count });
    if (/^\d{3}$/.test(fault)) return jsonResponse(Number(fault), { error: { message: 'Injected fault: HTTP ' + fault, type: fault === '429' ? 'rate_limit_error' : 'server_error' } });
    if (fault === 'reset') {
      const cause = Object.assign(new Error('socket hang up (injected)'), { code: 'ECONNRESET' });
      throw new TypeError('fetch failed', { cause });
    }
    const response = await fetchImpl(url, init);
    const text = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    delete headers['content-length']; delete headers['content-encoding'];
    if (fault === 'truncate') return new Response(text.slice(0, Math.floor(text.length / 2)), { status: response.status, headers });
    if (fault === 'garbage') return new Response('<html>502 Bad Gateway (injected)</html>', { status: 200, headers: { ...headers, 'content-type': 'application/json' } });
    if (fault === 'empty') return jsonResponse(200, { choices: [], content: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } });
    // malformed-args: only non-streaming JSON bodies can be rewritten.
    try {
      const payload = JSON.parse(text);
      if (corruptArguments(payload)) return new Response(JSON.stringify(payload), { status: response.status, headers });
    } catch {}
    return new Response(text, { status: response.status, headers });
  };
}

/** Run a tool call with the plan's tool faults applied. */
export async function withToolFaults(name, env, run) {
  const plan = faultPlan(env);
  if (!plan || !plan.rules.some((rule) => rule.target === 'tool')) return run();
  const hit = pick(plan, 'tool', name);
  if (!hit) return run();
  const { fault } = hit.rule;
  record(plan, { target: 'tool', tool: name, fault, call: hit.count });
  if (fault === 'error') throw Object.assign(new Error('EIO: i/o error (injected fault) while running ' + name), { code: 'EIO' });
  if (fault === 'slow') { await new Promise((resolve) => setTimeout(resolve, 1500)); return run(); }
  await run();
  throw Object.assign(new Error('Connection to the tool was lost before its result arrived (injected fault). It may or may not have completed.'), { code: 'ECONNRESET' });
}
