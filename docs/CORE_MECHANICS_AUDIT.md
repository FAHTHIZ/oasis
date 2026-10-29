# OASIS core-mechanics audit

**Audit date:** October 29, 2026  
**Scope:** the coding-agent execution engine—not integrations, model/provider count, editor surfaces, plugins, MCP catalogs, or project marketing.  
**Status:** source inspection completed; controlled head-to-head coding benchmark not yet run.

## Executive finding

At the level of the core coding loop, OASIS and Claude Code occupy the same design family: a model reasons over repository context, requests tools, receives tool results, and repeats until it can answer or reaches a stopping condition. That shared shape is expected for tool-using coding agents; it does **not**, by itself, establish copied source code or equal task quality.

OASIS's implementation is visible in this repository. Its main loop is in [src/agent.mjs](../src/agent.mjs#L2998-L3395), tool definitions and execution are in [src/tools.mjs](../src/tools.mjs), and regression tests are in [test/runtime.test.mjs](../test/runtime.test.mjs#L905-L1457). Claude Code's official architecture guide describes the corresponding gather-context → take-action → verify-results loop in [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works#the-agentic-loop).

**Evidence boundary:** the public [anthropics/claude-code repository](https://github.com/anthropics/claude-code) contains setup scripts, examples, command/configuration/plugin material, and documentation. It does not expose the actual CLI runtime implementation in a form that supports a reliable source-to-source diff. Its [LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) states that use is subject to Anthropic's commercial terms. Therefore this document compares OASIS source with Claude Code's officially documented and observable mechanics; it does not claim access to, or make claims about, private Claude Code implementation details.

## Follow one task through the engine

The right unit of comparison is the same task, at the same repository snapshot, with the same acceptance criteria—not a list of product features.

1. **Build working context.** createSession() assembles session configuration, instructions, tools, settings, permissions, hooks, memory, and optional agents. runAgentTurnRaw() adds the user request and can recall saved memory before requesting a model response. See [src/agent.mjs](../src/agent.mjs#L342-L605) and [src/agent.mjs](../src/agent.mjs#L3014-L3079).
2. **Ask the model for its next step.** requestCompletion() adapts the session to the configured provider protocol. The model can return text, tool calls, or both. OASIS supports several provider protocols; using the same model/provider in both products is necessary to reduce model-versus-harness confounding in a benchmark.
3. **Authorize before acting.** executeOneCallRaw() applies tool-availability and plan-mode restrictions, permission policy, approvals, and pre-tool hooks before dispatching a call. Denied operations become results visible to the model instead of being silently treated as successful. See [src/agent.mjs](../src/agent.mjs#L2803-L2940) and [src/permissions.mjs](../src/permissions.mjs).
4. **Execute the requested operation.** src/tools.mjs defines file listing, reads, search, edits, Git inspection, command execution, and other operations. The dispatcher routes session tools, agents, workflows, MCP tools, and core tools through their own handlers. Tool output is bounded and workspace-sensitive operations have path checks.
5. **Feed results back into the next decision.** Each tool result is associated with its call ID and appended to session history. The agent asks the model again. Consecutive read-only calls and consecutive subagent launches may run concurrently, while results are restored to the model's original call order. Side-effect ordering is intentionally preserved.
6. **Recover, bound, and continue.** The loop checks cancellation and tool/token/step budgets; compacts history as needed; records errors; repairs incomplete tool-call history after interruption; and returns explicit non-completion results when limits are reached. The loop is bounded, not literally infinite.
7. **Verify before claiming completion.** After edits, OASIS tracks changed paths, diff review, and recognized verification commands. If the model tries to finish without completing its post-edit gate, the runtime can send one targeted continuation prompt. It reports verification as incomplete if the gate remains unsatisfied. This is enforced by code and tests, not only a prompt: see [src/agent.mjs](../src/agent.mjs#L3101-L3207), [src/agent.mjs](../src/agent.mjs#L3323-L3356), and the [post-edit verification tests](../test/runtime.test.mjs#L1054-L1323).

The key distinction is between **the model's reasoning** and **the harness's guarantees**. The model chooses the next action; OASIS's runtime controls which actions are available, how they execute, how results are returned, and which completion claims are held back by its verification state.

## Core-mechanics comparison

| Mechanic | OASIS source evidence | Claude Code's public description | Audit result |
| --- | --- | --- | --- |
| Iterative tool loop | runAgentTurnRaw() calls the provider, collects tool calls, runs them, appends results, and continues until a stop condition or limit. | Official docs describe context gathering, action, verification, and repeating based on new results. | **Same core pattern.** This is a standard agent-harness pattern, not evidence of shared source. |
| Repository context | Workspace tools, project instructions, memory recall, Git inspection, file reads/search, and optional language-server diagnostics. | Official docs describe access to project files, terminal, Git state, project instructions, and tools for search/execution. | **Strong functional overlap.** Compare discovery quality and relevant-context selection on identical repositories. |
| File modifications | Exact-string edits, whole-file writes, multi-edits, snapshots, path checks, and sensitive-file protections. | Official docs list file-operation tools for reading, editing, creating, and reorganizing files. | **Same job; implementation and edge cases require behavioral tests.** |
| Shell/build/test execution | Command and shell tools, approval policy, execution limits, output caps, cancellation and optional OS sandboxing. | Official docs describe command execution, tests, builds, Git, and other terminal actions. | **Same job.** Compare command choice, failure interpretation, process cleanup, and test reruns. |
| Tool-call ordering and parallelism | runAgentTurnRaw() groups consecutive read-only calls and subagent launches for concurrency but preserves returned order. | Public docs describe chaining tool actions and parallel subagents, but don't establish the same scheduling details internally. | **OASIS behavior is source-verifiable; Claude internals are not inferred from docs.** |
| Error feedback and recovery | Tool failures become structured results; failure hooks can add feedback; output truncation and interrupted history have recovery paths. | Public docs describe course correction as new tool results feed the next model decision. | **Same objective.** Need matched failure-injection tasks to compare actual recovery rate. |
| Context continuity | Model-generated history summary with deterministic fallback, mid-turn compaction, bounded tool-output pruning, persistent memory and saved sessions. | Official docs describe project memory and auto memory; the CLI's exact internal compaction algorithm is not exposed by the cited guide. | **Same problem domain; no defensible claim that algorithms are identical.** |
| Verification | Runtime tracks changed files, full diff review and recognized test/check commands; attempts to finish early can be held for one follow-up; incomplete gate is surfaced. | Official docs include verifying results in the loop, but documentation alone doesn't prove matching enforcement details. | **An explicit OASIS mechanism exists.** Compare whether both catch bad patches and false-success reports on the same tasks. |
| Approval and safety | Rule-based permission policy, plan mode, approval callbacks, pre/post-tool hooks, snapshots, and optional Linux/macOS sandbox. | Claude Code documents permissions, sandboxing, and the ability to interrupt or steer its loop. | **Similar control boundary.** Verify every denial/cancellation path on each environment. |
| State rollback | OASIS checkpoints a turn and can rewind; changed files are snapshotted before modification. | Public descriptions discuss reviewing changes and managing Git workflows; they do not establish an equivalent internal rollback implementation. | **Do not mark as equivalent without a direct test.** |
| Delegation | Child agents have separate contexts, bounded concurrency, tool restrictions, shared state/communication, and optional isolated worktrees. | Public docs describe subagents and native worktree sessions. | **Same class of orchestration.** Compare task decomposition, result integration, isolation and failure cleanup. |

## Where OASIS is explicitly coupled to Claude-format conventions

This is separate from the generic agent loop. Several OASIS files contain deliberate interoperability with Claude Code's on-disk conventions and tool names:

- [src/memory.mjs](../src/memory.mjs#L1-L40) reads CLAUDE.md, .claude/rules/, and ~/.claude/CLAUDE.md alongside OASIS and AGENTS memory files.
- [src/settings.mjs](../src/settings.mjs#L1-L45) reads .claude/settings.json and supports Claude-shaped settings, with explicit precedence and managed-settings paths.
- [src/subagents.mjs](../src/subagents.mjs#L1-L80) imports .claude/agents definitions and maps names such as Read, Edit, Bash, Glob, and Grep onto OASIS tool names.
- [src/hooks.mjs](../src/hooks.mjs#L1-L40) defines a Claude-compatible hook event surface, while [src/agent.mjs](../src/agent.mjs#L27-L50) imports the compatibility mapping used to expose hook-facing names.

Those are real compatibility choices, not evidence of copying the underlying runtime source. However, they make the product boundary look blurrier and cause OASIS behavior to be shaped partly by another product's conventions.

**Recommended architectural separation:** keep the OASIS core's tool names, memory model, settings model, session state machine, and execution policy product-neutral. Put legacy/external-format readers and translators behind a clearly named, tested compatibility adapter. Keep interoperability only where it has real user value; don't let external naming conventions become the internal architecture. Any removal or migration needs tests and a clear data-preservation path.

## What the current evidence does—and does not—prove

**Verified from OASIS source and tests:**
- A bounded model/tool loop exists, with provider adapters and tool-result replay.
- Tool dispatch is separated from authorization, permissions and hooks.
- Context compaction has model-based and deterministic fallback paths.
- The post-edit verification gate has tests for missing diff review, missing verification, partial file reads, and irrelevant commands.
- Existing tests exercise OpenAI-compatible and Responses API tool cycles, transient retry behavior, tool ordering, and context compaction in addition to many safety checks.

**Not proven yet:**
- That OASIS and Claude Code produce equally correct patches on real repositories.
- That the two products choose equivalent actions, recover equally well from failed commands, or preserve requirements equally well over long tasks.
- That their internal implementations are similar line for line.
- That passing OASIS's current unit/smoke suite predicts head-to-head coding performance.

The repository's 22 evaluation fixtures have been described in OASIS's own readiness docs as a smoke suite, not a representative coding benchmark. Do not turn test count, similar loop structure, or a feature checklist into a parity score.

## The benchmark that settles the core question

Use a reproducible, task-level head-to-head evaluation before making stronger claims.

1. **Pin the inputs.** Use the same task prompt, clean base commit, runtime environment, acceptance tests, dependency lock state, and budget/time limit. Choose identical model identifiers when both products genuinely support the same model; otherwise record the provider/model difference separately.
2. **Cover real work.** Include repository-navigation questions; bug fixes requiring regression tests; multi-file features; refactors; a task with an initial test failure; context-heavy work; conflicting or ambiguous instructions; permission denial/cancellation; and tasks that must not modify unrelated behavior.
3. **Repeat stochastic tasks.** Run each task multiple times, preserve raw logs, patches and test output, and report every failure. Do not hand-select only successful runs.
4. **Use objective scoring.** Record acceptance-test pass rate, regressions, unrelated changes, instruction compliance, diff-review findings, verification honesty, recovery after failed actions, elapsed time and estimated cost. Have the same reviewers assess anonymized patches where feasible.
5. **Publish boundaries.** Report which model, runtime version, permissions, tools and environment each trial used. A model mismatch is a confounder, not a result about the harness alone.

The first result should be a task-by-task table—not a single unsupported percentage. This will show whether OASIS's core mechanics are genuinely competitive, where they fail, and which concrete loop behavior needs engineering work next.

## Source map

- [OASIS main agent loop](../src/agent.mjs#L2998-L3395)
- [OASIS tool registry and execution](../src/tools.mjs)
- [OASIS permission policy](../src/permissions.mjs)
- [OASIS context management](../src/context.mjs)
- [OASIS checkpoints and rewind](../src/checkpoints.mjs)
- [OASIS regression tests: context compaction and verification](../test/runtime.test.mjs#L905-L1323)
- [Claude Code: How Claude Code works / agentic loop](https://code.claude.com/docs/en/how-claude-code-works#the-agentic-loop)
- [Claude Code public repository](https://github.com/anthropics/claude-code)
- [Claude Code repository license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)
