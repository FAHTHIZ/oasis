import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeProject } from '../src/agent.mjs';
import { toolGuidanceFor, loadDeferredTool, searchTools, TOOL_GUIDANCE } from '../src/session-tools.mjs';
import { skillCatalogueLine } from '../src/tools.mjs';

test('describeProject reports manifests, scripts, the test command and missing toolchains', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-proj-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', other: 'x' } }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), '');
  await writeFile(path.join(root, 'go.mod'), 'module x\n');
  const text = await describeProject(root, { PATH: path.join(root, 'nothing-here') });
  assert.match(text, /Project: JavaScript\/TypeScript, Go \(package\.json, go\.mod\)/);
  assert.match(text, /Package manager: pnpm; scripts: test, lint; dependencies not installed/);
  assert.match(text, /Test command: pnpm test/);
  assert.match(text, /Not on PATH: node, go/);
  const empty = await mkdtemp(path.join(os.tmpdir(), 'oasis-empty-'));
  assert.equal(await describeProject(empty), '');
});

test('deferred tool guidance arrives once per group, with tool_search or a direct call', () => {
  const tool = (name) => ({ type: 'function', function: { name, description: name } });
  const session = { toolDefinitions: [], deferredTools: new Map(['git_commit', 'git_push', 'task_create'].map((name) => [name, tool(name)])) };
  const found = searchTools(session, { query: 'select:git_commit' });
  assert.deepEqual(found.loaded, ['git_commit']);
  assert.equal(found.guidance, TOOL_GUIDANCE['Git and GitHub']);
  assert.equal(searchTools(session, { query: 'select:git_push' }).guidance, undefined);
  assert.equal(loadDeferredTool(session, 'task_create'), true);
  assert.equal(session.pendingToolGuidance, TOOL_GUIDANCE['Task board and teams']);
  assert.equal(toolGuidanceFor(session, ['task_create', 'read_file']), '');
});

test('skill catalogue lines keep the summary and trigger within 200 characters', () => {
  assert.equal(skillCatalogueLine('Short one.'), 'Short one.');
  const long = 'Does the thing well. ' + 'Extra detail that the model does not need up front. '.repeat(5) + 'Use for "do the thing" or /thing.';
  const line = skillCatalogueLine(long);
  assert.equal(line, 'Does the thing well. Use for "do the thing" or /thing.');
  assert.ok(skillCatalogueLine('x'.repeat(400)).length <= 200);
});
