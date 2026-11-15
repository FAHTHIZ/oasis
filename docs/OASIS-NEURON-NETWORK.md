# Oasis Neuron Network

**Status:** architecture and first runtime slice; the [detailed design](#detailed-design-proposal-2026-11) below is a proposal for review  
**Scope:** a model-neutral coordination layer built into the existing Oasis runtime

ONN is a coordination system for agents. It is not a neural network: no
weights are trained by it, and the word "neuron" names an agent instance in
a graph. Model choices (using, fine-tuning or training a model) are covered
separately in [research/MODEL-STRATEGY.md](research/MODEL-STRATEGY.md).

Oasis Neuron Network (ONN) is the coordination architecture for turning Oasis's current subagents, named teams, shared task board, workflows, memory, skills, and verification system into one coherent agent network.

It is not a second agent loop and it is not a thin wrapper around another framework. Existing Oasis sessions and tools remain the execution substrate. ONN gives them a shared topology, policy, lifecycle, and eventually durable scheduling model.

## Design objective

A user describes an outcome. The coordinator chooses whether to work directly, delegate a focused task, run a deterministic workflow, or assemble a temporary team. Each worker receives only the context, model, tools, and workspace access required for its assignment. It returns a verifiable result or a durable artifact reference. The coordinator integrates the results, checks the final workspace state, and reports what was actually verified.

The network should make mid-tier and local models more effective through good decomposition, context control, tool reliability, verification, and reuse—not hide weak results behind more model calls.

## Architecture

### 1. Neuron graph — agent identity and lineage

A neuron is one agent instance with a role, model route, scoped tools, context, workspace, lifecycle, and usage record. A graph has one coordinator root and explicit parent-to-child edges. This is separate from the shared task dependency graph.

Each node should eventually carry:

- identity, role, parent, depth, team, and assigned task;
- capability and tool allowlists, inherited permissions, and isolation mode;
- model/provider route and context budget;
- status, cancellation state, checkpoint reference, and output/artifact references;
- input/output tokens, estimated cost, tool calls, elapsed time, and verification state.

The agent registry remains the source of truth. The first implementation adds lineage metadata to existing agent records and exposes a bounded read-only graph view. Subagents already nest: since 7863a84a (2026-11-08) a subagent can start its own subagents up to `subagentMaxDepth` layers (default 3, maximum 5, set by `OASIS_SUBAGENT_MAX_DEPTH` or `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; 1 turns nesting off), and read-only agents stay leaves. The network scheduler, per-child token and deadline budgets, and delegation security checks described below are not implemented yet.

### 2. Work graph — task dependencies and ownership

Keep `src/shared-tasks.mjs` as the canonical task board. It already validates dependency cycles, supports atomic claims with leases, prevents premature completion, and stores bounded redacted checkpoints.

The two graphs answer different questions:

- **Neuron graph:** which agent spawned or supervises which other agent?
- **Work graph:** which unit of work is blocked by which prerequisite, who owns it, and whether it is complete?

A task may move between agents without changing its dependency identity. A neuron may execute multiple tasks over its lifetime. The relationship is represented by a task ID on the agent record, not by conflating task nodes and agent nodes.

### 3. Coordination and messaging

Retain the current team registry, inbox messaging, activity timeline, cancellation, foreground/background workers, and isolated worktrees. Build a common scheduler around them rather than implementing a second messaging system.

Later scheduler work must provide bounded fan-out, per-parent child limits, depth limits, shared network budgets, cancellation propagation, dead-worker lease recovery, and deterministic shutdown. Worktree branches are not merged automatically; integration remains an explicit, verified operation.

### 4. Context and learning

Borrow Hermes's separation between the agent facade, context engine, memory providers, and skill system:

- Keep short-lived task context inside each neuron.
- Retrieve project and user memory on demand, with source and scope preserved.
- Load skills progressively: a concise index first, full instructions and references only when relevant.
- Distill repeatable successful procedures into reviewable skill proposals.
- Keep procedural learning inert until verified and explicitly approved.

Oasis already has category-based auto-memory, memory verification, skill loading, and a guarded `skill_propose` flow. Those are assets to connect, not features to replace. A future memory-provider contract should let local files remain the default while enabling optional external backends.

No agent may promote its own learning into trusted runtime instructions or permissions. Skill and memory content is data; it never grants capabilities.

### 5. Trust, execution, and verification

Borrow Claude Code's explicit lifecycle hooks, per-agent capability restrictions, and delegation boundaries. Borrow OpenHands's separation of agent decisions, action/observation events, and execution runtime. Keep Oasis's permission engine, sandbox adapters, secret redaction, worktree isolation, and verification gate.

Required invariants:

1. **Inherit and narrow:** a child cannot gain tools, paths, network access, or approval authority that its parent does not have.
2. **No implicit trust:** prompts, files, MCP results, messages, and worker reports are untrusted input.
3. **Delegation boundary checks:** validate the child task against the user's goal and the parent's authority before launch; inspect returned artifacts and claims before accepting them.
4. **One execution policy:** every tool execution path must converge on the Tool Kernel or a reviewed adapter that preserves the same policy, cancellation, timeout, schema, and audit contracts.
5. **Verify after the latest change:** tests and diagnostics count only when they ran against the current workspace state.
6. **No silent integration:** worktree changes are reviewed and tested before they reach the shared branch.

### 6. Runtime and durability

Do not replace Oasis's provider transport or session system just to adopt a graph library. Reuse its provider abstraction, context compaction, session persistence, transcripts, task leases, and checkpoints.

The future scheduler should persist state transitions and recover only from validated checkpoints. A resumed network must distinguish a restored summary from a live worker process. A process that did not survive restart must never be reported as still running.

### 7. Budget-aware model routing

Each neuron will receive an explicit budget envelope: maximum steps, token ceiling, cost ceiling when pricing is known, wall-clock deadline, and maximum tool calls. Child budgets are deducted from the parent allocation, not independently minted.

Model selection should consider task type, required tool capabilities, context size, latency, observed success, provider availability, and remaining budget. Local models remain valid choices for exploration, indexing, simple edits, and verification where they perform adequately. Expensive models should be reserved for work where measured quality justifies the spend.

## What we borrow — and what we do not

| Reference | Patterns to adopt | What not to copy wholesale |
|---|---|---|
| Hermes Agent | Modular agent facade, provider-neutral request normalization, persistent but bounded memory, skill induction, progressive prompt/context assembly | Its Python runtime and provider/plugin assumptions |
| Claude Code | Specialized subagents, teams, task claims, lifecycle hooks, layered settings, permission scoping, checkpoints, delegation checks | Closed implementation details or a Claude-only provider architecture |
| OpenHands | Clear agent/action/observation/runtime boundaries and pluggable execution environments | A second execution server or heavyweight app stack inside Oasis |
| Pi coding agent | Small extensible lifecycle hooks, tool registration, stateful extension contracts | Replacing Oasis's existing coding loop for its minimalism alone |
| LangGraph | Durable graph checkpoint concepts, pause/resume and interrupt semantics | A mandatory second graph runtime before Oasis proves it needs one |

Useful upstream references:

- [Hermes Agent architecture](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/architecture.md)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), [agent teams](https://code.claude.com/docs/en/agent-teams), [hooks](https://code.claude.com/docs/en/hooks), [permissions](https://code.claude.com/docs/en/permissions), and [checkpointing](https://code.claude.com/docs/en/checkpointing)
- [OpenHands backend architecture](https://github.com/OpenHands/docs/blob/main/openhands/usage/architecture/backend.mdx)
- [Pi coding-agent extensions](https://github.com/pi0/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [LangGraph persistence and checkpointing](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/checkpointers.mdx)

## Implementation sequence

| Phase | Deliverable | Acceptance criteria |
|---|---|---|
| 1. Network identity | Agent parent/depth lineage, graph inspection, persisted lineage | Existing top-level agent behavior unchanged; restored history preserves valid lineage |
| 2. Bounded hierarchy | Recursive delegation with depth, fan-out, child, token, cost, and deadline budgets | Cannot exceed any parent or session budget; cancellation reaches descendants **Partly done:** depth limit (`src/subagent-support.mjs`), one dollar ledger shared with the parent's `--max-budget-usd`, the 8-agent background cap shared across the tree, and stopping or failure of an agent stopping its descendants (`stopDescendants`). Per-child token, fan-out and deadline budgets are not implemented. |
| 3. Delegation trust | Intent/capability checks at spawn and result/artifact checks at return | No permission escalation; suspicious or out-of-scope output is quarantined |
| 4. Artifact handoff | Durable worker artifacts and compact structured reports | Large outputs are referenced, not repeatedly copied through parent context. **Reports done (November 2026):** a report over 12,000 characters (`OASIS_SUBAGENT_HANDOFF_CHARS`, `off` to disable) is written whole to `<scratch>/agents/<id>.md` and the parent gets a head/tail preview plus `report_file`, foreground and background (`src/report-handoff.mjs`, `test/report-handoff.test.mjs`). |
| 5. Unified scheduler | One coordination path for agents, teams, and workflow-created workers | Leases, retries, backpressure, shutdown, and recovery are consistent |
| 6. Tool Kernel coverage | Route remaining session, IDE, MCP, and extension execution paths through shared policy contracts | Characterization tests prove parity for approvals, cancellation, audit, and errors |
| 7. Learning fabric | Memory-provider contract and evidence-backed skill induction | No unverified or unapproved learning becomes active |
| 8. Recovery and evals | Durable graph checkpoints and network-level benchmark suite | Reproducible resume, fault injection, regression and security tests pass |

## First implementation slice

The first code slice introduces:

- parent ID and depth on agent records;
- persistence and restoration of that lineage;
- a read-only `neuron_network` tool for the main coordinator;
- bounded graph output containing status, role, task/team links, workspace mode, and aggregate usage.

This slice did not change spawning. Nested subagents were added separately (see phase 2) with a depth limit and shared dollar and background-agent caps; the per-child token and deadline budgets and the spawn-time trust checks of phases 2 and 3 are still missing.

## Report handoff (phase 4, first slice)

Before this slice a subagent report of up to a million characters came back as one tool result, and the parent's 24,000-character tool-result cap kept only its head and tail. In the regression test a 60,000-character report with a marker in the middle reached the parent without the marker. Now the full report is saved in the session scratch folder (git-ignored, symlinked folders refused) and the parent receives under 12,000 characters: the first ~6,000 and last ~2,000 characters and the file path, which it can read with `read_file` offset/limit or `grep`. Structured-output agents (`output_schema`) are unchanged because their result is the parsed object.

## Detailed design (proposal, 2026-11)

This section turns phases 2 to 8 above into one design. It was written after
the [Hermes Agent study](research/HERMES-AGENT.md) and the
[ecosystem comparison](research/OSS-ECOSYSTEM.md), and it is the network
half of the [general-purpose architecture](research/GENERAL-PURPOSE-ARCHITECTURE.md).
Nothing in it is implemented until the [roadmap](research/ROADMAP.md) marks
it done.

### Components

| Component | Responsibility | Built on |
| --- | --- | --- |
| Coordinator | The main session. Decides to work directly, delegate, run a workflow or form a team; integrates results; owns the user conversation | `src/agent.mjs` turn loop |
| Scheduler (new) | The one place that starts, queues, pauses, cancels and recovers neurons, for subagents, teams and workflow-created workers alike | Replaces the separate start paths in `src/agent-subagents.mjs` and `src/agent-tasks.mjs`, keeping their behaviour |
| Registry | Neuron records and lineage | Existing agent registry plus `src/neuron-network.mjs` |
| Work graph | Tasks, dependencies, claims and leases | `src/shared-tasks.mjs`, unchanged |
| Ledger (new) | Append-only journal of state transitions, budget charges and evidence events, persisted per session | `node:sqlite`, same file family as `src/session-search.mjs` |
| Router | Model route per neuron from task domain, capabilities, context size, remaining budget and observed success | `src/model-routing.mjs`, `src/escalation.mjs`, `src/cost-policy.mjs` |
| Gate | Spawn-time checks (authority, scope) and return-time checks (evidence, artifacts) | `src/permissions.mjs`, the evidence ledger in the general-purpose design |

### Neuron record

Fields marked new are additions to the existing agent record.

```text
id, parentId, depth                      existing (lineage)
role, description, background            existing
teamId, sharedTaskId                     existing
workspace: shared | worktree             existing
access: read-only | write-capable        existing
kind: leaf | orchestrator                new (Hermes-style; leaves cannot spawn)
domain: code | research | analysis | automation | writing   new
tools: allowlist (subset of parent)      new as an explicit, persisted set
route: { provider, model, reasoning }    existing in config; persisted
budget: { steps, tokens, usd, deadline, toolCalls, children }   new
spent:  { steps, tokens, usd, toolCalls, children }             new (usage exists)
state, stateSince, attempt               new (state machine below)
checkpoint, reportFile, artifacts[]      reportFile exists; others new
evidence: ledger range for this neuron   new
```

### Lifecycle

```text
proposed --gate ok--> queued --slot free--> running --report--> reviewing --accepted--> done
    |                   |                     |  ^                   |
    |gate refused       |cancel               |  |resume             |rejected
    v                   v                     v  |                   v
 refused            cancelled              waiting (approval, input, child, lease)
                                              |
                       budget or deadline --> stopped(budget)
                       error --------------> failed (retry if attempt < limit)
                       process restart ----> interrupted (never "running")
```

Rules:

- Every transition is a ledger entry written before the effect is visible.
- On restart, every neuron whose last state was `running` or `waiting` is
  moved to `interrupted`. It is never reported as running. Resuming it
  starts a new attempt from its last checkpoint with the existing
  `<interrupted-turn>` recovery note.
- `reviewing` is where the coordinator (or a gate rule) checks the report
  against the neuron's evidence. A report without the evidence its domain
  requires is `rejected` with the reason, and the coordinator decides
  whether to retry, re-scope or tell the user.

### Budget algebra

- A child's budget is reserved from the parent's remaining budget at spawn
  and returned (unspent part) when the child ends. Budgets are never minted.
- The session root's budget comes from the existing `--max-budget-usd`,
  `--max-turns`, token budgets and zero-budget mode.
- `children` bounds fan-out per parent; `depth` keeps the current
  `subagentMaxDepth` (default 3, maximum 5); total live neurons keep the
  current background cap of 8 per tree.
- Defaults follow the evidence Hermes recorded: one-shot runs get at most 2
  children unless the user raises it, because children re-pay the system
  prompt and re-explore.
- Enforcement is in the scheduler and the provider request path
  (`src/cost-policy.mjs` already refuses a request that would break a
  budget), not in prompts.

### Scheduling

- Queue ordered by: user-facing first (foreground before background), then
  work-graph readiness (all dependencies done), then age.
- Slots: global (8), per parent (`budget.children`), per provider (from the
  quota ledger's reported limits, so a free tier is not flooded).
- Backpressure: a parent that spawns past its slots gets `queued` children
  and a tool result that says so; it is not blocked silently.
- Cancellation propagates to all descendants (existing `stopDescendants`);
  the scheduler adds the ledger entries and the budget refunds.
- Leases: a neuron that holds a shared-task claim renews it while running;
  `interrupted` neurons lose their lease, so another neuron can claim the
  task (the store already refuses to restore live leases).

### Messages

Existing inbox messaging and team messages stay. Message kinds are fixed:

```text
assign      coordinator -> neuron   task, constraints, budget
report      neuron -> parent        summary, reportFile, artifacts, evidence range
question    neuron -> parent/user   needs input (moves the neuron to waiting)
progress    neuron -> parent        optional heartbeat, never required for correctness
cancel      parent -> neuron        propagates down
```

Message bodies are untrusted input to the receiver, like tool results.

### Spawn-time and return-time checks

At spawn (`proposed -> queued`):

1. Tools, paths, network and approval authority are a subset of the
   parent's (existing invariant 1, now checked on the persisted allowlist).
2. The task text is checked against the user goal and the parent's task
   for scope: a child of a read-only research task cannot be given a
   deploy step. Mismatches are refused with a reason; the coordinator can
   ask the user.
3. The budget reservation succeeds.

At return (`reviewing`):

1. The domain contract finds the evidence the report's claims need in the
   neuron's ledger range.
2. Artifacts exist, are inside the neuron's workspace, and are referenced
   by path and digest.
3. Worktree changes are not merged; integration remains a separate,
   verified step by the coordinator.

### Observability

- `neuron_network` (existing tool) gains state, budget and spent fields.
- `/agents` and `/tasks` in the terminal, and the web app, will read the same projection (planned).
- OpenTelemetry spans per neuron when telemetry is on, using the GenAI
  `invoke_agent` naming already supported.
- The ledger is the audit trail; it is redacted like transcripts.

### Interfaces for workflows and the SDK

Workflows (`src/workflows.mjs`) keep `agent()` and `pipeline()`. Under the
scheduler they create neurons like the `task` tool does, so workflow fan-out
is bounded by the same slots and budgets. The SDK (`src/sdk.mjs`) gets a
read-only network view and a cancel call; no SDK caller can create a neuron
with more authority than the session it belongs to.

### Acceptance criteria

| Area | Criterion | How it is checked |
| --- | --- | --- |
| Budgets | No neuron tree spends more tokens, dollars, steps or children than its root allows, under concurrent spawns | Property test with random spawn trees and a scripted model |
| Recovery | After a kill at any ledger write, restart shows no neuron as running, and resumed work produces the same final work-graph state | Fault-injection test that kills the process at each write |
| Cancellation | Cancelling any neuron stops all descendants within 2 seconds and refunds their unspent budget | Integration test with sleeping tools |
| Authority | No spawned neuron has a tool, path or network permission its parent lacks, including through workflows and teams | Exhaustive test over permission combinations |
| Evidence | A child report claiming passing tests without a matching ledger entry is rejected | Scripted-model test |
| Parity | Existing subagent, team, workflow and task-board tests pass unchanged | The current test suite |
| Overhead | Scheduler and ledger add under 5 ms per spawn and under 1% to a 30-step session on a 2-CPU machine | `bench/harness/run.mjs` timing |
