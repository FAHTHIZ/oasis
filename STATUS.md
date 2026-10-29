# OASIS status

**Audit date:** 2026-10-29  
**Repository:** https://github.com/FAHTHIZ/oasis  
**Branch audited:** main  
**Audited commit:** 2324f5054e5db223270b8f93124848e377140e32

This inventory separates code presence from verified behavior. A feature is **verified on current HEAD** only when its relevant tests or quality checks have passed against the exact audited commit. Historical CI results, existing tests, documentation, and source inspection are not substitutes for a fresh run.

## Implemented and verified on current HEAD

**None claimed in this audit.** The previously documented passing run is from an earlier revision. Current-head verification must be recorded only after fresh checks report success for the exact commit under review.

This is a conservative evidence status, not a claim that the repository has no working features.

## Implemented but not yet verified on current HEAD

These capabilities have implementation and/or focused regression tests in the repository, but this audit has not established a fresh passing run on the audited commit:

- **Agent/runtime foundation:** CLI, headless text/JSON/stream-JSON workflows, Node SDK, multi-provider tool loops, workspace-bound file tools, command execution, approvals, snapshots/checkpoints/rewind, saved sessions, budgets and context estimation.
- **LSP and diagnostics:** language-server navigation and diagnostics; configured project checkers; post-edit LSP verification for mapped files; baseline-aware findings and explicit unavailable outcomes; /fix completion gating.
- **Audit workflow:** isolated security, performance, test-coverage and dependency reviewers; structured finding validation, deduplication, bounded verification of high/critical findings, and partial-coverage reporting.
- **Policy and permissions:** allow/ask/deny rules, command-risk analysis, pre-tool hooks, path protections, secret redaction, process cancellation and optional Linux/macOS sandboxing. A permission-mode alias layer now maps `manual` to `default` and `accept-edits` to `acceptEdits` across settings, `/mode`, the policy object and CLI parsing; this remains unverified until current-head tests pass.
- **Sessions and context:** persisted sessions, /fork, /resume, /context, /compact, between-turn summarization, deterministic fallback and within-turn microcompaction.
- **Orchestration:** dynamic workflows, schema-checked results, parallel/pipeline/phase helpers, bounded subagents, background workers, resumable workflow results and a session-local task board.
- **Integrations:** MCP, skills, hooks, custom commands, layered memory, output styles, reviewed skill bundles and a plugin/marketplace compatibility adapter.
- **Workspace and delivery:** authenticated local browser workspace, task history, optional isolated Git worktrees, reviewable diffs, PTY-backed browser terminal where available, editor integration, GitHub Action, evaluation harness and desktop packaging.
- **Verification evidence and evaluation reports:** structured post-edit evidence, JSON/offline HTML comparison exports, atomic report writes and symlink-destination protections.
- **Licensing:** root Apache-2.0 license text and matching package metadata/README badge have been inspected. A complete documentation-wide license-string audit is still required.

The list above records implementation evidence only; it does not certify security, platform parity, production readiness or complete acceptance criteria.

## Experimental

- Dynamic workflow scripts in a sandboxed JavaScript runtime; resource exhaustion, cancellation semantics and model-authored plan quality remain concerns.
- Auto permission mode and optional OS sandboxing; neither replaces deterministic policy enforcement or security review.
- Third-party plugin interoperability; manifest recognition or import does not prove safety or full compatibility.
- Browser/PTY lifecycle; platform-specific process cleanup and stale-task recovery need end-to-end checks.
- OpenHands delegation; an optional bridge to a separately configured service, not a general Oasis-managed remote runner.
- Evaluation fixtures; regression/smoke evidence only, not a representative repository-scale coding benchmark.

## Not implemented or not yet meeting the requested acceptance criteria

- **Durable cross-session messaging:** /notify and /inbox with structured safe messages, busy-target queues, rate limits, loop prevention, read/dismiss state and a hard guarantee that messages cannot execute commands in the receiving session.
- **Path-scoped rules:** frontmatter path matching and conditional loading only for matching workspace paths, with conflicts handled deterministically.
- **Complete built-in output styles:** a single active style among default, concise, explanatory, architect and reviewer, switchable/listable through /style, while preserving project rules.
- **Native plugin package:** plugin.json, bundled skills/hooks/subagents/MCP servers/metadata, namespaced /plugin-name:command commands, explicit permission grants and visible permission diffs during updates.
- **Local-only investigation artifacts:** /artifact <name> creating a live local investigation page with goal, timeline, commands, changed files, tests, errors, hypotheses and rollback points; local-only defaults, secret redaction and cleanup.
- A general Oasis-owned local/self-hosted/managed runner with authenticated event streaming, approval pauses, cancellation, workspace allowlists, revocation and retention.
- Guaranteed diagnostic coverage for every edit/language, and a /fix gate that always blocks success when new diagnostics remain or verification fails.
- Guaranteed queued user steering before the next model decision, or full checkpoint/process isolation for every fork.
- Production readiness, security certification, platform parity, signed installers or competitive coding quality.

## Current-head verification plan

Run the repository quality workflow on the exact candidate commit, then inspect focused results for each area below. Do not mark a capability verified if a required test is missing, skipped, or failing.

| Area | Required evidence |
| --- | --- |
| Full quality suite | npm run check and the repository's required CI matrix on the same SHA |
| LSP and /fix | New diagnostic, pre-existing baseline, unavailable server, timeout/startup failure and completion-blocker tests |
| /audit | Reviewer failures, deduplication, high/critical verification, cancellation and timeout behavior |
| Permissions | Explicit policy denial prevents the underlying operation; precedence and protected-path tests |
| /fork and /resume | Isolation, persisted continuity, checkpoint references and interruption cleanup |
| /context and /compact | Attribution, preserved context, cancel behavior and stale-preview rejection |
| Plugins and styles | Install/update conflicts, permissions, permission diffs, command namespacing and all built-in styles |
| Documentation/license | Consistent Apache-2.0 declaration across LICENSE, README, package metadata, STATUS and docs |

The prior documented result of 685 tests on Node.js 22/24/26 belongs to an earlier commit and is historical evidence only. Check [Quality Checks](https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml), [publishing](https://github.com/FAHTHIZ/oasis/actions/workflows/pages.yml) and [desktop builds](https://github.com/FAHTHIZ/oasis/actions/workflows/desktop-build.yml) for candidate-revision results.

## License and attribution

The project currently selects **Apache-2.0**. The root LICENSE contains the license terms and application appendix; package.json declares Apache-2.0; and the README badge names Apache-2.0. Keep these aligned and search the full documentation tree for conflicting license statements before declaring the audit complete.

A root NOTICE is not added without an established project-wide attribution obligation. Preserve third-party notices with the components that require them and reassess when bundled dependencies or attribution requirements change.

## Change discipline

For each completed increment, update STATUS.md and CHANGELOG.md, add focused regression tests, run the relevant tests and full quality suite, and record the exact tested SHA. If execution is unavailable, report verification as pending rather than inferring success from source inspection.
