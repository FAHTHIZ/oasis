# OASIS whole-system replacement roadmap

**Audit snapshot:** 2026-11-07  
**Audited branch:** `main`  
**Audit base:** `daee264758424fa7db13ee449b56d930b5e12558`  
**Status:** architecture inventory and ranked improvement plan; not a security certification.

## Purpose

This document tracks OASIS as one complete product: runtime, interfaces, tools, provider layer, security boundaries, agent coordination, persistence, memory, verification, evaluation, packaging and maintenance.

The objective is not to replace every dependency. It is to find the weakest consequential component, compare it against maintained open-source implementations at source level, and replace or improve it only when the candidate is demonstrably better for OASIS's constraints. Every change should preserve existing behaviour that is valuable, add regression tests, and be verified before the next replacement begins.

"Ten times better" is a target for the improvement process, not a claim that a candidate is automatically ten times better.

## Audit method and limits

The inventory used the repository tree, current README and architecture/configuration/benchmark/interface documentation, source modules and tests. It then examined selected implementation paths in depth and compared them with upstream source, API definitions, licences, release metadata and design documentation.

This is a broad architecture and prioritisation audit, not a line-by-line review of all 1,404 tracked entries and not a penetration test. No live provider benchmark was run as part of this audit. A green test suite would establish only that the tested cases pass; it would not prove general security or superiority over another agent.

## Whole-system inventory

The repository tree at the audit base contained approximately **1,404 entries**. The major areas are:

| Area | Tracked entries | Primary responsibility |
|---|---:|---|
| Runtime and shared services (`src/`) | 219 | Agent orchestration, providers, tools, permissions, sandbox, memory, sessions, workflows, diagnostics and integrations |
| Tests (`test/`) | 410 | Unit, regression, security, integration and platform behaviour |
| Evaluations (`evals/`) | 524 | Task fixtures, verifiers and evaluation snapshots |
| Browser application core (`app/`) | 28 | Browser-side agent/runtime, provider and workspace experience |
| Benchmarks (`bench/`) | 36 | Harness behaviour, request/token efficiency and performance baselines |
| Desktop host (`desktop/`) | 7 | Electron entry point, packaging and secure-storage integration |
| Editor integration (`ide/`) | 9 | VS Code-family editor workflow |
| Extensions and skills (`plugins/`, `skills/`) | 61 | Optional capabilities and reusable instruction/tool packages |
| Build, release and CI (`.github/`, `scripts/`, `Casks/`, `Formula/`) | 46 | Validation, installer, publishing, automation and package distribution |
| Documentation (`docs/` and root documents) | Maintained guides | Architecture, setup, security, configuration, interfaces and benchmark methodology |

### Architecture map

| Layer | Current implementation | Assessment |
|---|---|---|
| User interfaces | CLI, Electron desktop, connected browser workspace, standalone PWA, editor extension, ACP, Node SDK, GitHub Action and messaging gateways | Broad coverage; keep the interfaces separate from runtime execution and document their different permission boundaries |
| Agent orchestration | `src/agent.mjs`, subagents, teams, workflows and background sessions | High-impact monolith; preserve behaviour while extracting stable lifecycle boundaries |
| Provider and model layer | Provider registry, cloud adapters, models.dev catalogue snapshot, aliases, fallback chain, pricing and usage accounting | Good foundation; capability freshness and routing quality need continuous measurement |
| Workspace operations | File/search/edit/patch tools, Git tools, LSP and repository mapping | Broad capability; maintain tool contracts and regression coverage |
| Permission and command safety | Permission policy, command-risk classifier, shell parser, protected paths, untrusted-content guards and secret shielding | Most important boundary to harden; multiple parsing paths currently overlap |
| Execution isolation | Linux bubblewrap, macOS Seatbelt, Docker/Podman backends and optional Anthropic sandbox runtime | Valuable platform-specific layers; not a universal sandbox and should remain opt-in/explicitly reported where appropriate |
| Agent coordination | Specialist agents, background processes, shared tasks, worktrees, inbox/approval state | Rich local orchestration; durability and cancellation semantics deserve dedicated failure testing |
| Persistence and memory | Session transcripts, checkpoints, backups, project rules, local memory files and auto-memory retrieval | Useful local-first design; retrieval quality and crash recovery need measurable baselines |
| Verification | Diagnostics, tests, LSP checks, claim checks, change guards, diff review and test-tamper guards | Strong set of primitives; unify verification evidence and ensure completion claims are evidence-backed |
| Extensions and protocols | MCP, ACP, hooks, plugins, imported skills and external extensions | Standards-based foundations; imported code remains a separate trust boundary |
| Observability | OpenTelemetry API/SDK/exporters, runtime spans, token/usage accounting and diagnostics | Keep OTel; audit GenAI span coverage, consistency, privacy and end-to-end correlation |
| Quality and release | 2,000+ test cases, held-out fixtures, harness/token benchmarks, CI, installer tests and release gates | Extensive infrastructure; add comparable real-task evaluations and preserve raw reports |

## Ranked replacement and improvement queue

The order reflects impact, weakness, likelihood of regression and whether a candidate can be validated independently. It is not a ranking of repository quality.

| Rank | Priority | Component | Current weak spot | Open-source comparison | Decision |
|---:|---|---|---|---|---|
| 1 | P0 | Shell parsing used by permissions and command-risk analysis | Tree-sitter AST commands are flattened back to strings, while `permissions.mjs` and `shell-risk.mjs` also contain separate splitters/tokenizers and wrapper handling. Multiple interpretations of the same shell input create a security-sensitive parser-differential risk. | [unbash](https://github.com/webpro-nl/unbash) provides a synchronous, zero-runtime-dependency typed Bash AST; [mvdan/sh](https://github.com/mvdan/sh) via [sh-syntax](https://github.com/un-ts/sh-syntax) offers broader shell-dialect coverage; tree-sitter provides incremental CST parsing and missing/error nodes. | **Next replacement candidate:** build a differential AST adapter and security corpus around unbash. Keep PowerShell on its existing parser. Do not remove tree-sitter globally until all consumers are mapped and parity is proven. |
| 2 | P1 | Agent execution core | `src/agent.mjs` is about 437 KB / 6,753 lines and combines lifecycle, provider requests, streaming, tool dispatch, retries, context management, cost accounting and recovery. | [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent) offers explicit lifecycle, context-transform, pre/post-tool and queue hooks; [Vercel AI SDK](https://ai-sdk.dev/docs/agents/overview) offers a provider-neutral tool-loop abstraction; [OpenHands SDK](https://docs.openhands.dev/sdk/arch/overview) separates agents, tools, workspace and server layers. | **Do not big-bang replace.** First define an Oasis-owned lifecycle contract, then prototype one replaceable seam behind it. Pi Agent Core currently requires Node 22.19+, above OASIS's declared 22.15 floor, and none of these frameworks automatically preserve Oasis-specific security and recovery behaviour. |
| 3 | P1 | Memory retrieval and knowledge maintenance | OASIS has useful local memory, redaction, categories, verification and approval, but recall ranking is lightweight lexical/token similarity rather than a benchmarked hybrid retrieval pipeline. | [Mem0](https://github.com/mem0ai/mem0) provides an open memory extraction/retrieval layer; [Letta](https://docs.letta.com/concepts/stateful-agents/) treats memory as persistent agent state with core/recall/archival tiers and versioned memory files. | **Improve incrementally.** Establish a private local memory-recall benchmark first; test lexical + SQLite FTS/BM25, optional embeddings and reranking without making cloud services mandatory or losing provenance/approval/forgetting controls. |
| 4 | P1 | Real-task agent evaluation | Model-free harness and token benchmarks are useful, but neither alone measures real coding success across models and agents. | [SWE-bench](https://github.com/swe-bench/SWE-bench) supplies repository issue tasks with verifiers; [Terminal-Bench](https://www.tbench.ai/) is a complementary full-terminal task benchmark. | **Extend the evaluation programme.** Add a pinned, budget-bounded external benchmark track. Report exact model/provider, commit, task set, verifier, settings, repetitions, cost and failures. Never mix model capability with harness capability when comparing agents. |
| 5 | P2 | Session persistence and resumability | Sessions, transcripts, checkpoints and background state are persisted through multiple local files and formats; there is no single documented event-log contract covering every operation. | [OpenCode](https://github.com/anomalyco/opencode) is a useful source-level reference for event-sourced sessions, message parts and replayable state projections. | **Study before replacing.** Design an append-only event contract and crash/replay tests; migrate only where it demonstrably simplifies recovery without sacrificing local-first operation. |
| 6 | P2 | Long-running workflows and background jobs | Workflows and background sessions have local execution, timeouts and persistence, but there is no distributed durable execution service. | [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript) provides durable workflow history, retries, timers and worker execution, but requires a Temporal service and deterministic workflow discipline. | **Optional server-mode candidate only.** Keep the local runner simple. Do not add a mandatory external service to the desktop/CLI product. |
| 7 | P2 | Sandbox conformance and resource controls | OASIS has several useful backends, but backend availability and enforcement differ by operating system and configuration. Resource/network isolation must be verified per backend, not inferred from a “sandbox” label. | [OpenHands runtime architecture](https://docs.openhands.dev/usage/architecture/runtime) and its [SDK workspace model](https://docs.openhands.dev/sdk/arch/overview) provide a useful container/remote-workspace comparison. | **Keep current primitives; improve conformance.** Build a per-platform matrix for filesystem, network, process, resource, secret and mount boundaries. Consider stronger remote/VM isolation only where a use case needs it. |
| 8 | P2 | Extension and integration trust | MCP, hooks, skills and imported extensions expand OASIS significantly, but they can execute third-party code and require a clear capability/trust model. | Official [MCP](https://github.com/modelcontextprotocol) and [ACP](https://agentclientprotocol.com/) protocols are preferable to bespoke transport layers. | **Keep the protocol SDKs.** Improve source pinning, capability review, least privilege, provenance, installation previews, rollback and audit records rather than replacing standards. |
| 9 | P3 | GenAI observability | OTel exists, but the newer GenAI agent/tool conventions are still marked Development; semantic alignment and sensitive payload handling need explicit review. | [OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) and [agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md). | **Keep OTel.** Audit span/metric naming for model calls, retries, tools, agents, memory and verification; keep prompt/content capture disabled unless explicitly enabled and protected. |
| 10 | P3 | Mobile and interface parity | There is a PWA and connected workspace but no native Android APK/iOS package; standalone browser execution does not have host shell access. | The current CLI/desktop/browser/editor/ACP surfaces already cover different execution contexts. | **Treat as a product gap, not a reason to rewrite the runtime.** Define the desired mobile execution model and threat boundary before selecting a native shell. |

## First replacement: routing foundation

The first component has already been improved on `main`:

- Replaced the binary keyword-only classification foundation in `src/model-routing.mjs` with the MIT-licensed `@blockrun/router-core` local classifier pinned to commit `fd6d03d035ff676642ba1683c333d929939f8a00`.
- Oasis-specific safety, mutation/action checks, explicit routing hints, model allow-list checks, session model restoration and usage/cost accounting remain owned by Oasis.
- The router performs local classification only; it does not make an additional inference/network call.
- New focused tests cover ambiguous, action-oriented and security-sensitive requests.
- This improves the classifier's input signals; it does **not** prove better task success or savings. That requires held-out routing accuracy and live same-model evaluations.

The routing change and subsequent test assertion fix are in the recent `main` history. See [the current source](../src/model-routing.mjs) and [its tests](../test/model-routing.test.mjs).

## Immediate next cycle: shell parser replacement proof

The next change will target the Bash parser boundary only.

### Why it is first

The current implementation uses a tree-sitter Bash grammar, but the runtime still has several layers that independently split, tokenize, flatten or normalize shell strings. These feed both permission matching and risk classification. A disagreement between those layers is more consequential than a style or performance issue.

### Candidate and caveat

[unbash](https://github.com/webpro-nl/unbash) is an actively maintained ISC-licensed TypeScript parser. Its current source exposes a typed Bash AST synchronously, with no runtime dependencies, WASM initialization or native addon. It supports GNU Bash, but not PowerShell, fish, zsh or every shell dialect. Its own published benchmark reports materially higher parse throughput than tree-sitter Bash WASM, but those are upstream measurements on the maintainer's machine and must be independently reproduced before being treated as OASIS results.

OpenCode's [issue #31485](https://github.com/anomalyco/opencode/issues/31485) and [PR #34772](https://github.com/anomalyco/opencode/pull/34772) are a useful real-world comparison: they describe similar permission bypass classes and a proposed unbash integration. That PR was closed without merging; it is evidence of a design experiment, not proof of production adoption. The PR author also disclosed that they maintain unbash. OASIS must independently verify the implementation.

### Acceptance gates before removing the current Bash parser

1. Create a versioned differential corpus from OASIS's current parser tests, real-world shell syntax fixtures and adversarial parser cases.
2. Compare command names, argv values, command substitutions, function/case/loop bodies, heredoc and herestring contents, redirect targets, static wrappers, assignments and source positions.
3. Preserve strict allow semantics: malformed, unsupported, dynamic or uncertain input must never become auto-approved merely because the new parser returned a partial AST.
4. Preserve deny/ask coverage across nested commands and path reads/writes. A parser result is only structure; OASIS's policy decisions remain independently tested.
5. Keep PowerShell handling unchanged. Confirm which other OASIS modules consume tree-sitter before removing or narrowing any dependency.
6. Run the full test suite and cross-platform CI, then publish parser parity, latency and dependency-size reports. Only then remove the old Bash runtime path.

## Components to retain unless evidence says otherwise

Do not replace these simply to increase the number of upstream packages:

- **MCP and ACP SDKs:** OASIS already uses protocol SDKs instead of implementing their wire formats from scratch.
- **OpenTelemetry:** existing SDK/exporter integration is a sound foundation; improve semantic consistency rather than swapping telemetry systems.
- **Ripgrep and tree-sitter:** mature search and language-structure foundations. A Bash parser replacement does not imply removing tree-sitter from code intelligence.
- **BPE token counting:** OASIS uses `gpt-tokenizer` with the o200k_base vocabulary for approximate context budgeting; retain provider-reported usage as authoritative when available.
- **Sandbox backends:** keep the existing Linux/macOS/container options while strengthening tests and explicit status reporting.
- **Git worktrees and checkpoints:** they provide valuable project isolation and recovery primitives; benchmark and harden them instead of replacing blindly.
- **Existing evaluation and security test suites:** these are assets. Improve their coverage and external comparability; do not discard them.

## Cross-system gaps to close

The following are measurement and integration gaps to address alongside the component replacements:

- **Parser differential testing:** one corpus, one expected policy result, multiple parser engines.
- **Routing calibration:** confusion matrix, confidence calibration, false-cheap rate and same-model task-success comparisons.
- **Memory quality:** recall precision/recall, stale-memory handling, conflict resolution, provenance, user correction and deletion tests.
- **Durable recovery:** process kill/restart during model calls, tool execution, checkpoint writes and background approval; verify idempotency and transcript integrity.
- **Sandbox conformance:** automated filesystem/network/process/resource tests for every supported backend/OS.
- **Tool/agent trace correlation:** one trace across model request, retries, tool call, subagent, verification and result, without collecting private prompt content by default.
- **Extension supply chain:** immutable source revisions, permission manifests, install previews, least privilege, revocation and deterministic rollback.
- **External coding evaluations:** pinned public tasks and verifiers, with cost/latency/quality reported separately.

## Change policy

Each cycle should be small enough to attribute regressions:

1. Inspect OASIS's current code and tests for the target boundary.
2. Read the candidate's implementation, API, release history and licence.
3. Write compatibility tests before swapping the implementation.
4. Integrate behind Oasis-owned interfaces and retain rollback capability.
5. Run focused tests, full tests, lint, package checks and cross-platform CI.
6. Record the exact commit, tests, benchmark results, regressions and remaining caveats here.

A replacement is complete only when its behaviour is measured and its CI gates pass. A dependency install or successful import is not an acceptance test.
