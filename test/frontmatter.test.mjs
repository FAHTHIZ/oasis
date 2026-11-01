import test from 'node:test';
import assert from 'node:assert/strict';
import { frontMatterValue } from '../src/frontmatter.mjs';
import { parseFrontMatter } from '../src/subagents.mjs';
import { compactSkillLines } from '../src/agent.mjs';

const folded = 'name: ponytail\ndescription: >\n  Lazy senior dev mode: the smallest change.\n  Use on any coding task.\nlicense: MIT';

test('folded and literal block scalars are read, not reported as ">"', () => {
  assert.equal(frontMatterValue(folded, 'description'), 'Lazy senior dev mode: the smallest change. Use on any coding task.');
  assert.equal(frontMatterValue(folded, 'license'), 'MIT');
  assert.equal(frontMatterValue('description: |-\n  line one\n  line two\nx: y', 'description'), 'line one\nline two');
  assert.equal(frontMatterValue('description: "quoted: value"', 'description'), 'quoted: value');
  assert.equal(frontMatterValue('name: a', 'description'), '');
  assert.equal(parseFrontMatter('---\n' + folded + '\n---\nBody').data.description, 'Lazy senior dev mode: the smallest change. Use on any coding task.');
});

test('small-context prompts keep one short sentence per skill', () => {
  const lines = '- ponytail [built-in]: Lazy senior dev mode: the smallest change. Use on any coding task.\n- long [project]: ' + 'word '.repeat(40) + '\nother line';
  const [first, second, third] = compactSkillLines(lines).split('\n');
  assert.equal(first, '- ponytail [built-in]: Lazy senior dev mode: the smallest change.');
  assert.ok(second.startsWith('- long [project]: word') && second.endsWith('…') && second.length < 140, second);
  assert.equal(third, 'other line');
});

test('README background drops badges, images and layout tags; small windows keep its opening', async () => {
  const { readmeText } = await import('../src/memory.mjs');
  const { compactProjectContext } = await import('../src/agent.mjs');
  const readme = '<!-- note -->\n<p align="center"><img src="logo.svg" alt="x"></p>\n<h1 align="center">Tool</h1>\n<p align="center"><a href="ci"><img src="badge.svg"></a> ![shot](a.png)</p>\n\n\n\n<strong>Fast</strong> agent.\n\n## Use\nRun it.';
  assert.equal(readmeText(readme), '# Tool\n\nFast agent.\n\n## Use\nRun it.');
  const context = '--- Project context: AGENTS.md ---\nRules.\n\n--- Project context: README.md ---\n' + 'word '.repeat(1000);
  const compact = compactProjectContext(context);
  assert.ok(compact.startsWith('--- Project context: AGENTS.md ---\nRules.'));
  assert.ok(compact.length < 2700 && compact.endsWith('read_file README.md for the rest]'), compact.length);
  assert.equal(compactProjectContext('--- Project context: AGENTS.md ---\nShort.'), '--- Project context: AGENTS.md ---\nShort.');
});
