// Plugin and skill evaluation: run a plugin (or a single skill) against test cases,
// grade the results, and compare against a run without it.
//
//   oasis plugin eval DIR [--cases FILE] [--runs N] [--no-baseline] [--json] [--out FILE]
//   oasis plugin eval init DIR [--count N] [--force]
//   oasis skills eval DIR ...            (same thing; DIR holds SKILL.md)
//
// DIR is a Claude Code / OASIS plugin directory (loaded like --plugin-dir) or a skill
// directory containing SKILL.md (copied into the case workspace's .oasis/skills).
// Cases live in DIR/evals/evals.json by default:
//
//   { "cases": [ { "id": "changelog", "prompt": "Add a changelog entry for the login fix",
//       "files": { "CHANGELOG.md": "# Changelog\n" },
//       "checks": { "contains": ["login"], "notContains": [], "regex": [],
//                   "files": { "CHANGELOG.md": "login" }, "toolsUsed": ["edit_file"], "toolsNotUsed": [] },
//       "rubric": "The entry is under an Unreleased heading and names the bug." } ] }
//
// "evals" (Anthropic skill-creator layout, with expected_output / expectations) and JSONL
// files are accepted too. Every case runs in a fresh temporary workspace, once with the
// plugin and once without (the baseline), N times each. Deterministic checks score first;
// a rubric, expected_output or expectations are graded by the configured model as judge.
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const option = (args, name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const asList = (value) => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const exists = async (file) => { try { await stat(file); return true; } catch { return false; } };

export async function detectTarget(dir) {
  const root = path.resolve(dir);
  if (!await exists(root)) throw new Error('No such plugin or skill directory: ' + root);
  if (await exists(path.join(root, 'SKILL.md'))) {
    const text = await readFile(path.join(root, 'SKILL.md'), 'utf8');
    const name = (text.match(/^name:\s*["']?([^"'\n]+)/m) || [])[1] || path.basename(root);
    const description = (text.match(/^description:\s*["']?([^\n]+?)["']?\s*$/m) || [])[1] || '';
    return { kind: 'skill', root, name: name.trim(), description, skills: [{ name: name.trim(), description }] };
  }
  let manifest = {};
  for (const file of ['.claude-plugin/plugin.json', 'oasis-plugin.json', 'plugin.json']) {
    try { manifest = JSON.parse(await readFile(path.join(root, file), 'utf8')); break; } catch {}
  }
  const skills = [];
  try {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(path.join(root, 'skills'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const text = await readFile(path.join(root, 'skills', entry.name, 'SKILL.md'), 'utf8');
        skills.push({ name: ((text.match(/^name:\s*["']?([^"'\n]+)/m) || [])[1] || entry.name).trim(), description: ((text.match(/^description:\s*["']?([^\n]+?)["']?\s*$/m) || [])[1] || '').trim() });
      } catch {}
    }
  } catch {}
  return { kind: 'plugin', root, name: String(manifest.name || path.basename(root)), description: String(manifest.description || ''), skills };
}

export function normalizeCases(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.cases)) list = raw.cases;
  else if (raw && Array.isArray(raw.evals)) list = raw.evals;
  else throw new Error('The eval file needs a "cases" (or "evals") array.');
  return list.map((item, index) => {
    if (!item || typeof item.prompt !== 'string' || !item.prompt.trim()) throw new Error('Case ' + (index + 1) + ' needs a "prompt" string.');
    const checks = item.checks || {};
    const files = {};
    if (item.files && !Array.isArray(item.files) && typeof item.files === 'object') Object.assign(files, item.files);
    const rubric = [item.rubric, item.expected_output ? 'Expected outcome: ' + item.expected_output : '', ...asList(item.expectations || item.assertions).filter((x) => typeof x === 'string').map((x) => '- ' + x)].filter(Boolean).join('\n');
    return {
      id: String(item.id ?? item.name ?? index + 1),
      prompt: item.prompt,
      files,
      checks: {
        contains: asList(checks.contains).map(String),
        notContains: asList(checks.notContains || checks.not_contains).map(String),
        regex: asList(checks.regex).map(String),
        files: checks.files && typeof checks.files === 'object' ? checks.files : {},
        toolsUsed: asList(checks.toolsUsed || checks.tools_used).map(String),
        toolsNotUsed: asList(checks.toolsNotUsed || checks.tools_not_used).map(String)
      },
      rubric
    };
  });
}

async function loadCases(file) {
  const text = await readFile(file, 'utf8');
  if (/\.jsonl$/i.test(file)) return normalizeCases(text.split(/\r?\n/).filter((line) => line.trim()).map((line, i) => { try { return JSON.parse(line); } catch { throw new Error(file + ':' + (i + 1) + ' is not valid JSON.'); } }));
  return normalizeCases(JSON.parse(text));
}

function safeRelative(workspace, rel) {
  const full = path.resolve(workspace, rel);
  if (full !== workspace && !full.startsWith(workspace + path.sep)) throw new Error('Case file path escapes the workspace: ' + rel);
  return full;
}

function toolsCalled(messages = []) {
  const names = [];
  for (const message of messages) for (const call of message && message.tool_calls || []) if (call && call.function && call.function.name) names.push(call.function.name);
  return names;
}

/** Deterministic checks. Returns [{check, pass, detail}]. */
export async function runChecks(testCase, { text = '', workspace, tools = [] }) {
  const results = [];
  const c = testCase.checks;
  for (const needle of c.contains) results.push({ check: 'contains ' + JSON.stringify(needle), pass: text.toLowerCase().includes(needle.toLowerCase()) });
  for (const needle of c.notContains) results.push({ check: 'does not contain ' + JSON.stringify(needle), pass: !text.toLowerCase().includes(needle.toLowerCase()) });
  for (const pattern of c.regex) {
    let pass = false;
    try { pass = new RegExp(pattern, 'i').test(text); } catch (error) { results.push({ check: 'regex ' + pattern, pass: false, detail: 'invalid regex: ' + error.message }); continue; }
    results.push({ check: 'matches /' + pattern + '/', pass });
  }
  for (const [rel, expectation] of Object.entries(c.files)) {
    const full = safeRelative(workspace, rel);
    let content = null;
    try { content = await readFile(full, 'utf8'); } catch {}
    if (expectation === false) { results.push({ check: rel + ' absent', pass: content === null }); continue; }
    if (content === null) { results.push({ check: rel + (expectation === true ? ' exists' : ' matches /' + expectation + '/'), pass: false, detail: 'file missing' }); continue; }
    if (expectation === true) { results.push({ check: rel + ' exists', pass: true }); continue; }
    let pass = false;
    try { pass = new RegExp(String(expectation), 'i').test(content); } catch {}
    results.push({ check: rel + ' matches /' + expectation + '/', pass });
  }
  for (const name of c.toolsUsed) results.push({ check: 'used ' + name, pass: tools.some((tool) => tool === name || tool.endsWith('__' + name)) });
  for (const name of c.toolsNotUsed) results.push({ check: 'did not use ' + name, pass: !tools.some((tool) => tool === name || tool.endsWith('__' + name)) });
  return results;
}

export function parseVerdict(text) {
  const raw = String(text || '');
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const value = JSON.parse(match[0]);
      const score = typeof value.score === 'number' ? Math.max(0, Math.min(1, value.score)) : value.pass ? 1 : 0;
      return { pass: Boolean(value.pass ?? score >= 0.5), score, reason: String(value.reason || '').slice(0, 400) };
    } catch {}
  }
  const pass = /\bPASS\b/.test(raw) && !/\bFAIL\b/.test(raw);
  return { pass, score: pass ? 1 : 0, reason: raw.trim().slice(0, 400) };
}

async function judge(agent, { config, env, root }, testCase, text, changed) {
  const session = await agent.createSession({ root, config, env, tools: [], bare: true });
  session.headless = true;
  try {
    const prompt = [
      'You are grading an AI coding agent\'s answer. Reply with only JSON: {"pass": true|false, "score": 0..1, "reason": "one sentence"}.',
      '', 'Task given to the agent:', testCase.prompt,
      '', 'Grading rubric:', testCase.rubric,
      '', 'Agent\'s final answer:', text.slice(0, 12000) || '(empty)',
      changed ? '\nFiles in the workspace after the run:\n' + changed.slice(0, 12000) : ''
    ].join('\n');
    const turn = await agent.runAgentTurn(session, prompt, { env, approval: async () => false });
    return parseVerdict(turn && turn.text);
  } finally {
    if (typeof agent.closeSession === 'function') await Promise.resolve().then(() => agent.closeSession(session)).catch(() => {});
  }
}

async function snapshotFiles(workspace, limit = 12000) {
  const { readdir } = await import('node:fs/promises');
  let out = '';
  async function walk(dir, depth) {
    if (depth > 4 || out.length > limit) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (['.git', 'node_modules', '.oasis'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (out.length < limit) {
        const content = await readFile(full, 'utf8').catch(() => '');
        out += '--- ' + path.relative(workspace, full).split(path.sep).join('/') + '\n' + content.slice(0, 3000) + '\n';
      }
    }
  }
  await walk(workspace, 0);
  return out;
}

async function runOne(agent, target, testCase, { withTarget, config, env, permissionMode }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'oasis-plugin-eval-'));
  const started = Date.now();
  let session;
  try {
    for (const [rel, content] of Object.entries(testCase.files)) {
      const full = safeRelative(workspace, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    const runEnv = { ...env };
    const others = String(env.OASIS_PLUGIN_DIRS || '').split(path.delimiter).filter((dir) => dir && path.resolve(dir) !== target.root);
    if (withTarget && target.kind === 'plugin') others.push(target.root);
    runEnv.OASIS_PLUGIN_DIRS = others.join(path.delimiter);
    if (withTarget && target.kind === 'skill') await cp(target.root, path.join(workspace, '.oasis', 'skills', path.basename(target.root)), { recursive: true, filter: (src) => !src.split(path.sep).includes('evals') });
    session = await agent.createSession({ root: workspace, config, env: runEnv, permissionMode: permissionMode || 'acceptEdits' });
    session.headless = true;
    const turn = await agent.runAgentTurn(session, testCase.prompt, { env: runEnv, approval: async () => false });
    const text = String(turn && turn.text || '');
    const tools = toolsCalled(session.messages);
    const checks = await runChecks(testCase, { text, workspace, tools });
    let verdict = null;
    if (testCase.rubric) {
      try { verdict = await judge(agent, { config, env: runEnv, root: workspace }, testCase, text, await snapshotFiles(workspace)); }
      catch (error) { verdict = { pass: false, score: 0, reason: 'judge failed: ' + (error.message || error) }; }
    }
    const parts = checks.map((check) => check.pass ? 1 : 0);
    if (verdict) parts.push(verdict.score);
    const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : (text.trim() ? 1 : 0);
    return { ok: true, score, pass: checks.every((check) => check.pass) && (!verdict || verdict.pass), checks, verdict, tools, toolCalls: tools.length, durationMs: Date.now() - started, text: text.slice(0, 2000) };
  } catch (error) {
    return { ok: false, score: 0, pass: false, error: String(error && error.message || error), checks: [], tools: [], toolCalls: 0, durationMs: Date.now() - started };
  } finally {
    if (session && typeof agent.closeSession === 'function') await Promise.resolve().then(() => agent.closeSession(session)).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export async function evaluateTarget(dir, options = {}) {
  const env = options.env || process.env;
  const target = await detectTarget(dir);
  const casesFile = options.casesFile ? path.resolve(options.casesFile) : path.join(target.root, 'evals', 'evals.json');
  if (!await exists(casesFile)) throw new Error('No eval cases at ' + casesFile + '. Run `oasis plugin eval init ' + dir + '` to draft some.');
  const cases = await loadCases(casesFile);
  const agent = options.agent || await import('./agent.mjs');
  const config = options.config || await (await import('./config.mjs')).loadConfig({ env });
  if (config.configured === false) throw new Error('No model provider is configured. Run `oasis setup` first.');
  const runs = Math.min(10, Math.max(1, Number(options.runs) || 1));
  const baseline = options.baseline !== false;
  const progress = options.progress || (() => {});
  const results = [];
  for (const testCase of cases) {
    const entry = { id: testCase.id, prompt: testCase.prompt, with: [], without: [] };
    for (let i = 0; i < runs; i++) {
      entry.with.push(await runOne(agent, target, testCase, { withTarget: true, config, env, permissionMode: options.permissionMode }));
      progress(testCase.id + ' with ' + target.name + ' (' + (i + 1) + '/' + runs + ')');
      if (baseline) {
        entry.without.push(await runOne(agent, target, testCase, { withTarget: false, config, env, permissionMode: options.permissionMode }));
        progress(testCase.id + ' baseline (' + (i + 1) + '/' + runs + ')');
      }
    }
    entry.score = mean(entry.with.map((r) => r.score));
    entry.passRate = mean(entry.with.map((r) => r.pass ? 1 : 0));
    if (baseline) {
      entry.baselineScore = mean(entry.without.map((r) => r.score));
      entry.baselinePassRate = mean(entry.without.map((r) => r.pass ? 1 : 0));
      entry.delta = entry.score - entry.baselineScore;
    }
    results.push(entry);
  }
  const summary = {
    target: { kind: target.kind, name: target.name, root: target.root },
    casesFile, runs, baseline,
    score: mean(results.map((r) => r.score)),
    passRate: mean(results.map((r) => r.passRate)),
    toolCalls: mean(results.flatMap((r) => r.with.map((x) => x.toolCalls))),
    durationMs: mean(results.flatMap((r) => r.with.map((x) => x.durationMs)))
  };
  if (baseline) {
    summary.baselineScore = mean(results.map((r) => r.baselineScore));
    summary.baselinePassRate = mean(results.map((r) => r.baselinePassRate));
    summary.delta = summary.score - summary.baselineScore;
    summary.baselineToolCalls = mean(results.flatMap((r) => r.without.map((x) => x.toolCalls)));
    summary.baselineDurationMs = mean(results.flatMap((r) => r.without.map((x) => x.durationMs)));
  }
  return { summary, cases: results };
}

const pct = (value) => Math.round(value * 100) + '%';
const signed = (value) => (value >= 0 ? '+' : '') + Math.round(value * 100) + ' pts';

export function formatEvalReport(report) {
  const { summary, cases } = report;
  const lines = ['Eval: ' + summary.target.kind + ' ' + summary.target.name + ' (' + cases.length + ' case' + (cases.length === 1 ? '' : 's') + ', ' + summary.runs + ' run' + (summary.runs === 1 ? '' : 's') + ' each)', ''];
  for (const entry of cases) {
    let line = (entry.passRate === 1 ? 'PASS ' : entry.passRate === 0 ? 'FAIL ' : 'MIXED') + '  ' + entry.id + '  score ' + pct(entry.score);
    if (summary.baseline) line += '  baseline ' + pct(entry.baselineScore) + '  (' + signed(entry.delta) + ')';
    lines.push(line);
    const last = entry.with[entry.with.length - 1];
    if (last && last.error) lines.push('       error: ' + last.error);
    for (const check of last && last.checks || []) if (!check.pass) lines.push('       failed: ' + check.check + (check.detail ? ' (' + check.detail + ')' : ''));
    if (last && last.verdict && !last.verdict.pass) lines.push('       judge: ' + last.verdict.reason);
  }
  lines.push('', 'With ' + summary.target.name + ': score ' + pct(summary.score) + ', pass rate ' + pct(summary.passRate) + ', ' + summary.toolCalls.toFixed(1) + ' tool calls, ' + (summary.durationMs / 1000).toFixed(1) + 's per run');
  if (summary.baseline) {
    lines.push('Baseline:  score ' + pct(summary.baselineScore) + ', pass rate ' + pct(summary.baselinePassRate) + ', ' + summary.baselineToolCalls.toFixed(1) + ' tool calls, ' + (summary.baselineDurationMs / 1000).toFixed(1) + 's per run');
    lines.push('Delta:     ' + signed(summary.delta) + (summary.delta > 0.05 ? ' (the ' + summary.target.kind + ' helps)' : summary.delta < -0.05 ? ' (the ' + summary.target.kind + ' makes results worse)' : ' (no clear difference)'));
  }
  return lines.join('\n') + '\n';
}

function templateCases(target, count = 3) {
  const skills = target.skills.length ? target.skills : [{ name: target.name, description: target.description }];
  const cases = [];
  for (let i = 0; i < count; i++) {
    const skill = skills[i % skills.length];
    cases.push({
      id: (skill.name || 'case').replace(/[^a-z0-9-]+/gi, '-').toLowerCase() + '-' + (i + 1),
      prompt: 'TODO: a realistic request that should trigger ' + (skill.name || target.name) + (skill.description ? ' (' + skill.description.slice(0, 120) + ')' : ''),
      files: {},
      checks: { contains: [], regex: [], files: {}, toolsUsed: [], toolsNotUsed: [] },
      rubric: 'TODO: what a good answer must do.'
    });
  }
  return { cases };
}

async function draftCases(target, { agent, config, env, count = 3 } = {}) {
  if (!agent || !config || config.configured === false) return templateCases(target, count);
  const session = await agent.createSession({ root: target.root, config, env, tools: [], bare: true });
  session.headless = true;
  try {
    const prompt = [
      'Draft ' + count + ' evaluation cases for this ' + target.kind + ' of an AI coding agent. Reply with only JSON of the form',
      '{"cases":[{"id":"kebab-id","prompt":"a realistic user request","files":{"relative/path":"starting file content"},"checks":{"contains":["phrase the answer must include"],"files":{"relative/path":"regex the file must match"}},"rubric":"what a good result must do"}]}',
      'Each case should be something the ' + target.kind + ' is meant to make better. Keep files small. Prefer checks that are objective.',
      '', 'Name: ' + target.name, 'Description: ' + (target.description || '(none)'),
      'Skills:', ...target.skills.map((skill) => '- ' + skill.name + ': ' + skill.description)
    ].join('\n');
    const turn = await agent.runAgentTurn(session, prompt, { env, approval: async () => false });
    const match = String(turn && turn.text || '').match(/\{[\s\S]*\}/);
    if (match) { const parsed = JSON.parse(match[0]); normalizeCases(parsed); return parsed; }
  } catch {} finally {
    if (typeof agent.closeSession === 'function') await Promise.resolve().then(() => agent.closeSession(session)).catch(() => {});
  }
  return templateCases(target, count);
}

export async function pluginEvalCli(args = [], options = {}) {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const usage = 'Usage: oasis plugin eval DIR [--cases FILE] [--runs N] [--no-baseline] [--json] [--out FILE]\n       oasis plugin eval init DIR [--count N] [--force]\n';
  const valueFlags = new Set(['--cases', '--runs', '--out', '--count', '--permission-mode']);
  const positional = args.filter((arg, i) => !arg.startsWith('--') && !valueFlags.has(args[i - 1]));
  if (positional[0] === 'init') {
    const dir = positional[1];
    if (!dir) { stdout.write(usage); return { ok: false }; }
    const target = await detectTarget(dir);
    const file = path.join(target.root, 'evals', 'evals.json');
    if (await exists(file) && !args.includes('--force')) throw new Error(file + ' already exists. Pass --force to overwrite it.');
    const agent = options.agent || await import('./agent.mjs');
    let config = options.config;
    if (!config) { try { config = await (await import('./config.mjs')).loadConfig({ env }); } catch { config = null; } }
    const count = Math.min(20, Math.max(1, Number.parseInt(option(args, '--count', '3'), 10) || 3));
    const drafted = await draftCases(target, { agent, config, env, count });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(drafted, null, 2) + '\n');
    stdout.write('Wrote ' + drafted.cases.length + ' draft case' + (drafted.cases.length === 1 ? '' : 's') + ' to ' + file + '. Review the prompts and checks, then run `oasis plugin eval ' + dir + '`.\n');
    return { ok: true, file };
  }
  const dir = positional[0];
  if (!dir) { stdout.write(usage); return { ok: false }; }
  const report = await evaluateTarget(dir, {
    env, agent: options.agent, config: options.config,
    casesFile: option(args, '--cases'), runs: option(args, '--runs', '1'),
    baseline: !args.includes('--no-baseline'),
    permissionMode: option(args, '--permission-mode', options.permissionMode || null),
    progress: (line) => stderr.write('[eval] ' + line + '\n')
  });
  const out = option(args, '--out');
  if (out) await writeFile(path.resolve(out), JSON.stringify(report, null, 2) + '\n');
  stdout.write(args.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : formatEvalReport(report));
  return { ok: true, report };
}
