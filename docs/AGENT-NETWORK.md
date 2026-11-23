# Agent network

OASIS runs subagents, agent teams and workflow agents as one network. Each
agent instance (a "neuron" in the code; nothing here is a neural network) has
a parent, a depth, a budget and a lifecycle record. The `neuron_network` tool
shows the graph to the main agent, and `/tasks` shows it to you.

This page describes what the runtime does today. Everything here is covered
by the tests named in each section.

## Report handoff

Before this slice a subagent report of up to a million characters came back as one tool result, and the parent's 24,000-character tool-result cap kept only its head and tail. In the regression test a 60,000-character report with a marker in the middle reached the parent without the marker. Now the full report is saved in the session scratch folder (git-ignored, symlinked folders refused) and the parent receives under 12,000 characters: the first ~6,000 and last ~2,000 characters and the file path, which it can read with `read_file` offset/limit or `grep`. Structured-output agents (`output_schema`) are unchanged because their result is the parsed object.

## Network ledger

Session files are saved between turns, so a process killed mid-turn used to forget every worker it had started since the last save. Every neuron's spawn, state changes and budget charges are now appended to a ledger in `node:sqlite` at `<config>/sessions/neuron-ledger.sqlite` (`src/neuron-ledger.mjs`). Rows are never edited (an `UPDATE` trigger refuses it); sessions with no activity for 30 days are dropped whole.

On restore, workers found only in the ledger come back as `interrupted` with the tokens and cost they had already spent, and the recovery is itself recorded, so a second restart agrees with the first. No neuron is ever shown as running after a restart. Writes are best-effort: without `node:sqlite`, on a read-only disk or with `OASIS_NEURON_LEDGER=0` the ledger is off and orchestration is unchanged. `OASIS_NEURON_LEDGER_FILE` moves the file.

`test/neuron-ledger.test.mjs` checks this: a scripted network is cut after each of its writes and restored, and every cut has no running neuron and the same lineage as the clean run; a writer killed with `SIGKILL` leaves a ledger that reopens and recovers; and the median spawn with its ledger write stays under 5 ms.

## Scheduler

`task`, agent teams and a workflow's `agent()` all start a child through one path, and that path now asks the scheduler (`src/neuron-scheduler.mjs`) for a slot before the child's first model request. Slots are limited three ways:

| Limit | Default | Change it with |
| --- | --- | --- |
| Agents working at once across the whole network | 8 | `OASIS_NETWORK_MAX_RUNNING` |
| Children of one parent working at once | 8 | `OASIS_SUBAGENT_MAX_CHILDREN` |
| Children on one provider host | no limit | `OASIS_PROVIDER_SLOTS=api.example.com=2,other.host=1` |

A child past a limit waits its turn instead of failing. A foreground child's `task` result then carries `scheduler_note` (for example "Queued for 3.2 s before starting: 8 agents were already running across the network (limit 8)."), a background child is returned as `"status": "queued"` with the reason and starts by itself, and the timeline shows `agent.queued`. `agent_status` marks a waiting agent `queued: true`, the stall monitor does not count the wait, and `agent_stop` cancels it while it waits.

A parent blocked on foreground children gives up its slot until the last of them returns, then takes one again. Only working agents hold slots, so a network full of parents waiting on their own children cannot deadlock. `test/neuron-scheduler.test.mjs` checks this with 40 random spawn trees (nested foreground and background children, random limits and providers): none exceeds a limit, all finish, and every slot is released.

## Budget algebra

Every neuron has a budget (`src/budget-algebra.mjs`) with five kinds of spend: tokens, dollars, requests, steps and children. The main session's limits are its `--max-total-tokens`, `--max-budget-usd` and `--max-requests`; anything unset is unlimited.

When a subagent run starts, it reserves its own budget from its parent's. The reservation counts against the parent at once, so siblings cannot spend the same money twice, and a grant is never more than the parent has left. When the run ends, however it ends (finished, failed, stopped or cancelled), the unspent part goes back to the parent. A resumed agent (`send_message`) reserves again, minus what its earlier runs spent. Every charge is checked against the neuron and every ancestor before it is applied: a model request (with its estimated prompt size), each agent step and each child spawned. The real token count and cost of a reply are recorded when it arrives, so one reply can pass a limit; the next request is then refused. Spawning counts one `children` against every ancestor, so a root limit caps the whole tree.

Set a per-run budget in an agent's front matter:

```yaml
---
name: scout
description: Finds files
budgetTokens: 200000
budgetUsd: 0.5
budgetRequests: 40
budgetSteps: 30
budgetChildren: 2
---
```

or for every subagent with `OASIS_SUBAGENT_BUDGET="tokens=200000,usd=0.5"` (the definition wins per kind). A subagent that runs out stops with a `NEURON_BUDGET_EXCEEDED` error, which its parent sees as the `task` result. Without either setting nothing is reserved and subagents draw on the shared session budget as before.

`test/budget-algebra.test.mjs` runs 60 random concurrent spawn trees with random limits, spends and cancellations. No tree passes its root's limit for any kind, a cancelled child refunds exactly what it had not spent, and after every neuron ends the root holds nothing back.

## Cancellation and leases

Stopping a neuron stops its whole subtree: cancelling the main turn aborts every foreground descendant through the shared signal, and `agent_stop` (or a parent that fails or stalls) aborts every descendant's controller and kills the processes and terminals they own. A neuron waiting for a scheduler slot is cancelled while it waits. `test/neuron-cancellation.test.mjs` runs a main session, a lead and a worker that sits in a 47-second command, and checks both paths stop all of them in under 2 seconds with no process left over.

A neuron that ends without finishing (cancelled, failed or stalled) releases every shared-task lease it holds, not just the task it was started for, so the task goes back to `pending` and another agent can claim it at once instead of after the 15-minute lease. A restored session never restores a live lease, so neurons found `interrupted` after a crash hold none.

## Evidence and contracts

Each session keeps an evidence ledger (`src/evidence-ledger.mjs`). After every tool call the runtime records what the result showed: a check (test, build, lint or type-check) with its exit code and whether a pipe hid it, another command or a code execution with the numbers it printed, a fetched page, a search and the URLs it returned, a file edit, or a side effect such as an install or a commit. Each event has a sequence number and a SHA-256 digest of the result. Only tool results produce events, so a reply that says "all tests pass" adds nothing. An edit makes every earlier check stale.

Verification contracts (`src/verification-contracts.mjs`) read a report together with the ledger range it was written from:

| Contract | When it applies | A claim is supported when |
| --- | --- | --- |
| `code` | The report says tests, builds or checks pass | The last check finished with exit code 0, no pipe hid its status, and nothing was edited after it |
| `research` | The report cites URLs | Every cited URL was fetched (`fetch_url` or the browser); a search hit alone does not count |
| `research` (quotes) | The report puts 5+ words in quotes or a blockquote next to a cited URL | The fetched page contains those words in that order (see [Quote checks](#quote-checks)) |
| `analysis` | The agent declares `domain: analysis`, or it executed code without running any test | Every decimal, percentage or 3+ digit number (years aside) was printed by an execution, command or fetched page; rounding is allowed |

When a subagent finishes, its report is checked against the evidence from that run before the parent sees it. A report with an unsupported claim comes back with `report_status: "rejected"` and `verification_issues` (domain and reason), and the timeline records `agent.report_rejected`. `unverified_claim` is still set for code claims. Background agents' completion notices list the reasons too.

### Quote checks

A fetched URL is not proof that the page says what the report claims. OASIS keeps the text each fetch showed the agent (`src/page-store.mjs`: in memory, up to 2 MB per page and 64 MB in all, repeated fetches of a page add up, a redirect's final URL is stored too) and checks direct quotes against it. A quote is five or more words in `"..."`, `“...”`, `«...»` or a `>` blockquote; it is tied to the URLs cited in the same paragraph or list item, or on the line after a blockquote. Words are compared after lowercasing and dropping punctuation, quote styles and dashes, and `...` or `…` splits a quote into pieces that must appear in order. A quote no cited page contains is a misquote: the report is rejected with the closest passage the page does have. A quote within a word or two of the page (85% word overlap) passes but is reported back as `near`. Pages fetched before a restart have no stored text, so their quotes are skipped rather than failed.

Agents can check before they write with `verify_quote` (`{checks: [{url, quote}]}`), a read-only session tool open to subagents. Each check returns `exact`, `near`, `missing` (with the closest passage), `not_fetched` or `invalid`. Test: `test/quote-verification.test.mjs`.

### Source independence

Five URLs are not five sources when four of them run the same wire story. `src/source-independence.mjs` groups URLs the way a fact-checker would: the same page (after dropping `www.`, AMP paths, fragments and tracking parameters), the same registrable domain (`docs.example.com` and `example.com` are one site; `bbc.co.uk` style suffixes are handled; on shared hosts such as github.com, medium.com or `*.github.io` each owner is its own source), or copied text: when at least half of the shorter page's 6-word shingles appear in the other, as with syndication, reprinted press releases and mirrors. Pages fetched before a restart have no stored text and are grouped by site only (`unchecked`).

The `source_independence` tool (`{urls: [...]}`, read-only, open to subagents) returns the groups and a count. Knowledge-board findings carry `independent_sources`; a corroborating post whose sources are copies of ones already cited is told it adds no independent evidence, and search ranks findings with more independent sources higher. The `deep-research` workflow has each verifier report `independent_sources` and search again when it is 1, and the report says "according to" for single-source claims and calls only claims with two or more corroborated. Test: `test/source-independence.test.mjs`.

Agents of one session can also share findings while they work, on the [shared knowledge board](SUBAGENTS.md#shared-knowledge-board). Each post goes through the same contracts against the poster's evidence and is labelled `grounded` or `noted`.

## Waiting approvals

A background neuron has nobody to ask, so a call that needs approval used to be denied on the spot. Now `src/neuron-approvals.mjs` parks it on the agent's record (tool, redacted arguments, the prompt text) and tells the agent to go on without it and say in its report that the step is waiting. The main agent and the user are told too, and `/tasks` shows `waiting for approval`. Parked requests are saved with the session, so they survive a restart.

`/tasks approve agent_N` or `/tasks deny agent_N` answers it (add the `approval_…` id when an agent has more than one). Approving stores a one-time grant for exactly that call, keyed by a hash of the tool and its arguments, then resumes the agent with the answer: straight into its inbox when it is still running, or through `send_message` from its saved conversation after a restart. The agent's next identical call uses the grant up, so the tool runs once; a repeat, or a call with other arguments, asks again. Denying resumes it with the refusal. A request nobody answers lapses after 24 hours (approving it then reports that it expired), and a grant the agent does not use within 30 minutes of the approval is dropped, so a yes never turns into a standing permission. The main agent cannot answer for the user. Ledger events: `agent.approval_pending`, `agent.approval_granted`, `agent.approval_denied`, `agent.approval_used`.

## Domain packs

The research and analysis packs (`plugins/oasis-research`, `plugins/oasis-analysis`) are ordinary plugins whose agents declare `domain: research` or `domain: analysis`, so the contracts above run on their reports. The evidence ledger records the research pack's `oasis_fetch_url` and `oasis_web_search` MCP tools as fetches and searches, the same as `fetch_url` and `web_search`. See [Domain packs](EXTENDING.md#domain-packs). Test: `test/domain-packs.test.mjs`.

## Spawn-time scope check

A child never gets more reach than the agent that starts it. Its tools are already a subset of the parent's; `src/spawn-scope.mjs` adds two checks on the parent's mode, run for `task`, team members and workflow `agent()` alike because all three start through `runSubagent`:

- A read-only parent (plan mode, or a read-only subagent) starts only read-only children. The child runs in plan mode whatever its own definition says, and is marked `scopeReadOnly` so its own children inherit the limit.
- A read-only parent cannot start a child whose task is a deploy, publish, push or release step (`npm publish`, `git push`, `kubectl apply`, "Deploy the app", "- release v2.1.0"). The spawn is refused with a reason instead of the child failing later at approval time. Research about deploys ("Explain our release process") is allowed.

Test: `test/spawn-scope.test.mjs` (every combination of parent mode, child definition and task).

## Network observability

- `neuron_network` nodes carry a `budget` field for agents that have a budget or spent something: per kind (`tokens`, `usd`, `requests`, `steps`, `children`) the amount `spent`, and with a limit also `limit` and `left`. A running agent's figure includes its open reservation. Prompts, reports and tool arguments are still never included.
- `/tasks` shows the same budget on each agent's row and in `/tasks agent_N`.
- With telemetry on, every `invoke_agent` span has `oasis.neuron.id` (`main` for the top-level turn), and subagent spans add `oasis.neuron.parent_id` and `oasis.neuron.depth`, so a trace backend can rebuild the network.

Test: `test/neuron-observability.test.mjs` (budget projection, a snapshot of the graph, and the span attributes from a real subagent run).

In the web app, every agent event carries the same budget line, so the subagent list under a turn shows what each agent spent against its limit. An agent with a parked approval is marked "needs approval" with the `/tasks approve` or `/tasks deny` command until it is answered (`test/app-subagents.test.mjs`).
