# OASIS product readiness and engineering priorities

**Audit date:** October 29, 2026  
**Purpose:** Maintain a truthful, product-owned plan for reliability, capability depth, safety and release quality.

OASIS is an independent open-source coding agent and local-first developer workspace. Its identity, roadmap, implementation and UX should stand on their own. Interoperability with documented protocols and configuration formats is an integration feature—not the product's identity. Keep adapters isolated, do not vendor proprietary implementation code, and do not infer complete behavior parity from a recognized file format or protocol.

## What is already in place

The project has a multi-step agent/tool loop; scoped workspace file operations; approvals; snapshots and rewind; Git and test tools; saved sessions; multiple hosted and local provider routes; MCP; skills and hooks; plugin adapters; subagents; a session-local task board; bounded worktree dispatch; persisted browser task history; opt-in isolated browser coding runs with a separate Git branch and reviewable diffs; a local authenticated browser workspace; a VS Code-family extension; a GitHub Action; and desktop packaging.

The latest completed Quality Checks and homepage/repository validation before the current hardening sequence passed on commit `e0591d6` ([Quality run 40828639606](https://github.com/FAHTHIZ/oasis/actions/runs/40828639606), [publishing run 40828639602](https://github.com/FAHTHIZ/oasis/actions/runs/40828639602)). The desktop build for that SHA was cancelled when later fixes were pushed. Follow-on changes include shared IPv4/IPv6/NAT64 checks, Keychain secret transport, cloud credential-context isolation, command-risk hardening, and optional sandbox credential masking. Do not treat the current `main` changes as fully verified until Quality Checks, publishing validation and desktop builds complete on one current SHA. These checks are regression evidence—not proof of production readiness or repository-scale coding quality. Live status: [Quality](https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml), [publishing](https://github.com/FAHTHIZ/oasis/actions/workflows/pages.yml), [desktop](https://github.com/FAHTHIZ/oasis/actions/workflows/desktop-build.yml).

## Biggest remaining gaps

Before release, use [the branch audit](BRANCH_AUDIT.md) to retire already-merged branch tips, selectively port the useful durable-task work instead of forcing its stale conflicted branch, and confirm that the provider setup fix passes on current `main`.

### P0 — Reliability and release confidence

- Keep all required workflows green on the same code revision. A failing or skipped platform check stays visible; do not hide it with retries that suppress assertions.
- Cover approve, deny, interrupt, cancel, resume, failed-tool recovery, dirty-worktree conflicts and browser terminal teardown in end-to-end tests.
- Test native PTY process lifecycle on each claimed platform. Linux-only success does not establish Windows, macOS, Android or Termux readiness.
- Verify the first-run, provider setup, editing, update and uninstall journeys on every OS advertised as supported.
- Publish installers only with clear provenance. Current desktop build artifacts are unsigned; do not imply publisher signing or verified auto-update behavior.

### P1 — Benchmark real coding work

The 33 current evaluation fixtures are useful regression tasks but remain small and heavily utility-focused. Expand the suite to at least 50 representative tasks across pinned repository snapshots:

- Multi-file bug fixes with regression tests and explicit acceptance criteria.
- Existing-codebase navigation and questions whose answers can be checked against source.
- Cross-module changes, refactors and test/debug loops.
- Interrupted, denied and recovered operations.
- Long-context tasks that exercise saved context, compaction and memory.
- Tests that require preserving unrelated behavior.

For each task, store the repository snapshot identifier, prompt, allowed tools, budget/time limit, reference patch, deterministic verifier and task-level result. Run stochastic tasks multiple times. Record pass rate, regressions, human-reviewed diff quality, elapsed time, tokens/cost and why failures occurred. The evaluation report comparator can compare saved reports over common task IDs; keep raw reports and methodology with every published result. Never turn a test count or smoke suite into a headline coding-quality score.

### P2 — Durable agent operations

The project now also has durable local browser task history, interrupted-task recovery, and opt-in isolated browser coding runs with a bounded, review-only diff endpoint. The next useful layer is a reliable, observable lifecycle across all agent types:

1. A run ledger with task, worker, status, branch, approvals, token/cost usage, last event and failure reason.
2. Pause/resume/cancel with clear terminal states and idempotent recovery after a process restart.
3. A visual monitor for agent progress and human approval actions.
4. Conflict previews and explicit, reviewable worktree integration; never merge unreviewed code automatically.
5. Cross-session coordination only after persistence, identity and auditability are designed.

### P3 — Security and trust

- Validate the macOS Keychain `security -i` stdin path on a real macOS host and verify Windows fallback-file ACLs; unit tests show the plaintext secret is absent from subprocess argv.
- Add platform-specific tests for process-tree termination and PTY teardown.
- Keep OS isolation limitations explicit. Optional Linux/macOS sandboxing is not on by default; when enabled it masks detected common credential paths but is not full filesystem-read isolation. A Windows OS sandbox is not implemented.
- Treat enabled MCP servers, hooks and third-party plugin executables as trusted code. Keep network access constrained and credentials scoped.
- Verify trusted HTTPS and secret handling on real devices. Do not expose the local workspace runtime to untrusted networks.
- Keep installer signing, provenance, updates and rollback on the release checklist.

## Product principles

- **Independent identity:** OASIS owns its product language, UI, architecture decisions and roadmap.
- **Original implementation:** build from OASIS-owned code and documented public interfaces; do not copy proprietary source or imitate undocumented internals.
- **Interoperability without dependency:** adapters for open protocols or documented formats must stay separable and must not define the product's identity.
- **Trustworthy claims:** a capability is marked complete only when a repeatable test or documented manual verification supports it.
- **User control:** consequential actions remain reviewable; agent delegation does not weaken permissions.
- **Small verified steps:** complete one release gate, update evidence, and only then move on to the next large capability.

## Definition of a stronger release

A release is ready only when all required CI workflows pass on the same commit, high-value user journeys have end-to-end coverage, advertised OS paths have been tested, evaluation results are reproducible, known security limitations are visible, and release artifacts have a clear verification story.

**Immediate priority:** stabilize the required quality matrix, expand the eval suite beyond utility smoke tests, and then implement the durable/visible agent lifecycle. Do not declare OASIS finished while those gates remain open.


The last fully verified implementation baseline before the follow-up fixes, `abe7c2f`, passed 648 Node tests across Node.js 22, 24 and 26, validated 33 fixtures, passed the PTY smoke test and browser E2E, and passed cross-platform security, publishing and Windows/macOS/Linux desktop packaging on the same SHA. The next follow-up adds process-tree cancellation to Git workflow commands and persistent background-session stops, and bounds HTTP MCP helper output while terminating its full process tree on timeout/overflow. It must pass its own same-SHA workflow matrix.