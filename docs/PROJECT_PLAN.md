# OASIS product and release-qualification plan

**Product lifecycle:** Stable  
**Package version:** `1.0.0`  
**Release channel:** stable (`v1.0.0` planned; not yet tagged or published as of November 4, 2026)  
**Release source:** `main`  
**Previous release:** `v0.4.0` (historical Beta; the tag and GitHub Release are no longer present in the repository)  
**License:** Apache-2.0

This document is the canonical statement of product scope, maturity, supported surfaces, known limits, and release gates. The root README is the concise public overview; the [architecture guide](ARCHITECTURE.md) describes the system; the [user guide](USER_GUIDE.md) describes how to operate it.

## Current verification snapshot

**Last fully verified commit before the release commit:** [`76d04f7`](https://github.com/FAHTHIZ/oasis/commit/76d04f7)  
**Inspection date:** November 1, 2026

| Workflow on this exact commit | Result |
|---|---|
| [Quality Checks](https://github.com/FAHTHIZ/oasis/actions/runs/41288176374) (Node 22/24/26; Windows/macOS/Linux security matrix; clean environment; native PTY; browser E2E with axe accessibility scans) | Success |
| [Installer checks](https://github.com/FAHTHIZ/oasis/actions/runs/41288176336) (Windows, macOS, Ubuntu) | Success |
| [Desktop packaging](https://github.com/FAHTHIZ/oasis/actions/runs/41288176364) (Windows, macOS, Linux) | Success |
| [Public site and repository metadata](https://github.com/FAHTHIZ/oasis/actions/runs/41288176333) | Success |

The release commit itself changes only release metadata and documentation. The publish job in `.github/workflows/desktop-build.yml` refuses to publish until Quality Checks, the public-site workflow and installer checks have all passed on that same commit, and it builds the installers and `SHA256SUMS` from it. Passing jobs from different commits are never combined into one claimed result.

## 1. Product position

OASIS is an open-source, local-first agentic development workspace. It connects a model selected by the user to a real project and coordinates codebase exploration, planning, file operations, controlled command execution, integrations, agent coordination, and verification.

OASIS is not a hosted model or a proprietary model endpoint. The user chooses the provider or local model; OASIS owns the local runtime, tool contracts, workspace access, execution policy, session state, interfaces, and verification reporting.

### Current maturity

The planned 1.0.0 product scope is feature-complete on `main` as **OASIS 1.0 (stable channel)**. The `v1.0.0` tag and GitHub Release are still to be created by the manual release job.

Work after 1.0 is refinement: stronger agents, better tool selection and task completion, robustness, lifecycle correctness, accessibility, platform consistency, security-boundary validation, operational recovery, and accurate packaging/documentation. The default priority is to improve and finish the existing product—not introduce substantial new product surfaces or expand scope.

"Stable" means the 1.0 gates below passed on the release commit and the public contracts (CLI flags, settings, tool names, SDK) will change only with notice. It does not certify security, uptime, or defect-free behavior, and the known limits in section 5 still apply.

## 2. Version and release channels

- `v0.4.0` was published as Beta; its [release notes](releases/v0.4.0.md) remain in the tree, but the tag and GitHub Release are no longer present in the repository (checked November 4, 2026). The only remaining tag is `0.6.7`.
- `package.json` is version `1.0.0` with `oasisRelease.channel` set to `stable`. The `v1.0.0` tag and GitHub Release are created by the desktop workflow (manual dispatch with `publish_release` and `confirm_stable_release`) from a verified `main` commit; the stable CLI installer then resolves `v1.0.0`. That run has not happened yet.
- Never move or retag `v0.4.0` or `v1.0.0`. Fixes after 1.0 ship as new versions (`1.0.1`, `1.1.0`, ...).

## 3. Product scope for 1.0

The intended 1.0 product is a unified runtime with multiple interfaces—not a collection of unrelated apps.

| Domain | Included capability |
|---|---|
| Agent orchestration | Multi-step model/tool loop, planning, repository exploration, tool orchestration, completion and failure reporting. |
| Workspace | File search/read/write/edit/delete, workspace checks, Git inspection, snapshots, diffs, and isolated worktree support. |
| Execution policy | Permission modes, approvals, command-risk analysis, protected paths/configuration, output bounds, process cleanup, and optional OS sandbox adapters. |
| Models and providers | Multiple provider protocols, compatible endpoints, local model services, provider setup, model routing, and cost estimation. |
| Context and memory | Sessions, project instructions, memory, context estimation, compaction, rewind, checkpoints, and saved task records. |
| Procedural learning (post-1.0 refinement) | Local proposals for reusable skills after verified work, separate user/project scope, explicit user promotion, and no automatic permission changes or model-weight updates. |
| Agent coordination | Bounded subagents, specialist reviews, task boards, dependency-aware dispatch, background records, and workflow automation. |
| Integrations | MCP, hooks, Agent Skills, plugins, extension import/export, search integrations, GitHub workflows, and editor bridges. |
| Code intelligence and verification | Diagnostics, language-server support where configured, project checks, automatic testing, weakened-test detection, diff review, and claim checks. |
| Developer surfaces | CLI, authenticated local browser workspace, Electron desktop shell, VS Code-family integration, SDK, and GitHub Action. |

Implementation presence does not mean every feature works identically across all providers, operating systems, editors, or third-party integrations. Use the support matrix below and the relevant subsystem tests.

## 4. Support and qualification matrix

| Surface / environment | Current status | Qualification boundary |
|---|---|---|
| CLI on Node.js 22+ | Primary workflow | Requires a compatible model/provider and the OS permissions required by chosen tools. |
| Local browser workspace | Available | Authenticated local runtime; some Projects/Tasks/Notes state remains separate from CLI state. Browser lifecycle and axe accessibility E2E run in Quality Checks on every commit. |
| Desktop Windows x64 | Installer built in CI from the release commit | Unsigned (SHA-256 checksums published). Install and packaging are checked on clean CI runners; no manual physical-machine journey. No native OASIS OS sandbox. |
| Desktop macOS arm64 | Installer built in CI from the release commit | Unsigned (SHA-256 checksums published). Install and packaging are checked on clean CI runners; no manual physical-machine journey. Optional sandbox integration is not full filesystem-read isolation. |
| Desktop Linux x86_64 | Installer built in CI from the release commit | Unsigned (SHA-256 checksums published). Install and packaging are checked on clean CI runners; no manual physical-machine journey. Optional sandbox integration is not full filesystem-read isolation. |
| VS Code-family integration | Implemented integration | Do not claim universal parity with every editor or extension marketplace. |
| SDK / GitHub Action | Implemented integration | Unattended execution must be deliberately scoped and isolated by the adopting repository/operator. |
| Android / Termux | Experimental use path | No native APK. PTY, background behavior, and real-device reliability are not fully qualified. |
| Remote access / phone pairing | Not in 1.0 scope | No shipped trusted-device enrollment or secure remote pairing service. |
| Tor/onion access | Not in 1.0 scope | Not a shipped capability. |
| Native Windows OS sandbox | Not implemented | Approval checks are not equivalent to OS isolation. The opt-in Docker/Podman container backend (`sandbox.backend`) works on Windows with Docker Desktop. |

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
- The 52-task evaluation harness (19 repository-level tasks) is a regression suite, not a representative repository-scale coding benchmark. No parity, speed, accuracy, or token-savings claims are justified by it.

These are explicit product boundaries. They should not be hidden by maturity wording or treated as completed merely because the corresponding functionality exists in some form.

## 6. 1.0 release gates and decisions

1. **Browser E2E lifecycle and fixture:** passes in Quality Checks, including completed-turn disclosure, failed-command warning, approval/denial, cancellation and side effects.
2. **Accessibility:** axe-core scans run against the real browser page in the E2E job; no findings are suppressed.
3. **Same-commit CI:** Quality Checks, installer checks, desktop packaging and public-site validation passed together on `76d04f7`, and the publish job re-requires them on the release commit.
4. **Clean-machine desktop journey — decision:** covered by CI on fresh GitHub-hosted Windows, macOS and Ubuntu runners (installer checks and desktop packaging). Manual first-launch, update and uninstall testing on physical machines was not done for 1.0. This is stated in the README, install guide and release notes.
5. **Security-boundary review:** refreshed on November 1, 2026 in the [security/reliability audit](SECURITY_RELIABILITY_AUDIT.md), including sandbox `/tmp` mounts, quoted tool-call recovery, unrequested git writes and eval credential isolation.
6. **Release integrity:** the publish job checks that the package version matches the tag, that `docs/releases/v1.0.0.md` exists, that the tag is new or already points at the same commit, and that `main` has not moved; it then publishes the installers with `SHA256SUMS`.
7. **Code signing — decision:** OASIS 1.0 installers are **not code-signed**. There is no Windows Authenticode or Apple Developer ID certificate for the project. Each release ships `SHA256SUMS`; checksums detect corruption and tampering in transit but are not publisher signatures, and Windows SmartScreen and macOS Gatekeeper will warn. Signing is a post-1.0 item.
8. **Documentation and public identity:** README, site, package metadata, install guide, security policy and release notes describe the same version and lifecycle.

### Post-1.0 options

Remote runner infrastructure, trusted-device pairing, more editor surfaces, a native Android app, wider sandbox isolation (including on by default), installer signing, and a larger real-world coding evaluation program.

## 7. Release acceptance checklist

- [x] Browser E2E passes on the release commit, including task completion, activity fold, approval/denial, cancellation and worktree review.
- [x] Accessibility checks show no unresolved release-blocking findings.
- [x] Quality Checks passes all jobs on the same commit (Node 22/24/26, Windows/macOS/Linux runtime/security matrix, clean environment, native PTY, browser E2E).
- [x] Installer checks pass on Windows, macOS and Ubuntu for the same commit.
- [x] Desktop packaging passes for Windows, macOS and Linux for the same commit.
- [x] Public-site validation and repository metadata checks pass for the same commit.
- [x] Clean-machine journey: decision recorded (CI runners only; no manual physical-machine testing for 1.0).
- [x] Security review refreshed against the release source; remaining limits are visible.
- [x] Explicit unsigned-distribution decision documented for 1.0, with SHA-256 checksums.
- [x] Version, tag, release notes, checksums, assets and stable status agree (enforced by the publish job).
- [x] 1.0.0 can be published only from a verified `main` commit (enforced by the publish job).
- [ ] The `v1.0.0` tag and GitHub Release are actually published.

## 8. Release and maintenance policy

- Keep direct maintainer work on `main` for this repository's current owner-directed workflow. Do not create new branches as a convenience for automated maintenance.
- Do not rewrite or force-push release tags.
- Make focused commits with a clear purpose; avoid bundling unrelated runtime changes and documentation changes.
- Every behavior change needs regression coverage at the closest stable boundary.
- Any update to a public claim must be backed by an implementation, test, or explicit limitation.
- After runtime changes, run focused tests, `npm test`, and `npm run check`; run relevant platform workflows.
- Do not claim a check passed unless its result is tied to the exact commit being described.
- Keep the changelog split into released versions and an Unreleased section.
- Treat research notes as non-normative: proposals are not shipped features or commitments.


Publishing is a separate maintainer action: dispatch `.github/workflows/desktop-build.yml` on `main` with `publish_release: true` and `confirm_stable_release: true`. The job checks that the package channel is `stable`, waits for same-commit quality, site and installer workflows, and publishes the release. Normal pushes build and validate artifacts but never publish.

## 9. Source-of-truth order

1. Executed code and tests for actual behavior.
2. This plan for product scope, lifecycle, support status, known limits, and release gates.
3. [Architecture](ARCHITECTURE.md) for system boundaries and component relationships.
4. [Installation](INSTALL.md) and [User guide](USER_GUIDE.md) for operational instructions.
5. [Security policy](../SECURITY.md), [privacy notes](PRIVACY.md), and the dated [security/reliability audit](SECURITY_RELIABILITY_AUDIT.md) for trust boundaries and evidence.
6. [Research archive](research/README.md) for non-normative analysis and future proposals.
