import test from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, parseRule, ruleMatches } from '../src/permissions.mjs';

test('a many-wildcard rule matches a long command in linear time (no ReDoS)', () => {
  const rule = parseRule('Bash(*a*a*a*a*a*a*a*a*b)');
  const started = Date.now();
  assert.equal(ruleMatches(rule, 'run_shell', { command: 'a'.repeat(20000) }), false);
  assert.equal(ruleMatches(rule, 'run_shell', { command: 'a'.repeat(20000) + 'b' }), true);
  assert.ok(Date.now() - started < 2000, 'took ' + (Date.now() - started) + ' ms');
});

test('glob matcher keeps the RegExp semantics it replaced', () => {
  const cases = [
    ['src/*.js', 'src/a.js', true], ['src/*.js', 'src/a/b.js', false], ['src/**/*.js', 'src/a.js', true],
    ['src/**/*.js', 'src/a/b/c.js', true], ['src/**', 'src/a/b', true], ['a?c', 'abc', true], ['a?c', 'a/c', false],
    ['**/.env', '.env', true], ['**/.env', 'x/y/.env', true], ['**/.env', 'x.env', false], ['a.b', 'axb', false],
    ['**', 'a\nb', false], ['*', 'a\nb', true], ['(x)', '(x)', true], ['', '', true], ['', 'a', false]
  ];
  for (const [pattern, text, expected] of cases) assert.equal(globToRegExp(pattern).test(text), expected, pattern + ' vs ' + JSON.stringify(text));
  assert.equal(ruleMatches(parseRule('Bash(git push *)'), 'run_shell', { command: 'git push origin main' }), true);
  assert.equal(ruleMatches(parseRule('Bash(git push *)'), 'run_shell', { command: 'git status' }), false);
});
