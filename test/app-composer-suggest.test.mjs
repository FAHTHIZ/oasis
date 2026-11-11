import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestToken, rankSuggestions, applySuggestion } from '../app/core/composer-suggest.mjs';

test('suggestToken finds / only at the start and @ after whitespace', () => {
  assert.deepEqual(suggestToken('/com'), { kind: '/', query: 'com', start: 0, end: 4 });
  assert.equal(suggestToken('/compact now'), null, 'a finished command with arguments closes the menu');
  assert.equal(suggestToken('please /com'), null);
  assert.deepEqual(suggestToken('look at @src/ma'), { kind: '@', query: 'src/ma', start: 8, end: 15 });
  assert.equal(suggestToken('mail me@example'), null, 'an @ inside a word is not a mention');
  assert.deepEqual(suggestToken('@a and @b', 2), { kind: '@', query: 'a', start: 0, end: 2 }, 'uses the caret, not the end');
  assert.equal(suggestToken(''), null);
});

test('rankSuggestions prefers exact, prefix and basename matches', () => {
  const files = ['src/agent.mjs', 'test/agent.test.mjs', 'docs/AGENTS.md', 'src/markdown.mjs', 'app/main.mjs'];
  assert.deepEqual(rankSuggestions(files, 'agent'), ['src/agent.mjs', 'docs/AGENTS.md', 'test/agent.test.mjs']);
  assert.equal(rankSuggestions(files, 'main')[0], 'app/main.mjs');
  assert.deepEqual(rankSuggestions(files, 'mdm'), ['src/markdown.mjs'], 'falls back to in-order letters');
  const commands = [{ name: 'compact' }, { name: 'commit' }, { name: 'config' }, { name: 'review' }];
  assert.deepEqual(rankSuggestions(commands, 'co', (c) => c.name).map((c) => c.name), ['compact', 'commit', 'config']);
  assert.equal(rankSuggestions(commands, '', (c) => c.name, 2).length, 2, 'an empty query lists the first items');
  assert.deepEqual(rankSuggestions(commands, 'zzz', (c) => c.name), []);
});

test('applySuggestion replaces the token and leaves one space before the caret', () => {
  assert.deepEqual(applySuggestion('/com', suggestToken('/com'), 'compact'), { value: '/compact ', caret: 9 });
  const text = 'fix @src/ma please';
  const token = suggestToken(text, 11);
  assert.deepEqual(applySuggestion(text, token, 'src/math.js'), { value: 'fix @src/math.js please', caret: 16 });
});

test('/connect NAME suggests apps and completes without a slash', () => {
  const token = suggestToken('/connect gi');
  assert.deepEqual(token, { kind: 'app', query: 'gi', start: 9, end: 11 });
  assert.deepEqual(applySuggestion('/connect gi', token, 'github'), { value: '/connect github ', caret: 16 });
  assert.deepEqual(suggestToken('/connect '), { kind: 'app', query: '', start: 9, end: 9 });
  assert.equal(suggestToken('/connect github now'), null);
});
