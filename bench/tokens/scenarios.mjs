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
  }
];
