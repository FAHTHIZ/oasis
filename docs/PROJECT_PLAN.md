# OASIS project plan

**Updated:** November 1, 2026  
**Lifecycle:** Beta  
**Repository:** [FAHTHIZ/oasis](https://github.com/FAHTHIZ/oasis)  
**Current main snapshot inspected:** [`ebb5fa1321bb8eae9d57b5f4b91e3ccb75b8a615`](https://github.com/FAHTHIZ/oasis/commit/ebb5fa1321bb8eae9d57b5f4b91e3ccb75b8a615)  
**Latest published release:** [`v0.4.0`](https://github.com/FAHTHIZ/oasis/releases/tag/v0.4.0), published October 31, 2026.  
**Source-audit baseline (runtime review):** `2683addcd077b3b20f5b4ad7e25f05e743e7c1bf`  
**Historical CI evidence baseline:** `5d6225e982755dd333dc0d476e685b4f8f0282ac`  
**Historical architecture source baseline (system-map audit):** [`e43d4187825a3a31bdcbe4136d0afab05a980641`](https://github.com/FAHTHIZ/oasis/commit/e43d4187825a3a31bdcbe4136d0afab05a980641)  
**Historical architecture guide revision:** [`aba586eda6f440be86c5e8b978f9e973f44034d2`](https://github.com/FAHTHIZ/oasis/commit/aba586eda6f440be86c5e8b978f9e973f44034d2)  
**Historical User Guide and documentation audit snapshot:** [`e9e79441eee7cad70b4229d69b98c18d553020db`](https://github.com/FAHTHIZ/oasis/commit/e9e79441eee7cad70b4229d69b98c18d553020db)

This is the single working reference for what OASIS is, what is implemented, what is still limited, and what must happen before a wider Beta release. The [architecture guide](ARCHITECTURE.md) is its companion system map for how those implemented components fit together. This plan replaces the overlapping status, milestone, readiness, capability-gate, implementation-plan, roadmap and gap-register documents. Historical CI results are not current release evidence.

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

**Inspected source commit:** `ebb5fa1321bb8eae9d57b5f4b91e3ccb75b8a615` on `main` (November 1, 2026). This is the audit baseline for the findings below; later commits require their own verification.

### Published release

- `v0.4.0` is a real Git tag pointing to `8ebb5cec5a273133950fd5f40f5b36f9da654e8e`.
- The matching GitHub Release was published on October 31, 2026 at 13:00:21 UTC and is the latest release.
- Published desktop assets include a Windows x64 `.exe`, macOS arm64 `.dmg`, Linux x86_64 `.AppImage` and `.deb`, updater metadata, and `SHA256SUMS`.
- The installers are unsigned. A checksum manifest detects accidental corruption; it is not a publisher signature.
- GitHub currently marks the release `prerelease: false`, although its name and product documentation identify it as Beta. The next release workflow must align GitHub metadata with the declared product lifecycle. Do not infer product stability from the GitHub flag alone.

### Development branch after v0.4.0

- `main` is 101 commits ahead of the `v0.4.0` tag in the inspected comparison.
- `package.json` on `main` still reports `0.4.0`. This version string must not be mistaken for a new `v0.4.0` release: current `main` includes later, unreleased changes.
- Do not move, replace, or retag `v0.4.0` to absorb subsequent work. The next versioned release should use a new version, immutable tag, release notes, checksums, and artifacts. `0.5.0` is a candidate next version, not a declared or published release.

### CI evidence for the inspected main commit

- **Quality Checks:** [run 41265370702](https://github.com/FAHTHIZ/oasis/actions/runs/41265370702) — **8 of 9 jobs passed; Browser end-to-end smoke test failed**. Node 22/24/26 package checks, Windows/macOS/Linux runtime-security tests, clean-environment tests, and native PTY integration passed. The browser job timed out after 15 seconds waiting for `#agentMessages .turn-work` to become visible at `.github/scripts/browser-e2e.mjs:320`. The run also reported accessible-name mismatches on `.send-key-toggle` and activity disclosure summaries; these findings need review.
- **Installer checks:** [run 41265370731](https://github.com/FAHTHIZ/oasis/actions/runs/41265370731) — Windows, macOS, and Ubuntu installer jobs passed.
- **Desktop packaging:** [run 41265370753](https://github.com/FAHTHIZ/oasis/actions/runs/41265370753) — Linux, macOS, and Windows package jobs and the workflow publish step passed.
- **Public site and repository metadata:** [run 41265370712](https://github.com/FAHTHIZ/oasis/actions/runs/41265370712) — validation and deployment jobs passed.
- **Branch cleanup:** [run 41265370788](https://github.com/FAHTHIZ/oasis/actions/runs/41265370788) passed; the GitHub branches endpoint at this snapshot returned only `main`.

The previous all-green run on October 31 belongs to an older commit and is historical evidence only. It must not be used to describe the inspected November 1 commit as fully green. Any new candidate needs fresh same-commit checks.

## Production-readiness outlook

Production readiness is an evidence gate, not a calendar date or a feature-count milestone. Do not describe OASIS as production-ready until the P0 acceptance gates, clean-machine first-run checks, critical user journeys, security-boundary validation, and release-artifact checks have all been demonstrated on one candidate commit.

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

### P0 — Stabilize the next versioned Beta release

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

- [ ] Quality Checks pass on the exact candidate SHA. The inspected `main` snapshot passed 8/9 jobs; browser E2E remains failing at the `.turn-work` visibility wait. Resolve the behavior and accessibility findings, then rerun the full workflow.
- [x] Windows, macOS, and Ubuntu installer workflow passed on the inspected `main` SHA: [run 41265370731](https://github.com/FAHTHIZ/oasis/actions/runs/41265370731).
- [x] Windows, macOS, and Linux desktop packaging workflow passed on the inspected `main` SHA: [run 41265370753](https://github.com/FAHTHIZ/oasis/actions/runs/41265370753). Packages remain unsigned.
- [x] Public-site validation and deployment passed on the inspected `main` SHA: [run 41265370712](https://github.com/FAHTHIZ/oasis/actions/runs/41265370712).
- [x] The `v0.4.0` tag, GitHub Release object, release notes, checksums, and downloadable desktop assets exist.
- [ ] GitHub release lifecycle metadata aligns with the Beta label. The published `v0.4.0` release is currently marked `prerelease: false`; set the correct metadata policy for the next release.
- [ ] Clean-machine install, first launch, provider setup, update, and uninstall are exercised on each advertised desktop OS. CI package success is not a substitute for real clean-machine checks.
- [ ] Desktop signing, publisher identity, and provenance are configured or their absence is explicitly accepted for the target audience.
- [ ] Documentation is verified against the exact candidate commit after the current consistency repair; then rerun applicable site and repository checks.
- [ ] Representative repository-scale evaluation is published. The current 33-task evaluator remains a smoke/regression suite, not a defensible coding-quality benchmark.

A green CI matrix is necessary, not sufficient. It does not replace security review, real-user journeys, clean-machine installation checks or representative coding evaluation.
