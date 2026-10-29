# Next milestone: Alpha confidence and end-to-end reliability

**Status checked:** October 29, 2026  
**Code snapshot audited before the latest main changes:** [`92798f0b5e0c636fd9702b3251759d14d74a03ca`](https://github.com/FAHTHIZ/oasis/commit/92798f0b5e0c636fd9702b3251759d14d74a03ca)  
**Latest fully verified code baseline:** [`5a537564a9817cf879afa636f8517825866c74f3`](https://github.com/FAHTHIZ/oasis/commit/5a537564a9817cf879afa636f8517825866c74f3), [Quality Checks run 40818083171](https://github.com/FAHTHIZ/oasis/actions/runs/40818083171): 594 tests, 22 fixtures, Node 22/24/26, Linux PTY and browser E2E passed. [Homepage/repository validation run 40818083169](https://github.com/FAHTHIZ/oasis/actions/runs/40818083169) passed on the same code commit.  
**Purpose:** prioritize OASIS-owned reliability, coding quality, safety, and release readiness based on what is implemented and verifiable.

## Decision

The next biggest milestone is **not another large feature**. It is to make OASIS a dependable, testable Alpha: the supported install paths should work, critical user journeys should be repeatable, all required CI workflows should agree, and the project should measure real coding outcomes instead of inferring quality from its feature list.

OASIS already has a substantial coding-agent loop, broad provider choice, MCP, hooks, skills, external ecosystem plugin formats, subagents, a dependency-aware team task board, a CLI, a local browser workspace, a VS Code-family extension, a GitHub Action, and a PTY/xterm path. More feature work will have diminishing value until we can prove those pieces work together reliably for a normal user.

## Why this is the next milestone

The isolated-worktree, durable task-history, public-fetch and federated-search/query-planning changes are included in code commit `5a53756`, whose [Quality Checks run 40818083171](https://github.com/FAHTHIZ/oasis/actions/runs/40818083171) passed 594 tests, 22/22 fixtures, the Node 22/24/26 matrix, PTY and browser E2E. [Homepage/repository validation run 40818083169](https://github.com/FAHTHIZ/oasis/actions/runs/40818083169) passed on the same code commit. Keep remaining priorities focused on measurable coding outcomes and end-to-end reliability, not feature count.

| Check | Latest available evidence | Interpretation |
| --- | --- | --- |
| Latest verified code Quality Checks | [Run 40818083171](https://github.com/FAHTHIZ/oasis/actions/runs/40818083171) passed: 594 tests, Node 22/24/26, 22 validated fixtures, Linux PTY smoke and browser E2E | Includes isolated worktrees, durable task history and current search/query-planning code. |
| Current desktop build | [Run 40807290603](https://github.com/FAHTHIZ/oasis/actions/runs/40807290603) passed on Windows, macOS and Linux for comparator code revision `268862c`. | Platform packaging passed; installers remain unsigned and first-run/update/uninstall behavior is not fully validated. |
| Current publishing validation | [Run 40807290592](https://github.com/FAHTHIZ/oasis/actions/runs/40807290592) passed | The repository/public-site checks passed on comparator code revision `268862c`. |




Verified main-branch hardening now also includes OAuth DNS pinning, stricter plugin archive SSRF/redirect validation, ZIP traversal/collision/header protections, API-key helper cache isolation and timeout cleanup. See [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md).

## Prioritized worklist

### P0 — Make the default-branch quality signal trustworthy

- [ ] Verify the newly committed provider-setup regression fix on current `main`: fresh setup must still default to OmniRoute, while re-opening setup must preserve the configured known provider or select `custom` for an unrecognized endpoint. The test has been added; do not mark this complete until current-main CI passes.
- [x] Change the `FileChanged` test to wait for hook-message delivery using the existing bounded `waitFor` helper; the full current test matrix passes with the assertion synchronized to the hook response.
- [x] Added process-tree termination to command, package-install, external-skill install and hook timeout/cancellation paths, plus a regression test for a descendant that inherits output pipes. Cross-platform process behavior still requires verification.
- [x] Added regression cases for additional reserved/documentation IPv4 and IPv6 addresses to the public URL-fetch guard.
- [ ] Repeat focused hook and process-tree tests independently, then keep all required workflows passing on the same commit as code changes continue.
- [ ] Keep the workflows' validation commands aligned where they are intended to cover the same checks. A passing workflow must not mask a failing duplicate gate.
- [x] Acceptance: Quality Checks, homepage/repository validation, and the desktop build matrix passed for one code commit. Continue repeated focused runs as additional reliability evidence.

### P1 — Align documentation with the shipped implementation

- [x] Corrected the stale TLS claim in `SECURITY.md`: the web runtime supports HTTPS when given a certificate and private key; non-loopback plaintext requires an explicit `--allow-insecure-lan` opt-in. Clearly state the remaining certificate-provisioning and real-device validation limitations.
- [x] The user guide describes the browser xterm.js/PTY path and keeps cross-platform lifecycle limitations explicit.
- [x] Updated the implementation baseline, current CI evidence and priority order in the status, roadmap and compatible ecosystem comparison docs. See [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md) for findings and residual risk.
- [ ] Acceptance: no documented feature is described as both shipped and unsupported in different sections; platform limitations are explicit.

### P2 — Prove coding ability with a reproducible benchmark

- [x] Added `oasis eval --compare <run-a.json> <run-b.json>` to compare repeated-trial reports over common task IDs, including task-balanced pass rates, median per-task time, mean cost per trial, and unmatched-task lists. External reports must be normalized; the command does not run compatible ecosystem or validate external results.

The 22 existing fixtures are a useful starter suite, not a serious competitive score. Expand the harness to **at least 25–30 representative tasks** across multiple repository snapshots:

- Bug fixes with regression tests.
- Multi-file features and refactors.
- Existing-codebase questions that require code navigation.
- Test/debug loops and failures that require recovery.
- Tool/permission-denial and cancellation/resume paths.
- Long-context tasks where compaction and memory matter.

For the controlled coding benchmark:

- Use the same task text, pinned repository snapshot, acceptance tests, allowed tools, permission policy, and budget/time cap.
- Use the same pinned model when both products support that exact model; otherwise document the model/provider difference and avoid attributing all differences to the harness.
- Run stochastic tasks multiple times and publish failures as well as successes. Record acceptance-test pass rate, regressions, instruction compliance, human-reviewed diff quality, elapsed time, and estimated cost/tokens.
- Keep the result reproducible: record versions, model identifiers, task revisions, commands, and raw result artifacts.
- Acceptance: publish a report with methodology and task-level outcomes—not an unsupported overall score or a claim of parity based on unit-test count.

### P3 — Close the product-level end-to-end gaps

- [ ] Add UI/runtime tests for approve, deny, interrupt, cancel, resume, dirty-worktree conflict, and failed-tool recovery.
- [ ] Exercise a real browser PTY round trip: launch a fixture process, stream output, send input, resize, interrupt/stop, and confirm there are no orphan processes.
- [ ] Verify trusted local HTTPS on real devices and ensure tokens/secrets never appear in browser logs, URLs, or workflow artifacts.
- [ ] Replace or mitigate the macOS Keychain CLI write path that currently places the secret in subprocess arguments, and verify Windows fallback-file ACLs. Keep this open until a non-argv secret transport/native API and platform tests are in place.
- [ ] Add supported-OS smoke tests for first launch, model setup, a small edit-and-test task, update, and uninstall. Windows/macOS desktop builds currently exist, but runtime success on those systems must be verified separately.
- [ ] Keep Android/Termux explicitly experimental for native PTY until its supported path is tested; do not imply that a Linux CI run proves phone compatibility.
- [ ] Document the signing status honestly. Until signing is configured, label installers as unsigned and explain how to verify that downloads came from the official repository.

### P4 — Then pursue the next competitive differentiator

After the Alpha gate is green, prioritize **persistent, observable multi-agent work across sessions**:

1. A visual agent/run monitor with clear task, worker, branch, approval, cost and failure status.
2. Recoverable orchestration: pause/resume after restart, durable task history, cancellation propagation and idempotent recovery.
3. Cross-session messaging and deliberate integration of worktree branches, with conflict previews and explicit human approval. Do not auto-merge by default.
4. Only then, remote/mobile control with a security model for identity, trusted devices, workspace isolation, reconnects and audit logs.

This is the highest-leverage next feature area because OASIS already has subagents, task leases, named teams, activity events and bounded dispatch. The missing value is a reliable, observable lifecycle—not simply spawning more agents.

## Product readiness scorecard

| Area | Current state | Acceptance gate |
| --- | --- | --- |
| Coding outcomes | The 22-task evaluation suite is a small helper-focused smoke suite; it does not measure repository-scale quality. | Expand to 30+ maintained tasks with pinned workspaces, deterministic acceptance checks, repeated runs, recorded failures, time, cost, and regression review. |
| Agent lifecycle | Subagents, task leases, peer messaging, session-local teams and worktree-isolated dispatch exist. | Add a durable run ledger, visible task/worker state, reliable pause/resume/cancel, recovery after restart and conflict-aware integration. |
| Safety | Workspace/path checks, approvals, secret filtering and optional Linux/macOS sandboxing exist. Windows OS isolation is not implemented. | Reduce secret exposure, validate platform storage/ACL behavior, and ship an explicit per-platform isolation support matrix. |
| Browser / PTY | Local authenticated browser workspace and a PTY-backed terminal path exist. | Verify full launch, input, resize, stream, cancellation, teardown and no-orphan-process behavior on supported platforms. |
| Distribution | Desktop build workflows exist; installers remain unsigned. | Validate first launch, update and uninstall on each supported OS, configure signing, and document release provenance. |
| Integrations | OASIS supports model providers, MCP, skills, hooks, plugin adapters and editor integration. | Test high-value integrations against pinned fixtures and publish concrete limitations; do not treat manifest compatibility as universal behavior parity. |

**Release rule:** ship only claims that have a repeatable verification path. Keep unsupported platform behavior explicitly marked, and prefer reliability and trust over adding another option to the feature list.

## Definition of done for the Alpha-confidence milestone

- [x] Quality Checks, homepage/repository validation, and desktop build workflows passed on comparator code revision `268862c`.
- [ ] The previously failing hook test passes repeatedly without fixed-delay masking or retry-only suppression.
- [ ] Installation and first-run steps are tested on every OS claimed as supported; unsupported/experimental paths are labelled.
- [ ] Core CLI and browser journeys have end-to-end tests for success, approval/denial, cancellation, recovery and verification.
- [ ] Documentation and security claims match the code and latest CI evidence.
- [ ] A reproducible representative-task benchmark exists, with results and limitations published.
- [ ] The release notes clearly state unsigned-installer status, sandbox defaults, provider requirements, and remaining platform limits.

**Release rule:** until the gate above is met, work should favor fixing reliability, testability and truthful documentation over adding parity features. This is a prioritization decision, not a claim that OASIS is unusable today.
