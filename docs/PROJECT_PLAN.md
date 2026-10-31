# OASIS project plan

**Updated:** October 31, 2026  
**Lifecycle:** Beta  
**Repository:** [FAHTHIZ/oasis](https://github.com/FAHTHIZ/oasis)  
**Audited main snapshot:** `51590f2f27e9378724e8325dc954ff1ac3a0f313`

This is the single working reference for what OASIS is, what is implemented, what is still limited, and what must happen before a wider Beta release. It replaces the overlapping status, milestone, readiness, capability-gate, implementation-plan, roadmap and gap-register documents. Historical CI results are not current release evidence.

## Product direction

OASIS is an **open-source, local-first AI coding agent and developer workspace**. It connects a model chosen by the user to a real project workspace, then helps explore code, plan changes, edit files, run commands, inspect diffs and verify results. It is designed around model choice, explicit execution controls, reusable workflows and an inspectable local runtime—not around one hosted model or a single chat interface.

OASIS has its own identity. Claude Code and other tools are useful comparison points for specific capabilities, but feature-count parity is not the product goal. Correctness, useful work, clear controls, reliability and user trust matter more than matching another product's command list.

OASIS does not include an AI model, hosted execution service or paid API subscription. Users connect a supported provider or a local model. When a hosted provider is selected, prompts and relevant code context are sent to that provider under its own terms.

## What is implemented

The repository contains real implementations—not only plans—for these product areas:

| Area | What the code provides |
|---|---|
| Coding agent | Multi-step model/tool loop, repository exploration, planning, bounded file and command tools, tool-result recovery, cancellation and post-edit verification tracking. |
| Workspace operations | File search/read/edit/write/delete with workspace checks, snapshots, Git inspection and isolated worktree support. |
| Execution controls | Permission rules and modes, approval prompts, command-risk analysis, hooks, output limits and process-tree cleanup. Optional OS sandboxing is a separate control from approval prompts. |
| Models | Multiple provider protocols and compatible endpoints, including local Ollama-style endpoints and gateways such as OmniRoute. Provider setup tests an inert tool-call response before saving a new configuration. |
| Continuity | Saved sessions, workspace instructions and memory, context estimates, history compaction, checkpoints, rewind and output preservation. |
| Agent coordination | Bounded subagents, specialist review, session-local teams/task boards, dependency-aware task dispatch, background task records and worktree isolation. |
| Automation | Sandboxed JavaScript workflows with schema-checked results, phases, pipelines and parallel work. |
| Integrations | MCP clients, hooks, skills, plugin adapters/native local plugin packages, web search and extension import/export paths. Compatibility is feature-specific, not universal. |
| Code intelligence | Language-server navigation/diagnostics where configured, project-checker execution and explicit unavailable states when a tool cannot provide evidence. |
| User surfaces | CLI, local authenticated browser workspace, VS Code-compatible integration and Electron desktop packaging for Windows, macOS and Linux. |
| Operations | Run monitoring and persisted task/event records, browser job history, diagnostics and a public landing page separate from the app workspace. |

These capabilities are present in the source and have subsystem tests. That does not mean every platform path, provider, integration or end-to-end user journey has been certified for release.

## Current release snapshot

At the audited snapshot:

- `package.json` is version **0.4.0** and the release notes are prepared.
- The only Git tag found was `v0.3.0`; no `v0.4.0` tag or GitHub Release had been published.
- Installer checks passed on Windows, macOS and Linux for the audited main snapshot.
- The branch-cleanup workflow passed and preserved all 11 remaining divergent branches.
- Quality Checks, public-site validation and desktop packaging were still running when checked. They must not be described as passing from a pending status.
- Desktop installers are unsigned. Automatic desktop updates and publisher signing/provenance are not configured.
- The full 33-task evaluation suite is a regression/smoke harness, not a representative repository-scale coding benchmark. No live, authenticated Claude Code head-to-head result is published.

The final documentation consolidation changes the source SHA. Re-run the required workflows after these changes; evidence from the audited base SHA is useful history, not proof for the final documentation commit.

## Known boundaries

| Boundary | Accurate statement |
|---|---|
| Beta maturity | OASIS is Beta software. Do not describe it as stable, production-certified or defect-free. |
| OS sandbox | Optional Linux/macOS sandboxing is disabled by default and is not full filesystem-read isolation. Windows has no OASIS-native OS sandbox; approval-based controls are not OS isolation. |
| Shell and tool permissions | Approval, command-risk checks and workspace path controls reduce risk but do not make arbitrary code, MCP servers, hooks or third-party plugins safe. |
| Desktop distribution | Windows, macOS and Linux desktop packages are built by CI but are unsigned. Build success is not proof of clean-machine first-run, update or uninstall behavior. |
| Android | There is no native Android APK release. The CLI may be tried in Termux, but native PTY behavior and background execution are experimental and not guaranteed. |
| Browser/CLI state | The browser workspace is local and authenticated, but project/task/note state is not fully synchronized with CLI state. |
| Multi-agent continuity | Run history and interrupted states can be recorded, but a runtime restart does not resurrect killed worker processes or pending approvals. Durable pause/resume and complete lease recovery remain open. |
| Benchmarks | The 33 fixtures are small regression tasks. The five-track benchmark design has not produced publishable results. No parity, speed, accuracy or token-savings claim is justified. |
| Remote/onion access | Self-hosted remote runner, trusted phone pairing and Tor/onion access remain design-only. They are not shipped capabilities. |

## Priorities

### P0 — Establish a trustworthy Beta release

1. Require Quality Checks, public-site validation, installer checks and desktop packaging to pass on one final commit.
2. Fix any failures in the actual code or tests. Do not remove gates, suppress meaningful assertions or use older runs as substitutes.
3. Verify first launch, provider setup, a small edit-and-test task, update and uninstall on clean Windows/macOS/Linux environments.
4. Keep the published version, immutable tag, release notes, checksums and installer assets consistent. State unsigned status plainly until signing and provenance are configured.
5. Keep README, installer instructions, release notes, security policy and platform support statements aligned with the actual build.

### P1 — Measure real coding work

Expand beyond the 33 helper-oriented fixtures to at least 50 representative repository tasks. Include multi-file features, real bug fixes with regression tests, failing-test diagnosis, refactoring, long-context continuity, permission denial, cancellation and recovery. Pin repository snapshots, model/provider, prompt, permissions, budgets and verifier. Run at least three trials per task and publish every failure and timeout. Keep automated acceptance and human diff review separate. See [Benchmarks](BENCHMARKS.md).

### P1 — Close the trust and platform evidence gap

Publish a clear support matrix for process cleanup, PTY, browser workspace, sandboxing and desktop packaging. Continue adversarial testing for path/symlink escape, network/private-address access, secrets, process descendants, cancellation and storage boundaries. Validate Windows credential-file ACLs and process-tree behavior; keep the absence of native Windows OS sandboxing explicit unless a supported solution is implemented and tested.

### P2 — Make agent work more recoverable

The next meaningful orchestration investment is not spawning more workers. It is a truthful, durable lifecycle: persisted worker/task identity, lease reconciliation, cancellation propagation, recoverable checkpoints, restart-aware state and clear handling of partial work. Keep parallel edits isolated. Show diffs and verification evidence before integration. Never describe a restored transcript as a live resumed worker.

### P2 — Improve the complete product journey

Prioritize high-value user journeys: provider setup, project onboarding, CLI/browser state ownership, accessible approval flows, browser PTY lifecycle and clear recovery after failed or interrupted tasks. Consider remote/mobile, JetBrains or other additional surfaces only after identity, trusted-device enrollment, workspace isolation, revocation and audit requirements are designed.

## Release acceptance checklist

- [ ] Latest Quality Checks pass on the exact candidate SHA.
- [ ] Public-site validation passes on that same SHA.
- [ ] Windows/macOS/Linux installer checks pass on that same SHA.
- [ ] Desktop packaging completes on that same SHA.
- [ ] Browser end-to-end tests cover first-run, approval/denial, cancellation, edit/verify and recovery paths.
- [ ] Clean-machine install and first-run behavior is exercised for each advertised desktop OS.
- [ ] Release version, immutable tag, release notes, checksums and uploaded artifacts agree.
- [ ] Unsigned status and sandbox/platform limitations are visible.
- [ ] README, Install, User Guide, Privacy, Security and release notes describe the same product.
- [ ] Benchmark claims stay within the evidence actually published.

A green CI matrix is necessary, not sufficient. It does not replace security review, real-user journeys, clean-machine installation checks or representative coding evaluation.
