import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const documents = [
  '../README.md',
  '../docs/USER-GUIDE.md',
  '../docs/RELEASES.md',
  '../docs/INTERFACES.md'
];

test('user-facing Markdown uses real code delimiters, not escaped backticks', async () => {
  const tick = String.fromCharCode(96);
  for (const file of documents) {
    const markdown = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.equal(markdown.includes('\\' + tick), false, file + ' contains escaped Markdown backticks');
    const fences = markdown.split('\n').filter((line) => line.startsWith(tick.repeat(3)));
    assert.equal(fences.length % 2, 0, file + ' has unbalanced code fences');
  }

  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const ways = readme.slice(readme.indexOf('## Two ways to work'), readme.indexOf('\n## ', readme.indexOf('## Two ways to work') + 3));
  assert.ok(ways.includes('Terminal') && ways.includes('Web app'), 'README must present the terminal and the web app as the two interfaces');
});
