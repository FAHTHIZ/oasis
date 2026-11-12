# OASIS architecture alternatives and decision map

**Scope:** candidate map for the current OASIS architecture on `main`, based on the source and maintained project documentation reviewed for this audit. **Status:** analysis and staged recommendations; no alternatives in this document have been integrated or benchmarked by this change. This is not a security certification or an exhaustive list of every project that could be used.

## Executive recommendation

OASIS already has substantial open-source foundations: the MCP and ACP SDKs, OpenTelemetry, ripgrep, tree-sitter, the `unbash` Bash AST, MiniSearch, optional OS/container sandboxing, Git worktrees and a large regression/evaluation suite. Replacing these wholesale would add migration risk without evidence of better outcomes.

The highest-leverage direction is to **reduce the number of hand-maintained policy and lifecycle paths**, and measure the resulting system before replacing components:

1. Finish one fail-closed shell-analysis path for allow/ask/deny and risk checks; retain differential testing against the current parser and adversarial policy cases.
2. Make strong isolation the default for untrusted repository code where a supported backend is available; expose a machine-readable capability/conformance result, and never silently downgrade an explicitly requested sandbox.
3. Decompose `src/agent.mjs` into provider transport, turn state machine, tool policy/dispatch, history/context, and verification interfaces without changing behavior in one large rewrite.
4. Measure local memory retrieval against a held-out corpus before adding embeddings or a vector database; preserve provenance, deletion and inspectability.
5. Add durable-recovery and real-task evaluations, so future replacements are chosen by verified completion, safety, latency, cost and resource use—not feature counts or a “100x” promise.

“100 times better” is not a meaningful unmeasured engineering claim. The scorecard below makes improvement measurable and allows a component to remain in place when an alternative does not win.

## Current architecture anchors

| Concern | Current implementation to preserve or compare |
|---|---|
| Agent lifecycle / model loop | `src/agent.mjs` (`createSession`, `requestCompletion`, `runAgentTurn`, subagents and tool calls) |
| Provider protocols and setup | `src/provider-registry.mjs`, provider/cloud modules and adapters in `src/agent.mjs`; the connected browser workspace keeps its own runtime-compatible catalogue |
| Tool authorization and shell policy | `src/permissions.mjs`, `src/permission-modes.mjs`, `src/shell-ast.mjs`, `src/unbash-shell-ast.mjs`, `src/shell-risk.mjs` |
| Execution isolation | `src/sandbox.mjs`, `src/sandbox-runtime.mjs`, `src/ssh-backend.mjs` |
| Workspace and code search | `src/tools.mjs`, `src/workspace-files.mjs`, `src/ripgrep.mjs`, tree-sitter integrations and Git worktrees |
| Session / workflow recovery | `src/sessions.mjs`, `src/checkpoints.mjs`, `src/workflows.mjs`, `src/workflow-sandbox.mjs` |
| Memory | `src/memory.mjs`, `src/auto-memory.mjs`, MiniSearch and Porter2 stemming |
| Verification and tests | `src/claim-check.mjs`, `src/diagnostics.mjs`, `src/change-guard.mjs`, `src/test-tamper.mjs`, `test/`, `evals/`, `bench/` |
| Integrations / telemetry | MCP and ACP SDKs, `src/plugins.mjs`, `src/hooks.mjs`, `src/telemetry.mjs` using OpenTelemetry |
| Interfaces | CLI, self-hosted web app, VS Code integration, ACP, SDK, GitHub Action and messaging gateways |

## Alternative map

These are candidates to evaluate, not automatic replacements. “Keep” means retain the existing seam until a measured gap justifies a migration.

| Area and observed pressure point | Open-source alternatives to compare | Recommendation and trade-off |
|---|---|---|
| **Agent orchestration** — `src/agent.mjs` is a very large module that owns provider requests, streaming/retry, tool calls, context and multiple agent lifecycles. | [LangGraph JS](https://github.com/langchain-ai/langgraphjs), [Mastra](https://github.com/mastra-ai/mastra), [Vercel AI SDK](https://github.com/vercel/ai), [Temporal](https://github.com/temporalio/temporal) for durable orchestration. | First extract OASIS-owned interfaces and state machines; do not swap the entire runtime. LangGraph/Mastra can add graph abstractions and dependencies; Temporal is a service-backed durable-workflow platform, not a drop-in local CLI loop. Evaluate one narrow workflow only after parity tests exist. |
| **Provider adapters** — a shared registry exists, but protocol handling still has custom paths and the browser has a separate catalogue. | [Vercel AI SDK](https://github.com/vercel/ai) for JS model/provider abstractions; [LiteLLM](https://github.com/BerriAI/litellm) as a self-hostable multi-provider proxy; [llama.cpp](https://github.com/ggml-org/llama.cpp) and [vLLM](https://github.com/vllm-project/vllm) for local serving. | Keep direct native adapters where protocol features matter. Prototype an optional compatibility layer only if it preserves streaming, tool-call IDs, reasoning replay, usage, cancellation and credential isolation. A proxy adds deployment, latency and another credential boundary; local model servers solve serving, not runtime orchestration. |
| **Shell parsing / policy matching** — Bash uses the `unbash` typed AST by default, with tree-sitter rollback; permission matching has a separate conservative legacy scanner and non-Bash dialects need distinct handling. | [unbash](https://github.com/webpro-nl/unbash), [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash), [bashlex](https://github.com/idank/bashlex) (Python), plus native PowerShell parsing for PowerShell. | Consolidate OASIS policy inputs around a common normalized command representation; keep unknown/dynamic syntax in ask/review. Differential-test parsers and policy decisions. Do not equate parse success with safety, or use one Bash parser for PowerShell/cmd. `unbash` is already integrated, so a second parser is a reference/rollback candidate, not an automatic upgrade. |
| **Authorization policy** — OASIS owns tool-specific allow/ask/deny semantics, mode behavior, path rules and command-risk overrides. | [Open Policy Agent (OPA)](https://github.com/open-policy-agent/opa), [Cedar](https://github.com/cedar-policy/cedar), [Casbin](https://github.com/casbin/casbin). | Keep high-impact policy enforcement in OASIS until there is a tested, versioned policy contract. A policy engine can improve auditability and testability, but does not parse shell semantics or provide OS isolation by itself. Prototype authorization decisions for declarative file/tool rules, never replace hard-deny behavior without an adversarial test corpus. |
| **Sandbox / execution** — `src/sandbox.mjs` supports Linux bubblewrap, macOS Seatbelt, Docker/Podman and optional domain-filtered sandbox-runtime; availability and enforcement differ by host. | [gVisor](https://github.com/google/gvisor), [nsjail](https://github.com/google/nsjail), [Firecracker](https://github.com/firecracker-microvm/firecracker), [bubblewrap](https://github.com/containers/bubblewrap), rootless [Podman](https://github.com/containers/podman), Linux Landlock, plus platform-native Windows isolation. | Retain backends while building a common conformance suite for filesystem, credentials, network, process, resource and escape behavior. gVisor/Firecracker offer stronger isolation at operational cost; nsjail/bubblewrap are lightweight Linux-specific layers; containers are not automatically VM-grade isolation. No backend covers every platform or hostile-kernel threat. Fail closed when the user explicitly requires isolation. |
| **Session and job storage** — session JSON has atomic writes and bounded validation, while checkpoints, agent transcripts, task state and workflow state use multiple local formats. | Embedded [SQLite](https://github.com/sqlite/sqlite), Node SQLite bindings such as [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [libSQL](https://github.com/tursodatabase/libsql); service-backed PostgreSQL only for a deliberate multi-user server. | Do not migrate merely to use a database. First define schema/version migrations, transactional invariants, recovery semantics and export/backup guarantees. SQLite could unify indexed session/job events and transactions; it adds migration, locking and corruption-recovery responsibilities. Keep JSON export/import and inspectable local-first data. |
| **Long-running orchestration** — local workflows and background sessions have limits, local persistence and restart semantics. | [Temporal](https://github.com/temporalio/temporal), [Restate](https://github.com/restatedev/restate), [Hatchet](https://github.com/hatchet-dev/hatchet), [BullMQ](https://github.com/taskforcesh/bullmq). | Keep local jobs as the default. Consider a pluggable durable executor for team/server deployments when restart-safe, idempotent jobs are demonstrated to be a requirement. Service-backed orchestration adds a server/database/operations burden and is not appropriate for the offline CLI path. Define approval, cancellation, retry and exactly-once/at-least-once semantics before selecting a backend. |
| **Memory / retrieval** — `src/memory.mjs` loads hierarchical instruction files and scoped rules; local retrieval uses MiniSearch BM25+ and stemming, with context budgets. | [SQLite FTS5](https://www.sqlite.org/fts5.html), [Tantivy](https://github.com/quickwit-oss/tantivy), [Qdrant](https://github.com/qdrant/qdrant), [LanceDB](https://github.com/lancedb/lancedb), [Chroma](https://github.com/chroma-core/chroma). | Establish BM25 baseline and a labeled query set first. A local hybrid lexical+embedding index may help semantic recall but introduces model downloads, privacy, freshness, deletion and relevance-calibration concerns. Vector databases are optional scale-outs, not an inherent replacement for Markdown instructions or small local memories. Always show source/provenance and permit removal. |
| **Code search / structure** — ripgrep and tree-sitter are already mature and directly integrated. | [ast-grep](https://github.com/ast-grep/ast-grep), [Zoekt](https://github.com/sourcegraph/zoekt), [SCIP](https://github.com/sourcegraph/scip), [Semgrep](https://github.com/semgrep/semgrep). | Retain ripgrep/tree-sitter. Add ast-grep for structural edits/search, SCIP or language servers for cross-file symbol navigation, and Zoekt only for large indexed multi-repository deployments. Semgrep can complement security scans. Avoid duplicating ignore rules, file exclusions and path-policy semantics across engines. |
| **Verification / test quality** — many targeted regressions exist; deterministic model-free tests do not alone measure end-to-end coding success. | [SWE-bench](https://github.com/SWE-bench/SWE-bench), [Terminal-Bench](https://github.com/Terminal-Bench/Terminal-Bench), [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai), [aider benchmark](https://github.com/Aider-AI/aider), [fast-check](https://github.com/dubzzz/fast-check), [StrykerJS](https://github.com/stryker-mutator/stryker-js). | Keep current tests and held-out cases; add pinned, sandboxed external tasks, property/fuzz tests for parser/path/protocol boundaries and selective mutation testing. Public task sets can be contaminated and model/provider outcomes vary; pin tasks/verifiers, report cost/latency/quality separately, and do not use one leaderboard score as proof of safety. |
| **Observability / agent traces** — OpenTelemetry is integrated and off by default; consistency and privacy across model/tool/worker/verification spans still need validation. | [OpenTelemetry](https://github.com/open-telemetry/opentelemetry-js), [Arize Phoenix](https://github.com/Arize-ai/phoenix), [Langfuse](https://github.com/langfuse/langfuse), [OpenLIT](https://github.com/openlit/openlit). | Keep OTel as the neutral instrumentation foundation. Add optional local/self-hosted viewers only as adapters. Ensure prompt/tool payloads are off by default, redact credentials, bound cardinality, and correlate model→tool→subagent→verification without exporting workspace content accidentally. |
| **Extension/plugin isolation** — MCP, hooks, plugins and imported skills are powerful, but native integrations may execute third-party code. | [WASI](https://github.com/WebAssembly/WASI), [Wasmtime](https://github.com/bytecodealliance/wasmtime), [Wasmer](https://github.com/wasmerio/wasmer), [Sigstore Cosign](https://github.com/sigstore/cosign), [SLSA](https://github.com/slsa-framework/slsa). | Keep standards-based MCP/ACP. Separate declarative skills from executable extensions; consider WASI for a constrained plugin tier and signed immutable source revisions for distribution. Wasm cannot safely host every native integration; explicit capabilities, provenance, review, revocation and rollback remain necessary. |
| **Browser/UI framework** — the connected local-runtime UI is an untrusted client of the host runtime; keep its API boundary explicit. | [Preact](https://github.com/preactjs/preact), [Svelte](https://github.com/sveltejs/svelte), [Lit](https://github.com/lit/lit). | No framework migration is recommended without evidence of UI complexity or maintainability pain. The connected UI must continue to treat the browser as an untrusted client and enforce all permissions server-side. Framework choice does not grant the browser client direct host execution privileges. |
| **Package/dependency supply chain** — npm lockfile, pinned CI actions, package vetting and package installation are already present. | [Socket](https://github.com/SocketDev/socket), [OpenSSF Scorecard](https://github.com/ossf/scorecard), [OSV-Scanner](https://github.com/google/osv-scanner), [Renovate](https://github.com/renovatebot/renovate), [Dependabot](https://github.com/dependabot/dependabot-core), [Sigstore](https://github.com/sigstore). | Build on the existing lockfile, checksum/pin and dependency-policy checks. Choose additional automated review/scanning based on findings, not badge count. Dependency scanners are advisory; signatures and provenance improve origin confidence but do not prove package behavior is safe. |
| **Provider catalogue freshness** — `src/provider-registry.mjs` and browser-side metadata are intentionally separate; model metadata is also sourced from a catalogue. | [models.dev](https://github.com/anomalyco/models.dev), [LiteLLM model/provider registry](https://github.com/BerriAI/litellm), provider SDK catalogs, generated schema artifacts. | Keep runtime-owned provider capabilities and tests authoritative; generate or validate duplicated UI/provider metadata from one schema where feasible. External catalogs can be stale or omit tool/vision/streaming quirks. A provider probe should never execute model-proposed tools or echo credentials. |

## Ranked execution plan

### P0 — policy and isolation evidence

- Route strict allow, deny and ask matching through one normalized parser representation where supported; keep a conservative fail-closed fallback for malformed, dynamic, oversized and unsupported syntax.
- Build parser differential fixtures for Bash and separate Windows PowerShell/cmd fixtures. Compare the **policy decision**, not just token output. Include wrappers, redirection, substitutions, loops, heredocs, variable indirection and malformed commands.
- Publish a sandbox capability report stating backend, OS, network mode, writable paths and resource caps. When isolation was requested and unavailable, do not run the command unsandboxed.
- Add backend conformance runs for secret visibility, workspace-only writes, network deny/allow, child-process cleanup and resource ceilings. Mark unsupported checks as unsupported, not passed.

### P1 — modular runtime and measured quality

- Extract interfaces from `src/agent.mjs` in small behavior-preserving steps: `ProviderTransport`, `TurnState`, `ToolPolicy`, `ToolExecutor`, `ContextManager`, `VerificationRunner` and `SessionStore` are candidate seams, not mandated class names.
- Add trace correlation and privacy tests before expanding telemetry or logging.
- Build labeled memory-retrieval and correction/deletion tests. Compare MiniSearch, SQLite FTS5 and a hybrid prototype on the same corpus and context budget.
- Add repeatable public coding tasks with pinned revisions and offline-capable verifiers. Record resolved tasks, regressions, tool failures, permission denials, runtime, tokens and cost.

### P2 — optional deployment scale-outs

- Specify an event/state schema and crash-recovery contract before considering SQLite or a durable workflow service.
- Prototype a durable executor only for users who need jobs to survive process/host restarts; preserve the local CLI path.
- Prototype WASI only for extensions that fit its capability model. Continue to treat native plugins/MCP servers as trusted executable code.

## Acceptance scorecard (before calling any replacement an improvement)

Every proposal should record baseline and candidate results on the same commit, task set, host and provider configuration:

- **Correctness:** existing suite passes; protocol/behavior parity; no unexplained regression in held-out tests.
- **Security:** parser/policy differential tests; explicit sandbox enforcement; no silent isolation downgrade; secret and network boundary tests.
- **Task quality:** verified completion and regression rate on pinned real tasks; model/provider and manual interventions recorded.
- **Performance:** startup, peak RSS, CPU, context tokens, task latency and package/install footprint.
- **Cost:** provider token usage/cost and any additional local model or service costs.
- **Operations:** offline/local-first support, upgrade/migration, backup/restore, observability and support burden.
- **Supply chain:** license reviewed, dependency pinned, transitive risk reviewed, upstream activity/release health checked at decision time.

A candidate advances only if it improves a stated metric without violating a safety or compatibility gate. Keep the current implementation when the measured result is neutral or worse.

## Audit boundaries

This map is a source-grounded architecture prioritization, not a line-by-line audit of every tracked file, penetration test, upstream maintenance guarantee, or proof that any named project is suitable for every OASIS deployment. The named repositories are comparison candidates; verify their current license, maintenance, API, threat model and platform support before adopting them. This document-only change does not install dependencies, alter runtime behavior, claim benchmark results, or certify OASIS.
