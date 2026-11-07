import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShellParser, parseShellCommands } from '../src/shell-ast.mjs';

test('tree-sitter remains available as an explicit Bash parser rollback mode', async () => {
  await loadShellParser({ OASIS_SHELL_PARSER: 'tree-sitter' });
  const parsed = parseShellCommands('echo fallback');
  assert.equal(parsed.unparsable, false);
  assert.deepEqual(parsed.commands.map((item) => item.tokens), [['echo', 'fallback']]);
});
