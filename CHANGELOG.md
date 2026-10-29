# Changelog

OASIS is an alpha hobby project. This file records notable user-facing changes; it does not imply that a release has been published.

## Unreleased

- Added canonical permission-mode normalization across settings, `PermissionPolicy`, `/mode`, and `--permission-mode`. `manual` maps to `default`; `accept-edits` and `accept_edits` map to `acceptEdits`. This is an alias-only change; no new permission bypass was added. Current-head CI is pending.

- Updated STATUS.md directly on main to use four evidence/maturity categories and to keep current-head verification unclaimed until fresh checks pass on the exact revision. Added a focused verification matrix; this is a documentation/status change, not a test result.

- Added detailed `/context all` accounting and a two-step `/compact` preview/confirm/cancel flow. Must-preserve records are bounded, included in compaction summaries and persisted across session save/resume; stale previews are rejected without mutating history. Focused tests cover redaction and freshness checks; full current-head CI remains pending.

- Added JSON and self-contained offline HTML exports for Arena comparisons, including paired per-task wins/ties/losses and sample/provenance caveats; report writes are atomic and refuse symlink destinations.
- Added structured post-edit verification evidence to agent results and surfaced it in the CLI/browser: changed files, diff-review state, latest recognized check result, LSP status and blockers. Missing optional LSP tooling is disclosed without substituting for a real code check.
- Added post-edit LSP verification for source edits where a language server is configured, including baseline-aware diagnostics and explicit unavailable states when a server does not answer.
- Added a completion blocker for new or unclassified LSP errors and focused tests for TypeScript-style diagnostics, diagnostic timeouts, startup failure, and the /fix gate. Full current-head checks remain pending.
- Added a built-in `/audit` workflow that runs isolated security, performance, test-coverage and dependency reviewers, merges duplicate findings, verifies up to four high/critical findings, and separates verified from unverified results. Worker timeout/cancellation stress coverage and full current-head validation remain open.

- Added a root capability status with Implemented, Actively hardening, Experimental, and Not yet guaranteed sections.
- Added a source-backed implementation plan and capability matrix for LSP verification, multi-agent audit, cross-session messaging, context controls, deterministic policy, session forking/steering, plugin packaging, investigation artifacts, scoped rules/styles, and remote execution.
- Audited the root license: the current Apache-2.0 body includes sections 1–9 and the application appendix, so no unsupported rewrite was made.
- Recorded that historical CI results do not verify the current main head. A root NOTICE is deferred until a project-wide attribution obligation is established.

- Added the first-run model connection choices to the browser/desktop workspace.
- Added fixed-localhost Ollama model discovery for the first-run flow.
- Added Electron OS-backed encryption for API keys entered through the desktop provider form, with fail-closed behavior if encryption is unavailable.
- Added secure-secret storage regression tests and CI screenshots for desktop and 390px browser layouts.

## 0.3.0

See the Git history and [release page](https://github.com/FAHTHIZ/oasis/releases) for changes included in the existing package version.
