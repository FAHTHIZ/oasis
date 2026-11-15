# OASIS engineering scorecard

**Review snapshot:** 2026-11-14 (first snapshot 2026-11-07, baseline 5ebb6d97)  
**Baseline commit:** e783eecb  
**Scope:** repository and release-readiness evidence; not a security certification or a competitor ranking.

This scorecard keeps product presentation, engineering discipline and measured runtime quality separate. Each rating describes the strength of available evidence at the snapshot; it is not a percentage and does not imply the software is finished.

## Status definitions

- **Established:** the workflow or policy exists and has relevant automated checks or inspectable evidence.
- **Partial:** a meaningful implementation exists, but an important environment, release, usability or measurement gate remains.
- **Open:** there is no sufficient evidence to call the requirement complete.
- **Not measured:** no controlled result is available; do not infer success from code volume, features or a demo.

## Current scorecard

| Area | Status | Evidence at this snapshot | Exit condition |
|---|---|---|---|
| Public product identity | Established | Brand guide, maintained marks, repository hero and consistent OASIS naming | Keep site, README, app and release artwork aligned |
| Public marketing website | Retired | The Pages-based marketing site and deployment workflow are removed. The local browser workspace remains a supported product interface. | No public marketing site is planned; keep browser-workspace onboarding in the repository docs. |
| First-run onboarding | Partial | Provider setup, CLI doctor/connect flow, web sign-in with Remember this device, browser e2e on desktop and phone widths | Run repeatable first-run checks on clean macOS, Windows and Linux hosts |
| Runtime architecture | Partial | Architecture map, provider request/stream adapters, tool-schema validation and ordered tool-batch scheduling are independently testable | Continue staged decomposition with characterization tests for retries, cancellation, metadata and recovery |
| Security boundaries | Established / Partial | Security policy, permission checks, protected paths and platform regression tests | Keep active-sandbox state explicit; expand independent threat review and platform-specific evidence |
| Automated test discipline | Established / Partial | Large Node test suite, cross-platform regression jobs, clean-environment tests, Docker sandbox and browser checks | Maintain green same-commit CI and document skipped tests and platform limitations |
| Release engineering | Partial | v1.1.1, v1.2.0 and v1.3.0 are published on GitHub with installers for Linux (deb and AppImage, x64 and arm64), macOS (dmg, x64 and arm64) and Windows (exe, x64 and arm64), the npm tarball and `SHA256SUMS`. On 2026-11-14 the tarball and amd64 deb matched `SHA256SUMS`, and the tarball installed into a clean prefix and ran `oasis --version` and `oasis doctor` on Linux | Code signing (macOS builds are ad hoc signed, Windows builds unsigned; needs the owner's certificates) and install/upgrade checks on clean macOS and Windows machines |
| Connected workspace delivery | Partial | Browser UI is served by the host runtime with access key, host allow-list, lockout and HTTPS-only provider setup; reloads reattach to running tasks | Server-side chat history shared across devices; SSE instead of polling |
| Benchmarks | Partial | Deterministic harness and token checks run in CI. Same-model live runs on free endpoints through a recording gateway (`bench/results/live-2026-11-14-*`): one trial per task on up to three tasks, with endpoint mismatches and harness flaws reported as such, not as scores | Repeated trials on a larger task set, with Claude Code, Codex CLI and Gemini CLI on an endpoint that speaks their protocol, and at least one stronger model |
| Contributor experience | Partial | Contribution/security/support policies and issue templates exist | Keep PR checklist concise; validate a first-time contributor path on a clean machine |
| Observability and operations | Partial | Usage metadata, diagnostics, sessions and command logs exist | Document operational signals, retention, error reporting and support expectations |
| Documentation quality | Established / Partial | README, documentation index, architecture/configuration/interface guides and replacement studies | Keep all setup, release and UI statements tied to current behavior |

## Non-negotiable release gates

A release should not be called ready until the same source commit has:

1. Passed the required quality workflow on supported Node versions.
2. Passed cross-platform security/runtime regressions and the browser end-to-end smoke test, with every skipped job explained.
3. Produced installers for the platforms named in the release notes.
4. Produced SHA-256 checksums for every downloadable asset and verified them after upload.
5. Passed install, launch, upgrade and uninstall smoke checks on clean environments.
6. Published notes that identify the tag, source commit, known limitations and supported platforms.
7. Updated the Homebrew cask and CLI formula from the verified release assets and checksum manifest.

A package version or Git tag alone is not a release. A successful packaging job or temporary CI artifact is not a public download.

## Competitive benchmark gates

Do not rank OASIS against Claude Code, Codex, OpenCode or another harness from feature counts or a single transcript. A defensible comparison must pin exact OASIS and peer commits, identical model and provider settings, the same prompts and repository states, equivalent tools and machine resources, independent verifiers, and multiple repetitions for nondeterministic tasks.

Report wall time, input/output tokens, cost, tool errors, intervention count and safety outcomes separately. Publish raw JSON/CSV and report the model's contribution separately from the harness. Include at least one local/mid-tier model and one stronger model when feasible. A harness cannot guarantee that a smaller model has the same reasoning capability as a frontier model.

## Review cadence

Revisit this scorecard after a meaningful runtime, interface, CI or release change. Update the baseline commit and dates. Mark an item established only when its exit condition has evidence; otherwise keep the limitation visible.

## Current priority order

1. Keep same-commit CI green (it broke on Node 24/26 on 2026-11-14 from a memory test's threshold; fixed in 972a7273).
2. Verify the web app over a real HTTPS tunnel from a phone.
3. Sign release builds once certificates are available, and verify install and upgrade on clean macOS and Windows machines.
4. Continue provider and agent lifecycle decomposition without destabilising existing interfaces.
5. Publish controlled, reproducible same-model harness comparisons.
