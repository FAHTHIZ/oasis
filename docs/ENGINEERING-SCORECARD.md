# OASIS engineering scorecard

**Review snapshot:** 2026-11-07  
**Baseline commit:** 84d802b8efa7c3474a10df7677e8d32bd9e59dfc  
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
| Public website | Partial | GitHub Pages publishes the product landing page and desktop download entry point | Deploy the root page and verify mobile/desktop rendering, connected-session guidance and release links |
| First-run onboarding | Partial | Provider setup, CLI doctor/connect flow, desktop onboarding and connected-session docs | Run repeatable first-run checks on clean desktop, Linux and a phone-sized browser |
| Runtime architecture | Partial | Architecture map, provider request/stream adapters and ordered tool-batch scheduler are independently testable | Continue staged decomposition with characterization tests for retries, cancellation, metadata and recovery |
| Security boundaries | Established / Partial | Security policy, permission checks, protected paths and platform regression tests | Keep active-sandbox state explicit; expand independent threat review and platform-specific evidence |
| Automated test discipline | Established / Partial | Large Node test suite, cross-platform regression jobs, clean-environment tests, Docker sandbox and browser checks | Maintain green same-commit CI and document skipped tests and platform limitations |
| Release engineering | Open | Desktop packaging workflow, explicit release gates and checksum generation exist; GitHub currently has no published release assets | Publish a reviewed release with platform artifacts, checksums, provenance and install/upgrade verification |
| Connected workspace delivery | Partial | Browser UI is served by the host runtime; Pages publishes documentation and product entry points only | Verify host connection, session authentication, workspace scope, mobile layout and browser-client isolation |
| Benchmarks | Partial | Deterministic harness/token checks and live-evaluation tooling exist | Publish repeated, same-model, same-task peer comparisons with raw data and independent verifiers |
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
7. Updated the public site to list only assets attached to that GitHub Release.

A package version or Git tag alone is not a release. A successful packaging job or temporary CI artifact is not a public download.

## Competitive benchmark gates

Do not rank OASIS against Claude Code, Codex, OpenCode or another harness from feature counts or a single transcript. A defensible comparison must pin exact OASIS and peer commits, identical model and provider settings, the same prompts and repository states, equivalent tools and machine resources, independent verifiers, and multiple repetitions for nondeterministic tasks.

Report wall time, input/output tokens, cost, tool errors, intervention count and safety outcomes separately. Publish raw JSON/CSV and report the model's contribution separately from the harness. Include at least one local/mid-tier model and one stronger model when feasible. A harness cannot guarantee that a smaller model has the same reasoning capability as a frontier model.

## Review cadence

Revisit this scorecard after a meaningful runtime, site, CI or release change. Update the baseline commit and dates. Mark an item established only when its exit condition has evidence; otherwise keep the limitation visible.

## Current priority order

1. Restore a fully green same-commit CI baseline.
2. Deploy and test the public product site, desktop downloads and host-connected browser session as distinct surfaces.
3. Create a verifiable public desktop release, only after the manual release gates pass.
4. Continue provider and agent lifecycle decomposition without destabilising existing interfaces.
5. Publish controlled, reproducible same-model harness comparisons.
