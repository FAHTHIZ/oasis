# Changelog

OASIS is an alpha hobby project. This file records notable user-facing changes; it does not imply that a release has been published.

## Unreleased

- Added post-edit LSP verification for source edits where a language server is configured, including baseline-aware diagnostics and explicit unavailable states when a server does not answer.
- Added a completion blocker for new or unclassified LSP errors and focused tests for TypeScript-style diagnostics, diagnostic timeouts, startup failure, and the /fix gate. Full current-head checks remain pending.

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
