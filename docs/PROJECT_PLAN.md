# OASIS product and release-qualification plan

**Product lifecycle:** Release Candidate / Production Qualification  
**Development package version:** `1.0.0`  
**Release channel:** Release Candidate 1 (unpublished)  
**Candidate source:** `main`  
**Latest published stable release:** `v0.4.0` (historical release; not the current development version)  
**License:** Apache-2.0

This document is the canonical statement of product scope, maturity, supported surfaces, known limits, and release gates. The root README is the concise public overview; the [architecture guide](ARCHITECTURE.md) describes the system; the [user guide](USER_GUIDE.md) describes how to operate it.

## Current verification snapshot

**Browser lifecycle fix:** [`f83d73e69ec24ce5a57588784de7531d2c585934`](https://github.com/FAHTHIZ/oasis/commit/f83d73e69ec24ce5a57588784de7531d2c585934)  
**Browser E2E fixture follow-up:** [`31bfdb7065d4a0f7c6098984e3a750eaa72dfde1`](https://github.com/FAHTHIZ/oasis/commit/31bfdb7065d4a0f7c6098984e3a750eaa72dfde1)  
**Latest documentation snapshot in this pass:** [`48fc802e7855b82115d6260bd90a1a055567374b`](https://github.com/FAHTHIZ/oasis/commit/48fc802e7855b82115d6260bd90a1a055567374b)  
**Inspection date:** November 1, 2026  
**Release metadata:** package `1.0.0`, Release Candidate 1; no RC tag or public 1.0.0 release has been created.

| Workflow on this exact commit | Current result |
|---|---|
| [Quality Checks](https://github.com/FAHTHIZ/oasis/actions/runs/41272900653) | Pending at inspection; no completed job results available yet. |
| [Installer checks](https://github.com/FAHTHIZ/oasis/actions/runs/41272900715) | Queued at inspection. |
| [Desktop packaging](https://github.com/FAHTHIZ/oasis/actions/runs/41272900640) | Queued at inspection. |
| [Public site and repository metadata](https://github.com/FAHTHIZ/oasis/actions/runs/41272900621) | In progress at inspection. |
| [Branch cleanup](https://github.com/FAHTHIZ/oasis/actions/runs/41272900625) | Queued at inspection. |

The browser client now reconciles busy/activity state from the server's terminal job status, so the interface cannot remain indefinitely busy if the event stream ends before a terminal event is consumed. A subsequent test commit also corrected the scripted provider fixture: it now performs a focused content check after diff review instead of trying to finish immediately after the diff call. The latest full CI run for the documented snapshot has not yet completed; these changes are implemented but not yet proven by a green same-commit browser E2E run. Do not infer a green browser test from the code changes alone.

The CI rows above refer to the latest documented candidate snapshot. Between the lifecycle fix and this snapshot, commit `31bfdb7` updated the browser E2E fixture; the remaining commits in this pass updated product wording, release evidence, documentation and the public landing page. A fresh CI run is required for the final snapshot before describing it as fully green. Never combine passing jobs from different commits into one claimed green result.


## 1. Product position

OASIS is an open-source, local-first agentic development workspace. It connects a model selected by the user to a real project and coordinates codebase exploration, planning, file operations, controlled command execution, integrations, agent coordination, and verification.

OASIS is not a hosted model or a proprietary model endpoint. The user chooses the provider or local model; OASIS owns the local runtime, tool contracts, workspace access, execution policy, session state, interfaces, and verification reporting.

### Current maturity

The planned 1.0.0 product scope is feature-complete. OASIS is no longer in Beta or an early feature-building phase. The current phase is **1.0 Release Candidate / Production Qualification**.

The work remaining is primarily refinement and qualification: stronger agents, better tool selection and task completion, robustness, lifecycle correctness, accessibility, platform consistency, security-boundary validation, operational recovery, and accurate packaging/documentation. The default priority is to improve and finish the existing product—not introduce substantial new product surfaces or expand scope.

This maturity statement is not a claim that production qualification is complete. A release-candidate label says the product scope is being stabilized; it does not certify security, platform support, uptime, or defect-free behavior.

## 2. Version and release channels

- The previously published `v0.4.0` remains an immutable historical Git tag and GitHub Release. Its name and release notes accurately record that it shipped as Beta at that time.
- The current development package on `main` is numeric SemVer `1.0.0`; `package.json` separately identifies the channel as `release-candidate`, candidate `1`.
- This is an unpublished source candidate, not a Git tag, GitHub Release, or downloadable installer. The stable CLI installer continues to resolve the latest stable tag, currently `v0.4.0`.
- The final `v1.0.0` release must be created from a newly qualified immutable commit only after every acceptance gate passes; never move or retag the historical `v0.4.0` release.
- Preserve the historical `v0.4.0` tag and never publish an RC candidate as stable.

## 3. Product scope for 1.0

The intended 1.0 product is a unified runtime with multiple interfaces—not a collection of unrelated apps.

| Domain | Included capability |
|---|---|
| Agent orchestration | Multi-step model/tool loop, planning, repository exploration, tool orchestration, completion and failure reporting. |
| Workspace | File search/read/write/edit/delete, workspace checks, Git inspection, snapshots, diffs, and isolated worktree support. |
| Execution policy | Permission modes, approvals, command-risk analysis, protected paths/configuration, output bounds, process cleanup, and optional OS sandbox adapters. |
| Models and providers | Multiple provider protocols, compatible endpoints, local model services, provider setup, model routing, and cost estimation. |
| Context and memory | Sessions, project instructions, memory, context estimation, compaction, rewind, checkpoints, and saved task records. |
| Agent coordination | Bounded subagents, specialist reviews, task boards, dependency-aware dispatch, background records, and workflow automation. |
| Integrations | MCP, hooks, Agent Skills, plugins, extension import/export, search integrations, GitHub workflows, and editor bridges. |
| Code intelligence and verification | Diagnostics, language-server support where configured, project checks, automatic testing, weakened-test detection, diff review, and claim checks. |
| Developer surfaces | CLI, authenticated local browser workspace, Electron desktop shell, VS Code-family integration, SDK, and GitHub Action. |

Implementation presence does not mean every feature works identically across all providers, operating systems, editors, or third-party integrations. Use the support matrix below and the relevant subsystem tests.

## 4. Support and qualification matrix

| Surface / environment | Current status | Qualification boundary |
|---|---|---|
| CLI on Node.js 22+ | Primary workflow | Requires a compatible model/provider and the OS permissions required by chosen tools. |
| Local browser workspace | Available | Authenticated local runtime; some Projects/Tasks/Notes state remains separate from CLI state. Browser lifecycle and accessibility E2E must pass before 1.0. |
| Desktop Windows x64 | Installer packaged in v0.4.0 | Unsigned. Clean-machine install, first-run, update, and uninstall need explicit real-machine evidence. No native OASIS OS sandbox. |
| Desktop macOS arm64 | Installer packaged in v0.4.0 | Unsigned. Clean-machine install, first-run, update, and uninstall need explicit real-machine evidence. Optional sandbox integration is not full filesystem-read isolation. |
| Desktop Linux x86_64 | Installer packaged in v0.4.0 | Unsigned. Clean-machine install, first-run, update, and uninstall need explicit real-machine evidence. Optional sandbox integration is not full filesystem-read isolation. |
| VS Code-family integration | Implemented integration | Do not claim universal parity with every editor or extension marketplace. |
| SDK / GitHub Action | Implemented integration | Unattended execution must be deliberately scoped and isolated by the adopting repository/operator. |
| Android / Termux | Experimental use path | No native APK. PTY, background behavior, and real-device reliability are not fully qualified. |
| Remote access / phone pairing | Not in 1.0 scope | No shipped trusted-device enrollment or secure remote pairing service. |
| Tor/onion access | Not in 1.0 scope | Not a shipped capability. |
| Native Windows OS sandbox | Not implemented | Approval checks are not equivalent to OS isolation. |

## 5. Operational and security boundaries

OASIS is a local-first runtime, not a security boundary around arbitrary code.

- Approved commands execute with the current operating-system user's permissions.
- Optional Linux/macOS sandboxing is disabled by default and is not full filesystem-read isolation.
- Native Windows OS sandboxing is not implemented.
- MCP servers, hooks, plugins, executable skills, package installers, and repository scripts may execute beyond OASIS file-tool restrictions.
- Browser Projects/Tasks/Notes data is stored in browser local storage and is not encrypted by OASIS.
- Browser-side project/task/note state is not fully synchronized with CLI state.
- Restarting the runtime does not resurrect killed worker processes, in-memory team state, PTY sessions, or pending approvals. Persisted history is not a live resumed worker.
- Desktop installers are unsigned; checksum manifests detect transfer corruption but are not publisher signatures.
- The 33-task evaluation harness is a regression/smoke suite, not a representative repository-scale coding benchmark. No parity, speed, accuracy, or token-savings claims are justified by it.

These are explicit product boundaries. They should not be hidden by maturity wording or treated as completed merely because the corresponding functionality exists in some form.

## 6. Current release-candidate blockers

The following items are release qualification work, not a request to expand product scope.

### P0 — Release blockers

1. **Browser E2E lifecycle and fixture:** the earlier failure exposed two separate issues: the scripted provider fixture needed to answer the post-edit `git_diff` verification request, and the browser client needed to reconcile its busy/activity state from the server's terminal job status if the event stream omitted the terminal event. The fixture response order and client lifecycle reconciliation have now been updated on the inspected commit. The full browser E2E run is still pending; retain assertions for completed-turn disclosure, failed-command warning, approval/denial, cancellation, and side effects.
2. **Accessibility:** run and resolve accessibility findings across empty, connection-error, provider, approval, activity-detail, and mobile states. Do not suppress axe findings simply to produce a green run.
3. **Same-candidate CI:** run Quality Checks, installer checks, desktop packaging, and public-site validation against one immutable candidate commit. Older successful runs are historical evidence only.
4. **Clean-machine desktop journey:** test installation, first launch, provider setup, a small task, update, uninstall, and user-data preservation on clean Windows, macOS, and Linux environments.
5. **Security-boundary review:** re-check workspace escape, protected paths, command execution, process descendants, network/private-address restrictions, credential storage/redaction, browser token handling, and integration trust boundaries on the candidate source.
6. **Release integrity:** build artifacts from the exact candidate commit; produce checksums; align package version, Git tag, release notes, updater metadata, and GitHub prerelease/stable flag; verify that the release page and installers point to the same immutable candidate.
7. **Documentation/public identity:** README, public site, package metadata, installer instructions, security policy, and release notes must describe the same version and lifecycle.

### P1 — Quality and robustness improvements

- Improve agent planning and tool selection without changing stable tool contracts unexpectedly.
- Improve long-running task lifecycle, interruption handling, progress, and accurate partial-completion reporting.
- Reduce avoidable context/tool-schema overhead while preserving correct tool availability.
- Improve browser/CLI state clarity and accessible interaction patterns.
- Add regression cases where real failures are observed; do not inflate tests with nonrepresentative checks.
- Improve cross-platform process, PTY, installer, and update diagnostics.

### P2 — Post-1.0 options

Potential future areas include remote runner infrastructure, trusted-device pairing, additional editor surfaces, a native Android app, expanded sandbox isolation, and a larger real-world coding evaluation program. These are explicitly outside the current 1.0 release scope unless a separate product decision adds them.

## 7. Release acceptance checklist

- [ ] Browser E2E passes on the exact candidate SHA, including task completion, activity fold, approval/denial, cancellation, and worktree review.
- [ ] Accessibility checks show no unresolved release-blocking findings across the required UI states.
- [ ] Quality Checks passes all jobs on the same candidate SHA (Node 22/24/26, Windows/macOS/Linux runtime/security matrix, clean environment, native PTY, browser E2E).
- [ ] Installer checks pass on Windows, macOS, and Ubuntu for the same candidate SHA.
- [ ] Desktop packaging passes for Windows, macOS, and Linux on the same candidate SHA.
- [ ] Public-site validation and repository metadata checks pass on the same candidate SHA.
- [ ] Clean-machine install, first-run, provider setup, basic task, update, and uninstall are manually verified on Windows, macOS, and Linux.
- [ ] Security review is refreshed against the candidate source and remaining limitations are visible.
- [ ] Desktop signing/provenance is implemented, or an explicit unsigned-distribution decision is documented for 1.0.
- [ ] Version, tag, release notes, checksums, updater metadata, assets, and GitHub prerelease/stable status agree.
- [ ] The 1.0.0 release is published only from the verified immutable candidate commit.

## 8. Release and maintenance policy

- Keep direct maintainer work on `main` for this repository's current owner-directed workflow. Do not create new branches as a convenience for automated maintenance.
- Do not rewrite or force-push release tags.
- Make focused commits with a clear purpose; avoid bundling unrelated runtime changes and documentation changes.
- Every behavior change needs regression coverage at the closest stable boundary.
- Any update to a public claim must be backed by an implementation, test, or explicit limitation.
- After runtime changes, run focused tests, `npm test`, and `npm run check`; run relevant platform workflows.
- Do not claim a check passed unless its result is tied to the exact commit being described.
- Keep the changelog split into the current candidate and future Unreleased changes.
- Treat research notes as non-normative: proposals are not shipped features or commitments.


A stable 1.0.0 publication is deliberately a separate maintainer action. Before dispatch, update `package.json` so `oasisRelease.channel` is `stable` (and the candidate state is cleared), add curated `docs/releases/v1.0.0.md` notes, and confirm all manual qualification gates. The workflow requires both `publish_release: true` and `confirm_stable_release: true`, checks that the package channel is `stable`, and waits for same-commit quality, site, and installer workflows. Normal pushes build/validate artifacts but do not publish a GitHub Release.

## 9. Source-of-truth order

1. Executed code and tests for actual behavior.
2. This plan for product scope, lifecycle, support status, known limits, and release gates.
3. [Architecture](ARCHITECTURE.md) for system boundaries and component relationships.
4. [Installation](INSTALL.md) and [User guide](USER_GUIDE.md) for operational instructions.
5. [Security policy](../SECURITY.md), [privacy notes](PRIVACY.md), and the dated [security/reliability audit](SECURITY_RELIABILITY_AUDIT.md) for trust boundaries and evidence.
6. [Research archive](research/README.md) for non-normative analysis and future proposals.
