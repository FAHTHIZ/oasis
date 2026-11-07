# Oasis Neuron Network

**Status:** architecture and first runtime slice  
**Scope:** a model-neutral coordination layer built into the existing Oasis runtime

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

The agent registry remains the source of truth. The first implementation adds lineage metadata to existing agent records and exposes a bounded read-only graph view. Nested spawning remains disabled until the network scheduler, inherited budgets, and delegation security checks are implemented.

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
| 2. Bounded hierarchy | Recursive delegation with depth, fan-out, child, token, cost, and deadline budgets | Cannot exceed any parent or session budget; cancellation reaches descendants |
| 3. Delegation trust | Intent/capability checks at spawn and result/artifact checks at return | No permission escalation; suspicious or out-of-scope output is quarantined |
| 4. Artifact handoff | Durable worker artifacts and compact structured reports | Large outputs are referenced, not repeatedly copied through parent context |
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

It intentionally does not enable recursive worker spawning yet. That requires the budget and security layers above; removing the current recursion guard before those controls exist would be a regression, not an improvement.
