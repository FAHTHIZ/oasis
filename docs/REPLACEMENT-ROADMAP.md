# OASIS whole-system replacement roadmap

**Audit snapshot:** 2026-11-07  
**Audited branch:** `main`  
**Audit base:** `20f44b897f5f9e1ad574df483d94d4a92a52c77b`  
**Status:** architecture inventory and ranked improvement plan; not a security certification.

## Purpose

This document tracks OASIS as one complete product: runtime, interfaces, tools, provider layer, security boundaries, agent coordination, persistence, memory, verification, evaluation, packaging and maintenance.

The objective is not to replace every dependency. It is to find the weakest consequential component, compare it against maintained open-source implementations at source level, and replace or improve it only when the candidate is demonstrably better for OASIS's constraints. Every change should preserve existing behaviour that is valuable, add regression tests, and be verified before the next replacement begins.

"Ten times better" is a target for the improvement process, not a claim that a candidate is automatically ten times better.

## Audit method and limits

The inventory used the repository tree, current README and architecture/configuration/benchmark/interface documentation, source modules and tests. It then examined selected implementation paths in depth and compared them with upstream source, API definitions, licences, release metadata and design documentation.

This is a broad architecture and prioritisation audit, not a line-by-line review of all 1,206 tracked files and not a penetration test. No live provider benchmark was run as part of this audit. A green test suite would establish only that the tested cases pass; it would not prove general security or superiority over another agent.

## Whole-system inventory

The repository tree at the audit base contains **1,418 entries, including 1,206 tracked files**. The following counts are tracked file blobs grouped by top-level directory; this is a structural inventory, not a line-by-line code review:

| Area | Tracked files | Primary responsibility |
|---|---:|---|
| Runtime and shared services (`src/`) | 219 | Agent orchestration, providers, tools, permissions, sandbox, memory, sessions, workflows, diagnostics and integrations |
| Tests (`test/`) | 411 | Unit, regression, security, integration and platform behaviour |
| Evaluations (`evals/`) | 384 | Task fixtures, verifiers and evaluation snapshots |
| Browser application (`app/`) | 26 | Browser-side runtime, provider compatibility and workspace experience |
| Benchmarks (`bench/`) | 29 | Harness behaviour, request/token efficiency and performance baselines |
| Skills (`skills/`) | 26 | Reusable agent skills and instructions |
| Scripts (`scripts/`) | 22 | Build, release, data refresh and maintenance automation |
| GitHub automation (`.github/`) | 17 | CI, installer checks, Pages deployment, issue templates and repository automation |
| Brand and demo assets (`assets/`) | 16 | Maintained visual identity and platform artwork |
| Website sources (`site/`) | 9 | Public browser-app/site content |
| Desktop host (`desktop/`) | 7 | Electron entry point, packaging and secure-storage integration |
| Editor integration (`ide/`) | 6 | VS Code-family editor workflow |
| Extensions (`plugins/`) | 6 | Optional integrations and capabilities |
| Documentation (`docs/`) | 9 | Architecture, setup, security, configuration, comparisons and benchmark methodology |

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
| 1 | P0 | Shell parsing used by permissions and command-risk analysis | The default `unbash` typed AST now drives both command-risk analysis and strict allow matching. Dynamic/computed commands, parser errors, resource limits, shell-fed scripts and redirections remain review-only for automatic allow. PowerShell stays separate; parser-differential and policy-parity coverage remains unfinished. | [unbash](https://github.com/webpro-nl/unbash) 6.0.3 is integrated as the synchronous, zero-runtime-dependency Bash AST. Tree-sitter Bash remains an explicit rollback backend and tree-sitter remains in place for multi-language code intelligence. | **Integrated; acceptance in progress:** expand parser-differential and adversarial policy tests, then publish parity/latency results. Keep rollback paths until evidence supports removing them. |
| 2 | P1 | Agent execution core | `src/agent.mjs` was about 437 KB before the first extraction and is about 425 KB at this audit head. It still combines lifecycle, provider requests, tool dispatch, retries, context management, cost accounting and recovery; streamed response parsing is now separated into `src/provider-stream.mjs`. | [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent) offers explicit lifecycle, context-transform, pre/post-tool and queue hooks; [Vercel AI SDK](https://ai-sdk.dev/docs/agents/overview) offers a provider-neutral tool-loop abstraction; [OpenHands SDK](https://docs.openhands.dev/sdk/arch/overview) separates agents, tools, workspace and server layers. | **Do not big-bang replace.** First define an Oasis-owned lifecycle contract, then prototype one replaceable seam behind it. Pi Agent Core currently requires Node 22.19+, above OASIS's declared 22.15 floor, and none of these frameworks automatically preserve Oasis-specific security and recovery behaviour. |
| 3 | P1 | Memory retrieval and knowledge maintenance | OASIS already has local Markdown memories, MiniSearch BM25+ ranking, Porter2 stemming, title/description boosts, prefix matching, recency/recall boosts, secret redaction, duplicate merging, verification/freshness metadata and bounded per-prompt recall. The gap is broad, held-out retrieval measurement and explicit hybrid/semantic evaluation—not the absence of full-text search. | [Mem0](https://github.com/mem0ai/mem0) provides an alternative extraction/retrieval layer; [Letta](https://docs.letta.com/concepts/stateful-agents/) treats memory as persistent agent state with core/recall/archival tiers and versioned memory files. Neither is a drop-in local-first replacement. | **Retain and measure first.** Build a local held-out corpus and report Recall@k/MRR/nDCG, stale/conflicting-note behaviour, provenance, user correction/deletion and prompt-token cost. Test optional embeddings/reranking only if they improve the measured baseline without requiring a cloud service. |
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

Recent `main` changes also make routing hints advisory, check catalogue metadata for tool-call capability before selecting a routed model, correct the reported routing tier when an unsupported candidate is rejected, and refresh legacy model caches. These safeguards improve routing constraints; they do not yet prove higher task success or lower cost. See [the current source](../src/model-routing.mjs) and [its tests](../test/model-routing.test.mjs).

## Real-model product demonstration

The README now embeds a real, unscripted `gpt-oss-20b` CLI recording, linked as a GIF/MP4 with its raw terminal cast. The commit is [`20f44b8`](https://github.com/FAHTHIZ/oasis/commit/20f44b897f5f9e1ad574df483d94d4a92a52c77b). The run shows file reading, a bug fix, a new test, a permission approval and a verification send-back.

This is valuable qualitative product evidence. It is one recorded run with shortened rate-limit waits; its reported duration, tool count and token usage are not a controlled benchmark or a basis for comparing OASIS against another agent. Use the separate evaluation methodology for quantitative claims.

## Agent runtime extraction: first provider-stream seam

The first small extraction from the central agent module is now on `main`:

- Commit [`7ba3f0a`](https://github.com/FAHTHIZ/oasis/commit/7ba3f0a3ec839bcbeeb95773057770d3f64a9a21) moved SSE framing, provider event decoding, streamed tool-call slot reconstruction, Anthropic usage merging and provider response assembly into `src/provider-stream.mjs`.
- The new `test/provider-stream.test.mjs` covers split SSE framing, complete response assembly, interrupted streams and nested provider metadata merging.
- `src/agent.mjs` decreased from 437,701 bytes at the preceding audited tree to 424,839 bytes at this head. It remains a large, high-coupling module; this is a bounded first seam, not a completed transport abstraction or proof of full parity.

Next: add characterization coverage around remaining provider request paths, errors, retries, cancellation and provider-specific metadata before extracting lifecycle or dispatch code. Keep permission enforcement and tool execution outside the provider adapter.

## Current P0 cycle: Bash parser integration and acceptance

The default Bash parsing path was replaced on \`main\` with \`unbash\` 6.0.3. The integration is deliberately narrow: it does not replace tree-sitter for language intelligence or PowerShell parsing, and it does not delegate permission policy to the parser.

### What is now integrated

- \`src/unbash-shell-ast.mjs\` adapts the typed Bash AST into OASIS command structures.
- \`src/shell-ast.mjs\` uses unbash by default. Set \`OASIS_SHELL_PARSER=tree-sitter\` to select the retained Bash rollback backend, or \`OASIS_SHELL_PARSER=legacy\` for the older splitter.
- PowerShell and cmd-style command lines remain on their existing path.
- Static shell wrappers (including common \`-c\` forms, selected launcher options and \`env\` prefixes) are inspected for nested commands.
- Dynamic or oversized loop expansion, malformed syntax and parser resource limits are treated as incomplete analysis, so the risk layer asks for review instead of assuming the target is safe.
- Strict allow matching uses the typed AST in the default `unbash` mode. Computed command names, dynamic expansions, parser errors, resource-limit results and shell-fed scripts cannot receive automatic allow decisions.
- Shell redirections, heredocs and herestrings are review-only for strict allow rules, including output redirection and descriptor duplication; deny/ask analysis remains separately enforced.
- Tree-sitter remains installed for non-shell language parsing.

### Upstream comparison and caveats

[unbash](https://github.com/webpro-nl/unbash) is ISC-licensed and provides a synchronous typed Bash AST with no runtime dependencies. It is a Bash parser, not a universal shell parser: PowerShell, fish and every zsh/ksh dialect are not covered by this replacement. Its upstream benchmark figures are not OASIS measurements. OpenCode's [issue #31485](https://github.com/anomalyco/opencode/issues/31485) and [PR #34772](https://github.com/anomalyco/opencode/pull/34772) are useful evidence of a similar parser-differential problem and an attempted integration, but that PR closed unmerged and is not evidence of production adoption.

### Remaining acceptance work

1. Compare common static Bash syntax against the retained tree-sitter backend: command tokens, substitutions, functions, case arms, bounded literal loops and pipeline links.
2. Test OASIS policy behaviour, not just parser output: nested shell wrappers must still trigger deny/ask rules, while strict allow rules must not approve compound or uncertain input.
3. Grow the adversarial corpus for redirections, heredocs/herestrings, command substitutions, dynamic variables, wrapper nesting and unsupported shell syntax.
4. Keep unsupported, malformed, dynamic and resource-limited input behind review; never let partial AST output become implicit auto-approval.
5. Benchmark parse latency and memory on OASIS fixtures before removing any rollback or conservative legacy path.

The integration is useful and the existing test/CI results are encouraging, but it is **not a security certification**. Record parser parity and policy coverage before calling this cycle complete.

### Main-branch implementation history

- Routing classifier: [\`daee264\`](https://github.com/FAHTHIZ/oasis/commit/daee264758424fa7db13ee449b56d930b5e12558)
- Whole-system roadmap: [\`0682258\`](https://github.com/FAHTHIZ/oasis/commit/068225836e68bec7dba8b846257421d313b5fc69)
- Initial Bash AST integration: [\`b7cbff7\`](https://github.com/FAHTHIZ/oasis/commit/b7cbff714ebe1c99f34c1c5e444e91d60673f6fc)
- Launcher-option handling: [\`893cd0f\`](https://github.com/FAHTHIZ/oasis/commit/893cd0f705d0876ad0d619b0da401747a7326500)
- Fail-closed unresolved loops: [\`26db445\`](https://github.com/FAHTHIZ/oasis/commit/26db4458fb0d892c4275ca71bd205ee6ee0d3a99)
- Typed-AST strict allow decisions: [`0f857e5`](https://github.com/FAHTHIZ/oasis/commit/0f857e56449cbb1c5c5487c829b9feed24790e13)
- Keep shell redirections behind explicit review: [`f5722ce`](https://github.com/FAHTHIZ/oasis/commit/f5722ce4aa34adfd28d3bb7bde1567086a833290)
- Prevent routing hints from bypassing action guards: [`1b68cc7`](https://github.com/FAHTHIZ/oasis/commit/1b68cc734d8a46e0ac90502fb39c0bf6fdc8998b)
- Capability-aware task model routing: [`4ba2e34`](https://github.com/FAHTHIZ/oasis/commit/4ba2e346f6822b4701db75475a439946781c90cc)
- Refresh legacy model caches: [`0b1a549`](https://github.com/FAHTHIZ/oasis/commit/0b1a549766bd40ea916f7ac0b64b2a0cea460729)
- Correct routing tier after tool-capability fallback: [`8945253`](https://github.com/FAHTHIZ/oasis/commit/8945253d6a772e116d1334c5281de62e81434595)
- Extract provider streaming: [`7ba3f0a`](https://github.com/FAHTHIZ/oasis/commit/7ba3f0a3ec839bcbeeb95773057770d3f64a9a21)
- Restore the real-model README demonstration: [`20f44b8`](https://github.com/FAHTHIZ/oasis/commit/20f44b897f5f9e1ad574df483d94d4a92a52c77b)

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
- **Memory quality:** measure the existing MiniSearch BM25+/Porter2 baseline on a held-out corpus; add stale/conflict, provenance, user-correction, deletion and prompt-token-cost metrics before considering hybrid semantic retrieval.
- **Durable recovery:** process kill/restart during model calls, tool execution, checkpoint writes and background approval; verify idempotency and transcript integrity.
- **Sandbox conformance:** automated filesystem/network/process/resource tests for every supported backend/OS.
- **Tool/agent trace correlation:** one trace across model request, retries, tool call, subagent, verification and result, without collecting private prompt content by default.
- **Extension supply chain:** immutable source revisions, permission manifests, install previews, least privilege, revocation and deterministic rollback.
- **Release publication and version consistency:** the `v1.1.0` Git tag exists at `2da78dd50a708833f97be97f20fb8016c0ab4c1d`, but no GitHub Release is associated with it as checked on 2026-11-07. Keep package version, tag, release object, checksums, README links and updater behaviour aligned; publish only after same-commit quality, site and installer gates pass.
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
