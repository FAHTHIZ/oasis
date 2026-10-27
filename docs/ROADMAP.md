# Oasis OSS roadmap

This roadmap distinguishes implemented code from future work. A listed idea is not shipped merely because it appears here.

## Milestone 0 — evaluation harness (experimental)

- A CLI evaluation runner executes reviewed reference tasks in disposable copies and records pass/fail, tokens, elapsed time, and optional estimated cost.
- The CI quality gate validates task fixtures by requiring the unchanged workspace to fail and the reference patch to pass.
- The starter suite contains 21 small tasks. Most are standalone utility exercises, so it is a smoke benchmark and not yet a reliable score for full-project coding quality.
- The runner is not an OS sandbox. Temporary directories and --yes do not provide isolation from host privileges or network access.

## Shipped foundations

- Read-only Git status/diff tools with common secret-path exclusions, plus plan mode that only exposes read-only tools and independently blocks non-read-only calls.

- Responsive browser dashboard for projects, tasks, notes, local persistence, backup/import, themes, and PWA app-shell caching.
- Installable Node.js CLI package layout and plain-English interactive/one-shot entry points.
- Native OpenAI Responses, OpenAI-compatible Chat Completions, and native Anthropic multi-step tool-calling loops.
- MCP stdio configuration, tool discovery/calling, explicit server setup, and per-tool approval.
- Bounded project file listing, glob search, ranged reads, exact-string patch editing, write/delete tools, and workspace/secret-path protections.
- Optional workspace-scoped session persistence, on-demand skill loading, and between-turn history compaction with a bounded deterministic fallback.
- Token and tool-call budgets, parallel read-only calls, and sequential handling of side effects.
- Command execution with argv arguments, approval defaults, child environment secret filtering, and selected destructive-command blocks.
- Package installation routing for npm/Python/system/Cargo/Go ecosystems with an explicit command summary and approval.
- Public documentation fetch with URL checks, redirect handling, and size limits.
- User-level provider configuration, environment setup diagnostics, built-in skills, project instructions, file snapshots, and snapshot restore.
- CI tests for install parsing, path boundaries, config permissions, snapshots, approvals, and a simulated agent tool cycle.

## Milestone 1 — make the CLI release-quality

- Run CI on the default branch and fix all failures.
- Exercise install/update on Linux, macOS, Windows, and Android/Termux.
- Add end-to-end UI/browser tests and accessibility review.
- Improve error recovery for package-manager failures and models without tool-calling support.
- Publish versioned releases only after successful builds and installation tests.

## Milestone 2 — provider and tool ecosystem

- Add and test additional native provider adapters beyond OpenAI-compatible endpoints and Anthropic's Messages API.
- Harden MCP lifecycle recovery, notifications, pagination, and end-to-end cross-platform tests.
- Add streaming responses and mid-turn compaction that can preserve active task/tool-call state safely.
- Extend the initial bundled capability catalog with remote marketplace discovery, version pinning, integrity checks, update/rollback, and supply-chain review.
- Design a provider/model capability probe and clearer setup diagnostics.

## Milestone 3 — agent strength

- Upgrade plan mode into persistent task checklists with explicit acceptance criteria, execution gates, and regression-oriented verifier cycles.
- Add narrow specialist agents for review/testing/research, with bounded concurrency and shared task state.
- Add structured event logs, task checklists, stronger independent verification, and more complete undo/revert workflows.
- Add language/toolchain diagnostics (LSP where available) and workspace-specific policy rules.

## Milestone 4 — sandboxing and integrations

- Add a real isolation layer for unattended code execution; permission prompts alone are not a sandbox.
- Define secure MCP and GitHub integrations, explicit scopes, secret management, audit logs, and recovery.
- Establish a well-tested install/bootstrap flow for supported platforms.
- Build the integrated mobile-first chat + terminal UI and connect it to the agent runtime through an authenticated local/remote bridge; the current static PWA cannot execute runtime commands.
- Connect browser workspace data to the CLI only after a local API and authentication boundary are designed.

## Deliberate non-claims

Oasis is not yet at Claude Code feature parity. It now includes MCP stdio integration, opt-in saved sessions, patch edits, glob discovery, ranged reads, bounded tool-loop safeguards, and best-effort between-turn context compaction. It still lacks streaming, mid-turn compaction, OS-level sandboxing, specialist-agent orchestration, and a mature end-to-end browser/GitHub execution environment.
