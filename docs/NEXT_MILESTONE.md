# Next milestone: Alpha confidence and end-to-end reliability

**Status checked:** October 29, 2026  
**Code baseline before this documentation update:** [`268862c783ed27e697c1dd540690d1548ea8cd77`](https://github.com/FAHTHIZ/oasis/commit/268862c783ed27e697c1dd540690d1548ea8cd77)  
**Purpose:** decide what OASIS should ship next based on the current implementation and the documented Claude Code capability set.

## Decision

The next biggest milestone is **not another large feature**. It is to make OASIS a dependable, testable Alpha: the supported install paths should work, critical user journeys should be repeatable, all required CI workflows should agree, and the project should measure real coding outcomes instead of inferring quality from its feature list.

OASIS already has a substantial coding-agent loop, broad provider choice, MCP, hooks, skills, Claude-format plugins, subagents, a dependency-aware team task board, a CLI, a local browser workspace, a VS Code-family extension, a GitHub Action, and a PTY/xterm path. More feature work will have diminishing value until we can prove those pieces work together reliably for a normal user.

## Why this is the next milestone

For comparator revision `268862c`, [Quality Checks](https://github.com/FAHTHIZ/oasis/actions/runs/40807290624) and [homepage/repository validation](https://github.com/FAHTHIZ/oasis/actions/runs/40807290592) passed. The desktop build matrix for this revision is [run 40807290603](https://github.com/FAHTHIZ/oasis/actions/runs/40807290603); its final Windows result should be checked before marking the all-workflow gate complete. The next step remains measured coding outcomes and end-to-end reliability, not another large feature.

| Check | Latest available evidence | Interpretation |
| --- | --- | --- |
| Current Quality Checks | [Run 40807290624](https://github.com/FAHTHIZ/oasis/actions/runs/40807290624) passed: 573 tests, Node 22/24/26, 21 validated fixtures, Linux PTY smoke and Linux Chromium browser smoke | The comparator code revision passed the automated quality matrix. |
| Current desktop build | The prior complete matrix [run 40804769799](https://github.com/FAHTHIZ/oasis/actions/runs/40804769799) passed on Windows, macOS and Linux. The comparator revision is being rechecked in [run 40807290603](https://github.com/FAHTHIZ/oasis/actions/runs/40807290603). | Do not treat prior-baseline packaging as proof that the current revision's full matrix passed; installers remain unsigned and first-run/update/uninstall behavior is not fully validated. |
| Current publishing validation | [Run 40807290592](https://github.com/FAHTHIZ/oasis/actions/runs/40807290592) passed | The repository/public-site checks passed on comparator code revision `268862c`. |




Verified main-branch hardening now also includes OAuth DNS pinning, stricter plugin archive SSRF/redirect validation, ZIP traversal/collision/header protections, API-key helper cache isolation and timeout cleanup. See [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md).

## Prioritized worklist

### P0 — Make the default-branch quality signal trustworthy

- [x] Change the `FileChanged` test to wait for hook-message delivery using the existing bounded `waitFor` helper; the full current test matrix passes with the assertion synchronized to the hook response.
- [x] Added process-tree termination to command, package-install, external-skill install and hook timeout/cancellation paths, plus a regression test for a descendant that inherits output pipes. Cross-platform process behavior still requires verification.
- [x] Added regression cases for additional reserved/documentation IPv4 and IPv6 addresses to the public URL-fetch guard.
- [ ] Repeat focused hook and process-tree tests independently, then keep all required workflows passing on the same commit as code changes continue.
- [ ] Keep the workflows' validation commands aligned where they are intended to cover the same checks. A passing workflow must not mask a failing duplicate gate.
- [x] Acceptance: Quality Checks, homepage/repository validation, and the desktop build matrix passed for one code commit. Continue repeated focused runs as additional reliability evidence.

### P1 — Align documentation with the shipped implementation

- [x] Corrected the stale TLS claim in `SECURITY.md`: the web runtime supports HTTPS when given a certificate and private key; non-loopback plaintext requires an explicit `--allow-insecure-lan` opt-in. Clearly state the remaining certificate-provisioning and real-device validation limitations.
- [x] The user guide describes the browser xterm.js/PTY path and keeps cross-platform lifecycle limitations explicit.
- [x] Updated the implementation baseline, current CI evidence and priority order in the status, roadmap and Claude Code comparison docs. See [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md) for findings and residual risk.
- [ ] Acceptance: no documented feature is described as both shipped and unsupported in different sections; platform limitations are explicit.

### P2 — Prove coding ability with a reproducible benchmark

- [x] Added `oasis eval --compare <run-a.json> <run-b.json>` to compare repeated-trial reports over common task IDs, including task-balanced pass rates, median per-task time, mean cost per trial, and unmatched-task lists. External reports must be normalized; the command does not run Claude Code or validate external results.

The 21 existing fixtures are a useful starter suite, not a serious competitive score. Expand the harness to **at least 25–30 representative tasks** across multiple repository snapshots:

- Bug fixes with regression tests.
- Multi-file features and refactors.
- Existing-codebase questions that require code navigation.
- Test/debug loops and failures that require recovery.
- Tool/permission-denial and cancellation/resume paths.
- Long-context tasks where compaction and memory matter.

For the OASIS-vs-Claude Code comparison:

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

## Current comparison with Claude Code

| Capability area | OASIS today | Practical gap |
| --- | --- | --- |
| Local coding loop and provider choice | Multi-step tool calling, file changes, approvals, checkpoints, Git/testing tools, SDK/headless modes, hosted and local provider options | Feature presence does not establish equal coding quality, latency, or reliability. |
| Extensions | MCP, hooks, skills, CLI workflows and a broad Claude Code plugin-format compatibility layer | Compatibility remains feature-by-feature; arbitrary third-party plugins and managed enterprise policies are not assumed equivalent. |
| Agents | Subagents, task claims/dependencies, peer messages, named per-session teams, worktree-isolated bounded dispatch and activity events | No equivalent polished visual agent monitor, persistent scheduler, or cross-session team lifecycle. |
| IDEs | VS Code-family integration (including Cursor/Windsurf support), selection context, reviewable diffs and chat panel | JetBrains is still a gap; Marketplace distribution and cross-version testing remain. |
| Browser and terminal | Local browser workspace with approvals and a bundled xterm.js renderer; CLI PTY manager | Linux/Node 22 PTY integration is verified; broader OS lifecycle and browser PTY E2E are not yet proved. |
| Remote and managed surfaces | Local-first browser, desktop packaging path, GitHub Action and Chrome browser tool | No equivalent complete Remote Control/cloud/mobile workflow, and desktop installers are currently unsigned. |
| Safety | Workspace checks, approvals, secrets filtering, optional Linux/macOS sandbox and configurable TLS for non-loopback web access | No Windows sandbox; sandbox is off by default; TLS does not replace trusted-device/session security or real-device verification. |
| Evaluation | 573 passing tests, 21 validated smoke fixtures, and new `oasis eval --compare` tooling | The comparison tool exists, but no apples-to-apples OASIS-vs-Claude Code task benchmark has been run or published. |

Claude Code's documented surface includes subagents, Agent View, agent teams, dynamic workflows, MCP, hooks, skills, plugins/marketplaces, IDEs, Remote Control, web/desktop/mobile entry points, Chrome, and CI/code-review workflows. Agent teams are documented as experimental; OASIS should compare feature behavior, limitations and measured outcomes—not market feature names as parity. Official references: [parallel agents and workflows](https://code.claude.com/docs/en/agents), [extension overview](https://code.claude.com/docs/en/features-overview), [Remote Control](https://code.claude.com/docs/en/remote-control), [best practices](https://code.claude.com/docs/en/best-practices), and [Claude Code power-user tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips).

## Definition of done for the Alpha-confidence milestone

- [ ] Quality Checks, homepage/repository validation, and desktop build workflows pass on the same final code commit.
- [ ] The previously failing hook test passes repeatedly without fixed-delay masking or retry-only suppression.
- [ ] Installation and first-run steps are tested on every OS claimed as supported; unsupported/experimental paths are labelled.
- [ ] Core CLI and browser journeys have end-to-end tests for success, approval/denial, cancellation, recovery and verification.
- [ ] Documentation and security claims match the code and latest CI evidence.
- [ ] A reproducible representative-task benchmark exists, with results and limitations published.
- [ ] The release notes clearly state unsigned-installer status, sandbox defaults, provider requirements, and remaining platform limits.

**Release rule:** until the gate above is met, work should favor fixing reliability, testability and truthful documentation over adding parity features. This is a prioritization decision, not a claim that OASIS is unusable today.
