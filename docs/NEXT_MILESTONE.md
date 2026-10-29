# Next milestone: Beta confidence and end-to-end reliability

**Status checked:** October 29, 2026  
**Latest verified implementation revision before this documentation refresh:** [0002f84a534cd1498b83b5e78fede53922aca7e5](https://github.com/FAHTHIZ/oasis/commit/0002f84a534cd1498b83b5e78fede53922aca7e5)  
**Quality Checks:** [run 40870856114](https://github.com/FAHTHIZ/oasis/actions/runs/40870856114) passed 685 Node tests on Node 22/24/26, clean-environment tests, 33 evaluation fixtures, Linux PTY, browser E2E and cross-platform security regressions. [Publishing validation run 40870856141](https://github.com/FAHTHIZ/oasis/actions/runs/40870856141) passed on that SHA. The desktop build workflow was still running when reviewed; unsigned installers and actual clean-machine install/update/uninstall validation remain open.

**Purpose:** prioritize OASIS-owned reliability, coding quality, safety, and release readiness based on what is implemented and verifiable.

## Decision

The next biggest milestone is **not another large feature**. It is to make OASIS a dependable, testable Beta: the supported install paths should work, critical user journeys should be repeatable, all required CI workflows should agree, and the project should measure real coding outcomes instead of inferring quality from its feature list.

OASIS already has a substantial coding-agent loop, broad provider choice, MCP, hooks, skills, external ecosystem plugin formats, subagents, a dependency-aware team task board, a CLI, a local browser workspace, a VS Code-family extension, a GitHub Action, and a PTY/xterm path. More feature work will have diminishing value until we can prove those pieces work together reliably for a normal user.

## Why this is the next milestone

Earlier isolated-worktree, durable task-history, public-fetch and federated-search/query-planning work is present in the current code. The latest verified revision, 0002f84, passed 685 tests, validated 33/33 fixtures on Node 22/24/26, and passed clean-environment, Linux PTY, browser E2E, publishing validation and cross-platform security checks. The desktop packaging workflow was still running, so release readiness is not fully closed. Keep remaining priorities focused on measurable OASIS user outcomes and end-to-end reliability, not feature count.

| Check | Latest available evidence | Interpretation |
| --- | --- | --- |
| Last fully verified Quality Checks baseline | [Run 40870856114](https://github.com/FAHTHIZ/oasis/actions/runs/40870856114) passed: 685 tests, Node 22/24/26, clean environment, 33 validated fixtures, Linux PTY, browser E2E and cross-platform security regressions | [Publishing validation run 40870856141](https://github.com/FAHTHIZ/oasis/actions/runs/40870856141) passed on the same 0002f84 revision. The desktop build was still running when checked; installers remain unsigned. |
| Current desktop build | [Run 40807290603](https://github.com/FAHTHIZ/oasis/actions/runs/40807290603) passed on Windows, macOS and Linux for comparator code revision `268862c`. | Platform packaging passed; installers remain unsigned and first-run/update/uninstall behavior is not fully validated. |
| Current publishing validation | [Run 40807290592](https://github.com/FAHTHIZ/oasis/actions/runs/40807290592) passed | The repository/public-site checks passed on comparator code revision `268862c`. |




Verified main-branch hardening now also includes OAuth DNS pinning, stricter plugin archive SSRF/redirect validation, ZIP traversal/collision/header protections, API-key helper cache isolation and timeout cleanup. See [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md).


### Security-hardening follow-up (CI-verified; platform validation remains open)

- [x] Centralize public-address validation across public fetch, plugin archive downloads, MCP OAuth discovery and browser requests; add IPv6 special-purpose and NAT64-encoded private destination regression cases.
- [x] Remove plaintext Keychain secrets from macOS subprocess argv and isolate cloud-token caches by configured profile/project/tenant context.
- [x] Add optional Linux/macOS sandbox masks for detected credential paths, ensure the masks overlay broad writable mounts, and reject unsafe paths in generated Seatbelt profiles.
- [x] Add tests for option-prefixed npm/pnpm/yarn verbs and command-chain permission parsing.
- [x] Quality Checks and publishing validation passed together on 0002f84; see [Quality run 40870856114](https://github.com/FAHTHIZ/oasis/actions/runs/40870856114) and [publishing run 40870856141](https://github.com/FAHTHIZ/oasis/actions/runs/40870856141). Desktop packaging was still running when checked.
- [ ] Validate macOS sandbox enforcement and Keychain interactions on an actual macOS host; Windows still has no OS sandbox, and Windows file ACL behavior requires testing.

## Prioritized worklist

### P0 — Make the default-branch quality signal trustworthy

- [ ] Keep latest-run-only CI scheduling per ref to avoid an expensive queue of obsolete matrices; ensure publishing groups main and pull requests separately so a PR cannot cancel main. Per-SHA grouping was dropped because it grows runner demand during rapid pushes. Acceptance still requires current-main quality, publishing, and desktop checks to pass on one stable SHA.
- [ ] Verify the newly committed provider-setup regression fix on current `main`: fresh setup must still default to OmniRoute, while re-opening setup must preserve the configured known provider or select `custom` for an unrecognized endpoint. The test has been added; do not mark this complete until current-main CI passes.
- [x] Change the `FileChanged` test to wait for hook-message delivery using the existing bounded `waitFor` helper; the full current test matrix passes with the assertion synchronized to the hook response.
- [x] Added process-tree termination to command, package-install, external-skill install and hook timeout/cancellation paths, plus a regression test for a descendant that inherits output pipes. Cross-platform process behavior still requires verification.
- [x] Added regression cases for additional reserved/documentation IPv4 and IPv6 addresses to the public URL-fetch guard.
- [ ] Repeat focused hook and process-tree tests independently, then keep all required workflows passing on the same commit as code changes continue.
- [ ] Verify the HTTP MCP credential-helper stdout cap, timeout, overflow termination and in-flight shutdown tests on current-main CI.
- [ ] Verify isolated worktree Git timeout cleanup kills the command and descendant, while normal worktree creation/merge tests still pass on current-main CI.
- [ ] Keep the workflows' validation commands aligned where they are intended to cover the same checks. A passing workflow must not mask a failing duplicate gate.
- [x] Acceptance: Quality Checks, homepage/repository validation, and the desktop build matrix passed for one code commit. Continue repeated focused runs as additional reliability evidence.

### P1 — Align documentation with the shipped implementation

- [x] Corrected the stale TLS claim in `SECURITY.md`: the web runtime supports HTTPS when given a certificate and private key; non-loopback plaintext requires an explicit `--allow-insecure-lan` opt-in. Clearly state the remaining certificate-provisioning and real-device validation limitations.
- [x] The user guide describes the browser xterm.js/PTY path and keeps cross-platform lifecycle limitations explicit.
- [x] Updated the implementation baseline, current CI evidence and priority order in the status, roadmap and compatible ecosystem comparison docs. See [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md) for findings and residual risk.
- [ ] Acceptance: no documented feature is described as both shipped and unsupported in different sections; platform limitations are explicit.

### P2 — Prove coding ability with a reproducible benchmark

The benchmark is specifically about **core mechanics**, not ecosystem breadth. Follow the [Core mechanics audit](CORE_MECHANICS_AUDIT.md): evaluate repository understanding, action selection, edits, test/debug recovery, verification honesty, context continuity, and unintended changes on identical pinned tasks. Do not infer source-code provenance or parity from the shared agent-loop shape.

- [x] Added `oasis eval --compare <run-a.json> <run-b.json>` to compare repeated-trial reports over common task IDs, including task-balanced pass rates, median per-task time, mean cost per trial, and unmatched-task lists. External reports must be normalized; the command does not run compatible ecosystem or validate external results.

The 33 existing fixtures are a useful starter suite, not a serious competitive score. Expand the harness to **at least 50 representative tasks** across multiple repository snapshots:

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

- [x] Browser E2E now covers approval display, deny-once for a destructive file delete, stop/cancel while approval is pending, and confirms the file remains intact/no command side effect occurs.
- [ ] Add the remaining UI/runtime cases for resume, dirty-worktree conflict and failed-tool recovery.
- [ ] Exercise a real browser PTY round trip: launch a fixture process, stream output, send input, resize, interrupt/stop, and confirm there are no orphan processes.
- [ ] Verify trusted local HTTPS on real devices and ensure tokens/secrets never appear in browser logs, URLs, or workflow artifacts.
- [x] Replace the macOS Keychain plaintext-argv write path with `security -i` and hex-encoded stdin; unit tests verify the secret is absent from process argv. [ ] Validate that path against a real macOS Keychain and verify Windows fallback-file ACLs.
- [ ] Add supported-OS smoke tests for first launch, model setup, a small edit-and-test task, update, and uninstall. Windows/macOS desktop builds currently exist, but runtime success on those systems must be verified separately.
- [ ] Keep Android/Termux explicitly experimental for native PTY until its supported path is tested; do not imply that a Linux CI run proves phone compatibility.
- [ ] Document the signing status honestly. Until signing is configured, label installers as unsigned and explain how to verify that downloads came from the official repository.

### P4 — Close the multi-agent lifecycle gap

**Run monitor and saved-chat recovery are CI-verified on [`fef120a`](https://github.com/FAHTHIZ/oasis/commit/fef120a52af030249aae1ba1b1df2e0cf4054a81).** [Quality Checks run 40882893190](https://github.com/FAHTHIZ/oasis/actions/runs/40882893190) passed the Node 22/24/26 matrix, cross-platform security regressions, clean-environment tests, Linux PTY and browser E2E; [publishing validation run 40882893526](https://github.com/FAHTHIZ/oasis/actions/runs/40882893526) also passed. The authenticated Run monitor lists recent coding-agent runs, reconstructs worker/team state from lifecycle events, displays worktree/branch and available usage/approval metadata, explicitly marks worker processes and outstanding approvals interrupted after runtime restart, and can reopen the saved parent chat for completed/interrupted workspace-mode runs. It does not restore the worker processes or pending approvals.

The next steps are deliberately in order:

1. Persist orchestration state, not just the event trail: durable task dependencies, worker identities, claim leases and recovery state with explicit schema/versioning.
2. Add a safe restart/resume contract that reconstructs only recoverable work, propagates cancellation and requires human review when the original worker or approval state cannot be restored.
3. Add safe pause/resume and cancellation propagation, including honest interrupted states after restart. Never pretend a process that was killed by restart has resumed.
4. Add per-worker review, conflicting-diff previews and deliberate human-approved worktree integration. Do not auto-merge by default.
5. Only after the local lifecycle is reliable, revisit cross-device/remote control with identity, trusted-device enrollment, workspace isolation, reconnects and audit logs.

The monitor is a first deliverable, not a claim of full durable teams. The missing value remains a reliable, recoverable lifecycle—not simply spawning more agents.

## Product readiness scorecard

| Area | Current state | Acceptance gate |
| --- | --- | --- |
| Coding outcomes | The 33-task evaluation suite is a small helper-focused smoke suite; it does not measure repository-scale quality. | Expand to at least 50 maintained tasks with pinned workspaces, deterministic acceptance checks, repeated runs, recorded failures, time, cost, and regression review. |
| Agent lifecycle | Subagents, task leases, peer messaging, session-local teams and worktree-isolated dispatch exist. | Verify the current visual monitor first, then add durable orchestration state, safe pause/resume/cancel, restart recovery and conflict-aware integration. |
| Safety | Workspace/path checks, approvals, secret filtering and optional Linux/macOS sandboxing exist. Windows OS isolation is not implemented. | Reduce secret exposure, validate platform storage/ACL behavior, and ship an explicit per-platform isolation support matrix. |
| Browser / PTY | Local authenticated browser workspace and a PTY-backed terminal path exist. | Verify full launch, input, resize, stream, cancellation, teardown and no-orphan-process behavior on supported platforms. |
| Distribution | Desktop build workflows exist; installers remain unsigned. | Validate first launch, update and uninstall on each supported OS, configure signing, and document release provenance. |
| Integrations | OASIS supports model providers, MCP, skills, hooks, plugin adapters and editor integration. | Test high-value integrations against pinned fixtures and publish concrete limitations; do not treat manifest compatibility as universal behavior parity. |

**Release rule:** ship only claims that have a repeatable verification path. Keep unsupported platform behavior explicitly marked, and prefer reliability and trust over adding another option to the feature list.

## Definition of done for the Beta-confidence milestone

- [x] Quality Checks, homepage/repository validation, and desktop build workflows passed on comparator code revision `268862c`.
- [ ] The previously failing hook test passes repeatedly without fixed-delay masking or retry-only suppression.
- [ ] Installation and first-run steps are tested on every OS claimed as supported; unsupported/experimental paths are labelled.
- [ ] Core CLI and browser journeys have end-to-end tests for success, approval/denial, cancellation, recovery and verification.
- [ ] Documentation and security claims match the code and latest CI evidence.
- [ ] A reproducible representative-task benchmark exists, with results and limitations published.
- [ ] The release notes clearly state unsigned-installer status, sandbox defaults, provider requirements, and remaining platform limits.

**Release rule:** until the gate above is met, work should favor fixing reliability, testability and truthful documentation over adding parity features. This is a prioritization decision, not a claim that OASIS is unusable today.
