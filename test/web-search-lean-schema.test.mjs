import test from 'node:test';
import assert from 'node:assert/strict';
import { webSearchToolDefinition, WEB_SEARCH_TOOL_DEFINITION } from '../src/web-search.mjs';
import { taskToolDefinition, BUILTIN_AGENTS } from '../src/subagents.mjs';

test('web_search drops the fusion strategy option when there is nothing to fuse', () => {
  const lean = webSearchToolDefinition({});
  assert.equal(lean.function.name, 'web_search');
  assert.equal(lean.function.parameters.properties.strategy, undefined);
  assert.ok(lean.function.parameters.properties.query);
  assert.ok(WEB_SEARCH_TOOL_DEFINITION.function.parameters.properties.strategy, 'the shared definition is not mutated');
  assert.equal(webSearchToolDefinition({ TAVILY_API_KEY: 'k' }).function.parameters.properties.strategy, undefined);
});

test('web_search keeps the strategy option with two or more providers', () => {
  const full = webSearchToolDefinition({ TAVILY_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'b' });
  assert.ok(full.function.parameters.properties.strategy);
});

test('task tool lists built-in agents with short summaries', () => {
  const description = taskToolDefinition(BUILTIN_AGENTS).function.description;
  for (const name of Object.keys(BUILTIN_AGENTS)) assert.match(description, new RegExp('- ' + name + ': '));
  assert.ok(description.length < 900, 'task description stays short: ' + description.length);
});
