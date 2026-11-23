# Task model

Source: `src/task-model.mjs`, `src/task-tools.mjs`, the task gate in `src/completion-gates.mjs`.

Every non-subagent turn starts by reading the request into a task spec. The same spec shape is used for the main turn, for every delegated agent (`task`, teams, workflows) and for the agent experience store, so planning, delegation, verification and learning talk about the same thing. Reading a request is deterministic and needs no model call.

## What a task carries

| Field | What it holds |
| --- | --- |
| `intent` | `question`, `investigate`, `change`, `create`, `plan` or `operate`, and a one-line summary |
| `domains` | A primary domain and secondary ones: `software`, `security`, `research`, `analysis`, `writing`, `planning`, `automation`, `computer`, `operations`, `general` |
| `complexity` | `trivial`, `simple`, `moderate` or `complex` |
| `risk` | `low`, `medium`, `high` or `critical`, with reasons (destructive, financial, external communication, publishing, production, credentials, system change). A negated action ("do not delete anything") does not count |
| `deliverables` | Files named in the request, a code change, a report, data, a plan, a document, a check run or an action |
| `acceptance` | Criteria, each with a kind and parameters (below) |
| `constraints`, `dependencies` | Constraints stated in the request; ids of tasks this one depends on |
| `permissions` | What the task needs (read, write, execute, network, and any risk permissions). Informational: it never grants anything. Permission rules and approvals decide as before |
| `evidence` | Which kinds of evidence a result needs (check, fetch, execution, file, side effect) |
| `autonomy` | How much ceremony the task gets: planning `none` or `explicit`, verification `none`, `runtime` or `independent` |
| `outcome` | Filled in when the task finishes (below) |

A reply such as "yes" or "go on" continues the previous task instead of starting a new one. The spec is saved with the session.

## Acceptance criteria

Every criterion is evaluated against tool results the runtime recorded, never against the reply's description of them.

| Kind | Met when |
| --- | --- |
| `check_passes` | A test, build or check (optionally a named command) passed after the last edit, finished, ran tests and did not have its exit status hidden by a pipe |
| `file_exists` | The file exists inside the workspace, is not empty and, if asked, contains given text |
| `word_limit` | The reply or a file is within a length in words, sentences, bullets, paragraphs, lines or characters. "A 300-word summary" allows 20% either way; "a two-sentence summary" is a ceiling |
| `cites_sources` | The result cites sources and every cited page was fetched; with `independent`, they count as independent sources (one site, or copies of one story, count once) |
| `claims_supported` | Every citation, quote and computed number in the result is backed by evidence (the report contracts in `src/verification-contracts.mjs`) |
| `side_effect` | A tool result records the action (a commit, push, pull request, install, merge, deleted file, scheduled job). A command that exited 0 is not proof the requested action happened, so this stays `unknown` |
| `independent_review` | A separate reviewer passed the result |
| `manual` | Only a person can judge; always `unknown` to the runtime |

Criteria come from the request ("save it as notes.md", "under 300 words", "with at least two independent sources", "fix ... and make sure the tests pass"). The model can add criteria the request implies with `task_contract declare`, but nothing it sends can set a status, and paths must stay inside the workspace.

## Outcomes

An outcome keeps five results apart, so finishing is never mistaken for succeeding:

- execution: completed, failed, stalled, cancelled or partial
- evidence: the tool results the run left, by kind
- claims: how many checkable claims the result made and how many were supported
- acceptance: criteria met, unmet and unknown
- independent verification: whether a separate review ran and passed

The verdict is derived from them, weakest first:

| Verdict | Meaning |
| --- | --- |
| `failed`, `cancelled` | The run did not complete |
| `incomplete` | It stopped at a step or budget limit |
| `rejected` | A claim was unsupported, a checkable criterion unmet, or a review failed |
| `unverified` | Completed, but nothing about the result was checked |
| `evidenced` | Everything checked held, but some criteria could not be judged by the runtime, or some claims rest only on one source as read, on inference, or on evidence that has since changed |
| `verified` | Every runtime-checkable criterion met, and at least one claim or criterion was actually checked |
| `independently_verified` | Verified, and an independent review passed |

Tool activity alone never raises the verdict: a run that fetched ten pages and cited none of them is `unverified`, and an answer that accurately repeats one page is `evidenced`, not `verified`.

## Claims

Source: `src/claim-ledger.mjs`.

The outcome types each checkable statement in the answer by what backs it. A statement is a claim when it reports a test or build result, cites a URL, quotes, gives a result-like number, or draws an explicit conclusion ("so", "therefore", "suggests", "likely"). Other prose is not counted.

| Status | Meaning |
| --- | --- |
| `observed` | The runtime saw it: a check that passed after the last edit |
| `calculated` | Every number in it was printed by code, a command or a check the agent ran |
| `reported` | It rests on pages the agent read: the cited pages were fetched, quotes are on them, numbers appear in them. What a page says can still be wrong |
| `inferred` | A conclusion; it depends on the claims just before it |
| `unverified` | Nothing observed backs it: a page never fetched, a number nothing printed, "tests pass" with no passing check |
| `contradicted` | The evidence says otherwise: the last check failed, the quoted words are not on the page |
| `stale` | It held when made, but its basis changed later |

A sentence with mixed footing takes its weakest part, and a conclusion drawn from a contradicted claim is unverified. Each claim keeps its basis (evidence ledger entries with URL, command, digest and time), the sources it cites and how many of them are [independent](SUBAGENTS.md#shared-knowledge-board), a confidence score, and its age. `result.task.outcome.claims.byStatus` counts them.

Claims are kept in the session's claim log (saved with the session, at most 200). New evidence is checked against it as it arrives:

- a page fetched again with different content makes the claims citing it stale
- a check that fails after a claim that checks passed contradicts it if no files changed in between, and makes it stale otherwise
- claims that depend on an invalidated claim become stale in turn

Contradicted claims, and claims made stale by a changed page, are named to the agent before its next step, so it can correct itself. Memories saved from an invalidated claim are revised ([Memory](MEMORY.md#saving-what-an-answer-claimed)).

## The task gate

Before the main agent's final answer ends the turn, the completion gate evaluates the task against the turn's evidence. Missing deliverable files, broken length limits, missing or unread sources, and claims the evidence does not back (cited pages never fetched, misquotes, numbers no code printed) send the answer back once with the list. Code checks stay with the post-edit verification gate and the claim check, which already own them. Anything still unmet after that is named at the end of the answer ("Not verified: ..."), and the turn result carries `task` with the spec summary and its outcome. A plan-mode turn is not gated.

An answer that already tells the user the work was not done ("Could not write the file.") is not sent back: the gate exists to catch unfinished work presented as finished. Its outcome is still recorded as unverified or rejected.

Simple tasks stay simple. A trivial question gets no contract text and no extra round trip. Tests after edits and backed claims are standing rules, so a `<task-contract>` block is added to the prompt only when the request spelled out something checkable (a file, a length, sources, an action), when a complex task needs a plan, or when a high-risk task needs independent verification. The block is a few lines; it rides on every request of the turn.

## Delegated tasks

Each subagent run gets its own spec, with the parent task's id as `parentId`, and is assessed when it returns. The `task` result carries `outcome` (verdict, claims checked and supported, acceptance per criterion), and the [experience store](SUBAGENTS.md#experience) records the verdict and claim counts.

## Turning it off

`OASIS_TASK_MODEL=0`, or `"taskModel": false` in settings, turns off the main-turn contract and gate. Subagent assessment and the report contracts are unaffected.

## Limits

Reading a request is pattern-based. It recognizes common phrasings in English and will miss or misread some requests; a wrong criterion costs one extra round trip and is visible in the turn result. The task model checks what the runtime can observe. It cannot judge whether prose is good or a plan is wise; such criteria stay `manual`.
