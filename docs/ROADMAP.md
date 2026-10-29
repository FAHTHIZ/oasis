# Oasis OSS roadmap

This roadmap distinguishes implemented code from future work. A listed idea is not shipped merely because it appears here. **Last verified: October 29, 2026**, against code baseline [`02feecc610f5775279b827a51744bc244e725068`](https://github.com/FAHTHIZ/oasis/commit/02feecc610f5775279b827a51744bc244e725068). The next milestone is [Alpha confidence and end-to-end reliability](NEXT_MILESTONE.md); current security findings are in [SECURITY_RELIABILITY_AUDIT.md](SECURITY_RELIABILITY_AUDIT.md), implementation/CI evidence is in [CURRENT_STATUS.md](CURRENT_STATUS.md), and the competitor-specific comparison is [CLAUDE_CODE_GAP.md](CLAUDE_CODE_GAP.md).

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
- Hooks: a broad Claude Code-style event and handler surface, including command, HTTP, prompt, MCP-tool and agent handlers, with file/config/worktree/team lifecycle events and regression coverage. The parity details and remaining semantics are tracked in [CLAUDE_CODE_GAP.md](CLAUDE_CODE_GAP.md).
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

## Next milestone — Alpha confidence and end-to-end reliability

The current priority is to make the existing product dependable and measurable before adding another layer of feature parity. The previous main baseline had mixed CI: Quality Checks/desktop passed while homepage validation failed the `FileChanged` hook test. A test synchronization fix, process-tree cancellation changes and additional URL-address filtering are now committed; current-main workflows must finish successfully before the release gate is considered green.

Follow the task list, evidence links and acceptance criteria in [NEXT_MILESTONE.md](NEXT_MILESTONE.md), and see [SECURITY_RELIABILITY_AUDIT.md](SECURITY_RELIABILITY_AUDIT.md) for fixes made and security boundaries that remain. The gate includes deterministic hooks tests, aligned validation workflows, accurate docs, core CLI/browser end-to-end coverage, supported-OS smoke tests, and a representative coding-task benchmark. Until the required workflows pass on one commit and the failure is explained, the release-confidence milestone is open.

## Post-alpha — highest-value Claude Code gaps

Once the Alpha-confidence gate is complete, prioritize:

1. **Persistent, observable agent work:** a visual agent/run monitor; durable pause/resume and recovery; cross-session messaging; transparent worker status, cost, approvals and failures; conflict-aware worktree integration with explicit human approval.
2. **Secure remote continuity:** remote/mobile access to existing sessions only after identity, trusted-device enrollment, workspace isolation, permission enforcement, reconnect/revocation and audit logs are designed and tested.
3. **Platform gaps:** JetBrains integration; validated native PTY/process cleanup across supported systems; Windows sandbox and credential storage; native Gemini adapter; desktop signing or explicit unsigned-package handling.
4. **Ecosystem hardening:** test real third-party plugin compatibility, lifecycle boundaries, marketplace trust/update/rollback and provider failure recovery. Don't present a detected or importable extension as fully compatible without tests.

These priorities follow from the [Claude Code comparison](CLAUDE_CODE_GAP.md). Do not treat an accessible local web server as a replacement for a secure hosted session service.

## Milestone 1 — Alpha release gate

- Make the `FileChanged` hook regression deterministic and root-caused.
- Require Quality Checks, homepage/repository validation, and desktop build workflows to pass on the same commit.
- Add end-to-end coverage for approval/denial, cancellation, recovery/resume, worktree conflicts, and browser PTY interaction.
- Verify first launch and a small edit/test task on each OS claimed as supported. Treat Android/Termux as experimental until tested.
- Document TLS behavior, sandbox defaults, provider setup, unsigned installers and platform limits truthfully.
- Expand the 21-task smoke suite into at least 25–30 representative, reviewed repository tasks and publish reproducible OASIS-versus-Claude Code results where the same model can be pinned.
- Publish a versioned Alpha only when the acceptance criteria in [NEXT_MILESTONE.md](NEXT_MILESTONE.md) are satisfied; successful packaging alone is not sufficient.

## Milestone 2 — provider and tool ecosystem

- **Current extension gap:** OASIS has a broad native Claude Code plugin-format path, including marketplaces, core plugin manifests, commands, agents, skills, hooks, MCP servers, multiple source types, and supporting settings. This is not a guarantee that every third-party or enterprise plugin works unchanged. The separate Claude/Codex/Gemini import adapters are intentionally safety-reviewed: detected capabilities are classified, imported command prompts remain untrusted, MCP proposals are disabled until approved, and unsupported hooks/scripts/lifecycle actions do not silently execute. Track feature-specific gaps and evidence in [CLAUDE_CODE_GAP.md](CLAUDE_CODE_GAP.md).
- **Progress:** portable Agent Skills preserve bounded text references/assets and expose them through manifest-verified, traversal-safe read access; scripts remain inactive.
- **Progress:** extension inspection now emits a versioned, normalized adapter/install plan for detected Claude Code, Codex, Gemini CLI, and portable Agent Skills layouts. Each capability is explicitly classified as supported, inspect-only, review-required, unsupported, or not detected. The CLI and browser show the plan before install approval.
- **Progress:** recognized Markdown slash-command instructions from Claude Code plugin/command layouts can be imported as ordinary untrusted Oasis skill prompts. Oasis does not register native slash-command aliases, argument interpolation, or TOML command behavior; those remain inactive.
- **Progress:** supported Markdown command files from Claude Code plugin/command paths and Gemini CLI command paths receive namespaced aliases such as `/acme-agent:review`. The CLI and browser resolve aliases into integrity-checked, untrusted prompt context; arguments are literal text, not shell expansion. Native slash-command argument conventions are only partially mapped; hooks and scripts stay inactive.
- **Progress:** native MCP declarations from `.mcp.json`, `mcp.json`, `mcp-servers.json`, and `gemini-extension.json` are inspected into a bounded proposal. Only local stdio commands passing Oasis validation can be selected. The browser and CLI can import reviewed proposals, with the inspected commit rechecked after approval and duplicate names rejected; saved configurations are disabled, manifest environment values are not copied, and source repository/commit/manifest provenance is retained for auditability.
- **Progress:** verified extension updates stage the new revision, refuse edited/missing/unexpected owned files, and preserve up to three prior verified revisions per scope. Rollback re-verifies the selected backup and swaps it in transactionally; the formerly active revision is retained as another backup.
- **Next extension runtime work:** add richer native agent metadata adapters, permissioned lifecycle management, and encrypted secret/environment provisioning. Keep hooks and executable lifecycle actions inactive until sandboxing and audit logging are in place.

- Add and test additional native provider adapters. **Progress:** Claude on AWS Bedrock (SigV4 signing, checked against the AWS test vector) Google Vertex AI (streaming) and Microsoft Foundry (x-api-key, Entra bearer or `az login`, streaming) are implemented and tested against local fake endpoints. These adapters still need checking against live cloud accounts. A native Gemini adapter is still to do.
- Harden MCP lifecycle recovery, notifications, pagination, and end-to-end cross-platform tests.
- **Implemented, needs broader evaluation:** mid-turn compaction summarizes completed tool rounds while retaining the active user request and the latest complete tool-call/result batch. It uses a tool-free summary request with a deterministic fallback; it is a bounded heuristic, not a guarantee that every provider/task retains perfect continuity. Incremental model streaming is implemented in the CLI/browser runtime with a non-streaming JSON fallback for compatible gateways.
- Extend the initial bundled capability catalog with remote marketplace discovery, version pinning, integrity checks, update/rollback, and supply-chain review.
- Expand provider/model capability probing to cover route availability, quota/auth failures, and clearer recovery guidance. The inert tool-call probe is implemented for setup and `oasis doctor --test-provider`.

## Milestone 3 — agent strength

- Upgrade plan mode into persistent task checklists with explicit acceptance criteria, execution gates, and regression-oriented verifier cycles.
- Add narrow specialist agents for review/testing/research, with bounded concurrency. **Progress:** the session task board now supports dependency-aware `task_claim`/`task_renew`/`task_release`, peer messages, named team lifecycle, and `dispatch_ready_tasks` for bounded model-directed waves of background workers in isolated worktrees. Cancellation/failure releases the worker's task lease. It remains session-local and does not run an autonomous persistent queue.
- **Progress:** up to two independent read-only specialist reviews can execute concurrently; parent tool-call results remain ordered. With `auto_dispatch: true`, the ready-task dispatcher fills freed slots and can start downstream work once prerequisite commits are integrated. It does not persist the live worker chain across process restarts, auto-merge branches, or resolve overlapping edits.
- **Progress:** OpenTelemetry export is implemented (metrics, events and nested traces over OTLP/HTTP JSON) and tested against a local collector.
- Add structured event logs, task checklists, stronger independent verification, and more complete undo/revert workflows.
- **Progress:** a `diagnostics` tool runs detected type checkers and linters (tsc, ESLint, Ruff, mypy, Pyright, go vet, cargo check) plus built-in JS/JSON syntax checks and returns structured problems. An `lsp` tool now keeps language servers running per session for definition, references, hover, symbols, call hierarchy, and pushed or pulled diagnostics. Auto memory keeps durable notes across sessions (Markdown files, BM25 recall, secret redaction, duplicate merging). MCP resources and prompts are supported. Session commands now include `/effort`, `/copy`, `/undo`, `/fork`, `/loop`, `/cd`, `/sandbox`, `/skills`, `/config`, `/doctor` and `/release-notes`. Workspace-specific policy rules remain future work.

## Milestone 4 — sandboxing and integrations

- Add a real isolation layer for unattended code execution; permission prompts alone are not a sandbox.
- Add embedded GitHub OAuth or GitHub App authentication with reviewed fine-grained scopes, branch/push/PR workflows, audit logs, and recovery. Current repository access reuses host-side GitHub CLI auth only.
- Expand the optional OpenHands bridge into a richer delegated-task lifecycle: direct event streaming, UI-linked confirmation status, and worktree change inspection/integration. Current bridge requires a separately configured Agent Server and profile; remote confirmations remain handled in OpenHands.
- Establish a well-tested install/bootstrap flow for supported platforms.
- **Progress:** the CLI has a persistent PTY manager and the browser includes a bundled xterm.js renderer; complete process-tree cleanup and cross-platform integration testing remain Alpha-gate work.
- **Progress:** the web bridge supports HTTPS with a user-provided certificate/key pair, enforces TLS 1.2+, and refuses non-loopback plaintext listeners unless `--allow-insecure-lan` is explicitly used. Certificate provisioning, phone trust onboarding, and real-device security tests remain unfinished.
- Share browser dashboard projects/tasks/notes with the selected repository workspace through a tested sync and conflict-resolution design.

## Deliberate non-claims

OASIS is not yet at Claude Code feature parity, and no apples-to-apples task benchmark demonstrates equal coding outcomes. The tested baseline is meaningful for a local-first single-machine coding agent, but it does not establish release maturity across every OS.

Current boundaries: the PTY/xterm path still needs broader cross-platform lifecycle testing; multi-agent task dispatch and named teams remain session-scoped without a durable visual run monitor or cross-session team service; branches are not merged automatically; embedded GitHub OAuth is not implemented; the general remote/mobile control lifecycle is incomplete; third-party plugin compatibility is feature-by-feature rather than universal; the optional sandbox is disabled by default and has no Windows implementation; native Gemini and JetBrains support remain gaps; desktop installers are unsigned; browser dashboard data does not fully sync with the CLI; and context compaction is a best-effort heuristic. The 21 fixture suite is only a smoke benchmark.

See [NEXT_MILESTONE.md](NEXT_MILESTONE.md) for the prioritized acceptance gate, [SECURITY_RELIABILITY_AUDIT.md](SECURITY_RELIABILITY_AUDIT.md) for findings and residual risks, [CURRENT_STATUS.md](CURRENT_STATUS.md) for verification evidence, and [CLAUDE_CODE_GAP.md](CLAUDE_CODE_GAP.md) for the source-backed capability comparison.
