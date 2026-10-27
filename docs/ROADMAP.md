# Oasis OSS roadmap

This roadmap distinguishes implemented code from future work. A listed idea is not shipped merely because it appears here.

## Milestone 0 — evaluation harness (experimental)

- A CLI evaluation runner executes reviewed reference tasks in disposable copies and records pass/fail, tokens, elapsed time, and optional estimated cost.
- The CI quality gate validates task fixtures by requiring the unchanged workspace to fail and the reference patch to pass.
- The starter suite contains 21 small tasks. Most are standalone utility exercises, so it is a smoke benchmark and not yet a reliable score for full-project coding quality.
- The runner is not an OS sandbox. Temporary directories and --yes do not provide isolation from host privileges or network access.

## Shipped foundations

- Chat-native provider setup: the agent can install/start a local OmniRoute gateway only after approval, test an inert tool call, and switch the saved provider after verification. Conversational installs of selected Vercel Agent Skills are also supported; imported instructions remain untrusted and scripts/hooks stay inactive.

- Read-only Git status/diff tools with common secret-path exclusions, plus plan mode that only exposes read-only tools and independently blocks non-read-only calls.

- Responsive browser dashboard for projects, tasks, notes, local persistence, backup/import, themes, and static PWA app-shell caching.
- Authenticated local HTTP bridge (`oasis web`) with mobile-friendly agent chat, saved-session restoration, polled job events, browser approval/denial, and a workspace command runner that reuses the CLI's argv-only safety policy.
- GitHub CLI-backed account status, up to 30 accessible repositories, approval-gated cloning, and active workspace switching without passing GitHub tokens to the browser.
- Service-worker exclusion for `/api/*` so authenticated runtime responses are never cached.
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

- **Current extension gap:** Oasis supports a safety-reviewed subset of native ecosystems, not drop-in compatibility with every plugin. Portable skills/resources, recognized Markdown command aliases, and disabled-first local stdio MCP proposals are supported; native hooks, scripts, dependency lifecycles, full command semantics, plugin UI, and all Codex/Gemini/Claude manifest features remain unsupported or inspect-only.
- **Progress:** portable Agent Skills preserve bounded text references/assets and expose them through manifest-verified, traversal-safe read access; scripts remain inactive.
- **Progress:** extension inspection now emits a versioned, normalized adapter/install plan for detected Claude Code, Codex, Gemini CLI, and portable Agent Skills layouts. Each capability is explicitly classified as supported, inspect-only, review-required, unsupported, or not detected. The CLI and browser show the plan before install approval.
- **Progress:** recognized Markdown slash-command instructions from Claude Code plugin/command layouts can be imported as ordinary untrusted Oasis skill prompts. Oasis does not register native slash-command aliases, argument interpolation, or TOML command behavior; those remain inactive.
- **Progress:** supported Markdown command files from Claude Code plugin/command paths and Gemini CLI command paths receive namespaced aliases such as `/acme-agent:review`. The CLI and browser resolve aliases into integrity-checked, untrusted prompt context; arguments are literal text, not shell expansion. Native slash-command argument conventions are only partially mapped; hooks and scripts stay inactive.
- **Progress:** native MCP declarations from `.mcp.json`, `mcp.json`, `mcp-servers.json`, and `gemini-extension.json` are inspected into a bounded proposal. Only local stdio commands passing Oasis validation can be selected. The browser and CLI can import reviewed proposals, with the inspected commit rechecked after approval and duplicate names rejected; saved configurations are disabled, manifest environment values are not copied, and source repository/commit/manifest provenance is retained for auditability.
- **Progress:** verified extension updates stage the new revision, refuse edited/missing/unexpected owned files, and preserve up to three prior verified revisions per scope. Rollback re-verifies the selected backup and swaps it in transactionally; the formerly active revision is retained as another backup.
- **Next extension runtime work:** add richer native agent metadata adapters, permissioned lifecycle management, and encrypted secret/environment provisioning. Keep hooks and executable lifecycle actions inactive until sandboxing and audit logging are in place.

- Add and test additional native provider adapters beyond OpenAI-compatible endpoints and Anthropic's Messages API.
- Harden MCP lifecycle recovery, notifications, pagination, and end-to-end cross-platform tests.
- Add mid-turn compaction that can preserve active task/tool-call state safely. Incremental model streaming is implemented in the CLI/browser runtime with a non-streaming JSON fallback for compatible gateways.
- Extend the initial bundled capability catalog with remote marketplace discovery, version pinning, integrity checks, update/rollback, and supply-chain review.
- Expand provider/model capability probing to cover route availability, quota/auth failures, and clearer recovery guidance. The inert tool-call probe is implemented for setup and `oasis doctor --test-provider`.

## Milestone 3 — agent strength

- Upgrade plan mode into persistent task checklists with explicit acceptance criteria, execution gates, and regression-oriented verifier cycles.
- Add narrow specialist agents for review/testing/research, with bounded concurrency and shared task state.
- Add structured event logs, task checklists, stronger independent verification, and more complete undo/revert workflows.
- Add language/toolchain diagnostics (LSP where available) and workspace-specific policy rules.

## Milestone 4 — sandboxing and integrations

- Add a real isolation layer for unattended code execution; permission prompts alone are not a sandbox.
- Add embedded GitHub OAuth or GitHub App authentication with reviewed fine-grained scopes, branch/push/PR workflows, audit logs, and recovery. Current repository access reuses host-side GitHub CLI auth only.
- Establish a well-tested install/bootstrap flow for supported platforms.
- Upgrade the argv-based command runner to a real interactive PTY and terminal emulator, with lifecycle controls and platform testing.
- **Progress:** the web bridge supports HTTPS with a user-provided certificate/key pair, enforces TLS 1.2+, and refuses non-loopback plaintext listeners unless `--allow-insecure-lan` is explicitly used. Certificate provisioning, phone trust onboarding, and real-device security tests remain unfinished.
- Share browser dashboard projects/tasks/notes with the selected repository workspace through a tested sync and conflict-resolution design.

## Deliberate non-claims

Oasis is not yet at Claude Code feature parity. It includes MCP stdio integration, opt-in saved sessions, patch edits, glob discovery, ranged reads, bounded tool-loop safeguards, best-effort between-turn context compaction, incremental streamed output, and bounded read-only specialist reviews. It still lacks a full PTY, embedded GitHub OAuth, a general remote plugin marketplace, mid-turn compaction, OS-level sandboxing, independent parallel subagent execution, cross-platform end-to-end UI tests, and a mature browser/GitHub execution environment.
