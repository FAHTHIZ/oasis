# OASIS status

**Audit date:** 2026-10-29  
**Repository:** https://github.com/FAHTHIZ/oasis  
**Default branch:** main

This file distinguishes existing code from behavior proven reliable. A module or command existing is not proof that its acceptance criteria are met.

## Implemented

- **Agent/runtime foundation:** CLI, headless text/JSON/stream-JSON workflows, Node SDK, multi-provider tool loops, workspace-bound file tools, command execution, approvals, snapshots/checkpoints/rewind, saved sessions, budgets and context estimation.
- **LSP and diagnostic foundations:** src/lsp.mjs provides language-server diagnostics, definition, references, hover, symbols and call hierarchy; src/diagnostics.mjs detects configured type checkers and linters. Focused tests exist. This does not prove that every edit is automatically verified.
- **Agent orchestration:** dynamic JavaScript workflows, schema-checked results, parallel/pipeline/phase helpers, bounded subagents, specialist reviews, background workers, resumable workflow results and a session-local task board.
- **Safety foundations:** configurable allow/ask/deny rules, plan/acceptEdits/default/auto-related modes, command-risk analysis, PreToolUse hooks, path protections, optional Linux/macOS sandboxing, secret redaction and process-tree cancellation.
- **Sessions/context:** persisted sessions, /fork, /resume, /context, /compact, between-turn summarization, deterministic fallback and within-turn microcompaction.
- **Integrations/customization:** MCP clients/server mode, skills, hooks, custom commands, layered memory, output styles, reviewed skill bundles and an ecosystem plugin/marketplace adapter.
- **Workspace/delivery:** authenticated local browser workspace, persisted browser task history, optional isolated Git worktrees with reviewable diffs, PTY-backed browser terminal where available, VS Code-family integration, GitHub Action, evaluation harness and desktop packaging.
- **Docs/licensing:** architecture, roadmap, readiness, security, current-status, branch audit and benchmark documents; CHANGELOG.md; Apache-2.0 text with sections 1–9 and its application appendix.

## Actively hardening

- **LSP-verified editing:** automatically collect LSP diagnostics after edits, baseline pre-existing findings, surface collection failures, and block /fix success while new errors remain.
- **Multi-agent review:** add /audit with isolated security, performance, coverage and dependency reviewers, strict schemas, deduplication, optional verification, timeouts and bounded reporting.
- **Policy enforcement:** define stable plan/manual/accept-edits/auto semantics, policy-source precedence and protected paths; prove denial prevents execution.
- **Context controls:** add detailed /context all attribution, must-preserve records and a cancelable compaction preview.
- **Session lifecycle:** test fork isolation, resume continuity, checkpoint references, queued steering and interrupt cleanup as invariants.
- **Extension safety:** verify namespacing, requested permissions and permission-diff updates across supported plugin types.
- **Remote/task lifecycle:** validate durable state, approval pauses, cancellation, redaction, revocation and workspace isolation across supported platforms.
- **Release confidence:** require fresh Quality, publishing and desktop checks on the same revision before marking a milestone verified.

## Experimental

- **Dynamic workflow scripts:** orchestration through a sandboxed JavaScript runtime; resource exhaustion, cancellation semantics and model-authored plan quality remain concerns.
- **Auto permission mode and optional OS sandboxing:** defense in depth; neither classifier quality nor OS-specific sandboxing replaces deterministic policy or security review.
- **Third-party plugin interoperability:** compatibility is feature-by-feature; import or manifest recognition does not prove safety or full compatibility.
- **Browser/PTY lifecycle:** useful local interface, but platform-specific process cleanup and stale-task recovery need end-to-end checks.
- **OpenHands delegation:** an optional bridge to a separately configured remote service, not a general Oasis-managed remote runner.

## Not yet guaranteed

- A diagnostic is surfaced for every edit/language; /fix cannot claim success while new errors remain; LSP startup or timeout is always treated as verification failure.
- A built-in /audit always runs all requested reviewers and returns deduplicated, severity-sorted, evidence-backed findings in all environments.
- Durable cross-session /notify and /inbox with busy-target queues, rate limits, loop prevention, read/dismiss state and no command-execution channel.
- Accurate token accounting for hidden provider overhead or a preview of exactly what compaction will discard.
- Equivalent plan/manual/accept-edits/auto modes with managed > project > user policy precedence and cross-platform enforcement.
- Guaranteed queued user steering before the next model decision, or full checkpoint/process isolation for every fork.
- A native Oasis plugin package with complete namespacing, install-time grants, permission-change diffs and uniform marketplace compatibility.
- A /artifact command that creates a live local-only investigation page with redaction, access control and cleanup.
- Guaranteed path-scoped rule loading. The requested built-in style set (default, concise, explanatory, architect, reviewer) is not complete.
- A general Oasis-owned local/self-hosted/managed runner with authenticated event streaming, approval pauses, cancellation, workspace allowlists, revocation and retention.
- Production readiness, security certification, platform parity, signed installers or competitive coding quality. Evaluation fixtures are regression evidence, not a repository-scale benchmark.

## Verification evidence

Focused tests exist for LSP, diagnostics, permissions, workflows, sessions, plugins, output styles, hooks and background agents. The existing status docs cite an earlier passing run with 685 tests on Node 22/24/26. That historical run does not verify the current main head. Check [Quality Checks](https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml), [publishing](https://github.com/FAHTHIZ/oasis/actions/workflows/pages.yml), and [desktop builds](https://github.com/FAHTHIZ/oasis/actions/workflows/desktop-build.yml) for the exact revision.

## First five files to create or modify

1. STATUS.md — capability inventory and maturity boundary.
2. docs/IMPLEMENTATION_PLAN.md — per-capability files, risks, tests, MVP and acceptance criteria.
3. src/lsp.mjs — LSP diagnostics lifecycle and verification contract.
4. src/agent.mjs — deterministic post-edit verification and /fix completion gate.
5. test/lsp.test.mjs and focused agent/slash tests — success and failure regressions.

CHANGELOG.md is updated alongside completed increments. LICENSE was inspected and left unchanged because its current text contains sections 1–9 and the application appendix. A root NOTICE is deferred because no project-wide third-party NOTICE obligation was established; component-level notices must remain with their components.
