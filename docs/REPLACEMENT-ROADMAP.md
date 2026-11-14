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
| Editor integration (`ide/`) | 6 | VS Code-family editor workflow |
| Extensions (`plugins/`) | 6 | Optional integrations and capabilities |
| Documentation (`docs/`) | 9 | Architecture, setup, security, configuration, comparisons and benchmark methodology |

### Architecture map

| Layer | Current implementation | Assessment |
|---|---|---|
| User interfaces | CLI, self-hosted web app, editor extension, ACP, Node SDK, GitHub Action and messaging gateways | Broad coverage; keep the interfaces separate from runtime execution and document their different permission boundaries |
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
| 3 | P1 | Memory retrieval and knowledge maintenance | OASIS already has local Markdown memories, MiniSearch BM25+ ranking, Porter2 stemming, title/description boosts, prefix matching, recency/recall boosts, secret redaction, duplicate merging, verification/freshness metadata and bounded per-prompt recall. The gap is broad, held-out retrieval measurement and explicit hybrid/semantic evaluation—not the absence of full-text search. | [Mem0](https://github.com/mem0ai/mem0) provides an alternative extraction/retrieval layer; [Letta](https://docs.letta.com/concepts/stateful-agents/) treats memory as persistent agent state with core/recall/archival tiers and versioned memory files. Neither is a drop-in local-first replacement. | **Retain and measure first.** Build a local held-out corpus and report Recall@k/MRR/nDCG, stale/conflicting-note behaviour, provenance, user correction/deletion and prompt-token cost. Test optional embeddings/reranking only if they improve the measured baseline without requiring a cloud service. First corpus in place: `npm run bench:memory` (30 memories, 25 held-out questions: recall@1 92%, recall@3 100%, MRR 0.960), guarded by a regression test. A full store now archives its least valuable note, and outdated notes leave the prompt index; see [BENCHMARKS.md](BENCHMARKS.md#memory-retrieval-benchmark). |
| 4 | P1 | Real-task agent evaluation | Model-free harness and token benchmarks are useful, but neither alone measures real coding success across models and agents. | [SWE-bench](https://github.com/swe-bench/SWE-bench) supplies repository issue tasks with verifiers; [Terminal-Bench](https://www.tbench.ai/) is a complementary full-terminal task benchmark. | **Extend the evaluation programme.** Add a pinned, budget-bounded external benchmark track. Report exact model/provider, commit, task set, verifier, settings, repetitions, cost and failures. Never mix model capability with harness capability when comparing agents. |
| 5 | P2 | Session persistence and resumability | Sessions, transcripts, checkpoints and background state are persisted through multiple local files and formats; there is no single documented event-log contract covering every operation. | [OpenCode](https://github.com/anomalyco/opencode) is a useful source-level reference for event-sourced sessions, message parts and replayable state projections. | **Study before replacing.** Design an append-only event contract and crash/replay tests; migrate only where it demonstrably simplifies recovery without sacrificing local-first operation. |
| 6 | P2 | Long-running workflows and background jobs | Workflows and background sessions have local execution, timeouts and persistence, but there is no distributed durable execution service. | [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript) provides durable workflow history, retries, timers and worker execution, but requires a Temporal service and deterministic workflow discipline. | **Optional server-mode candidate only.** Keep the local runner simple. Do not add a mandatory external service to the desktop/CLI product. |
| 7 | P2 | Sandbox conformance and resource controls | OASIS has several useful backends, but backend availability and enforcement differ by operating system and configuration. Resource/network isolation must be verified per backend, not inferred from a “sandbox” label. | [OpenHands runtime architecture](https://docs.openhands.dev/usage/architecture/runtime) and its [SDK workspace model](https://docs.openhands.dev/sdk/arch/overview) provide a useful container/remote-workspace comparison. | **Keep current primitives; improve conformance.** Build a per-platform matrix for filesystem, network, process, resource, secret and mount boundaries. Consider stronger remote/VM isolation only where a use case needs it. |
| 8 | P2 | Extension and integration trust | MCP, hooks, skills and imported extensions expand OASIS significantly, but they can execute third-party code and require a clear capability/trust model. | Official [MCP](https://github.com/modelcontextprotocol) and [ACP](https://agentclientprotocol.com/) protocols are preferable to bespoke transport layers. | **Keep the protocol SDKs.** Improve source pinning, capability review, least privilege, provenance, installation previews, rollback and audit records rather than replacing standards. |
| 9 | P3 | GenAI observability | OTel exists, but the newer GenAI agent/tool conventions are still marked Development; semantic alignment and sensitive payload handling need explicit review. | [OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) and [agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md). | **Keep OTel.** Audit span/metric naming for model calls, retries, tools, agents, memory and verification; keep prompt/content capture disabled unless explicitly enabled and protected. **Done 2026-11-11:** model, tool and turn spans and the inference/token/tool metrics follow the GenAI conventions; standard span names behind `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`; content capture stays opt-in. |
| 10 | P3 | Multi-device chat history | Done. With the runtime server, tasks from other browsers and the terminal are listed under **Other devices and terminal**, and reopening one loads its messages and tool steps from the server (`GET /api/sessions/:id` returns `display`). Chats made in the browser-only mode (kept in IndexedDB) are copied into the server session store when the app connects (`POST /api/sessions/import`, one copy per browser chat, sent again only after it changes), so the terminal and other devices see them. Only their text turns are copied; browser tool steps stay in that browser. | Tool steps of browser-only chats are not copied. |

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

Progress (November 2026): \`test/shell-policy-adversarial.test.mjs\` now checks policy, not only parser output. 54 compound, substituted, redirected, wrapped and malformed inputs must never match a strict allow rule; 41 spellings of \`rm\` (shell \`-c\`, \`eval\`, functions, loops, case arms, process substitution, \`sudo\`/\`env\`/\`nohup\`/\`xargs\`/\`find -exec\`, quoting tricks, \`busybox\`/\`toybox\` applets) must hit a \`Bash(rm:*)\` deny rule; and computed program names always need a person. The corpus found one gap, now fixed: \`busybox rm x\` and \`toybox rm x\` escaped deny rules. Parser parity covers 30 more static forms; the remaining differences (\`time\`, \`coproc\`, \`select\` and C-style \`for\` headers) are policy-neutral because both backends still report the inner command. Measured unbash parse latency on this machine: p50 5.7 µs, p99 18.7 µs per command line.

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

## Open-source replacement matrix (2026-11-12)

Audit date: 2026-11-12 · base `ab7d2c1e` · Node floor `>=22.15` · package licence Apache-2.0.

Rule: replace a home-grown part only when a maintained, permissively licensed library is measurably better on OASIS's own fixtures; otherwise keep it and record why. GitHub figures were read from the GitHub API on the audit date. "Ours" figures were measured in this repo.

### Already library-backed (earlier cycles, verified in source)

| Module | Library | Notes |
|---|---|---|
| `src/glob.mjs` | [picomatch](https://github.com/micromatch/picomatch) | thin wrapper (dotfiles, literal brackets) |
| `src/html-markdown.mjs` | [Defuddle](https://github.com/kepano/defuddle) + linkedom + turndown | worker-thread timeout kept |
| `src/json-schema.mjs` | [Ajv](https://github.com/ajv-validator/ajv) | lazy-loaded |
| `src/secret-rules.mjs` | [Gitleaks](https://github.com/gitleaks/gitleaks) rule set (MIT) | converted snapshot |
| `src/security-scan.mjs` | gitleaks, osv-scanner, semgrep, trivy, … | orchestrates real scanners |
| `src/lsp.mjs` | [vscode-jsonrpc](https://github.com/microsoft/vscode-languageserver-node) | framing/ids/cancel |
| `src/markdown.mjs` | [marked](https://github.com/markedjs/marked) lexer, [lowlight](https://github.com/wooorm/lowlight), [jsdiff](https://github.com/kpdecker/jsdiff), wrap-ansi, string-width | renderer is OASIS-specific (streaming, diffs, mermaid) |
| `src/frontmatter.mjs` | [yaml](https://github.com/eemeli/yaml) | plus Claude-Code-compatible lenient retry |
| `src/tokens.mjs` | [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) | |
| `src/proxy.mjs` | [undici](https://github.com/nodejs/undici) `ProxyAgent` | |
| `src/tool-call-repair.mjs` | [jsonrepair](https://github.com/josdejong/jsonrepair) | |
| `src/session-search.mjs` | SQLite FTS5 via built-in `node:sqlite` | |
| memory | [MiniSearch](https://github.com/lucaong/minisearch) + Porter2 | |
| `app/markdown.mjs`, `app/core/zip.mjs`, `app/core/workspace.mjs` diff | marked, [fflate](https://github.com/101arrowz/fflate), jsdiff (vendored via import map) | |
| routines cron | [croner](https://github.com/Hexagon/croner) | |

### Decision matrix for remaining home-grown parts

| Rank | Module | Best candidates (stars · licence · last push) | Evidence | Decision |
|---:|---|---|---|---|
| 1 | `src/rrule.mjs` (RFC 5545 subset, own day-scan engine, refuses BYSETPOS/BYWEEKNO/BYYEARDAY) | [rrule-temporal](https://github.com/ggaabe/rrule-temporal) 2.2.8 (122 · MIT · 2026-11-12, zero runtime deps, bundles a Temporal polyfill, CJS+ESM); [rrule.js](https://github.com/jkbrzt/rrule) (3,752 · BSD-3 · last push 2024-06, long-standing TZ/DST issues) | rrule-temporal reproduced all 14 OASIS fixture expectations (weekly/biweekly, -1FR, month-end, Feb 29, Thanksgiving, BYHOUR×BYMINUTE, COUNT, UNTIL incl. date-only, DST wall clock) and adds BYSETPOS, BYWEEKNO, BYYEARDAY, RSCALE. Impossible rules stop at a 10,000-iteration bound (~100 ms). DAILY from 2000 → next in 26 ms cold. Only difference: a local time inside a spring-forward gap is skipped (RFC 5545 §3.3.10 "MUST be ignored"); OASIS moved it forward. | **Replace engine.** Keep OASIS's parser for friendly errors and routine policy (no sub-daily, minute floor). |
| 2 | `src/file-watch.mjs` (`fs.watch` per parent dir) | [chokidar](https://github.com/paulmillr/chokidar) 5.0.0 (12,266 · MIT · 2026-11-06; Node ≥20.19, one dep `readdirp`; 6.x needs Node ≥22.22); [@parcel/watcher](https://github.com/parcel-bundler/watcher) (845 · MIT, native) | Tried on main's code: chokidar 5 does not watch a path that does not exist yet (`getWatched()` empty, `ready` fires twice), which OASIS relies on for settings files created mid-session; the swap broke "interactive sessions reload settings files live" in `test/hooks-v3.test.mjs` and was reverted. @parcel/watcher is native. | **Keep.** A possible in-house improvement is `fs.watch({ recursive: true })` for nested `SKILL.md` edits. |
| 3 | `src/mermaid-ascii.mjs` | [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) 1.1.3 (11,274 · MIT · 2026-05; pulls [elkjs](https://github.com/kieler/elkjs) EPL-2.0/GPL-3.0, 8.2 MB, loaded at import); [mermaid-ascii](https://github.com/AlexanderGrooff/mermaid-ascii) (Go binary) | On OASIS's `test/mermaid.test.mjs` inputs beautiful-mermaid dropped labels set on a later line (`N1[Second label]` rendered `N1`), garbled a sequence `Note over` and self-message inside `loop`, garbled an `erDiagram`, rejected `graph LR; A-->B` semicolon syntax, has no width bound (84 cols where OASIS reflows to 50) and a 60-node graph overwrote labels (`N┴6`). It does add class/state diagrams. | **Partly adopted** (`e22c0f55`): beautiful-mermaid draws state, class and xychart diagrams (loaded on first use); flowcharts, sequence and ER diagrams stay on the OASIS renderer for the reasons given. |
| 4 | fuzzy `@file` ranking (`src/completion.mjs` `rankFuzzy`/`fuzzyScore`) | [fzf-for-js](https://github.com/ajitid/fzf-for-js) 0.5.2 (957 · BSD-3 · last release 2023-04); [uFuzzy](https://github.com/leeoniya/uFuzzy) (3,042 · MIT); [Fuse.js](https://github.com/krisk/Fuse) (20,528 · Apache-2.0, Bitap, not path-aware) | On this repo's 1,449 tracked paths: `srcli` → fzf ranks `src/line-editor.mjs` first, OASIS `src/cli.mjs`; `cli.mjs` → fzf ranks four eval snapshots above `src/cli.mjs`, OASIS ranks it first. OASIS 0.76 ms vs fzf 3.6 ms per query. | **Keep** (OASIS's tiers are path-aware and faster on our corpus). |
| 5 | `src/zip.mjs` (plugin archive reader) | fflate (already a dep; MIT); [yauzl](https://github.com/thejoshwolfe/yauzl) 3.4.0 (832 · MIT) | fflate's `unzipSync` exposes no external attributes, so symlink rejection and the executable bit would be lost. OASIS's reader validates central/local header agreement, case-colliding and Windows-reserved names and bounds inflate output (zip-bomb guard). yauzl adds ZIP64 only, which plugin archives do not need. | **Replaced with yauzl** (`dd3629b3`), CRC-32 verified; OASIS keeps its name, symlink and size checks on top. |
| 6 | `src/package-vetting.mjs` edit distance | [fastest-levenshtein](https://github.com/ka-weihe/fastest-levenshtein) (775 · MIT · 2024-03) | Ours is optimal-string-alignment (adjacent swaps cost 1), which typosquat detection needs (`reqeusts`→`requests`). fastest-levenshtein has no transpositions. | **Keep.** |
| 7 | `src/circuit-breaker.mjs` (40 lines, per-provider failure map) | [cockatiel](https://github.com/connor4312/cockatiel) 4.0.0 (1,837 · MIT); [opossum](https://github.com/nodeshift/opossum) 10.0.0 (1,694 · Apache-2.0) | Both wrap a callable per breaker; OASIS keys breakers by provider name across the fallback chain and needs only count+cooldown. Revisited: the old map was never wired into requests (dead). cockatiel adds half-open probing and exponential cooldown with no dependencies. | **Replaced with cockatiel** (keyed per endpoint+model, wired into the fallback chain). |
| 8 | `src/atomic-write.mjs` | [write-file-atomic](https://github.com/npm/write-file-atomic) 7.0.1 (257 · ISC; 8.x needs Node ≥22.22.2) | Upstream replaces hard-linked files (breaks the link) and has no fallback for Windows/network shares that refuse rename (`EPERM`/`EBUSY`/`EXDEV`); OASIS handles both and keeps mode bits. | **Keep.** |
| 9 | `src/clipboard.mjs` | [clipboardy](https://github.com/sindresorhus/clipboardy) 5.3.2 (1,981 · MIT; 6 deps incl. execa, ships xsel/Windows binaries, 875 kB) | Same strategy (spawn platform tool); OASIS adds termux, WSL `clip.exe` and an OSC 52 fallback for SSH. | **Keep.** |
| 10 | `src/line-editor.mjs`, `vim-mode.mjs`, `keybindings.mjs` | [Ink](https://github.com/vadimdemedes/ink) (40k · MIT, React renderer), [Inquirer](https://github.com/SBoudrias/Inquirer.js) (prompts, not an editor), `node:readline`, [pi-tui](https://github.com/earendil-works/pi) editor (MIT, tied to its own TUI renderer) | None offers a drop-in multi-line raw-mode editor with Claude-Code-format keybindings, vim normal mode with text objects, Ctrl+R history and pure state-in/state-out tests. | **Keep.** |
| 11 | `src/edit-match.mjs` | OpenCode `edit.ts` replacer chain (MIT, not a package); Google [diff-match-patch](https://github.com/google/diff-match-patch) (archived) | No maintained library implements unique-only relaxed matching; OASIS's ladder already mirrors OpenCode's replacers. | **Keep.** |
| 12 | `src/apply-patch.mjs` | OpenAI reference `apply_patch.py` / Codex Rust crate (Apache-2.0) | Already a port of the reference with CRLF handling; no npm package. | **Keep.** |
| 13 | `src/safe-regex.mjs` (worker + timeout) | [re2js](https://github.com/le0pard/re2js) (211 · MIT); [node-re2](https://github.com/uhop/node-re2) (native) | RE2 forbids look-around/back-references that users' monitor patterns use; the worker keeps full JS semantics with a hard deadline. | **Keep.** |
| 14 | `src/cdp.mjs` | [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface) 0.34 (4,559 · MIT; `ws@7`, `commander@2.11`); playwright-core (large) | OASIS uses Node 22's built-in WebSocket with no deps; the alternative adds old transitive deps. | **Keep.** |
| 15 | `src/process-tree.mjs` | [tree-kill](https://github.com/pkrumins/node-tree-kill) (359 · MIT · last push 2020) | tree-kill parses `ps`; OASIS uses process groups (works after the leader exits) and `taskkill /T`. | **Keep.** |
| 16 | `src/secure-store.mjs` | [@napi-rs/keyring](https://github.com/Brooooooklyn/keyring-node) (native) | Native dependency; OASIS uses `security`/`secret-tool` with a 0600 fallback. | **Keep** (no heavy native deps). |
| 17 | `src/images.mjs` dimension sniffing | [image-size](https://github.com/image-size/image-size) (archived) | Upstream archived; OASIS reads PNG/JPEG/GIF/WebP headers in a few lines. | **Adopted** (`0dbedb5a`): the per-format parsers of image-size (types only, no file I/O) behind one shared sniffer. |
| 18 | `src/security-patterns.mjs` | Semgrep (already used by `security_scan`) | This is an offline per-edit hint, not a scanner. | **Keep.** |
| 19 | `src/text-encoding.mjs`, `src/key-pool.mjs`, `src/think-tags.mjs`, `src/notebook.mjs`, `app/core/command-palette.mjs` | — | Small, domain-specific, no better library. | **Keep.** |
| 20 | `src/agent-ignore.mjs` gitignore matcher (own pattern→RegExp translator) | [node-ignore](https://github.com/kaelzhang/node-ignore) 7.0.14 (507 · MIT · 2026-11-12, zero deps, used by ESLint, Prettier, globby) | Differential test against `git check-ignore --no-index` on 37 pattern sets × 63 paths (2,331 cases): OASIS 1 mismatch (unclosed `a[b`), node-ignore 0. | **Replace.** |
| 21 | `src/repo-map.mjs` personalized PageRank | [graphology](https://github.com/graphology/graphology) metrics `pagerank` (MIT) | [graphology's pagerank](https://github.com/graphology/graphology/blob/master/src/metrics/centrality/pagerank.js) teleports uniformly (`1 / graph.order`) and has no personalization vector, which the focus-file ranking needs; the power iteration itself is about 15 lines. | **Keep.** |
| 22 | `src/web.mjs` HTTP routing on `node:http` | Hono, Fastify (MIT) | A framework swap would rewrite security-sensitive host checks, auth limiter and SSE handling in a 3,195-line module, with no failing behaviour to fix. | **Keep.** |
| 23 | `src/tool-aliases.mjs` `splitSimpleCommandLine` / `parseArgsString`, `src/eval.mjs` `parseArgs` | unbash (already a dep), `node:util` `parseArgs`, jsonrepair | The splitter deliberately returns null on any shell syntax (a safety property a full parser would not give); the eval option parser carries per-flag error messages that `util.parseArgs` cannot express. | **Keep.** |
| 24 | `src/mcp-oauth.mjs` | @modelcontextprotocol/client (already used) | Protocol work already done by the official SDK; OASIS adds only the SSRF endpoint guard, loopback callback and 0600 token store. | **Already library-backed.** |
| 25 | `src/shell-completion.mjs`, `src/sounds.mjs`, `src/provider-retry.mjs` `parseDurationMs`, HTML escaping in `src/session-html.mjs` / `src/eval-report.mjs` | omelette/tabtab (stale), `ms`, `entities` (already a dep) | A few lines each; no library would fix or remove anything that matters. | **Keep.** |
| 26 | Web-app code highlighting (`app/markdown.mjs`) | [highlight.js](https://github.com/highlightjs/highlight.js) 11.11.2 (BSD-3; browser ESM from `@highlightjs/cdn-assets`, already used in the terminal via lowlight) | Fenced code blocks were plain text in the app; highlight.js's own `es/` entries are CJS wrappers that cannot load through the import map, the CDN-assets build can. CSP unchanged apart from the import-map hash. | **Adopted** (`1abfe757`). |
| 27 | Web-app Markdown sanitizing (`app/markdown.mjs`, already marked-based) | [DOMPurify](https://github.com/cure53/DOMPurify) 3.4.17 (MPL-2.0 OR Apache-2.0) | 30 XSS payloads produced 0 disallowed tags or attributes before the change, and the CSP blocks inline handlers; DOMPurify is defence in depth with a tag/attribute allow-list and http(s)/mailto-only links. Verified in real Chromium (`test/app-markdown-browser.test.mjs`). | **Adopted** (`1abfe757`). |
| 28 | Terminal Markdown (`src/markdown.mjs`) | [marked-terminal](https://github.com/mikaelbr/marked-terminal) 8.0.0 (504 · MIT; 7 deps incl. cli-table3, node-emoji, terminal-image) | OASIS already uses marked's `Lexer` for inline parsing and lowlight for code; its block layer is line-oriented so partial replies render while they stream, and it draws diffs and Mermaid. marked-terminal renders whole documents only. | **Keep.** |
| 29 | Keyless web search (`src/web-search.mjs` DuckDuckGo/Bing HTML) | [SearXNG](https://github.com/searxng/searxng) (AGPL-3.0 service, used over HTTP, not linked); linkedom DOM parsing | SearXNG is already a configurable backend (`OASIS_SEARXNG_URL`, JSON API, reciprocal-rank fusion with Tavily/Brave/Exa/Firecrawl); keyless DuckDuckGo → Bing stays the default. A linkedom parse cost 336 ms to import plus 20–50 ms per page; the regex parsers were made order- and quote-independent instead. | **Keep SearXNG option; harden parsers** (`39433004`). |
| 30 | Session search (`src/session-search.mjs`) | SQLite [FTS5](https://www.sqlite.org/fts5.html) via built-in `node:sqlite` (Node ≥22.13 unflagged; SQLite 3.50.4 in Node 22.21); MiniSearch (previous) | 1,000 synthetic sessions × 40 messages: MiniSearch re-indexed everything on each query (≈3 s); FTS5 with an incremental 0600 cache takes ≈1.5 s for the first build and 25–150 ms per later query. Labelled 15-query set: 15/15 top hits for both. Session files unchanged; corrupt cache rebuilt. | **Replace** (`2aa64c3c`). |
| 31 | Memory retrieval reranker (`rankMemories`, MiniSearch BM25+) | [transformers.js](https://github.com/huggingface/transformers.js) 4.3.2 (Apache-2.0) with all-MiniLM-L6-v2 / bge-small-en-v1.5 (q8) | `npm run bench:memory` baseline: held-out recall@1 23/25, recall@3 25/25, MRR 0.960. Best hybrid (BM25 + MiniLM reciprocal-rank fusion): 24/25, MRR 0.980, dev unchanged; pure reranking reached 25/25 held-out but lost a dev query; bge fusion also 24/25. Cost: 745 MB `node_modules` (onnxruntime-node and sharp native binaries), a 23–56 MB model download from Hugging Face on first use, about 0.5–0.6 s model load. One query out of 40 does not justify a heavy native optional dependency and a network fetch. | **Not adopted**; revisit with a larger corpus. |
| 32 | Web-app diff view (`app/main.mjs` `renderDiff`) | [diff2html](https://github.com/rtfpessoa/diff2html) 3.4.56 (MIT; deps `diff`, `@profoundlogic/hogan`) | No browser-loadable ESM: `lib-esm` uses extensionless imports and hogan is CommonJS (its compiler uses `new Function`); only UMD globals exist, outside the app's import-map-only module graph. Its main gain over the app was word-level change marks, which the terminal already had via jsdiff. | **Not adopted**; jsdiff word highlights shared with the app (`d321abba`). |
| 33 | Provider HTTP retry (`src/provider-retry.mjs`) | [p-retry](https://github.com/sindresorhus/p-retry) (MIT), undici `RetryAgent` | The module is provider policy (Retry-After and `x-ratelimit-reset` parsing, hard-quota and unconfigured-route detection, abortable jittered waits feeding the fallback chain and UI notices). p-retry only replaces the attempt loop; `RetryAgent` would hide retries from the fallback chain and notices. | **Keep.** |
| 34 | Token counting, JSON repair, terminal widgets | gpt-tokenizer, jsonrepair (already deps); Ink / Inquirer / @clack/prompts | `src/tokens.mjs` and `src/tool-call-repair.mjs` already delegate to gpt-tokenizer and jsonrepair. The TUI widgets are covered by row 10. | **Already library-backed / Keep.** |

### Execution log

Filled in as replacements land on `main`.

| Commit | Change | Tests |
|---|---|---|
| `0b649064` | `src/rrule.mjs` expansion → rrule-temporal 2.2.8; OASIS parser/policy kept; BYSETPOS, BYWEEKNO, BYYEARDAY added; DST gap still moves forward | `test/rrule.test.mjs`, `test/routines.test.mjs` 30/30 |
| `76d6d595` | `src/agent-ignore.mjs` matching → node-ignore 7.0.14; translator deleted; new `git check-ignore` parity test | `test/agent-ignore.test.mjs` 7/7, `test/ast-grep.test.mjs` |
| — | `src/file-watch.mjs` → chokidar 5 tried and reverted (see row 2) | `test/hooks-v3.test.mjs` regression |
| `b80cc225` | `src/file-watch.mjs`: recursive `fs.watch` for skill trees; watches the parent until a skills folder appears | `test/hooks-v3.test.mjs` 9/9 |
| `1abfe757` | Web app: highlight.js 11.11.2 code highlighting and DOMPurify 3.4.17 sanitizing | `test/app-core`, `app-e2e`, `live-tool-output`, `app-markdown-browser` (Chromium) |
| `39433004` | Keyless DuckDuckGo/Bing parsers independent of attribute order and quotes | `test/web-search.test.mjs` 20/20 |
| `2aa64c3c` | `src/session-search.mjs` MiniSearch → SQLite FTS5 (`node:sqlite`), incremental cached index | `test/session-search.test.mjs` 6/6 plus 36 importer tests |
| (this commit) | `src/circuit-breaker.mjs` → cockatiel 4.0.0 `ConsecutiveBreaker` + exponential half-open cooldown; wired into `requestCompletion` and `remainingFallbacks` | `test/circuit-breaker` 6/6, `fallback-chain`, `fallback-retry-delay` |
| `d321abba` | Web-app diffs mark changed words (shared `src/word-diff.mjs`, jsdiff) | `test/word-diff`, `markdown`, `app-core`, `app-markdown-browser` |
| (this commit) | One durable replace (`replaceFileDurably` / `replaceFileDurablySync` in `src/atomic-write.mjs`: random temp name, fsync, Windows rename retry, directory fsync, temp always removed) used by 20 state stores that each had their own temp+rename; pid-only temp names collided on concurrent saves and several leaked temps on failure | `test/atomic-write` (concurrency, cleanup, mode), 186 store tests |
| `8d7a94d7` | Durable recovery: a save taken mid tool batch keeps finished results (labelled recovered data) and answers still-running calls with an explicit `Interrupted:` result instead of dropping the step | `test/session-midturn`, `steering`, `runtime`, `web-midturn-save` |
| (this commit) | Tool-call IDs on the wire (`src/tool-call-ids.mjs`): unique per request, `[A-Za-z0-9_-]{1,40}` (Mistral: nine alphanumerics), deterministic so the cached prefix is stable; the loop also gives empty or repeated IDs in one reply fresh IDs | `test/tool-call-ids` 6/6, 520 provider/stream/tool tests |

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
- **Tool/agent trace correlation:** one trace across model request, retries, tool call, subagent, verification and result, without collecting private prompt content by default. Status: turn, model request, tool and subagent spans share one trace, and retries and recoveries are `oasis.recovery` events on the span they happened in (`src/agent.mjs` `traceRecovery`).
- **Extension supply chain:** immutable source revisions, permission manifests, install previews, least privilege, revocation and deterministic rollback.
- **Release publication and version consistency:** the `v1.1.0` Git tag exists at `2da78dd50a708833f97be97f20fb8016c0ab4c1d`, but no GitHub Release is associated with it as checked on 2026-11-07. As of 2026-11-14 `package.json` is 1.3.0 and v1.1.1, v1.2.0 and v1.3.0 each have a GitHub Release (v1.3.0 is Latest); `v1.1.0` is still a tag only. Keep package version, tag, release object, checksums, README links and updater behaviour aligned; publish only after same-commit quality, site and installer gates pass.
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
