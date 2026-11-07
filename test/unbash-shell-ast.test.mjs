import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnbashShellCommands } from '../src/unbash-shell-ast.mjs';

const parse = (line) => parseUnbashShellCommands(line);

test('unbash exposes shell syntax as source-ordered commands', () => {
  assert.deepEqual(parse('echo one && git status').commands.map((c) => c.tokens), [
    ['echo', 'one'],
    ['git', 'status']
  ]);
  assert.deepEqual(parse("r''m \"a b\" c\\ d").commands[0].tokens, ['rm', 'a b', 'c d']);
  assert.deepEqual(parse('echo hi # ; rm -rf ~').commands.map((c) => c.tokens), [['echo', 'hi']]);
});

test('structured word parts preserve quote removal and computed command names', () => {
  assert.deepEqual(parse("$'\\x72\\x6d' -rf x").commands[0].tokens, ['rm', '-rf', 'x']);
  const computed = parse('$(echo rm) -rf build').commands;
  assert.equal(computed[0].computedName, true);
  assert.deepEqual(computed.slice(1).map((c) => c.tokens), [['echo', 'rm']]);
});

test('nested substitutions and literal shell wrappers remain visible to policy checks', () => {
  const substitution = parse('echo "$(id -u)"').commands;
  assert.deepEqual(substitution.map((c) => c.tokens), [['echo', '$(id -u)'], ['id', '-u']]);
  const wrapper = parse("bash -c 'echo ready && git status'").commands;
  assert.deepEqual(wrapper.map((c) => c.tokens), [
    ['bash', '-c', 'echo ready && git status'],
    ['echo', 'ready'],
    ['git', 'status']
  ]);
});

test('pipeline links, here-strings and heredocs preserve their execution context', () => {
  const piped = parse('echo x | sh').commands;
  assert.equal(piped[1].pipedFrom, piped[0]);
  assert.equal(parse("bash <<< 'git status'").commands[0].stdinScript, 'git status');
  assert.match(parse("bash <<'EOF'\ngit status\nEOF").commands[0].stdinScript, /git status/);
});

test('literal for-loop values are expanded without evaluating dynamic input', () => {
  assert.deepEqual(parse('for d in a b; do rm "$d"; done').commands.map((c) => c.tokens), [
    ['rm', 'a'],
    ['rm', 'b']
  ]);
  assert.equal(parse('for d in $(list); do rm "$d"; done').commands.some((c) => c.tokens[0] === 'list'), true);
});

test('parser limits and malformed syntax fail closed', () => {
  assert.equal(parse('if then ;').unparsable, true);
  assert.deepEqual(parse('x'.repeat(100_001)), {
    commands: [],
    unparsable: true,
    tooLarge: true
  });
});
