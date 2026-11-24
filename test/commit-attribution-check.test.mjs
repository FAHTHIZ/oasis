import test from 'node:test';
import assert from 'node:assert/strict';
import { attributionProblems } from '../.github/scripts/check-commit-attribution.mjs';

const record = (sha, body) => sha + '\u0000' + body + '\u0001\n';

test('pushed commits that credit an AI tool are reported; people and sign-offs are not', () => {
  const log = record('a'.repeat(40), 'Fix a bug\n\nCo-authored-by: Codex <codex@openai.com>\n')
    + record('b'.repeat(40), 'Add docs\n\n🤖 Generated with [Claude Code](https://claude.ai/code)\n')
    + record('c'.repeat(40), 'Pair work\n\nCo-authored-by: Jane Doe <jane@example.com>\n')
    + record('d'.repeat(40), 'Bump a dependency\n\nSigned-off-by: dependabot[bot] <support@github.com>\n');
  assert.deepEqual(attributionProblems(log), [
    'aaaaaaaaaaaa: Co-authored-by: Codex <codex@openai.com>',
    'bbbbbbbbbbbb: 🤖 Generated with [Claude Code](https://claude.ai/code)'
  ]);
  assert.deepEqual(attributionProblems(''), []);
});
