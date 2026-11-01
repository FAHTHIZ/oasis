# Oasis OSS roadmap

This roadmap distinguishes implemented code from future work. A listed idea is not shipped merely because it appears here.

## Shipped foundations

- Responsive browser dashboard for projects, tasks, notes, local persistence, backup/import, themes, and PWA app-shell caching.
- Installable Node.js CLI package layout and plain-English interactive/one-shot entry points.
- Native OpenAI Responses, OpenAI-compatible Chat Completions, and native Anthropic multi-step tool-calling loops.
- MCP stdio configuration, tool discovery/calling, explicit server setup, and per-tool approval.
- Bounded project file listing, glob search, ranged reads, exact-string patch editing, write/delete tools, and workspace/secret-path protections.
- Optional workspace-scoped session persistence and on-demand skill loading.
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
- Add streaming responses and robust context compaction for long-running tasks.
- Add skills discovery, installation from trusted sources, versioning, and supply-chain review.
- Design a provider/model capability probe and clearer setup diagnostics.

## Milestone 3 — agent strength

- Add planning and verification stages with explicit task checklists and regression-oriented tests.
- Add narrow specialist agents for review/testing/research, with bounded concurrency and shared task state.
- Add structured event logs, task checklists, stronger independent verification, and more complete undo/revert workflows.
- Add language/toolchain diagnostics (LSP where available) and workspace-specific policy rules.

## Milestone 4 — sandboxing and integrations

- Add a real isolation layer for unattended code execution; permission prompts alone are not a sandbox.
- Define secure MCP and GitHub integrations, explicit scopes, secret management, audit logs, and recovery.
- Establish a well-tested install/bootstrap flow for supported platforms.
- Connect browser workspace data to the CLI only after a local API and authentication boundary are designed.

## Deliberate non-claims

Oasis is not yet at Claude Code feature parity. It now includes MCP stdio integration, opt-in saved sessions, patch edits, glob discovery, ranged reads, and bounded tool-loop safeguards. It still lacks streaming, robust context compaction, OS-level sandboxing, specialist-agent orchestration, and a mature end-to-end browser/GitHub execution environment.
