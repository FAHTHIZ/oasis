# Changelog

OASIS is an alpha hobby project. This file records notable user-facing changes; it does not imply that a release has been published.

## Unreleased

- Strengthened CI concurrency further: every main commit now gets a unique group, so a later push cannot replace its queued quality, publishing, or desktop verification. PR updates share PR-number groups and remain cancellable. A regression test covers all three workflows; fresh validation is pending.

- Hardened task-history event sanitization for unusual JSON keys and added one focused persistence regression test. Current-head CI is pending.

- Native Oasis plugins now validate author/license/minimum version metadata, support `subagents/` manifests, and can be installed or validated from local folders and explicit HTTPS/SSH/file Git URLs. Remote sources use bounded non-shell Git cloning and are removed after staging; no package scripts run automatically. Tests and current-head CI validation are tracked separately.

- Simplified the invalid-version regression assertion and removed duplicated native-plugin verification wording; current-main CI remains the release gate.

- Hardened native plugin rollback: uninstall restores the package and registry if settings updates fail. Version ordering handles hyphenated prerelease identifiers and large numeric core values; regression tests cover subagent grants. Current-main CI is pending.

- Removed a case-colliding duplicate pull-request template, retained the richer lowercase canonical template, added a repository-wide case-only path collision regression test, and documented intentional exact-content copies used by static-site deployment and frozen evaluation snapshots. Refreshed the branch inventory for all 37 non-main refs and identified 22 retirement candidates; divergent feature/security branches remain preserved. No remote ref is claimed deleted because the available GitHub connection has no delete-ref operation.


- Fixed native plugin capability exposure so explicitly granted agent definitions are included in the compatibility manifest; added semantic prerelease ordering and validation tests, and removed duplicate MCP coverage. Current-main CI is pending.

- Added native local plugin packages using root `plugin.json`, allowlisted bundled commands/skills/agents/hooks/MCP server files, explicit permissions, namespaced commands, conflict checks, versioned updates and permission-diff previews/confirmation. Tests cover installation, permission isolation, unrequested grants, conflicts, updates, MCP paths and uninstall; current-head CI pending.

- LSP completion responses now explicitly disclose when language-server diagnostics were unavailable even if independent checks passed; `/diagnostics` directs the agent to collect both LSP and project-checker results and report Errors, Warnings, Information, and Verification unavailable separately.

- Hardened GitHub Action completion wording so an incomplete verification result is not described as finished successfully; added a focused status test.
- Updated path-scoped memory coverage to assert matching-only on-demand loading, restored the reviewer style's evidence-first wording, and made the `/audit` test fixture self-contained. Latest full-suite validation is still pending.

- Added an explicit clean protocol-level LSP fixture to the post-edit verification happy-path tests, fixed diagnostic offset calculation in the fake LSP, and added `/context all` category/caveat regression coverage. The tests are committed for current-head CI; no passing result is claimed yet.

- Added `/artifact NAME` with an auto-refreshing local-only investigation page and structured event store. Active sessions record task starts, commands, changed files, test outcomes and tool errors; users can add hypotheses/rollback notes, list/open/stop/delete artifacts, and common secrets are redacted before local storage. Focused tests added; current-head CI pending.

- Added a license-consistency regression test covering the full Apache-2.0 sections/application appendix, package metadata, README badge/statement, and project-license claims in public documentation.

- Completed the project license consistency audit on main: aligned DISCOVERABILITY.md, PUBLIC_LAUNCH.md and USER_GUIDE.md with Apache-2.0, while retaining accurate MIT references for third-party dependencies and projects. Root LICENSE and package metadata were already Apache-2.0; no project-wide NOTICE requirement was identified.

- Wired durable session messages into `/notify` and `/inbox`; agent-turn lifecycle marks live sessions busy/idle, queued delivery waits while the target is busy, cached target objects are revalidated against the live registry, and inbox read/dismiss actions are available. Message text is displayed as untrusted data and never returned as an agent prompt. Focused tests and current-head CI pending.

- Implemented the requested built-in response styles (default, concise, explanatory, architect, reviewer) and the /style command while retaining /output-style compatibility. Added style-switching tests for one-active-style and preserving project instructions; CI verification pending.
- Corrected path-scoped rules so frontmatter-scoped instructions stay out of base memory and load only for matching paths. Added safe glob matching and broad-to-specific/user-to-project rule ordering tests; CI verification pending.

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
- Added `docs/REMOTE_RUNNER_DESIGN.md`, a security-first design for local, self-hosted and future optional managed execution; no runner implementation is claimed.
