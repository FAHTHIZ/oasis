# Memory

OASIS keeps durable notes across sessions: preferences, decisions with their reason, non-obvious project facts and lessons. This page covers how they are stored, recalled and checked, and how a memory changes when the facts change.

## Where memories live

Each memory is a Markdown file with a short header, so you can read and edit it:

```
<config>/memory/user/<category>/<slug>.md             every project
<config>/memory/projects/<key>/<category>/<slug>.md   one repository
```

Categories are `preferences`, `project`, `decisions`, `lessons`, `people` and `reference`. Each folder has a generated `MEMORY.md` index. A store holds at most 500 memories (`OASIS_MEMORY_LIMIT` lowers that). When it is full, the least valuable note moves to `.archive/` instead of the save failing: outdated notes go first, then stale ones that were never recalled. Secrets and `<private>` text are redacted before anything is written.

`oasis memory list`, `search Q`, `show ID`, `forget ID` and `path` manage them from the terminal. `OASIS_AUTO_MEMORY=0` turns auto memory off. With `"memoryWriteApproval": "ask"` or `"queue"`, every save and delete the agent makes waits for you (`/memory pending`, `/memory approve ID`).

## Recall and freshness

The one-line abstract of every memory goes into the system prompt. Most valuable memories come first, and outdated ones are left out. For each prompt, the full text of the few most relevant memories is recalled with BM25 ranking. A recalled memory shows its freshness:

| Freshness | Meaning |
| --- | --- |
| current | checked with `memory_verify` since it last changed, within 90 days |
| unverified | never checked, or changed since it was checked |
| stale | not updated or checked for 90 days |
| uncertain | checked but the evidence was incomplete, or the belief has gone back and forth |
| outdated | contradicted; it leaves the index but stays searchable |

`memory_verify` records what was checked (`current`, `outdated` or `uncertain`, with a short evidence reference such as a file and line).

## Belief revision

A note that contradicts a saved memory is a revision, not an addition. Before this, the new text was appended, leaving both beliefs in one note ("the test command is npm test … the test command is pnpm vitest"), or saved under another name while the old note kept being recalled next to it.

OASIS compares the new note with saved ones statement by statement. Two statements conflict when they:

- give different figures or versions (`Postgres 14` vs `Postgres 16`);
- negate each other;
- swap an opposite word (`enabled` vs `disabled`);
- give the same slot a new value (`the test command is npm test` vs `… is pnpm vitest`, `prefers tabs` vs `prefers spaces`).

A slot needs a word such as "is", "uses", "prefers" or ":", so a plain list ("run lint before commit", "run tests before commit") is never read as one item replacing another. What happens next depends on where the conflict is:

| Situation | What OASIS does |
| --- | --- |
| The same memory (same name, or nearly the same abstract) | The contradicted statements are replaced. Unrelated statements stay. The old statement goes into the memory's revision history with when, why (`"npm test" vs "pnpm vitest"`), which session and what evidence. |
| Another memory | The old memory is marked `outdated`, with a note saying what superseded it and why. The two are linked (`supersedes` / `superseded_by`), so it leaves the index and recall no longer offers it as current. |
| The old memory was verified current | It is not overturned by a bare assertion. Saving into it is refused with the verification it would contradict, and a new memory under another name is kept as `uncertain` next to it. Pass `evidence` (what shows the new statement is true) or `replace: true` to go ahead. |
| A revision back to a belief that was revised away | The memory is marked `uncertain`: the evidence keeps changing, so verify it before relying on it. |

`memory_save` returns what happened (`revised`, `superseded`, `contested`, `flipflop`, or `action: "conflict"`) with a note for the agent. `memory_read` shows the full revision history, `memory_search` the last three revisions, and a recalled memory shows its last two (`Revised 2026-11-23: was "…" (reason)`) and the evidence it was saved with.

### Saving a board finding

Subagents cannot write memory. The main agent saves what they found once it has been checked. `memory_save` with `from_finding: "k_N"` takes a finding from the session's [shared knowledge board](SUBAGENTS.md#shared-knowledge-board). The finding's claim, detail and sources become the content. If the runtime grounded the finding, its provenance becomes the memory's evidence: who posted it, who corroborated it, how many independent sources it has, and the URLs. A retracted finding is refused. So is a finding that is still [contested](SUBAGENTS.md#disagreements), until the dispute is resolved.

### Saving what an answer claimed

A memory that restates a claim from this session's answers is linked to it in the [claim log](TASK-MODEL.md#claims), by a shared URL in its evidence or a close match in wording. `memory_save` returns the linked claim ids, and says so when a linked claim was unverified, contradicted or stale. When later evidence undoes the claim (the cited page changes, a check that passed now fails), the memory is marked uncertain, or outdated if the claim was contradicted, with a verification note naming the claim and the cause.

Tests: `test/memory-revision.test.mjs`, `test/auto-memory.test.mjs`, `test/claim-ledger.test.mjs`.
