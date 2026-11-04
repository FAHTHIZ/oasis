import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseBenchArgs, agentEnvironment, runBenchmark } from '../scripts/bench-live.mjs';
import { parseAiderOutput, parseOpenCodeOutput, buildAiderArgs, buildOpenCodeArgs, EXTERNAL_AGENTS } from '../src/eval.mjs';

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
  assert.equal(agentEnvironment('codex', options, env).OPENAI_BASE_URL, 'http://localhost:20128/v1');
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
      { taskId: 'a', taskFingerprint: 'fa', status: 'passed', wallTimeMs: 1000, totalTokens: 10, costUSD: 0.01 },
      { taskId: 'b', taskFingerprint: external ? 'fb' : 'fb', status: external ? 'failed' : 'passed', wallTimeMs: 3000, totalTokens: 20, costUSD: 0.02 },
      ...(external ? [] : [{ taskId: 'only-oasis', taskFingerprint: 'fx', status: 'passed', wallTimeMs: 5, totalTokens: 1, costUSD: 0 }])
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
    assert.match(markdown, /\| OASIS 1\.0\.0 \(opus\) \| 100% \| 2\/2 \|/);
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
