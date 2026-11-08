import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseBenchArgs, agentEnvironment, runBenchmark, summarize, renderSummary } from '../scripts/bench-live.mjs';
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

test('Codex gets a gateway provider entry because it ignores OPENAI_BASE_URL', () => {
  const args = buildCodexArgs({ model: 'm1' }, 'do it', { OASIS_CODEX_BASE_URL: 'http://127.0.0.1:20128/v1' });
  assert.ok(args.includes('model_provider=bench'));
  assert.ok(args.includes('model_providers.bench.base_url="http://127.0.0.1:20128/v1"'));
  assert.ok(args.includes('model_providers.bench.env_key="OPENAI_API_KEY"'));
  assert.deepEqual(args.slice(-3), ['-m', 'm1', 'do it']);
  assert.ok(!buildCodexArgs({}, 'x', {}).includes('-c'));
});
