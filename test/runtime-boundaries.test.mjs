import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { briefFailure } from '../src/provider-errors.mjs';
import { briefFailure as appBriefFailure } from '../app/core/providers.mjs';
import { splitThinking, visibleReply } from '../src/think-tags.mjs';

test('the CLI runtime does not import browser application modules', async () => {
  const source = await readFile(new URL('../src/agent.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]\.\.\/app[\/]/);
});

test('browser and CLI share the same provider failure formatter', () => {
  assert.equal(appBriefFailure, briefFailure);
  assert.equal(briefFailure('Provider limit: per day quota exhausted; retry in 2h3m'), 'daily quota used up (retry in 2h3m)');
  assert.equal(briefFailure('Model has been retired by the provider'), 'model retired by the provider');
});

test('runtime-owned reasoning parser strips only leading thought blocks', () => {
  assert.deepEqual(splitThinking('<thought>hidden</thought>Answer'), { content: 'Answer', reasoning: 'hidden' });
  assert.equal(visibleReply('<thought>hidden</thought>Answer'), 'Answer');
  assert.equal(splitThinking('The literal <think> tag is documentation.').reasoning, '');
});
