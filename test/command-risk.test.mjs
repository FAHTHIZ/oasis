import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommand } from '../src/permissions.mjs';

test('script and project-runner commands remain high-risk under automatic approval', () => {
  const cases = [
    ['node', ['script.mjs']],
    ['python3', ['tool.py']],
    ['ruby', ['task.rb']],
    ['deno', ['run', 'main.ts']],
    ['bun', ['run', 'task.ts']],
    ['npm', ['run', 'test']],
    ['pnpm', ['exec', 'eslint', '.']],
    ['yarn', ['test']],
    ['cargo', ['test']],
    ['go', ['test', './...']],
    ['make', ['all']]
  ];
  for (const [command, args] of cases) {
    const result = analyzeCommand(command, args);
    assert.match(
      result.highRisk || '',
      /executes interpreter code, repository-controlled scripts, or project-provided runners/,
      command + ' ' + args.join(' ')
    );
  }
});

test('pure version/help probes do not acquire unnecessary high-risk classification', () => {
  for (const [command, args] of [
    ['node', ['--version']],
    ['python3', ['-V']],
    ['npm', ['--version']],
    ['cargo', ['--help']],
    ['go', ['version']]
  ]) {
    const result = analyzeCommand(command, args);
    assert.equal(result.blocked, undefined, command);
    assert.equal(result.highRisk, undefined, command + ' ' + args.join(' '));
  }
});

test('explicit inline-code classification remains intact', () => {
  assert.match(analyzeCommand('node', ['-e', 'process.exit(0)']).highRisk || '', /runs inline code/);
  assert.match(analyzeCommand('python3', ['-c', 'print(1)']).highRisk || '', /runs inline code/);
});
