# Implementation roadmap

**Date:** 2026-11-15, updated 2026-11-17. Status: P0 to P2 are built, each
row says what shipped. Two rows wait on a harness run with real models: the
lower `-p` child default (0.3) and the cost gate for capability routing (2.3).
P3 is waiting for benchmarks or a user need. The items follow the
[Neuron Network design](OASIS-NEURON-NETWORK.md#detailed-design-proposal-2026-11).
Items are ordered so that each one is useful alone, can
ship in a normal release, and builds on the existing OASIS runtime rather
than beside it.

Every item has acceptance criteria that a test or benchmark can check. An
item is "done" only when its criteria pass in CI on Linux, macOS and
Windows, the full test suite passes, and the docs describe what shipped
(not what was planned). This file is updated in the same commit.

Priorities:

- **P0:** low cost, protects existing behaviour, or unblocks later items.
- **P1:** the two core changes (scheduler + ledger, evidence contracts).
- **P2:** capabilities that depend on P1.
- **P3:** optional, benchmark-gated, or waiting for a user need.

## P0: guards and small adoptions

| # | Item | Source of the idea | Acceptance criteria |
| --- | --- | --- | --- |
| 0.1 | Prompt-surface snapshot test: the system prompt and tool list for fixed configs are snapshotted; any change needs an explicit snapshot update | Hermes Agent (MIT), study | Done: `test/prompt-surface.test.mjs`. Fails when a tool description or prompt section changes without a snapshot update; covers default, a git repository with project instructions, plan mode, a small context window and the explore subagent, and checks the system prompt is byte-stable across requests of one turn |
| 0.2 | Delegation roles `leaf` / `orchestrator` on agent definitions; leaves cannot call `task` | Hermes `max_spawn_depth` and orchestrator role | Covered by existing features, so no new field was added: `disallowedTools: task` (or leaving `Agent` out of `tools`) makes a leaf, read-only agents never get `task`, and `subagentMaxDepth` bounds nesting ([Subagents](SUBAGENTS.md#safety-boundaries), `test/subagent-nesting.test.mjs`) |
| 0.3 | One-shot child cap: `oasis -p` runs default to at most 2 concurrent children unless configured | Hermes `oneshot_max_children` | Partly done: `subagentMaxParallel` / `OASIS_SUBAGENT_MAX_PARALLEL` caps children per reply (`test/subagent-max-parallel.test.mjs`: 5 requested, at most 2 overlap, all 5 run). The default stays 6 until a harness run shows a lower `-p` default saves tokens without losing pass rate |
| 0.4 | Static audit of skill and plugin scripts at install (`src/skill-install.mjs`): report shell, network and file-write patterns before enabling | Hermes skills guard | Done: `src/skill-audit.mjs` runs in `oasis skills add`, `oasis plugin install`/`update` (Claude Code and native plugins), `oasis add` and the agent install tools (`test/skill-audit.test.mjs`, `test/claude-plugins.test.mjs`, `test/native-plugins.test.mjs`). `curl \| sh` is a warning and still installs; high-risk lines refuse the install, and the confirmation is re-running with `--allow-risky` (the agent tool cannot override). Benign fixtures report nothing; files are only read. Calibrated on 209 Oasis and Hermes skills (1 refused, a keychain read) and 58 Anthropic and Oasis plugins (none refused) |
| 0.5 | Trajectory export filter: `oasis sessions export --verified` keeps only sessions whose completion gates passed, and redacts secrets with the bundled rules | Model strategy | Done: `sessionVerified` in `src/trajectories.mjs` (`test/trajectories.test.mjs`). The completion gates themselves are not logged, so "verified" means the session's event log ends on a passing verification command with no successful edit after it. A planted token exports redacted; failing, never-checked and edited-after-check sessions are excluded; formats unchanged |

## P1: the two core changes

| # | Item | Acceptance criteria |
| --- | --- | --- |
| 1.1 | Network ledger in `node:sqlite`: append-only state transitions and budget charges per neuron | Done: `src/neuron-ledger.mjs`, see [Network ledger](OASIS-NEURON-NETWORK.md#network-ledger-roadmap-11). `test/neuron-ledger.test.mjs` cuts a scripted network after every write: after restart no neuron is running and the lineage matches the clean run; a `SIGKILL`ed writer recovers; median spawn with the ledger write is under 5 ms. The ledger is written alongside the registry; the scheduler (1.2) will read it |
| 1.2 | Scheduler: one start path for `task`, teams and workflow `agent()` | Done: `src/neuron-scheduler.mjs`, see [Scheduler](OASIS-NEURON-NETWORK.md#scheduler-roadmap-12). Existing subagent, team, workflow and task-board tests pass unchanged; global cap 8, per-parent children and per-provider slots are enforced in a property test over 40 random spawn trees; queued children get `scheduler_note` or `status: queued` with the reason. Parents waiting on foreground children park their slot, so nesting cannot deadlock |
| 1.3 | Budget algebra: reservations from parent to child, refunds on end, enforced in the scheduler and `src/cost-policy.mjs` | Done: `src/budget-algebra.mjs`, see [Budget algebra](OASIS-NEURON-NETWORK.md#budget-algebra-roadmap-13). `test/budget-algebra.test.mjs` runs 60 random concurrent spawn trees: no tree exceeds its root's tokens, dollars, requests, steps or children, a cancelled child refunds exactly its unspent reservation, and nothing is held back once every neuron has ended. An end-to-end test stops a looping subagent at its `budgetRequests` |
| 1.4 | Cancellation and leases through the scheduler | Done, see [Cancellation and leases](OASIS-NEURON-NETWORK.md#cancellation-and-leases-roadmap-14). `test/neuron-cancellation.test.mjs`: cancelling the main turn, or `agent_stop` on a background lead, stops a nested worker that sits in a 47-second command in under 2 s and leaves no process behind; an ended neuron releases every lease it claimed (`releaseAgentLeases` in `src/shared-tasks.mjs`), and a restored session never restores a live lease |
| 1.5 | Evidence ledger: the Tool Kernel records evidence events from tool results (test runs, fetches, executed cells, side effects) with digests | Done: `src/evidence-ledger.mjs`, see [Evidence and contracts](OASIS-NEURON-NETWORK.md#evidence-and-contracts-roadmap-15-17). Checks, commands, code executions, fetches, searches, edits and side effects are recorded from tool results with SHA-256 digests; nothing reads model text. `test/evidence-ledger.test.mjs`: reads and denied calls add nothing, an edit makes the earlier check stale and a piped check proves nothing, as in `src/claim-check.mjs` |
| 1.6 | Domain verification contracts: `code` reimplemented on the evidence ledger, then `research` and `analysis` | Done: `src/verification-contracts.mjs`. The subagent claim-check tests now run against the `code` contract and pass unchanged; a research report citing a URL that was only searched or never fetched is flagged (unit and end-to-end); an analysis number no execution printed is flagged, with rounding and percentages allowed. Agent definitions can declare `domain: analysis` |
| 1.7 | Return-time gate: child reports reviewed against the child's evidence range | Done: subagent reports are checked against the child's evidence for that run. A scripted child claiming passing tests with no test-run event comes back with `report_status: "rejected"` and `verification_issues` giving the reason (`test/subagent-claim-check.test.mjs`); `unverified_claim` is kept for existing callers and an `agent.report_rejected` event is logged |

## P2: capabilities on top of P1

| # | Item | Acceptance criteria |
| --- | --- | --- |
| 2.1 | Serializable approval state: a pending approval in a background neuron survives restart and can be answered later | Adapted from OpenAI Agents JS (MIT). Restart test: the approval is shown after restart, answering it resumes the neuron, and the tool runs exactly once. Done: `src/neuron-approvals.mjs` parks the request, saves it with the session and answers it with `/tasks approve` or `/tasks deny`; a one-time grant covers that exact call; `test/neuron-approvals.test.mjs` |
| 2.2 | Spawn-time scope check of the child's task against the parent's task and access | Read-only parent cannot create a child with write tools or a deploy step (test over permission combinations, including teams and workflows) Done: `src/spawn-scope.mjs`, `test/spawn-scope.test.mjs` |
| 2.3 | Capability router: per-model results on `evals/tasks/` select the cheapest route above a quality floor per task class | Router decisions are reproducible from a stored results table; on the harness, cost drops with no task-class pass rate falling more than 2 points versus the current routing. Built, gate not yet run: `src/capability-router.mjs`, `oasis eval --route-table`, `modelRouting.mode: "capability"` (opt-in); `test/capability-router.test.mjs`. The harness comparison needs real model runs |
| 2.4 | Compaction-triggered reflection: when a session compacts, propose memory and skill updates through `src/learning.mjs` (still inert until approved) | Adapted from Letta (Apache-2.0). Proposals appear after compaction in a fixture session; nothing is written without `/learning approve`. Done for skills: `src/compaction-reflection.mjs`, `test/compaction-reflection.test.mjs`; memory keeps its existing write path |
| 2.5 | Domain packs: `plugins/oasis-research` becomes the research pack with agent roles and a verification contract; an analysis pack follows | Pack installs through the existing plugin path; its contract is used by 1.6; removing the pack restores current behaviour. Done: `plugins/oasis-research` (researcher and fact-checker agents, `domain: research`) and `plugins/oasis-analysis` (analyst agent, `domain: analysis`); the evidence ledger counts the pack's fetch and search tools; `test/domain-packs.test.mjs` |
| 2.6 | Network observability: `neuron_network`, `/agents`, `/tasks` and the web app show state, budget and spent from the ledger | Snapshot tests of the projection; OpenTelemetry `invoke_agent` spans carry neuron id and parent id when telemetry is on. Done for `neuron_network`, `/tasks` and telemetry, see [Network observability](OASIS-NEURON-NETWORK.md#network-observability-roadmap-26); `test/neuron-observability.test.mjs`. The web app's subagent list shows each agent's budget and a waiting approval from the same events (`test/app-subagents.test.mjs`) |

## P3: optional and benchmark-gated

| # | Item | Gate before adoption |
| --- | --- | --- |
| 3.1 | Local embeddings plus `sqlite-vec` for memory and session recall | Beats FTS5 on `evals/memory-retrieval/` recall@5 by at least 10 points, adds under 150 MB installed size as an optional dependency, and OASIS works with it absent |
| 3.2 | Optional in-process small model (`node-llama-cpp`, `transformers.js` or `onnxruntime-node`) for routing or injection screening | Measured gain on a labelled set; optional dependency only |
| 3.3 | Offline prompt and skill optimisation with DSPy against the eval harness | Optimised text improves the held-out eval set and is reviewed like any other change; DSPy never becomes a runtime dependency |
| 3.4 | First fine-tune of a small open-weight model (Apache-2.0 or MIT base) on verified trajectories | Only with a measured gain on the held-out eval set and a permissive base licence |
| 3.5 | Critic-based refinement loop for a domain | Adapted from OpenHands SDK (MIT); only when a benchmark shows a gain for that domain and the loop is bounded |
| 3.6 | A2A protocol endpoint | A concrete user integration that MCP and ACP cannot serve |

## Not on the roadmap

- Replacing the OASIS turn loop, provider transport or permission engine
  with another framework.
- Bundling model weights.
- An original pre-trained model.
- Dependencies rejected in the
  licensing review (Apache-2.0, MIT, BSD and ISC only; see [third-party notices](../THIRD-PARTY-NOTICES.md)).
