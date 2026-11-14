import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseBenchArgs, agentEnvironment, geminiGatewayEnv, runBenchmark, summarize, renderSummary } from '../scripts/bench-live.mjs';
import { parseAiderOutput, parseOpenCodeOutput, buildAiderArgs, buildOpenCodeArgs, buildCodexArgs, EXTERNAL_AGENTS } from '../src/eval.mjs';

test('bench:live parses options and refuses unknown agents', () => {
  const options = parseBenchArgs(['--agents', 'oasis,claude', '--model', 'cc/claude-opus-4-6', '--router', 'http://localhost:20128/v1/', '--trials', '3', '--yes']);
  assert.deepEqual(options.agents, ['oasis', 'claude']);
  assert.equal(options.router, 'http://localhost:20128/v1');
  assert.equal(options.trials, 3);
  assert.throws(() => parseBenchArgs(['--agents', 'cursor']), /Unknown agent/);
  assert.throws(() => parseBenchArgs(['--trials', '0']), /trials/);
});

test('--router points every agent at the same gateway with the shared key', () => {
  const options = parseBenchArgs(['--router', 'http://localhost:20128/v1']);
  const env = { OASIS_BENCH_API_KEY: 'sk-test', PATH: '/bin' };
  assert.equal(agentEnvironment('oasis', options, env).OASIS_BASE_URL, 'http://localhost:20128/v1');
  assert.equal(agentEnvironment('oasis', options, env).OASIS_API_KEY, 'sk-test');
  assert.equal(agentEnvironment('claude', options, env).ANTHROPIC_BASE_URL, 'http://localhost:20128');
  assert.equal(agentEnvironment('claude', options, env).ANTHROPIC_AUTH_TOKEN, 'sk-test');
  // Without ANTHROPIC_API_KEY current Claude Code stops at "Not logged in" before any request.
  assert.equal(agentEnvironment('claude', options, env).ANTHROPIC_API_KEY, 'sk-test');
  assert.equal(agentEnvironment('codex', options, env).OPENAI_BASE_URL, 'http://localhost:20128/v1');
  assert.equal(agentEnvironment('codex', options, env).OASIS_CODEX_BASE_URL, 'http://localhost:20128/v1');
  assert.equal(agentEnvironment('aider', options, env).OPENAI_API_BASE, 'http://localhost:20128/v1');
  assert.equal(agentEnvironment('oasis', parseBenchArgs([]), env).OASIS_BASE_URL, undefined);
});

test('runBenchmark scores agents only on shared, identical tasks and never writes the key', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-live-test-'));
  const calls = [];
  const runner = async (args, { env, resultsDir }) => {
    calls.push({ args, env });
    const external = args[0] && args[0].startsWith('--') && args[0] !== '--trials';
    if (args[0] === '--codex') throw new Error('Could not start the Codex CLI (codex). Install it.');
    const rows = [
      { taskId: 'a', taskFingerprint: 'a'.repeat(64), category: 'utility-logic', difficulty: 'small', trial: 1, status: 'passed', wallTimeMs: 1000, totalTokens: 10, costUSD: 0.01 },
      { taskId: 'b', taskFingerprint: 'b'.repeat(64), category: 'configuration-integration', difficulty: 'large', trial: 1, status: external ? 'failed' : 'passed', wallTimeMs: 3000, totalTokens: 20, costUSD: 0.02 },
      ...(external ? [] : [{ taskId: 'only-oasis', taskFingerprint: 'c'.repeat(64), category: 'utility-logic', difficulty: 'small', trial: 1, status: 'passed', wallTimeMs: 5, totalTokens: 1, costUSD: 0 }])
    ];
    const file = path.join(resultsDir, 'run-' + calls.length + '.json');
    await writeFile(file, JSON.stringify({ results: rows }));
    return { resultsPath: file, summary: { label: external ? 'Claude Code 2.1.300 (opus)' : 'OASIS 1.0.0 (opus)' }, results: rows };
  };
  try {
    const options = parseBenchArgs(['--agents', 'oasis,claude,codex', '--model', 'opus', '--router', 'http://localhost:20128/v1', '--out', out, '--yes']);
    const { summary } = await runBenchmark(options, { env: { OASIS_BENCH_API_KEY: 'sk-secret-value' }, runner });
    assert.deepEqual(summary.sharedTasks, ['a', 'b']);
    const [oasis, claude, codex] = summary.agents;
    assert.equal(oasis.passRate, 1);
    assert.equal(claude.passRate, 0.5);
    assert.match(codex.skipped, /Could not start/);
    assert.equal(calls[0].env.OASIS_MODEL, 'opus');
    assert.ok(calls[1].args.includes('--claude-code') && calls[1].args.includes('opus'));
    const markdown = await readFile(path.join(out, 'SUMMARY.md'), 'utf8');
    assert.match(markdown, /\| OASIS 1\.0\.0 \(opus\).*100%.*2\/2/);
    assert.match(markdown, /complete matching SHA-256 task fingerprints/);
    assert.match(markdown, /not a confidence interval or significance test/);
    assert.match(markdown, /Codex CLI: Could not start/);
    for (const name of ['SUMMARY.md', 'summary.json', 'oasis.json', 'claude.json']) {
      assert.doesNotMatch(await readFile(path.join(out, name), 'utf8'), /sk-secret-value/);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('an agent that errors before verification on every trial is reported as not run, not 0%', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-live-err-'));
  try {
    const runner = async (args, { resultsDir }) => {
      const rows = [{ taskId: 'a', status: 'failed', error: 'Claude Code did not return a valid JSON result: not logged in' }];
      const file = path.join(resultsDir, 'r.json');
      await writeFile(file, '{}');
      return { resultsPath: file, summary: {}, results: rows };
    };
    const { summary } = await runBenchmark(parseBenchArgs(['--agents', 'claude', '--out', out]), { runner });
    assert.match(summary.agents[0].skipped, /every trial ended in an agent error.*not logged in/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('OpenCode and Aider adapters build non-interactive commands and tolerate any output', () => {
  assert.equal(EXTERNAL_AGENTS.opencode.flag, '--opencode');
  assert.equal(EXTERNAL_AGENTS.aider.flag, '--aider');
  assert.deepEqual(buildOpenCodeArgs({ model: 'p/m' }, 'fix it'), ['run', '--format', 'json', '-m', 'p/m', 'fix it']);
  assert.ok(buildAiderArgs({}, 'fix it').includes('--yes-always'));
  assert.ok(!buildAiderArgs({}, 'fix it').includes('--timeout'));
  const timed = buildAiderArgs({ timeoutSeconds: 2700 }, 'fix it');
  assert.equal(timed[timed.indexOf('--timeout') + 1], '2700', 'slow local models must not hit litellm\'s 600 s default');
  const open = parseOpenCodeOutput('{"type":"tool_use","part":{"type":"tool"}}\n{"type":"text","part":{"type":"text","text":"done"}}\n{"type":"step_finish","part":{"tokens":{"input":100,"output":20,"reasoning":5},"cost":0.002}}');
  assert.equal(open.totalTokens, 125);
  assert.equal(open.result, 'done');
  assert.equal(parseOpenCodeOutput('plain text output').isError, false);
  assert.equal(parseOpenCodeOutput('{"type":"error","error":{"message":"bad key"}}').isError, true);
  const aider = parseAiderOutput('Main model: gpt-4o\nTokens: 4.2k sent, 310 received. Cost: $0.01 message, $0.03 session.');
  assert.equal(aider.inputTokens, 4200);
  assert.equal(aider.costUSD, 0.03);
  assert.equal(aider.model, 'gpt-4o');
});


test('live summary excludes missing, mismatched, and incomplete task fingerprints from headline scores', () => {
  const options = parseBenchArgs(['--agents', 'oasis,claude', '--model', 'same-model', '--trials', '2']);
  const make = (agent, rows) => ({ agent, name: agent, summary: { label: agent, sourceRevision: 'd'.repeat(40), provider: { model: 'same-model' }, runtime: { node: 'v22', platform: 'linux', arch: 'x64' } }, results: rows });
  const rows = (id, fingerprint, trialCount = 2) => Array.from({ length: trialCount }, (_, index) => ({
    taskId: id, taskFingerprint: fingerprint, category: 'configuration-integration', difficulty: 'large', trial: index + 1,
    status: 'passed', wallTimeMs: 100, totalTokens: 50, costUSD: 0.01
  }));
  const a = [...rows('verified', 'a'.repeat(64)), ...rows('legacy', undefined).map(({ taskFingerprint, ...row }) => row), ...rows('changed', 'b'.repeat(64)), ...rows('short', 'c'.repeat(64))];
  const b = [...rows('verified', 'a'.repeat(64)), ...rows('legacy', undefined).map(({ taskFingerprint, ...row }) => row), ...rows('changed', 'e'.repeat(64)), ...rows('short', 'c'.repeat(64), 1)];
  const summary = summarize([make('oasis', a), make('claude', b)], options, new Date('2026-11-05T00:00:00Z'));
  assert.deepEqual(summary.sharedTasks, ['verified']);
  assert.deepEqual(summary.unverifiedTasks, ['legacy']);
  assert.deepEqual(summary.fingerprintMismatchTasks, ['changed']);
  assert.deepEqual(summary.incompleteTasks, ['short']);
  assert.equal(summary.agents[0].passRate, 1);
  const rendered = renderSummary(summary);
  assert.match(rendered, /Only 1 task\(s\) have complete, identical SHA-256/);
  assert.match(rendered, /Excluded task IDs: changed, legacy, short/);
  assert.doesNotMatch(rendered, /about 10 points are noise/);
});

test('live summary records provenance and does not call one agent a head-to-head', () => {
  const options = parseBenchArgs(['--agents', 'oasis']);
  const summary = summarize([{ agent: 'oasis', name: 'OASIS', summary: { label: 'OASIS fixture', sourceRevision: 'a'.repeat(40), provider: { model: 'fixture-model' }, runtime: { node: 'v22', platform: 'linux', arch: 'x64' } }, results: [] }], options);
  assert.ok(summary.caveats.some((item) => item.includes('not a head-to-head')));
  assert.equal(summary.agents[0].reportedModel, 'fixture-model');
  assert.equal(summary.agents[0].sourceRevision, 'a'.repeat(40));
});

test('live benchmark enforces eval-compatible trial limits and valid router URLs', () => {
  assert.throws(() => parseBenchArgs(['--trials', '11']), /matching oasis eval/);
  assert.throws(() => parseBenchArgs(['--agents', '']), /at least one agent/);
  assert.throws(() => parseBenchArgs(['--router', 'file:///tmp/gateway']), /HTTP\(S\) URL/);
});

test('OpenCode gets a generated gateway provider, since it ignores OPENAI_BASE_URL', () => {
  const options = parseBenchArgs(['--agents', 'opencode', '--model', 'qwen3-coder', '--router', 'http://127.0.0.1:8789', '--yes']);
  const env = agentEnvironment('opencode', options, { OASIS_BENCH_API_KEY: 'k' });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.provider.bench.options.baseURL, 'http://127.0.0.1:8789/v1');
  assert.equal(config.provider.bench.options.apiKey, 'k');
  assert.ok(config.provider.bench.models['qwen3-coder'].tool_call);
  assert.equal(agentEnvironment('opencode', options, { OPENCODE_CONFIG: '/x.json' }).OPENCODE_CONFIG_CONTENT, undefined);
});

test('live benchmark respects an OpenCode config supplied through its injected environment', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-opencode-env-'));
  const calls = [];
  try {
    const runner = async (args, { resultsDir }) => {
      calls.push(args);
      const rows = [{ taskId: 'a', taskFingerprint: 'a'.repeat(64), category: 'utility-logic', difficulty: 'small', trial: 1, status: 'passed', wallTimeMs: 10, totalTokens: 1, costUSD: 0 }];
      const file = path.join(resultsDir, 'opencode.json');
      await writeFile(file, JSON.stringify({ results: rows }));
      return { resultsPath: file, summary: { label: 'OpenCode fixture' }, results: rows };
    };
    await runBenchmark(parseBenchArgs(['--agents', 'opencode', '--model', 'qwen3-coder', '--router', 'http://127.0.0.1:8789/v1', '--out', out]), {
      env: { OPENCODE_CONFIG: '/tmp/custom-opencode.json', OASIS_BENCH_API_KEY: 'test-key' }, runner
    });
    assert.ok(calls[0].includes('qwen3-coder'));
    assert.ok(!calls[0].includes('bench/qwen3-coder'), 'custom config owns the provider name; do not inject the generated bench prefix');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('Codex gets a gateway provider entry because it ignores OPENAI_BASE_URL', () => {
  const args = buildCodexArgs({ model: 'm1' }, 'do it', { OASIS_CODEX_BASE_URL: 'http://127.0.0.1:20128/v1' });
  assert.ok(args.includes('model_provider=bench'));
  assert.ok(args.includes('model_providers.bench.base_url="http://127.0.0.1:20128/v1"'));
  assert.ok(args.includes('model_providers.bench.env_key="OPENAI_API_KEY"'));
  assert.deepEqual(args.slice(-3), ['-m', 'm1', 'do it']);
  assert.ok(!buildCodexArgs({}, 'x', {}).includes('-c'));
});

test('live summary verifies same-model only from the gateway record', async () => {
  const { gatewayReport } = await import('../scripts/bench-gateway.mjs');
  const options = parseBenchArgs(['--agents', 'oasis,claude', '--model', 'm', '--upstream', 'https://openrouter.ai/api/v1']);
  const make = (agent) => ({ agent, name: agent, summary: { label: agent }, results: [{ taskId: 't', taskFingerprint: 'a'.repeat(64), category: 'c', difficulty: 'small', trial: 1, status: 'passed' }] });
  const ok = summarize([make('oasis'), make('claude')], options, new Date(), gatewayReport([{ agent: 'oasis', status: 200, servedModel: 'm', provider: 'P' }, { agent: 'claude', status: 200, servedModel: 'm', provider: 'P' }]));
  assert.equal(ok.sameModelVerified, true);
  assert.ok(!ok.caveats.some((c) => /do not prove/.test(c)));
  assert.match(renderSummary(ok), /Same model verified/);
  const bad = summarize([make('oasis'), make('claude')], options, new Date(), gatewayReport([{ agent: 'oasis', status: 200, servedModel: 'm' }, { agent: 'claude', status: 200, servedModel: 'other' }]));
  assert.equal(bad.sameModelVerified, false);
  assert.ok(bad.caveats.some((c) => /not a verified same-model/.test(c)));
  const none = summarize([make('oasis'), make('claude')], parseBenchArgs(['--agents', 'oasis,claude', '--model', 'm']), new Date());
  assert.ok(none.caveats.some((c) => /do not prove/.test(c)));
  assert.throws(() => parseBenchArgs(['--router', 'http://x', '--upstream', 'https://y']), /either/);
});

test('an agent skipped after a few gateway calls does not void same-model verification', async () => {
  const { gatewayReport } = await import('../scripts/bench-gateway.mjs');
  const options = parseBenchArgs(['--agents', 'oasis,codex,claude', '--model', 'm', '--upstream', 'https://openrouter.ai/api/v1']);
  const make = (agent) => ({ agent, name: agent, summary: { label: agent }, results: [{ taskId: 't', taskFingerprint: 'a'.repeat(64), category: 'c', difficulty: 'small', trial: 1, status: 'passed' }] });
  const report = gatewayReport([{ agent: 'oasis', status: 200, servedModel: 'm', provider: 'P' }, { agent: 'claude', status: 200, servedModel: 'm', provider: 'P' }, { agent: 'codex', status: 429 }, { agent: 'codex', status: 200, servedModel: 'm-other' }]);
  const summary = summarize([make('oasis'), make('claude'), { agent: 'codex', name: 'codex', skipped: 'rate limited' }], options, new Date(), report);
  assert.equal(summary.sameModelVerified, true);
  assert.equal(summary.servedModel, 'm');
});

test('gateway runs keep loopback out of the agents\' HTTPS proxy', async () => {
  const { withLoopback } = await import('../scripts/bench-live.mjs');
  assert.equal(withLoopback(''), '127.0.0.1,localhost,::1');
  assert.equal(withLoopback('corp.example, localhost'), 'corp.example,localhost,127.0.0.1,::1');
});

test('--interleave runs task by task across agents and merges each agent\'s trials', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-live-interleave-'));
  const order = [];
  const meta = { a: ['utility-logic', 'small'], b: ['agent-operations', 'large'] };
  const runner = async (args) => {
    const agent = args[0] === '--trials' ? 'oasis' : args[0];
    const task = args[args.indexOf('--task') + 1];
    order.push(agent + ':' + task);
    if (agent === '--aider' && task === 'b') throw new Error('Aider exited with code 1: 429 Too Many Requests');
    const failed = agent === '--claude-code' && task === 'b';
    const rows = [{ taskId: task, taskFingerprint: task.repeat(64), category: meta[task][0], difficulty: meta[task][1], trial: 1, status: failed ? 'failed' : 'passed', wallTimeMs: 10, totalTokens: 5, costUSD: 0, ...(failed ? { error: 'Claude Code exited with code 1: overloaded' } : {}) }];
    return { resultsPath: '', summary: { label: agent }, results: rows };
  };
  try {
    assert.throws(() => parseBenchArgs(['--interleave']), /--interleave needs --task/);
    const options = parseBenchArgs(['--agents', 'oasis,claude,aider', '--model', 'm', '--router', 'http://localhost:1/v1', '--task', 'a,b', '--interleave', '--out', out, '--yes']);
    const { summary } = await runBenchmark(options, { env: {}, runner });
    assert.deepEqual(order, ['oasis:a', '--claude-code:a', '--aider:a', 'oasis:b', '--claude-code:b', '--aider:b']);
    // Aider has no row for b, so b is not a matched task; a is.
    assert.deepEqual(summary.sharedTasks, ['a']);
    assert.deepEqual(summary.sharedTaskIds, ['a']);
    const saved = JSON.parse(await readFile(path.join(out, 'oasis.json'), 'utf8'));
    assert.deepEqual(saved.results.map((row) => row.taskId), ['a', 'b']);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('trials that ended in an agent error are named in the caveats', () => {
  const row = (status, error) => ({ taskId: 'a', taskFingerprint: 'a'.repeat(64), category: 'utility-logic', difficulty: 'small', trial: 1, status, wallTimeMs: 1, totalTokens: 1, costUSD: 0, ...(error ? { error } : {}) });
  const runs = [
    { agent: 'oasis', name: 'OASIS', summary: {}, results: [row('passed')] },
    { agent: 'codex', name: 'Codex CLI', summary: {}, results: [row('failed', 'Codex CLI exited with code 1: 429 Too Many Requests')] }
  ];
  const summary = summarize(runs, parseBenchArgs(['--agents', 'oasis,codex', '--model', 'm', '--router', 'http://localhost:1/v1']));
  assert.ok(summary.caveats.some((line) => /^Codex CLI: 1 scored trial\(s\) ended in an agent or provider error.*429/.test(line)));
  assert.ok(!summary.caveats.some((line) => line.startsWith('OASIS:')));
});

test('Gemini CLI on a router gets a private home pinned to API-key auth; --upstream refuses it', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-gemini-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = await geminiGatewayEnv(dir, {});
  assert.equal(out.GEMINI_CLI_TRUST_WORKSPACE, 'true');
  assert.equal(out.GEMINI_SANDBOX, 'false');
  const settings = JSON.parse(await readFile(path.join(out.GEMINI_CLI_HOME, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(settings.security.auth.selectedType, 'gemini-api-key');
  const own = await geminiGatewayEnv(dir, { GEMINI_CLI_HOME: '/mine', GEMINI_SANDBOX: 'docker' });
  assert.equal(own.GEMINI_CLI_HOME, undefined);
  assert.equal(own.GEMINI_SANDBOX, undefined);
  const env = agentEnvironment('gemini', parseBenchArgs(['--router', 'http://127.0.0.1:3001']), { OASIS_BENCH_API_KEY: 'k' });
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:3001');
  assert.equal(env.GEMINI_API_KEY, 'k');
  assert.throws(() => parseBenchArgs(['--agents', 'oasis,gemini', '--upstream', 'https://api.example.test/v1', '--model', 'm']), /wire format/);
});

test('a run stops when the upstream quota runs out, keeps its progress, and drops rate-limited tasks from the scores', async () => {
  const http = await import('node:http');
  const { quotaExhausted } = await import('../scripts/bench-gateway.mjs');
  assert.equal(quotaExhausted(429, { 'x-should-retry': 'false' }), true);
  assert.equal(quotaExhausted(429, {}, '{"error":{"code":"PROMOTION_MODEL_LIMIT_REACHED"}}'), true);
  assert.equal(quotaExhausted(429, {}, 'slow down'), false);
  assert.equal(quotaExhausted(500, { 'x-should-retry': 'false' }), false);
  // Upstream: fine for task a, then a quota 429 on Claude Code's task b.
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    req.resume();
    req.on('end', () => {
      if (calls <= 2) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); return; }
      res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' }); res.end('{"error":{"code":"PROMOTION_MODEL_LIMIT_REACHED"}}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const out = await mkdtemp(path.join(os.tmpdir(), 'oasis-bench-live-quota-'));
  const ran = [];
  const runner = async (args, { env }) => {
    const agent = args[0] === '--trials' ? 'oasis' : args[0];
    const task = args[args.indexOf('--task') + 1];
    ran.push(agent + ':' + task);
    const base = env.OASIS_BASE_URL || env.ANTHROPIC_BASE_URL;
    const response = await fetch(base.replace(/\/$/, '') + (env.OASIS_BASE_URL ? '/chat/completions' : '/v1/chat/completions'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) });
    await response.text();
    const passed = response.ok;
    return { resultsPath: '', summary: { label: agent }, results: [{ taskId: task, taskFingerprint: task.repeat(64), category: 'c', difficulty: 'small', trial: 1, status: passed ? 'passed' : 'failed', wallTimeMs: 1, totalTokens: 2, costUSD: 0 }] };
  };
  try {
    const options = parseBenchArgs(['--agents', 'oasis,claude', '--model', 'm', '--upstream', 'http://127.0.0.1:' + upstream.address().port + '/v1', '--task', 'a,b,c', '--interleave', '--out', out, '--yes']);
    const { summary } = await runBenchmark(options, { env: {}, runner });
    // oasis:b got the first 429 and is marked; the run stops before claude:b and task c.
    assert.deepEqual(ran, ['oasis:a', '--claude-code:a', 'oasis:b']);
    assert.match(summary.stoppedEarly, /quota ran out/);
    assert.deepEqual(summary.notRun.map((u) => u.agent + ':' + u.task), ['claude:b', 'oasis:c', 'claude:c']);
    assert.deepEqual(summary.sharedTasks, ['a']);
    assert.ok(summary.caveats[0].startsWith('The run stopped early'));
    const progress = JSON.parse(await readFile(path.join(out, 'progress.json'), 'utf8'));
    assert.equal(progress.agents.oasis.results[1].upstreamQuotaExhausted, true);
    assert.equal(progress.agents.oasis.results[1].upstreamRateLimited, 1);
    // A failed trial that hit 429s is not scored against the agent.
    const scored = summarize([
      { agent: 'oasis', name: 'oasis', summary: {}, results: [{ taskId: 'b', taskFingerprint: 'b'.repeat(64), category: 'c', difficulty: 'small', trial: 1, status: 'failed', upstreamRateLimited: 3 }] },
      { agent: 'claude', name: 'claude', summary: {}, results: [{ taskId: 'b', taskFingerprint: 'b'.repeat(64), category: 'c', difficulty: 'small', trial: 1, status: 'passed' }] }
    ], parseBenchArgs(['--agents', 'oasis,claude', '--model', 'm']));
    assert.deepEqual(scored.rateLimitedTasks, ['b']);
    assert.deepEqual(scored.sharedTasks, []);
    assert.ok(scored.caveats.some((c) => /HTTP 429: b\./.test(c)));
  } finally {
    upstream.close();
    await rm(out, { recursive: true, force: true });
  }
});

test('the relay records message sizes, never contents', async () => {
  const { messageSizes } = await import('../scripts/bench-gateway.mjs');
  const sizes = messageSizes({ messages: [{ role: 'system', content: 'abc' }, { role: 'tool', content: 'x'.repeat(50) }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.deepEqual(sizes.largestMessage, { role: 'tool', chars: 50 });
  assert.equal(sizes.lastMessage.role, 'user');
  assert.ok(!JSON.stringify(sizes).includes('abc'));
  assert.deepEqual(messageSizes({}), {});
});

test('the relay names the tool behind a large result (chat, Responses and Anthropic shapes), not its arguments', async () => {
  const { messageSizes } = await import('../scripts/bench-gateway.mjs');
  const chat = messageSizes({ messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"secret/plan.md"}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'y'.repeat(900) }] });
  assert.deepEqual(chat.largestMessage, { role: 'tool', chars: 900, tool: 'read_file' });
  assert.ok(!JSON.stringify(chat).includes('plan.md'));
  const responses = messageSizes({ input: [{ type: 'function_call', call_id: 'r1', name: 'shell', arguments: '{}' }, { type: 'function_call_output', call_id: 'r1', output: 'z'.repeat(700) }] });
  assert.deepEqual(responses.lastMessage, { role: 'function_call_output', chars: 700, tool: 'shell' });
  const anthropic = messageSizes({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'w'.repeat(800) }] }] });
  assert.equal(anthropic.largestMessage.tool, 'Read');
});

test('tasks only some agents ran are not scored but their outcomes are listed', () => {
  const options = parseBenchArgs(['--agents', 'oasis,claude,codex', '--model', 'm']);
  const row = (id, status, extra = {}) => ({ taskId: id, taskFingerprint: 'a'.repeat(64), category: 'security-boundaries', difficulty: 'medium', trial: 1, status, wallTimeMs: 1, totalTokens: 1, costUSD: 0, ...extra });
  const make = (agent, rows) => ({ agent, name: agent, summary: { label: agent, provider: { model: 'm' } }, results: rows });
  const summary = summarize([
    make('oasis', [row('both', 'passed'), row('cut', 'passed')]),
    make('claude', [row('both', 'failed'), row('cut', 'failed', { upstreamRateLimited: 2 })]),
    make('codex', [row('both', 'passed')])
  ], options, new Date('2026-11-14T00:00:00Z'));
  assert.deepEqual(summary.sharedTasks, ['both']);
  assert.deepEqual(summary.partialTasks, { cut: { oasis: 'passed 1/1', claude: 'failed 0/1 (upstream HTTP 429)', codex: 'not run' } });
  assert.equal(summary.agents[0].trials, 1);
  const rendered = renderSummary(summary);
  assert.match(rendered, /1 task\(s\) were not run by every completed agent and are not scored: cut/);
  assert.match(rendered, /\| `cut` \| passed 1\/1 \| failed 0\/1 \(upstream HTTP 429\) \| not run \|/);
});
