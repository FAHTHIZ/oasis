# Oasis OSS roadmap

This roadmap distinguishes implemented code from future work. A listed idea is not shipped merely because it appears here.

## Shipped foundations

- Responsive browser dashboard for projects, tasks, notes, local persistence, backup/import, themes, and PWA app-shell caching.
- Installable Node.js CLI package layout and plain-English interactive/one-shot entry points.
- OpenAI-compatible multi-step tool-calling loop.
- Bounded project file listing/search/read/write/delete tools with workspace and secret-path protections.
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

- Implement and test native provider adapters (including Anthropic's native Messages API).
- Add optional MCP server support with explicit server trust and per-tool permissions.
- Add streaming responses and robust context compaction/session resume.
- Add skills discovery, installation from trusted sources, versioning, and supply-chain review.
- Design a provider/model capability probe and clearer setup diagnostics.

## Milestone 3 — agent strength

- Add planning and verification stages with explicit task checklists and regression-oriented tests.
- Add narrow specialist agents for review/testing/research, with bounded concurrency and shared task state.
- Add persistent sessions, structured event logs, undo/revert workflows, and safer patch-based editing.
- Add language/toolchain diagnostics (LSP where available) and workspace-specific policy rules.

## Milestone 4 — sandboxing and integrations

- Add a real isolation layer for unattended code execution; permission prompts alone are not a sandbox.
- Define secure MCP and GitHub integrations, explicit scopes, secret management, audit logs, and recovery.
- Establish a well-tested install/bootstrap flow for supported platforms.
- Connect browser workspace data to the CLI only after a local API and authentication boundary are designed.

## Deliberate non-claims

Oasis is not yet at Claude Code feature parity. The current release foundation does not have native Anthropic API support, MCP, session persistence, streaming, multi-agent orchestration, or OS-level sandboxing. Those are substantial milestones, not just cosmetic additions.
