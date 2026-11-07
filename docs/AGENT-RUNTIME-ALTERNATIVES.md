# Agent runtime alternatives and decomposition plan

**Research snapshot:** 2026-11-07. **Scope:** the next architecture cycle after the whole-system map: OASIS's agent execution core. This is a source-grounded design comparison, not a recommendation to wholesale-replace OASIS or a claim that a candidate is better before a parity prototype is measured.

## Why this is next

`src/agent.mjs` is OASIS's central execution module. It combines session assembly, provider protocol conversion and requests, streaming/retries, context compaction, tool-call normalization and dispatch, permissions integration, subagents, workflows, verification, telemetry and completion checks. The module's size and responsibility concentration make changes hard to isolate and review. The right first goal is **smaller explicit seams with unchanged behavior**, not a framework migration.

OASIS's existing code also contains important product-specific behavior that a general agent library may not provide: local-first execution, strict tool permissions, sandbox integration, secret filtering, worktree isolation, multiple provider protocols, cancellation/steering, bounded recovery and a runtime-owned verification gate. Any candidate must preserve these properties or remain outside the enforcement boundary.

## What the public-source comparison suggests

The repositories below are architectural references and possible components. The project docs and GitHub repositories should be checked directly at the time of a real adoption decision for current API, support status, license, dependency footprint and security model. A framework's popularity or feature list is not evidence that it is a drop-in replacement.

| Candidate | Best comparison target in OASIS | Potential value | Costs / reasons not to replace wholesale |
|---|---|---|---|
| [LangChain.js](https://github.com/langchain-ai/langchainjs) and [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | Model/tool abstractions; explicit graph state and workflow transitions | Broad ecosystem and a useful reference for modeling a run as state transitions, checkpoints and resumable graph nodes. | Introduces its abstractions and provider/tool adapters across a runtime that already supports direct protocols. Must prove support for OASIS-specific stream replay, approvals, cancellation, local mode, context management and deterministic replay. Avoid a migration that replaces tested behavior with framework defaults. |
| [Mastra](https://github.com/mastra-ai/mastra) | TypeScript-first agents, workflows and observability conventions | Useful comparison for how a TS-native product packages agents, workflows, storage and evaluations behind explicit APIs. | A younger framework surface may change; its persistence/execution model may bring assumptions or service dependencies that conflict with OASIS local-first use. Evaluate individual modules/contracts rather than adopting the platform wholesale. |
| [Vercel AI SDK](https://github.com/vercel/ai) | Provider model calls, streaming and tool-call iteration | Candidate reference or adapter for request/streaming ergonomics and provider boundaries; especially relevant if an interface needs streaming UI integration. | A model SDK does not by itself replace OASIS's authorization, filesystem/process policy, sandbox, local session durability or verification. Confirm which providers/protocol features are supported and whether its abstractions retain required provider-specific metadata. |
| [OpenAI Agents SDK for TypeScript](https://github.com/openai/openai-agents-js) | Handoffs, agent/tool concepts and tracing for an OpenAI-centric deployment | Useful focused reference for defining an agent and its tools without designing every interface from scratch. | Provider-specific orientation is a poor fit as the core of a model-agnostic runtime unless hidden behind OASIS-owned interfaces. Do not outsource safety decisions to model-side instructions or tool schemas. |
| [Google ADK for TypeScript](https://github.com/google/adk-js) | Agent/workflow composition and stateful orchestration | Useful comparison for workflow and multi-agent APIs in a TypeScript codebase. | Evaluate the actual TS package maturity, provider portability, license and local/offline story from its upstream source before adoption. A Google-centered design should not become a required OASIS runtime dependency. |
| [OpenAI Cookbook tool-calling examples](https://github.com/openai/openai-cookbook) | Small reference implementations of provider call → tool dispatch → continuation | Transparent examples can help compare a minimal loop or message conversion with OASIS. | Examples are not a durable runtime, provider abstraction, security boundary or compatibility guarantee. Reuse patterns, not an example as a substitute for OASIS's policies. |

**Initial decision:** none of these should replace all of `src/agent.mjs` in one step. Build a framework-neutral contract and compare implementations behind it. If one candidate cannot preserve an invariant without forks or substantial adapters, retain OASIS's implementation for that seam.

## Proposed OASIS-owned boundaries

These are responsibilities to separate, not a mandate to create classes with these exact names. Keep external data contracts and current behavior stable while extracting one boundary at a time.

| Boundary | Current responsibility / evidence | Contract to extract |
|---|---|---|
| `ProviderTransport` | `requestCompletionRaw`, protocol converters, SSE parsing, retries and fallback handling in `src/agent.mjs`; provider registry is `src/provider-registry.mjs`. | `complete(request, { signal, onDelta, onProgress })` returns normalized assistant output, usage, provider metadata and typed errors. No tool execution; preserve provider call IDs, Responses output items, Anthropic thinking blocks/signatures and compatible-provider reasoning metadata. |
| `TurnCoordinator` | `runAgentTurnRaw` in `src/agent.mjs` controls the model/tool loop, token/tool caps, steering and stop conditions. | Explicit state/event transitions for request, provider response, tool batch, cancellation, retry and finalization. A deterministic reducer should be testable with fake provider and executor ports; side effects remain effects, not state transitions. |
| `ToolPolicy` | `authorizeCall`, `PermissionPolicy`, permission modes, hooks and command risk checks. | One authoritative pre-execution decision with policy version, action fingerprint and decision (`allow`, `ask`, `deny`). Re-authorize after input-changing hooks. The model/framework never supplies its own authorization verdict. |
| `ToolExecutor` | `executeOneCallRaw`, `executeTool`, power tools, MCP and session tools. | Validated tool request → policy → approval → sandbox/executor → bounded result. Preserve path checks, secret redaction, audit events, cancellation, output limits and ordered side effects. Keep third-party MCP calls distinguishable from local built-ins. |
| `ContextManager` | `compactHistoryIfNeeded`, `compactMidTurnHistoryIfNeeded`, `microcompact`, token estimates, image handling and provider-specific context recovery. | Pure planning functions return a proposed context transformation plus accounting; commit only after validity checks. Never separate tool-call/result pairs or lose the active user request. Keep provider usage authoritative when available. |
| `VerificationGate` | `verificationIssues`, `verificationSummary`, `claim-check`, edit/check tracking and assisted verification. | Consume runtime-observed changes/check results and return explicit evidence and blockers. Do not accept model claims or framework “done” statuses as proof. |
| `SessionStore` | `src/sessions.mjs`, checkpoint/transcript persistence and task/workflow storage. | Versioned read/write/append/transaction interface with atomicity, bounded input, migration, backup/export and crash-recovery semantics. Begin with the current file store as the reference adapter; no storage migration is implied. |

Suggested dependency direction: interface → turn coordinator → provider/tool/context/policy/verification ports → concrete adapters. Core policy should not import an agent framework. Provider adapters should not be able to access the workspace. Tool implementations should not choose which model is authoritative. Persistence should store versioned domain state rather than live process handles.

## Staged comparison and replacement plan

### Stage A — freeze current behavior as executable contracts

1. Inventory exports and call sites in `src/agent.mjs`; document module/function responsibilities and current message/event shapes.
2. Add characterization tests for provider conversions and streams, tool-call batches, policy outcomes, retries/fallback, cancellation, compaction, saved-session resume and verification completion.
3. Run the existing full suite, `npm run check`, lint and current harness/token baselines; preserve raw reports and the exact commit.
4. Add invariant tests for local-only/no-network cases and deterministic fake provider/tool adapters. Do not change runtime behavior in this stage.

### Stage B — extract provider transport first

Move one protocol path at a time behind an OASIS-owned `ProviderTransport` contract. Keep direct native protocols as the baseline. Compare only the transport seam with candidate SDKs; ensure tests cover partial and interrupted SSE, reasoning/tool metadata replay, usage/cost, abort, timeout, malformed responses, retry-after and credential redaction. Avoid a gateway service as a requirement for local use.

### Stage C — separate decision loop from execution

Represent one turn as explicit transitions and inject a fakeable provider and tool executor. Tool invocation still passes through OASIS authorization and sandbox policy. Preserve stable event names or provide compatibility mapping to the CLI, web, desktop, ACP and SDK consumers. Test every cancellation and failure boundary, including interruption between tool approval and tool result.

### Stage D — compare a bounded framework prototype

Choose **one** representative task flow, not every interface. Implement the same fixture behind the OASIS contracts using one candidate (LangGraph.js or Mastra are reasonable orchestration references; Vercel AI SDK is a narrower provider/streaming comparison). Record:

- Verified task success and regressions, with fixed task/model/provider and repetitions.
- Tool and provider feature parity, especially local endpoints and provider-specific replay.
- Permission denials, approval prompts, sandbox enforcement and any behavior not expressible without bypassing the OASIS policy boundary.
- Startup, peak memory, package size, dependencies, latency, token usage and cost.
- Recovery after process kill, cancellation, provider outage and corrupted/old state.
- License, transitive dependency, maintenance, security reporting and upgrade burden.

If a framework wins on workflow ergonomics but loses portability, integrate only its isolated workflow layer or keep it as an optional deployment adapter. If it requires duplicate state or bypasses OASIS's executor, reject it for the core runtime.

### Stage E — migrate incrementally or keep the current implementation

Each extracted module gets a compatibility adapter and can be reverted independently. Migrate one feature flag/entry point at a time; remove old paths only after all interface, cross-platform and regression gates pass. Keep the handwritten implementation if alternatives do not demonstrate a clear improvement.

## Hard invariants for any agent-framework experiment

- OASIS remains model-agnostic and local-first; external orchestration services are optional, not silently required.
- The user request, OASIS policy, managed settings and operating-system boundary remain authoritative over framework prompts and model output.
- Every tool call is validated, authorized and executed by the OASIS tool/policy boundary; no framework shortcut may directly run a command or edit a workspace.
- Deny/ask rules remain fail-closed for unsupported or ambiguous shell syntax.
- Cancellation reaches provider streams, child processes, MCP calls where supported, workflows and background workers; unresolved side effects are reported honestly.
- Provider-specific IDs, message blocks, usage, model selection, credentials and error details are preserved without leaking secrets.
- Saved sessions/workflows remain bounded, versioned, recoverable and exportable; no silent history loss or false “completed” state.
- The completion gate uses observed file changes and actual check results, not a framework's final-answer text.
- Telemetry remains disabled by default; prompt, file and tool payloads are not exported by default.

## Implementation progress

The first provider-stream seam has now been extracted on `main` in commit [`7ba3f0a`](https://github.com/FAHTHIZ/oasis/commit/7ba3f0a3ec839bcbeeb95773057770d3f64a9a21). SSE framing, provider event decoding, streamed tool-call slot handling, Anthropic usage merging and response assembly now live in `src/provider-stream.mjs`, with focused coverage in `test/provider-stream.test.mjs`.

This is a deliberately narrow extraction. It does not yet establish a complete `ProviderTransport` interface, nor does it separate request construction, retries, fallback, cancellation and credential handling. Preserve the existing helper compatibility and characterize those remaining behaviours before moving them.

## Next implementation decision

The next code change should be a **characterization-test tranche around provider requests, retries, cancellation and protocol metadata**, followed by another narrow extraction behind an OASIS-owned contract. Do not install a large agent framework just to solve module size. Before choosing between LangGraph.js, Mastra or a smaller provider SDK, verify their current upstream TypeScript APIs, licenses, supported providers, release/maintenance activity and persistence behavior directly. This research snapshot is a shortlist, not a claim that all package details were independently verified or that a winner exists.

## Sources and limits

- [LangChain.js](https://github.com/langchain-ai/langchainjs), [LangGraph.js](https://github.com/langchain-ai/langgraphjs), [Mastra](https://github.com/mastra-ai/mastra), [Vercel AI SDK](https://github.com/vercel/ai), [OpenAI Agents SDK for TypeScript](https://github.com/openai/openai-agents-js), [Google ADK for TypeScript](https://github.com/google/adk-js), and [OpenAI Cookbook](https://github.com/openai/openai-cookbook) are upstream starting points for direct verification.
- Comparison was prompted by current ecosystem search and grounded against OASIS's `src/agent.mjs`, `src/permissions.mjs`, `src/provider-registry.mjs`, `src/sessions.mjs`, runtime tests and existing architecture/benchmark docs.
- Upstream maturity and APIs change quickly. Re-check live repositories, package licenses, security advisories and feature support at the time of any implementation; no dependency or runtime replacement was made by this documentation change.
