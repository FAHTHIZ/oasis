import test from 'node:test';
import assert from 'node:assert/strict';
import { isAiCredit, stripAiAttribution, commitIdentity, sanitizeCommitArgv } from '../src/commit-attribution.mjs';

const AI_CREDITS = [
  'Co-authored-by: Perplexity <noreply@perplexity.ai>',
  'Co-authored-by: Claude <noreply@anthropic.com>',
  'Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>',
  'Co-authored-by: Cursor Agent <cursoragent@cursor.com>',
  'Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>',
  'Co-authored-by: devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>',
  'Co-authored-by: aider (gpt-4o) <noreply@aider.chat>',
  'Co-authored-by: Codex <codex@openai.com>',
  'Co-authored-by: OASIS',
  'Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>',
  'Generated-by: Gemini CLI',
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  'Generated with Codex',
  '<sub>Created with [Perplexity](https://www.perplexity.ai/computer/tasks/x)</sub>'
];
const HUMAN = [
  'Co-authored-by: Claude Monet <monet@gmail.com>',
  'Co-authored-by: Jane Doe <jane@anthropic.com>',
  'Signed-off-by: Fahim Hussain <gtxnrg@gmail.com>',
  'Co-authored-by: Bob <123+bob@users.noreply.github.com>',
  'Generated with love by our team',
  'Built with esbuild',
  'Fix the generated parser',
  'Refs: #42'
];

test('AI and bot credits are recognised; people and ordinary lines are not', () => {
  for (const line of AI_CREDITS) assert.equal(isAiCredit(line), true, line);
  for (const line of HUMAN) assert.equal(isAiCredit(line), false, line);
});

test('stripAiAttribution keeps the message and human trailers', () => {
  const message = 'Fix login\n\nBody text.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nSigned-off-by: Fahim Hussain <gtxnrg@gmail.com>\n';
  assert.equal(stripAiAttribution(message), 'Fix login\n\nBody text.\n\n\nSigned-off-by: Fahim Hussain <gtxnrg@gmail.com>\n');
  assert.equal(stripAiAttribution('Summary\n\n---\n<sub>Created with [Perplexity](https://p.ai/x)</sub>'), 'Summary');
  assert.equal(stripAiAttribution('a\r\nCo-authored-by: Codex <codex@openai.com>\r\n'), 'a\r\n');
  assert.equal(stripAiAttribution('nothing to do\n'), 'nothing to do\n');
  assert.equal(stripAiAttribution(''), '');
  assert.equal(stripAiAttribution(undefined), '');
});

test('commitIdentity uses the human who triggered the run, never a bot', () => {
  assert.deepEqual(commitIdentity({ GITHUB_ACTOR: 'FAHTHIZ', GITHUB_ACTOR_ID: '252817169', GITHUB_REPOSITORY: 'FAHTHIZ/oasis' }), { name: 'FAHTHIZ', email: '252817169+FAHTHIZ@users.noreply.github.com' });
  assert.deepEqual(commitIdentity({ GITHUB_ACTOR: 'github-actions[bot]', GITHUB_ACTOR_ID: '41898282', GITHUB_REPOSITORY_OWNER: 'acme', GITHUB_REPOSITORY_OWNER_ID: '7' }), { name: 'acme', email: '7+acme@users.noreply.github.com' });
  assert.deepEqual(commitIdentity({ GITHUB_ACTOR: 'dependabot[bot]', GITHUB_REPOSITORY: 'someone/repo' }), { name: 'someone', email: 'someone@users.noreply.github.com' });
  assert.deepEqual(commitIdentity({ GITHUB_ACTOR: 'a' }, { name: 'Jane', email: 'j@x.dev' }), { name: 'Jane', email: 'j@x.dev' });
  assert.deepEqual(commitIdentity({}), { name: '', email: '' });
});

test('sanitizeCommitArgv cleans -m, --message and --trailer values only after commit', () => {
  assert.deepEqual(
    sanitizeCommitArgv('git', ['commit', '-m', 'Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>', '--trailer', 'Co-authored-by: Codex <codex@openai.com>', '--trailer', 'Refs: #1']),
    ['commit', '-m', 'Fix', '--trailer', 'Refs: #1']
  );
  assert.deepEqual(sanitizeCommitArgv('git', ['-C', 'x', 'commit', '--message=Fix\n\n🤖 Generated with Claude Code', '--trailer=Assisted-by=Copilot']), ['-C', 'x', 'commit', '--message=Fix']);
  assert.deepEqual(sanitizeCommitArgv('git', ['commit', '-m', 'Fix', '-m', 'Co-authored-by: Claude <noreply@anthropic.com>']), ['commit', '-m', 'Fix']);
  const untouched = ['commit', '-m', 'Plain'];
  assert.equal(sanitizeCommitArgv('git', untouched), untouched);
  const other = ['log', '-m', 'Co-authored-by: Claude <noreply@anthropic.com>'];
  assert.equal(sanitizeCommitArgv('git', other), other);
  assert.deepEqual(sanitizeCommitArgv('git', ['commit', '-m', 'x', '--', '-m']), ['commit', '-m', 'x', '--', '-m']);
});
