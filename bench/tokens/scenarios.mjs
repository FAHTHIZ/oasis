// Scripted model behaviour for the token-efficiency benchmark.
//
// Each scenario is a fixed, realistic sequence of tool calls a capable model
// makes on an evals/tasks fixture: explore, read, edit, run the tests, review
// and answer. The calls are the same on every run, so any change in the bytes
// OASIS sends is caused by the harness, not by the model.
//
// The sequence for taskflow-search follows the shape of the live gpt-oss-20b
// run that passed it (bench/results/live-2026-11-05b, 16 tool calls, 18
// requests): orientation, reading the code it changes plus neighbours,
// targeted edits, a test run, one re-read after editing and a final review.

const call = (name, args) => ({ name, args });

export const scenarios = [
  {
    id: 'taskflow-search',
    task: 'taskflow-search',
    // gpt-oss-20b has no entry in the window table, so OASIS uses the 32K
    // default, as in the live run.
    model: 'gpt-oss-20b',
    steps: [
      { text: 'I will look at the project layout first.', calls: [call('list_files', { path: '.' })] },
      { calls: [call('read_file', { path: 'README.md' })] },
      { calls: [call('read_file', { path: 'package.json' })] },
      { calls: [call('grep', { pattern: 'filterTasks', path: '.' })] },
      { calls: [call('read_file', { path: 'src/query.mjs' })] },
      { calls: [call('read_file', { path: 'src/cli.mjs' })] },
      { calls: [call('read_file', { path: 'test/query.test.mjs' })] },
      { calls: [call('read_file', { path: 'test/cli.test.mjs' })] },
      { calls: [call('read_file', { path: 'test/helpers.mjs' })] },
      { text: 'Adding the search option to filterTasks.', calls: [call('edit_file', {
        path: 'src/query.mjs',
        old_string: "export function filterTasks(tasks, { status, tag, priority, overdue, now = new Date() } = {}) {\n  const wanted = tag ? normalizeTag(tag) : null;",
        new_string: "export function filterTasks(tasks, { status, tag, priority, overdue, search, now = new Date() } = {}) {\n  const wanted = tag ? normalizeTag(tag) : null;\n  const needle = search ? String(search).trim().toLowerCase() : '';"
      })] },
      { calls: [call('edit_file', {
        path: 'src/query.mjs',
        old_string: "    if (overdue && !isOverdue(task, now)) return false;\n    return true;",
        new_string: "    if (overdue && !isOverdue(task, now)) return false;\n    if (needle && !`${task.title}\\n${task.notes || ''}`.toLowerCase().includes(needle)) return false;\n    return true;"
      })] },
      { calls: [call('edit_file', {
        path: 'src/cli.mjs',
        old_string: "'size', 'notes', 'file']);",
        new_string: "'size', 'notes', 'file', 'search']);"
      })] },
      { calls: [call('edit_file', {
        path: 'src/cli.mjs',
        old_string: 'overdue: flags.overdue, now: clock });',
        new_string: 'overdue: flags.overdue, search: flags.search, now: clock });'
      })] },
      { text: 'Now the tests.', calls: [call('edit_file', {
        path: 'test/query.test.mjs',
        old_string: "test('paginates from page 1', () => {",
        new_string: "test('searches title and notes case-insensitively', () => {\n  const list = [{ id: 1, title: 'Buy MILK', notes: '', status: 'open', tags: [] }, { id: 2, title: 'x', notes: 'call about milk', status: 'open', tags: [] }, { id: 3, title: 'y', notes: '', status: 'open', tags: [] }];\n  assert.deepEqual(filterTasks(list, { search: 'milk' }).map((t) => t.id), [1, 2]);\n  assert.deepEqual(filterTasks(list, { search: 'milk', status: 'open' }).map((t) => t.id), [1, 2]);\n  assert.deepEqual(filterTasks(list, { search: '  ' }).map((t) => t.id), [1, 2, 3]);\n});\n\ntest('paginates from page 1', () => {"
      })] },
      { calls: [call('run_command', { command: 'npm', args: ['test'] })] },
      // Models commonly re-read a file they just edited to check the result.
      { calls: [call('read_file', { path: 'src/query.mjs' })] },
      { calls: [call('git_diff', {})] }
    ],
    final: 'Added a case-insensitive `search` option to `filterTasks` (title and notes, combined with the other filters; blank searches match everything), wired `taskflow list --search <text>` and `--search=<text>` in the CLI, and added a test. `npm test` passes.'
  },
  {
    // A longer run with large files on a 128K-window model: big reads early,
    // a failing test, a fix and a second test run, so old tool results
    // dominate the later requests.
    id: 'normalize-token-usage',
    task: 'normalize-token-usage',
    model: 'gpt-4o',
    steps: [
      { text: 'Checking the repository state first.', calls: [call('git_status', {})] },
      { calls: [call('list_files', { path: '.' })] },
      { calls: [call('read_file', { path: 'README.md' })] },
      { calls: [call('read_file', { path: 'package.json' })] },
      { calls: [call('grep', { pattern: 'normalizeUsage|prompt_tokens', path: 'src' })] },
      { calls: [call('read_file', { path: 'src/agent.mjs' })] },
      { calls: [call('read_file', { path: 'src/agent.mjs', offset: 335, limit: 25 })] },
      { calls: [call('glob_files', { pattern: 'test/**/*.mjs' })] },
      { calls: [call('read_file', { path: 'test/runtime.test.mjs', offset: 1, limit: 60 })] },
      { text: 'Writing the helper and a test.', calls: [call('write_file', { path: 'src/lib.mjs', content: 'export function normalizeUsage(usage = {}) {\n  const number = (value) => Number(value ?? 0) || 0;\n  const base = number(usage.input_tokens ?? usage.prompt_tokens);\n  const inputTokens = usage.input_tokens !== undefined ? base + number(usage.cache_creation_input_tokens) : base;\n  const outputTokens = number(usage.output_tokens ?? usage.completion_tokens);\n  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };\n}\n' })] },
      { calls: [call('write_file', { path: 'test/lib.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { normalizeUsage } from '../src/lib.mjs';\n\ntest('normalizeUsage counts both cache fields with input_tokens', () => {\n  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 4 }), { inputTokens: 16, outputTokens: 3, totalTokens: 19 });\n});\n\ntest('normalizeUsage keeps prompt_tokens/completion_tokens compatibility', () => {\n  assert.deepEqual(normalizeUsage({ prompt_tokens: 7, completion_tokens: 2 }), { inputTokens: 7, outputTokens: 2, totalTokens: 9 });\n  assert.deepEqual(normalizeUsage(), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });\n});\n" })] },
      { calls: [call('run_command', { command: 'node', args: ['--test', 'test/lib.test.mjs'] })] },
      { text: 'The cache-read count is missing.', calls: [call('read_file', { path: 'src/lib.mjs' })] },
      { calls: [call('edit_file', { path: 'src/lib.mjs', old_string: 'base + number(usage.cache_creation_input_tokens)', new_string: 'base + number(usage.cache_creation_input_tokens) + number(usage.cache_read_input_tokens)' })] },
      { calls: [call('run_command', { command: 'node', args: ['--test', 'test/lib.test.mjs'] })] },
      { calls: [call('run_command', { command: 'npm', args: ['test'] })] },
      { calls: [call('git_diff', {})] }
    ],
    final: 'Added `normalizeUsage` in `src/lib.mjs`: input includes cache creation and cache read counts when `input_tokens` is present, `prompt_tokens`/`completion_tokens` still work, missing values are 0, and total is input + output. Added `test/lib.test.mjs`; the new tests and `npm test` pass.'
  }
];
