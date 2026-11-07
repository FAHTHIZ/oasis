import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShellParser, parseShellCommands } from '../src/shell-ast.mjs';
import { parseUnbashShellCommands } from '../src/unbash-shell-ast.mjs';

const FIXTURES = [
  'git status --short',
  'echo one && git status',
  "r''m \"a b\" c\\ d",
  "$'\\x72\\x6d' -rf x",
  'echo hi # ; rm -rf ~',
  'f(){ git status; }',
  'case a in a) rm x;; esac',
  'for d in a b; do rm "$d"; done',
  'echo "$(id -u)" > out',
  'echo x | sh'
];

test('common Bash syntax has command-token parity with retained tree-sitter backend', async () => {
  await loadShellParser({ OASIS_SHELL_PARSER: 'tree-sitter' });
  assert.equal(parseShellCommands('echo tree-sitter-ready').unparsable, false);

  for (const source of FIXTURES) {
    const reference = parseShellCommands(source);
    const candidate = parseUnbashShellCommands(source);
    assert.ok(reference, 'tree-sitter unavailable for fixture: ' + source);
    assert.equal(reference.unparsable, false, 'tree-sitter parsed: ' + source);
    assert.equal(candidate.unparsable, false, 'unbash parsed: ' + source);
    assert.deepEqual(
      candidate.commands.map((command) => command.tokens),
      reference.commands.map((command) => command.tokens),
      source
    );
  }
});

test('both parsers retain pipeline source relationships', async () => {
  await loadShellParser({ OASIS_SHELL_PARSER: 'tree-sitter' });
  const reference = parseShellCommands('echo x | sh');
  const candidate = parseUnbashShellCommands('echo x | sh');
  assert.ok(reference.commands[1].pipedFrom);
  assert.ok(candidate.commands[1].pipedFrom);
  assert.equal(candidate.commands[1].pipedFrom.tokens[0], reference.commands[1].pipedFrom.tokens[0]);
});
