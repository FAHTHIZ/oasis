import test from 'node:test';
import assert from 'node:assert/strict';
import { run, parseArgs } from '../src/cli.mjs';
import { NOW, tempFile, sink } from './helpers.mjs';

test('parses flags in both forms', () => {
  assert.deepEqual(parseArgs(['add', 'Buy', 'milk', '--priority', 'high', '--tag=home', '--tag', 'errand']), { command: 'add', args: ['Buy', 'milk'], flags: { priority: 'high', tags: ['home', 'errand'] } });
  assert.deepEqual(parseArgs(['list', '--overdue', '--', '--literal']).flags, { overdue: true });
  assert.throws(() => parseArgs(['list', '--color', 'red']), /Unknown option/);
  assert.throws(() => parseArgs(['list', '--sort']), /needs a value/);
});

test('add, list and done round-trip through the file', async (t) => {
  const file = await tempFile(t);
  const env = { TASKFLOW_FILE: file };
  const now = () => NOW;
  await run(['add', 'Write', 'notes', '--due', 'tomorrow', '--tag', 'docs'], { stdout: sink(), env, now });
  await run(['add', 'Old', 'thing', '--due', '2026-10-01'], { stdout: sink(), env, now });
  const out = sink();
  await run(['list', '--sort', 'due'], { stdout: out, env, now });
  assert.equal(out.text, '  2 [ ]   Old thing (overdue)\n  1 [ ]   Write notes #docs (tomorrow)\n'.replace(/\[ \]   /g, '[ ] · '));
  await run(['done', '2'], { stdout: sink(), env, now });
  const after = sink();
  await run(['list'], { stdout: after, env, now });
  assert.match(after.text, /Write notes/);
  assert.doesNotMatch(after.text, /Old thing/);
});

test('unknown commands print usage and exit 2', async (t) => {
  const out = sink();
  assert.equal(await run(['frobnicate'], { stdout: out, env: { TASKFLOW_FILE: await tempFile(t) } }), 2);
  assert.match(out.text, /Usage/);
});
