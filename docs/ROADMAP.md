# Oasis OSS roadmap

This roadmap distinguishes implemented code from future work. A listed idea is not shipped merely because it appears here. **Last verified: October 28, 2026**, against `main` at implementation baseline `eaa828d1fafce684737f4458e1fb3b9b1fe0a901`. The current test and capability inventory lives in [CURRENT_STATUS.md](CURRENT_STATUS.md); the competitor-specific backlog lives in [CLAUDE_CODE_GAP.md](CLAUDE_CODE_GAP.md).

## Milestone 0 — evaluation harness (experimental)

- A CLI evaluation runner executes reviewed reference tasks in disposable copies and records pass/fail, tokens, elapsed time, and optional estimated cost.
- The CI quality gate validates task fixtures by requiring the unchanged workspace to fail and the reference patch to pass.
- The starter suite contains 21 small tasks. Most are standalone utility exercises, so it is a smoke benchmark and not yet a reliable score for full-project coding quality.
- The runner is not an OS sandbox. Temporary directories and --yes do not provide isolation from host privileges or network access.

## Shipped foundations

- Chat-native setup tools for OmniRoute and existing provider presets, selected external Vercel Agent Skills, stdio MCP servers, and optional delegation to an already-running OpenHands Agent Server. OpenHands delegation uses a server-owned Agent Profile, explicit manual approval, AlwaysConfirm, bounded polling, and no forwarding of Oasis model credentials.

- Read-only Git status/diff tools with common secret-path exclusions, plus plan mode that only exposes read-only tools and independently blocks non-read-only calls.

- Responsive browser dashboard for projects, tasks, notes, local persistence, backup/import, themes, and static PWA app-shell caching.
- Authenticated local HTTP bridge (`oasis web`) with mobile-friendly agent chat, saved-session restoration, polled job events, browser approval/denial, and a workspace command runner that reuses the CLI's argv-only safety policy.
- GitHub CLI-backed account status, up to 30 accessible repositories, approval-gated cloning, and active workspace switching without passing GitHub tokens to the browser.
- Service-worker exclusion for `/api/*` so authenticated runtime responses are never cached.
- Installable Node.js CLI package layout and plain-English interactive/one-shot entry points.
- Native OpenAI Responses, OpenAI-compatible Chat Completions, and native Anthropic multi-step tool-calling loops.
- MCP stdio configuration through both CLI and chat, tool discovery/calling, explicit per-call approval, and live registration of a newly approved MCP server in the current session.
- Bounded project file listing, glob search, ranged reads, exact-string patch editing, write/delete tools, and workspace/secret-path protections.
- Optional workspace-scoped session persistence, on-demand skill loading, and between-turn history compaction with a bounded deterministic fallback; within-turn microcompaction trims older bulky tool results when the estimated context grows too large.
- The session task checklist is persisted with saved sessions. Tool-call execution preserves requested order across reads and writes, while consecutive read-only workspace calls may run together.
- Token and tool-call budgets, parallel read-only calls, and sequential handling of side effects.
- Saved-session startup locks reject duplicate concurrent browser requests with HTTP 409 before they can run the same history in parallel.
- Command execution with argv arguments, approval defaults, child environment secret filtering, and selected destructive-command blocks.
- Package installation routing for npm/Python/system/Cargo/Go ecosystems with an explicit command summary and approval.
- Public documentation fetch with URL checks, redirect handling, and size limits.
- User-level provider configuration, environment setup diagnostics, built-in skills, project instructions, file snapshots, and snapshot restore.
- PDF text extraction in `read_file` (page ranges), headless `--json-schema` structured output with validation and retries, and `-w/--worktree` sessions on their own branch.
- Hooks: 14 events (including PostToolUseFailure, PermissionRequest, SubagentStart, Pre/PostCompact, Notification, CwdChanged) and `command`, `http`, and `prompt` hook types.
- Custom commands and skills: inline `` !`cmd` `` output, `allowed-tools`, `effort`, `context: fork` subagent runs, `/skill-name`, and headless `/command` expansion.
- Auto permission mode: a classifier model allows routine actions and blocks risky ones. It is resistant to prompt injection because it never sees tool output.
- SDK (`import { query, tool } from 'oasis-oss'`) with in-process tools and `canUseTool`, plus a `--bare` headless mode.
- GitHub Action (`action.yml`): `@oasis` mentions on issues and PRs lead to a branch, a PR, and a reply in the thread.
- Interactive terminal rebuilt (October 2026): multiline editor, per-workspace history with Ctrl+R, Tab completion for `/commands` and `@files`, Shift+Tab modes, `!` shell mode, Ctrl+V image paste, streaming Markdown with syntax highlighting, colored diffs, type-ahead queue, Esc to interrupt, and an animated startup banner (`OASIS_NO_ANIMATION=1` to skip).
- Claude Code-compatible CLI flags (`--system-prompt`, `--tools`, `--mcp-config`, `--agents`, `--session-id`, `--name`, `--fallback-model`, `--max-budget-usd`, `--settings`, `--setting-sources`, `--from-pr`, stream-json input and more) and USD cost tracking.
- Session tools: `tool_search` (deferred MCP tools), `monitor_command`, `enter_plan_mode`, `notify`, and in-session cron (`cron_create`, `cron_list`, `cron_delete`, `/schedule`).
- Workflow commands: `/goal`, `/btw`, `/recap`, `/rename`, `/simplify`, `/verify`, `/batch`, `/fewer-permission-prompts`, `/keybindings`, `/terminal-setup`, `/privacy-settings`, `/stop`. Sessions are saved by default.
- Bundled [Ponytail](https://github.com/DietrichGebert/ponytail) skills (MIT) for a lean, smallest-complete-change mode.
- CI tests for install parsing, path boundaries, config permissions, snapshots, approvals, and a simulated agent tool cycle.

## Next: Claude Code parity

Recommended order is based on capability impact, not ease of implementation:

1. **Finish the real PTY and terminal lifecycle** — the CLI agent now supports `run_command interactive=true` plus `terminal_read/input/resize/interrupt/stop/list` over a real `node-pty` session manager, with bounded output, incremental reads and session-close cleanup. The native package remains optional, and the initial native smoke test is Linux/Node 22 only. Still open: Windows/macOS integration and process-tree cleanup, browser terminal transport and rendered terminal UI, and beginner-first signed OS installers.
2. **Complete multi-agent coordination** — task claiming/locking, peer-to-peer messages, lifecycle controls, visible agent monitoring and worktree conflict/merge handling on top of the shared dependency-aware board already shipped.
3. **IDE integrations** — start with a VS Code extension that can review diffs, expose task/session state and hand off to the same runtime.
4. **Remote and cross-surface workflows** — cloud/remote sessions, mobile steering, Chrome, desktop and chat integrations; this requires an explicit server trust/auth model rather than merely exposing `oasis web`.
5. **Platform and extension parity** — native Gemini and Azure adapters, PowerShell/Windows sandboxing, broader plugin compatibility and a remote marketplace.
6. **Terminal polish** — full-screen transcript, vim mode, themes and an editable keybinding file.

See [CLAUDE_CODE_GAP.md](CLAUDE_CODE_GAP.md) for the sourced comparison and [CURRENT_STATUS.md](CURRENT_STATUS.md) for the current verification baseline.

## Milestone 1 — make the CLI release-quality

- Run CI on the default branch and fix all failures.
- Exercise install/update on Linux, macOS, Windows, and Android/Termux.
- **Progress:** a Linux Chromium smoke test exercises authenticated browser chat against a fixture provider, including a real write/read tool cycle and verification of the resulting workspace file. Broader critical-path UI coverage, approval/cancellation flows, accessibility review, and cross-platform browser testing remain open.
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

- Add and test additional native provider adapters. **Progress:** Claude on AWS Bedrock (SigV4 signing, checked against the AWS test vector) and Google Vertex AI (streaming) is implemented and tested against local fake endpoints. These adapters still need checking against live cloud accounts. Azure Foundry and native Gemini are still to do.
- Harden MCP lifecycle recovery, notifications, pagination, and end-to-end cross-platform tests.
- **Implemented, needs broader evaluation:** mid-turn compaction summarizes completed tool rounds while retaining the active user request and the latest complete tool-call/result batch. It uses a tool-free summary request with a deterministic fallback; it is a bounded heuristic, not a guarantee that every provider/task retains perfect continuity. Incremental model streaming is implemented in the CLI/browser runtime with a non-streaming JSON fallback for compatible gateways.
- Extend the initial bundled capability catalog with remote marketplace discovery, version pinning, integrity checks, update/rollback, and supply-chain review.
- Expand provider/model capability probing to cover route availability, quota/auth failures, and clearer recovery guidance. The inert tool-call probe is implemented for setup and `oasis doctor --test-provider`.

## Milestone 3 — agent strength

- Upgrade plan mode into persistent task checklists with explicit acceptance criteria, execution gates, and regression-oriented verifier cycles.
- Add narrow specialist agents for review/testing/research, with bounded concurrency. **Progress:** a dependency-aware shared task board (`task_create`, `task_list`, `task_get`, `task_update`) is available to the main session and subagents and persists with saved sessions. It is a task board, not a complete agent-team system: task claims/locking, a scheduler, direct peer-to-peer messaging, team lifecycle controls, visual monitoring, and edit-conflict coordination remain future work.
- **Progress:** up to two independent read-only specialist reviews can execute concurrently; parent tool-call results remain ordered. Parallel code-writing agents and shared edit coordination remain future work.
- **Progress:** OpenTelemetry export is implemented (metrics, events and nested traces over OTLP/HTTP JSON) and tested against a local collector.
- Add structured event logs, task checklists, stronger independent verification, and more complete undo/revert workflows.
- **Progress:** a `diagnostics` tool runs detected type checkers and linters (tsc, ESLint, Ruff, mypy, Pyright, go vet, cargo check) plus built-in JS/JSON syntax checks and returns structured problems. An `lsp` tool now keeps language servers running per session for definition, references, hover, symbols, call hierarchy, and pushed or pulled diagnostics. Auto memory keeps durable notes across sessions (Markdown files, BM25 recall, secret redaction, duplicate merging). MCP resources and prompts are supported. Session commands now include `/effort`, `/copy`, `/undo`, `/fork`, `/loop`, `/cd`, `/sandbox`, `/skills`, `/config`, `/doctor` and `/release-notes`. Workspace-specific policy rules remain future work.

## Milestone 4 — sandboxing and integrations

- Add a real isolation layer for unattended code execution; permission prompts alone are not a sandbox.
- Add embedded GitHub OAuth or GitHub App authentication with reviewed fine-grained scopes, branch/push/PR workflows, audit logs, and recovery. Current repository access reuses host-side GitHub CLI auth only.
- Expand the optional OpenHands bridge into a richer delegated-task lifecycle: direct event streaming, UI-linked confirmation status, and worktree change inspection/integration. Current bridge requires a separately configured Agent Server and profile; remote confirmations remain handled in OpenHands.
- Establish a well-tested install/bootstrap flow for supported platforms.
- Upgrade the argv-based command runner to a real interactive PTY and terminal emulator, with lifecycle controls and platform testing.
- **Progress:** the web bridge supports HTTPS with a user-provided certificate/key pair, enforces TLS 1.2+, and refuses non-loopback plaintext listeners unless `--allow-insecure-lan` is explicitly used. Certificate provisioning, phone trust onboarding, and real-device security tests remain unfinished.
- Share browser dashboard projects/tasks/notes with the selected repository workspace through a tested sync and conflict-resolution design.

## Deliberate non-claims

OASIS is not yet at Claude Code feature parity. The tested baseline is strong for a single-machine CLI coding agent, but does not establish equal coding outcomes or full platform parity. It includes MCP, saved sessions, patch edits, glob/ranged reads, permissions, optional Linux/macOS sandboxing, a shared dependency-aware agent task board, incremental streaming, and bounded read-only specialist reviews. It still lacks a full PTY/TUI, atomic task claims and full agent-team coordination, embedded GitHub OAuth, a general remote plugin marketplace, Windows sandboxing, native Gemini/Azure adapters, IDE and Chrome integrations, cloud/remote sessions, mobile/desktop surfaces, broad cross-platform end-to-end tests, and a mature browser/GitHub execution environment. Mid-turn compaction remains a best-effort heuristic and the 21 evaluation fixtures are only a smoke suite.
