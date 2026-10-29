import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommand } from '../src/permissions.mjs';

test('remote package execution and high-impact project runner verbs are high-risk', () => {
  const cases = [
    ['npx', ['untrusted-package']],
    ['bunx', ['untrusted-package']],
    ['npm', ['exec', 'deploy-tool']],
    ['pnpm', ['dlx', 'deploy-tool']],
    ['yarn', ['exec', 'deploy-tool']],
    ['npm', ['run', 'deploy']],
    ['pnpm', ['run', 'release']],
    ['yarn', ['run', 'publish']],
    ['npm', ['--prefix', './app', 'run', 'deploy']],
    ['pnpm', ['--dir', './app', 'exec', 'deploy-tool']],
    ['yarn', ['--cwd', './app', 'run', 'publish']],
    ['npm', ['--unknown-config-flag', 'value', 'run', 'deploy']],
    ['cargo', ['run', '--release']],
    ['go', ['run', './cmd/deploy']],
    ['make', ['deploy']]
  ];
  for (const [command, args] of cases) {
    const result = analyzeCommand(command, args);
    assert.match(
      result.highRisk || '',
      /executes a remote package or an explicit high-impact project runner/,
      command + ' ' + args.join(' ')
    );
  }
});

test('ordinary scripts and common test/check runners retain normal risk', () => {
  for (const [command, args] of [
    ['node', ['script.mjs']],
    ['python3', ['tool.py']],
    ['npm', ['test']],
    ['npm', ['run', 'test']],
    ['npm', ['--silent', 'run', 'test']],
    ['npm', ['run', 'check']],
    ['pnpm', ['run', 'typecheck']],
    ['yarn', ['test']],
    ['cargo', ['test']],
    ['go', ['test', './...']],
    ['make', ['all']]
  ]) {
    const result = analyzeCommand(command, args);
    assert.equal(result.blocked, undefined, command + ' ' + args.join(' '));
    assert.equal(result.highRisk, undefined, command + ' ' + args.join(' ') + ' should be normal risk');
  }
});

test('unknown package-manager option ordering fails closed', () => {
  assert.match(
    analyzeCommand('npm', ['--unknown-config-flag', 'value', 'publish']).blocked || '',
    /Unrecognized package-manager option ordering/
  );
});

test('publishing remains blocked when package-manager options precede the verb', () => {
  for (const [command, args] of [
    ['npm', ['--prefix', './app', 'publish']],
    ['pnpm', ['--dir', './app', 'publish']],
    ['yarn', ['--cwd', './app', 'publish']]
  ]) {
    assert.match(analyzeCommand(command, args).blocked || '', /Publishing a package is blocked/);
  }
});

test('explicit inline-code classification remains intact', () => {
  assert.match(analyzeCommand('node', ['-e', 'process.exit(0)']).highRisk || '', /runs inline code/);
  assert.match(analyzeCommand('python3', ['-c', 'print(1)']).highRisk || '', /runs inline code/);
});
