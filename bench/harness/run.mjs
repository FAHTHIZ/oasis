#!/usr/bin/env node
// OASIS harness benchmark: measures the runtime itself, with no model.
//
// Every score here comes from the real OASIS functions that run during a
// session, fed with a fixed labelled corpus (bench/harness/cases). Where a
// track has a meaningful "harness without this guard" baseline, the baseline
// is reported next to OASIS so the difference is visible.
//
//   node bench/harness/run.mjs            # print a summary table
//   node bench/harness/run.mjs --json out.json
//   node bench/harness/run.mjs --verbose  # list every failing case
//
// The run is deterministic apart from the startup/latency track, which uses
// wall-clock time and is reported as a median over several runs.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repairToolArguments, extractTextToolCalls } from '../../src/tool-call-repair.mjs';
import { relaxedReplace } from '../../src/edit-match.mjs';
import { analyzeCommand } from '../../src/permissions.mjs';
import { shellCommandBlocked, shellHighRisk } from '../../src/power-tools.mjs';
import { discardingGitCommand } from '../../src/git-safety.mjs';
import { findElisionPlaceholder } from '../../src/change-guard.mjs';
import { analyzeTestDiff } from '../../src/test-tamper.mjs';
import { findSecretsInText } from '../../src/secret-shield.mjs';

import * as toolCalls from './cases/tool-calls.mjs';
import * as edits from './cases/edits.mjs';
import * as commands from './cases/commands.mjs';
import * as guards from './cases/guards.mjs';
import * as heldoutV2 from './cases/heldout-v2.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : '';
const skipLatency = argv.includes('--no-latency');

const deepEqual = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);

// ------------------------------------------------------------ tool calls
function benchToolCalls(list = toolCalls.cases) {
  const names = new Set(toolCalls.TOOLS);
  const rows = [];
  for (const c of list) {
    let oasis;
    let baseline;
    if (c.kind === 'args') {
      try { oasis = repairToolArguments(c.raw).args; } catch { oasis = null; }
      try {
        const v = c.raw === '' ? {} : JSON.parse(c.raw);
        baseline = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
      } catch { baseline = null; }
    } else {
      const found = extractTextToolCalls(c.raw, names);
      oasis = found ? found.calls.map(({ name, args }) => ({ name, args })) : [];
      baseline = []; // a harness that only reads native tool calls runs nothing
    }
    rows.push({ id: c.id, kind: c.kind, oasis: deepEqual(oasis, c.expect), baseline: deepEqual(baseline, c.expect), got: oasis });
  }
  const recoverable = rows.filter((r, i) => list[i].expect !== null && !(Array.isArray(list[i].expect) && !list[i].expect.length));
  const negatives = rows.filter((r, i) => list[i].expect === null || (Array.isArray(list[i].expect) && !list[i].expect.length));
  return {
    track: 'Tool-call recovery',
    question: 'Does a damaged or text-written tool call still run, and does prose stay prose?',
    cases: rows.length,
    oasis: { correct: rows.filter((r) => r.oasis).length, recovered: recoverable.filter((r) => r.oasis).length, of: recoverable.length, falseRuns: negatives.filter((r) => !r.oasis).length, negatives: negatives.length },
    baseline: { label: 'strict JSON.parse, native calls only', correct: rows.filter((r) => r.baseline).length, recovered: recoverable.filter((r) => r.baseline).length, of: recoverable.length },
    failures: rows.filter((r) => !r.oasis).map((r) => r.id)
  };
}

// ------------------------------------------------------------------ edits
function oasisEdit(file, oldString, newString) {
  // Same order as edit_file in src/tools.mjs: exact unique match, then
  // relaxed matching only when there is no exact match at all.
  let count = 0;
  for (let at = file.indexOf(oldString); at >= 0; at = file.indexOf(oldString, at + oldString.length)) count++;
  if (count === 1) return file.replace(oldString, () => newString);
  if (count > 1) return null;
  const relaxed = relaxedReplace(file, oldString, newString);
  return relaxed ? relaxed.next : null;
}

function benchEdits(list = edits.cases) {
  const rows = list.map((c) => {
    const o = oasisEdit(c.file, c.old, c.new);
    const b = edits.exactReplace(c.file, c.old, c.new);
    return { id: c.id, oasis: o === c.expect, baseline: b === c.expect, wrongWrite: c.expect !== null ? (o !== null && o !== c.expect) : o !== null };
  });
  const apply = rows.filter((r, i) => list[i].expect !== null);
  const refuse = rows.filter((r, i) => list[i].expect === null);
  return {
    track: 'Edit application',
    question: 'Does an edit with whitespace, line-ending, indentation or quote drift land correctly, and does an ambiguous edit get refused?',
    cases: rows.length,
    oasis: { correct: rows.filter((r) => r.oasis).length, applied: apply.filter((r) => r.oasis).length, of: apply.length, refusedCorrectly: refuse.filter((r) => r.oasis).length, refuseOf: refuse.length, wrongWrites: rows.filter((r) => r.wrongWrite).length },
    baseline: { label: 'exact unique match', correct: rows.filter((r) => r.baseline).length, applied: apply.filter((r) => r.baseline).length, of: apply.length },
    failures: rows.filter((r) => !r.oasis).map((r) => r.id)
  };
}

// --------------------------------------------------------------- commands
function commandOutcome(c) {
  if (c.shell) {
    if (shellCommandBlocked(c.shell)) return 'blocked';
    if (shellHighRisk(c.shell)) return 'held';
    if (discardingGitCommand(c.shell)) return 'snapshot';
    return 'runs';
  }
  const [cmd, ...args] = c.argv;
  const analysis = analyzeCommand(cmd, args);
  if (analysis.blocked) return 'blocked';
  if (analysis.highRisk) return 'held';
  if (discardingGitCommand(cmd, args)) return 'snapshot';
  return 'runs';
}

// A pre-command snapshot only helps when the damage is to tracked/untracked
// files in the current Git working tree. New cases set `recoverable: true`
// instead of being added to this list.
const SNAPSHOT_RECOVERS = new Set(['h-git-checkout-force', 'git-reset-hard', 'git-clean', 'git-checkout-dot', 'git-restore-dot', 'git-stash-drop', 'git-stash-clear', 'chained-reset', 'argv-git-reset-hard', 'argv-git-clean', 'rm-cwd', 'rm-cwd-glob']);

function benchCommands(list = commands.cases) {
  const rows = list.map((c) => {
    const outcome = commandOutcome(c);
    const protectedOk = outcome === 'blocked' || outcome === 'held' || (outcome === 'snapshot' && (c.recoverable || SNAPSHOT_RECOVERS.has(c.id)));
    const redirected = !c.destructive && outcome === 'blocked' && Boolean(c.redirect);
    return { id: c.id, destructive: c.destructive, outcome: redirected ? 'redirected to ' + c.redirect : outcome, redirected, ok: c.destructive ? protectedOk : (outcome !== 'blocked' || redirected) };
  });
  const bad = rows.filter((r) => r.destructive);
  const good = rows.filter((r) => !r.destructive);
  const by = (list, o) => list.filter((r) => r.outcome === o).length;
  return {
    track: 'Command safety under auto-approve',
    question: 'With approvals switched off, which destructive commands are still stopped or made recoverable, and which everyday commands still run?',
    cases: rows.length,
    oasis: {
      protected: bad.filter((r) => r.ok).length, destructive: bad.length,
      blocked: by(bad, 'blocked'), held: by(bad, 'held'), snapshot: bad.filter((r) => r.outcome === 'snapshot' && r.ok).length,
      benignAllowed: good.filter((r) => r.ok).length, benign: good.length, benignRedirected: good.filter((r) => r.redirected).length, benignHeld: by(good, 'held')
    },
    baseline: { label: 'no command policy', protected: 0, destructive: bad.length, benignAllowed: good.length, benign: good.length },
    failures: rows.filter((r) => !r.ok).map((r) => r.id + ' (' + r.outcome + ')')
  };
}

// ----------------------------------------------------------------- guards
function benchGuard(track, question, list, detect, label) {
  const rows = list.map((c) => ({ id: c.id, positive: c[label], hit: Boolean(detect(c)) }));
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  return {
    track, question, cases: rows.length,
    oasis: { caught: pos.filter((r) => r.hit).length, of: pos.length, falseAlarms: neg.filter((r) => r.hit).length, negatives: neg.length },
    baseline: { label: 'no guard', caught: 0, of: pos.length, falseAlarms: 0, negatives: neg.length },
    failures: rows.filter((r) => r.hit !== r.positive).map((r) => r.id)
  };
}

// --------------------------------------------------- overhead and latency
function scriptedServer() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      requests.push({ at: process.hrtime.bigint(), payload });
      const reply = { id: 'x', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: reply.usage }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)); }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: 'http://127.0.0.1:' + server.address().port + '/v1' })));
}

const estTokens = (text) => Math.ceil(String(text).length / 4);

async function runOnce(url, home, root, extraEnv = {}) {
  const started = process.hrtime.bigint();
  const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'cli.mjs'), '-C', root, '-p', 'Say ok.'], {
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: url, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0', NO_COLOR: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, started, ended: process.hrtime.bigint(), err };
}

async function benchOverhead() {
  const { server, requests, url } = await scriptedServer();
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-root-'));
  await writeFile(path.join(root, 'package.json'), '{"name":"bench","scripts":{"test":"node --test"}}\n');
  try {
    const profiles = [
      { name: 'default', env: {} },
      { name: 'small-context (16K)', env: { OASIS_CONTEXT_WINDOW: '16384' } }
    ];
    const out = [];
    for (const profile of profiles) {
      const firstReq = [];
      const total = [];
      let payload = null;
      const runs = skipLatency ? 1 : 5;
      for (let i = 0; i < runs; i++) {
        const before = requests.length;
        const r = await runOnce(url, home, root, profile.env);
        if (r.code !== 0) throw new Error('oasis -p failed (' + r.code + '): ' + r.err.slice(-400));
        const req = requests[before];
        if (!req) throw new Error('no model request captured');
        payload = req.payload;
        firstReq.push(Number(req.at - r.started) / 1e6);
        total.push(Number(r.ended - r.started) / 1e6);
      }
      const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const system = (payload.messages || []).filter((m) => m.role === 'system').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      const toolsJson = JSON.stringify(payload.tools || []);
      out.push({
        profile: profile.name,
        tools: (payload.tools || []).length,
        systemPromptTokens: estTokens(system),
        toolSchemaTokens: estTokens(toolsJson),
        firstRequestTokens: estTokens(system) + estTokens(toolsJson),
        msToFirstModelRequest: skipLatency ? null : Math.round(median(firstReq)),
        msEndToEnd: skipLatency ? null : Math.round(median(total))
      });
    }
    return { track: 'Context overhead and startup', question: 'How much of the context window does OASIS spend before the user says anything, and how fast does a headless run reach the model?', profiles: out, note: 'Tokens are estimated as characters / 4. Times are medians of 5 cold `oasis -p` runs against a local scripted endpoint.' };
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- main
const SETS = {
  development: { toolCalls: toolCalls.cases, edits: edits.cases, commands: commands.cases, elision: guards.elision, tamper: guards.tamper, secrets: guards.secrets },
  heldout: { toolCalls: toolCalls.heldout, edits: edits.heldout, commands: commands.heldout, elision: guards.heldoutElision, tamper: guards.heldoutTamper, secrets: guards.heldoutSecrets },
  heldoutV2: heldoutV2
};
function suite(set) {
  const c = SETS[set];
  return [
    benchToolCalls(c.toolCalls),
    benchEdits(c.edits),
    benchCommands(c.commands),
    benchGuard('Placeholder (elision) guard', 'Does a write that replaces real code with "// ... rest unchanged" get stopped, without flagging ordinary comments?', c.elision, (x) => findElisionPlaceholder(x.text), 'placeholder'),
    benchGuard('Weakened-test detection', 'Does skipping, deleting or de-asserting a test get flagged, without flagging honest test changes?', c.tamper, (x) => analyzeTestDiff(x.diff).length, 'weakened'),
    benchGuard('Commit secret scanning', 'Is a credential caught before it is committed, without flagging env references, placeholders and hashes?', c.secrets, (x) => findSecretsInText(x.text).length, 'secret')
  ];
}
const results = await Promise.all(suite('development'));
const heldout = await Promise.all(suite('heldout'));
const heldoutV2Results = await Promise.all(suite('heldoutV2'));
results.push(await benchOverhead());

const report = {
  suite: 'oasis-harness-bench',
  version: 1,
  date: new Date().toISOString(),
  node: process.version,
  platform: process.platform + '-' + process.arch,
  cpus: os.cpus().length,
  sourceRevision: process.env.OASIS_SOURCE_REVISION || process.env.GITHUB_SHA || await gitRevision(),
  results,
  heldout,
  heldoutV2: heldoutV2Results
};

async function gitRevision() {
  return await new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    child.on('error', () => resolve(null));
  });
}

function line(r) {
  const o = r.oasis;
  switch (r.track) {
    case 'Tool-call recovery': return `recovered ${o.recovered}/${o.of} (${pct(o.recovered, o.of)}%) · baseline ${r.baseline.recovered}/${r.baseline.of} · wrongly ran ${o.falseRuns}/${o.negatives} negatives`;
    case 'Edit application': return `applied ${o.applied}/${o.of} (${pct(o.applied, o.of)}%) · baseline ${r.baseline.applied}/${r.baseline.of} · refused ${o.refusedCorrectly}/${o.refuseOf} bad edits · wrong writes ${o.wrongWrites}`;
    case 'Command safety under auto-approve': return `protected ${o.protected}/${o.destructive} (${pct(o.protected, o.destructive)}%: ${o.blocked} blocked, ${o.held} held, ${o.snapshot} snapshot) · everyday commands usable ${o.benignAllowed}/${o.benign} (${o.benignRedirected} via a dedicated tool)`;
    default: return `caught ${o.caught}/${o.of} (${pct(o.caught, o.of)}%) · false alarms ${o.falseAlarms}/${o.negatives}`;
  }
}

function print(title, list) {
  console.log('\n== ' + title);
  for (const r of list) {
    if (r.profiles) {
      console.log('\n' + r.track);
      for (const p of r.profiles) console.log(`  ${p.profile.padEnd(20)} tools ${String(p.tools).padStart(3)} · system ${p.systemPromptTokens} tok · schemas ${p.toolSchemaTokens} tok · first request ${p.firstRequestTokens} tok` + (p.msToFirstModelRequest !== null ? ` · ${p.msToFirstModelRequest} ms to first request · ${p.msEndToEnd} ms end to end` : ''));
      continue;
    }
    console.log('\n' + r.track + ' (' + r.cases + ' cases)\n  ' + line(r));
    if (verbose && r.failures.length) console.log('  failing: ' + r.failures.join(', '));
  }
}
print('Development set (cases the runtime was improved against)', results);
print('Held-out set v1 (untuned score: bench/results/harness-heldout-v1.json; its misses were fixed afterwards)', heldout);
print('Held-out set v2 (first score: bench/results/harness-heldout-v2.json)', heldoutV2Results);

if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify(report, null, 2) + '\n');
  console.log('\nWrote ' + jsonOut);
}
