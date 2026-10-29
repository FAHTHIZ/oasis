---
name: workflow-authoring
description: Reference for writing OASIS dynamic workflow scripts (the workflow tool): agent, pipeline, parallel, phase, log, args, schemas, sizing, resume and saving.
---

# Writing dynamic workflows

A workflow is a JavaScript script with top-level `await` that the `workflow` tool runs. The script
holds the orchestration and intermediate results; only its `return` value comes back to the
conversation. Use one when a task needs many agents: auditing every file, migrations across many
modules, research with independent cross-checks, fix-until-green loops.

## Globals (the only things the script can use)

- `agent(prompt, options)` runs one subagent and resolves to its final report (a string).
  Options: `label` (shown in /workflows), `schema` (JSON Schema; the reply is parsed and
  validated, retried up to 5 times, and the call resolves to the object), `agentType`
  (`general-purpose`, `Explore`, `Plan`, or a custom agent), `model`, `isolation: 'worktree'`
  (the agent edits in its own git worktree).
- `pipeline(items, (item, index) => agent(...))` runs one task per item with the concurrency
  limit and resolves to results in order. A failed task becomes `null`; filter with `.filter(Boolean)`.
- `parallel([() => agent(...), () => agent(...)])` runs different tasks together; failures are `null`.
- `phase(title)` groups the agents that follow; `log(...)` adds a progress note.
- `args` is the input (a string from `/name text`, or the JSON passed in the tool's `args`).
- Plain JS works: loops, `if`, `JSON`, `Math` (but not `Math.random`), string templates.

Not available: `import`/`require`, files, shell, network, `Date.now()`, `new Date()`,
`Math.random()`, timers. Agents do the real work with their tools under the session's permissions.

## Rules of thumb

1. Start with `export const meta = { name: 'kebab-name', description: '...', phases: [...] }`
   when the workflow may be saved; it is optional for one-off runs.
2. Make every agent prompt self-contained: the agent sees only its prompt, not the conversation.
   Include paths, the goal, constraints, and the exact output wanted.
3. Use `schema` whenever the script reads fields from a result. Keep schemas small, with
   `required` lists and `maxItems` caps.
4. Discover first, then fan out: one `Explore` agent lists the work items (with a schema), then
   `pipeline` processes them. Cap lists (`.slice(0, 50)`) so runs stay sized to the task.
5. Verify independently: a second agent checks each finding or fix without seeing the first
   agent's reasoning; keep only confirmed results.
6. Edits in parallel need `isolation: 'worktree'` or disjoint files; otherwise run edits
   sequentially (`for (const item of items) await agent(...)`).
7. Return a compact result: a summary string or a small object. Large intermediate data stays in
   the script.
8. Hard limits: 1000 agents per run, 4096 items per pipeline/parallel call, concurrency from
   `OASIS_WORKFLOW_MAX_CONCURRENT_AGENTS` (default: CPU count, max 16).

## Example

```js
export const meta = { name: 'find-flaky', description: 'Find and confirm flaky tests', phases: ['List', 'Probe', 'Confirm'] }
phase('List')
const { tests } = await agent('List every test file in this repo (paths only).', { agentType: 'Explore', label: 'list tests',
  schema: { type: 'object', required: ['tests'], properties: { tests: { type: 'array', items: { type: 'string' }, maxItems: 200 } } } })
phase('Probe')
const probes = await pipeline(tests.slice(0, 60), (file) => agent(
  `Run the test file ${file} 5 times with the project's test runner. Report whether results differ between runs and quote the failing assertion.`,
  { label: file, schema: { type: 'object', required: ['flaky'], properties: { flaky: { type: 'boolean' }, evidence: { type: 'string' } } } }))
const suspects = tests.filter((file, i) => probes[i] && probes[i].flaky)
log(`${suspects.length} suspects`)
phase('Confirm')
const confirmed = await pipeline(suspects, (file) => agent(`Independently check whether ${file} is flaky: run it 10 times and explain the cause if it is.`, { label: 'confirm ' + file }))
return suspects.map((file, i) => ({ file, analysis: confirmed[i] }))
```

## Running, resuming, saving

- Run: workflow tool with `script` (inline), `path` (a file in the workspace) or `name` (saved).
  Add `run_in_background: true` for long runs; a notice arrives when it finishes.
- Progress: `/workflows`, `/workflows ID`; stop with `/workflows stop ID` or action `stop`.
- Resume: action `run` with `resume_run_id`; completed agents with the same prompt and options
  return their saved results, so fix the script and relaunch cheaply.
- Save: `/workflows save ID [--user]` writes it to `.claude/workflows/` (or your personal folder);
  it then runs as `/name args`.
