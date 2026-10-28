# Oasis OSS roadmap

This roadmap distinguishes implemented code from future work. A listed idea is not shipped merely because it appears here.

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
- CI tests for install parsing, path boundaries, config permissions, snapshots, approvals, and a simulated agent tool cycle.

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

- Add and test additional native provider adapters beyond OpenAI-compatible endpoints and Anthropic's Messages API.
- Harden MCP lifecycle recovery, notifications, pagination, and end-to-end cross-platform tests.
- **Implemented, needs broader evaluation:** mid-turn compaction summarizes completed tool rounds while retaining the active user request and the latest complete tool-call/result batch. It uses a tool-free summary request with a deterministic fallback; it is a bounded heuristic, not a guarantee that every provider/task retains perfect continuity. Incremental model streaming is implemented in the CLI/browser runtime with a non-streaming JSON fallback for compatible gateways.
- Extend the initial bundled capability catalog with remote marketplace discovery, version pinning, integrity checks, update/rollback, and supply-chain review.
- Expand provider/model capability probing to cover route availability, quota/auth failures, and clearer recovery guidance. The inert tool-call probe is implemented for setup and `oasis doctor --test-provider`.

## Milestone 3 — agent strength

- Upgrade plan mode into persistent task checklists with explicit acceptance criteria, execution gates, and regression-oriented verifier cycles.
- Add narrow specialist agents for review/testing/research, with bounded concurrency and shared task state.
- **Progress:** up to two independent read-only specialist reviews can execute concurrently; parent tool-call results remain ordered. Parallel code-writing agents and shared edit coordination remain future work.
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

Oasis is not yet at Claude Code feature parity. It includes MCP stdio integration, opt-in saved sessions, patch edits, glob discovery, ranged reads, bounded tool-loop safeguards, best-effort between-turn context compaction, incremental streamed output, and bounded read-only specialist reviews. It still lacks a full PTY, embedded GitHub OAuth, a general remote plugin marketplace, OS-level sandboxing, parallel code-writing subagents with shared edit coordination, broad cross-platform end-to-end UI tests (a Linux Chromium chat smoke test is in place), and a mature browser/GitHub execution environment. Mid-turn compaction is implemented as a bounded heuristic and still needs long-task evaluation across provider protocols.
