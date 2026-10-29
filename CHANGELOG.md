# Changelog

OASIS is an alpha hobby project. This file records notable user-facing changes; it does not imply that a release has been published.

## Unreleased

- Reworked STATUS.md into four evidence-focused capability categories: implemented and verified on current HEAD, implemented but not yet verified on current HEAD, experimental, and not implemented or not meeting acceptance criteria. No capability is marked verified until fresh checks pass on the exact audited SHA.
- Recorded the current main SHA used for the status audit and separated historical test evidence from current-head verification.
- Confirmed the selected project license remains Apache-2.0: the root LICENSE includes sections 1–9 and the application appendix, package.json declares Apache-2.0, and the README badge matches. Full documentation-wide consistency audit remains pending.
- Preserved the previously documented feature inventory while making its verification limitations explicit. Durable messaging, path-scoped rules, the complete built-in style set, native plugin packaging, and local investigation artifacts remain acceptance-criteria gaps until implementation and fresh tests establish otherwise.
- Added an explicit current-head verification matrix for the full quality suite, LSP and /fix, /audit, permissions, session/context controls, plugins/styles, and licensing.

- Added JSON and self-contained offline HTML exports for Arena comparisons, including paired per-task wins/ties/losses and sample/provenance caveats; report writes are atomic and refuse symlink destinations.
- Added structured post-edit verification evidence to agent results and surfaced it in the CLI/browser: changed files, diff-review state, latest recognized check result, LSP status and blockers. Missing optional LSP tooling is disclosed without substituting for a real code check.
- Added post-edit LSP verification for source edits where a language server is configured, including baseline-aware diagnostics and explicit unavailable states when a server does not answer.
- Added a completion blocker for new or unclassified LSP errors and focused tests for TypeScript-style diagnostics, diagnostic timeouts, startup failure, and the /fix gate. Full current-head checks remain pending.
- Added a built-in /audit workflow that runs isolated security, performance, test-coverage and dependency reviewers, merges duplicate findings, verifies up to four high/critical findings, and separates verified from unverified results. Worker timeout/cancellation stress coverage and full current-head validation remain open.

- Added the first-run model connection choices to the browser/desktop workspace.
- Added fixed-localhost Ollama model discovery for the first-run flow.
- Added Electron OS-backed encryption for API keys entered through the desktop provider form, with fail-closed behavior if encryption is unavailable.
- Added secure-secret storage regression tests and CI screenshots for desktop and 390px browser layouts.

## 0.3.0

See the Git history and [release page](https://github.com/FAHTHIZ/oasis/releases) for changes included in the existing package version.
