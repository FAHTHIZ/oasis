# OASIS capability and release gates

**Updated:** 2026-10-29  
**Purpose:** Turn the goal of a highly capable coding agent into measurable, OASIS-owned engineering work. This document describes OASIS requirements and acceptance criteria, not feature-count parity claims.

## Operating rule

A capability is complete only when its behavior is implemented, covered by automated tests where feasible, and verified on the supported environments. A UI control, manifest adapter, unit test count, successful package build, or model-provider connection alone is not proof of end-to-end readiness.

Work directly on `main` in small, reviewable commits. Update this document and the implementation status as evidence changes. Never claim a green release gate from an older commit.

## Gate 0 — Current-main integrity

- [ ] Quality Checks passes on the current `main` commit.
- [ ] Homepage/repository validation passes on the same commit.
- [ ] Windows/macOS/Linux packaging passes on the same commit.
- [ ] Focused tests for the latest fixes pass independently.
- [ ] Required workflows exercise the same intended validation commands without masking failures or relying on retry-only suppression.
- [ ] Documentation identifies the exact commit for any historical evidence and distinguishes it from current results.

**Acceptance:** link each required workflow to the same commit SHA and record any unsupported platform path explicitly.

## Gate 1 — Reliable coding loop

- [ ] Test repository exploration, planning, multi-file edits, command execution, failure diagnosis, correction, and final verification end to end.
- [ ] Verify that approval, denial, interruption, cancellation, and tool errors result in correct, visible terminal states.
- [ ] Ensure command timeouts and cancellation stop child processes and close inherited pipes on each supported OS.
- [ ] Preserve unrelated changes; detect dirty-worktree conflicts and stale file snapshots before overwriting user work.
- [ ] Make verification evidence visible: commands run, exit codes, relevant test results, changed paths, and known failures.
- [ ] Keep final summaries grounded in tool output; never report tests or edits as successful unless observed.

**Acceptance:** deterministic fixture repositories cover success and failure paths, with regression tests for every discovered defect.

## Gate 2 — Representative coding evaluation

The existing 21 fixtures are a utility-focused smoke suite, not a representative coding-quality score. Expand the maintained suite to at least 30 tasks across pinned repository snapshots, including:

- [ ] Repository navigation and source-grounded questions.
- [ ] Multi-file feature implementation and refactoring.
- [ ] Bug fixes with regression tests and explicit acceptance criteria.
- [ ] Test/debug loops involving an initial failed attempt.
- [ ] Safe handling of permissions, denied tools, cancellation, and recovery.
- [ ] Long-context tasks that require preserving constraints and earlier decisions.
- [ ] Tasks that must leave unrelated files and behavior unchanged.

Every task must include a pinned base snapshot, prompt, allowed tools, budget/time cap, deterministic verifier, and reference patch or equivalent expected behavior. Run stochastic tasks repeatedly and retain raw results, including failures. Report acceptance-test pass rate, regressions, instruction compliance, reviewed diff quality, elapsed time, and token/cost estimates.

**Acceptance:** publish reproducible task-level results and methodology. Do not infer comparative performance from fixture count or a single run.

## Gate 3 — Durable, observable agent work

- [ ] Persist task identity, state transitions, events, worker, workspace/branch, approvals, verification results, and failure reason.
- [ ] Recover interrupted work after restart without relabeling unfinished work as completed.
- [ ] Make pause, resume, cancellation, and shutdown idempotent and observable.
- [ ] Keep parallel workers isolated from the user's checkout and one another.
- [ ] Present diffs and test evidence before integration; never auto-merge unreviewed agent work.
- [ ] Bound task history, event payloads, file previews, and retained artifacts; redact secrets before persistence or display.
- [ ] Make concurrency limits, task leases, timeouts, and cleanup behavior explicit.

**Acceptance:** restart and cancellation tests prove that state is accurate, partial changes remain reviewable, and no orphan workers remain.

## Gate 4 — Trust and platform support

- [ ] Replace secret transport through subprocess arguments and verify platform-native credential-store behavior.
- [ ] Verify Windows fallback-file ACLs and process-tree cleanup.
- [ ] Publish a platform support matrix for native PTY, sandboxing, browser workspace, and desktop packaging.
- [ ] Keep OS isolation separate from application permission prompts; document which controls are enabled by default.
- [ ] Verify authenticated browser access, origin/host checks, HTTPS setup, and absence of tokens in URLs/logs/artifacts.
- [ ] Treat MCP servers, hooks, and enabled third-party executables as trusted code and make their permissions clear.
- [ ] Label desktop artifacts unsigned until signing and provenance verification are configured.

**Acceptance:** security claims map to source controls and repeatable tests; unsupported cases are explicitly labelled rather than inferred from Linux CI.

## Gate 5 — Release confidence

- [ ] Verify first launch, provider setup, a small edit-and-test task, update, and uninstall on each claimed supported OS.
- [ ] Keep install instructions and troubleshooting aligned with actual package contents.
- [ ] Publish a concise changelog, known limitations, supported-platform matrix, and artifact verification instructions.
- [ ] Retain a rollback path and avoid presenting experimental remote execution as a managed hosted service.
- [ ] Re-run all required workflows after the final code and documentation changes.

**Release decision:** OASIS is ready for a release only when the applicable gates above have current evidence. This is a living checklist; passing one gate does not imply that all other gates or competitive coding outcomes are complete.
