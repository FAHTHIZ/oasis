# OASIS current implementation status

**Audit date:** October 29, 2026  
**Implementation baseline:** [`eeb5e7ee623ed18dc9c7fcca79b9ebd0503e25c4`](https://github.com/FAHTHIZ/oasis/commit/eeb5e7ee623ed18dc9c7fcca79b9ebd0503e25c4)  
**Package version:** `0.3.0` · **Runtime:** Node.js 22+ · **License:** MIT

This is the repository-grounded status page. It separates shipped implementation, automated evidence and known gaps. A feature name, passing unit test, or successful artifact build is not by itself proof of cross-platform readiness or competitive coding quality. See [Next milestone](NEXT_MILESTONE.md) for the prioritized Alpha-confidence checklist.

## Executive assessment

OASIS has grown into a feature-rich, local-first coding-agent project: CLI and headless runtime, multiple hosted/local model routes, tools for editing and verification, MCP, skills/hooks/plugins, session memory, subagents and task coordination, a browser workspace with a PTY/xterm path, a VS Code-family extension, a GitHub Action, and a desktop packaging pipeline.

The present bottleneck is **release confidence, not raw feature count**. The latest Quality Checks and desktop build workflows passed on the current main commit, but the homepage/repository validation workflow failed its `FileChanged` hook test on that same commit. Until the discrepancy is reproduced, explained and fixed, the overall CI signal is mixed. OASIS also has no apples-to-apples coding-task benchmark against Claude Code; its 21 evaluation fixtures are still a smoke suite of mostly small tasks.

## Verified repository and CI snapshot

**Current main:** `eeb5e7ee623ed18dc9c7fcca79b9ebd0503e25c4` (October 29, 2026).

| Evidence | Latest verified result |
| --- | --- |
| Runtime modules | 60 `.mjs` modules under `src/` in the latest repository inventory |
| Test layout | 47 `*.test.mjs` specifications plus a shared helper in the prior file inventory |
| Node test suite | **549 passed, 0 failed** in [Quality Checks run 40795987277](https://github.com/FAHTHIZ/oasis/actions/runs/40795987277) |
| Evaluation-fixture validation | **21/21 valid**; a small regression/smoke suite, not a full coding benchmark |
| Node runtime matrix | Node.js 22, 24 and 26 passed in the latest Quality Checks run |
| Native PTY check | Real interactive-process smoke test passed on Linux / Node.js 22; this is not proof of Windows/macOS/Termux support |
| Browser E2E | Linux Chromium authenticated chat smoke test passed, including a workspace write/read cycle |
| Package integrity | Production-package checks passed in the latest Quality Checks run |
| Desktop packaging | [Build OASIS desktop installers run 40795987139](https://github.com/FAHTHIZ/oasis/actions/runs/40795987139) passed |
| Homepage/repository validation | [Run 40795987174](https://github.com/FAHTHIZ/oasis/actions/runs/40795987174) failed in the validation step on the `FileChanged` hook test on the same commit |
| Release maturity | Package version `0.3.0`; CI can build desktop installers, but the current installers are unsigned and first-run behavior is not yet proven across all supported operating systems |

The conflicting workflow results must remain visible: a green Quality Checks run does not cancel out a failing publishing validation run. The failure should be treated as unresolved until the focused test is reproducible and both workflows pass on one commit. The quality browser smoke test runs in Linux Chromium; it does not establish Android/Termux, Windows/macOS PTY lifecycle, real-device TLS, cross-browser, or live-cloud-provider readiness.

## What the code currently provides

### 1. Coding-agent runtime and CLI

- Interactive terminal editor with multiline input, workspace history/search, tab completion, type-ahead, interruption, streamed Markdown, and edit diffs.
- Multi-step model/tool loops for OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic Messages.
- One-shot/headless text, JSON, and stream-JSON workflows, an SDK, budget/cost tracking, token/tool-call limits, saved sessions, and best-effort context compaction.
- Workspace-bound read/write/edit/delete tools, glob/search, shell and argv command tools, background-process controls, package-install planning, checkpoints, backups, rewind, and Git operations.
- Slash commands and workflows including `/plan`, `/goal`, `/batch`, `/simplify`, `/verify`, `/btw`, `/recap`, `/loop`, `/schedule`, `/commit`, and `/pr`.
- The CLI now exposes persistent PTY sessions to the agent; the browser workspace renders them with bundled xterm.js. Native PTY support still needs Windows/macOS validation and reliable process-tree cleanup, and this is not yet a polished standalone full-screen CLI TUI.

### 2. Models and providers

- Native OpenAI Responses, OpenAI-compatible Chat Completions, and native Anthropic Messages protocol.
- Supported provider paths include Anthropic on AWS Bedrock, Google Vertex and Microsoft Foundry (Azure), plus compatible gateways and local endpoints such as OpenRouter, Gemini's OpenAI-compatible endpoint, Ollama/LM Studio, and OmniRoute.
- Provider setup verifies an inert tool call before saving settings; configured models must support tool calling.
- Claude on Microsoft Foundry is supported natively (`foundry` protocol). A native Gemini adapter is not implemented in this baseline. A Gemini-compatible endpoint is not the same as a native Gemini adapter. Live authenticated testing of all cloud accounts is still needed.

### 3. Code understanding and verification

- File listing, ranged reads, exact-string patch edits, snapshots/checkpoints, Git status/diff/log/commit/branch/push tooling, and worktree creation.
- Language-server support for navigation, references, hover, symbols, call hierarchy and diagnostics, plus detected type-checker/linter diagnostics.
- PDF text extraction, notebook cell reading/editing, and image input for vision-capable providers.
- Web search and bounded public-document fetching.
- `oasis eval` uses reviewed reference tasks and verifiers. Its 21-task starter set is intentionally too small and utility-heavy to rank large-repository coding performance reliably.

### 4. Agents and task coordination

- Built-in/custom subagents with separate context, bounded parallel execution, background status, steering/resume/cancel tools, and optional worktree isolation.
- Separate specialist reviews for code, security, architecture, and test strategy are bounded and read-only.
- A shared **session-local** dependency-aware task board is available to the main agent and child agents through `task_create`, `task_list`, `task_get`, and `task_update`. It validates task IDs, prerequisite existence, cycles, and blocked status transitions. Its task data is included in saved sessions.
- The board supports exclusive lease-based `task_claim`/`task_renew`/`task_release`, dependency gates, and shared status. `dispatch_ready_tasks` starts a bounded wave of ready tasks as background agents in isolated worktrees, skips active claims and already-running assignments, and tags each agent with its task ID. By default, the coordinator launches one manual wave; with explicit `auto_dispatch: true`, OASIS refills freed slots and launches newly unblocked tasks as workers finish. It records each task's worker branch/commit and defers dependent work until prerequisite commits are integrated into the main checkout; it pauses with a review/integration message instead of running downstream tasks against stale code. Failed/cancelled/incomplete workers also pause chaining and release an incomplete worker's lease when safe. The live scheduler is session-scoped; saving an active auto-dispatch workflow now records a sanitized recovery checkpoint, and resuming the session marks the workflow interrupted rather than reviving nonexistent workers. It still is not a persistent scheduler and never merges worktrees automatically.
- Running agents can message peers directly; `team_create`, `team_status`, and `team_shutdown` provide named session-local teams, a member roster, membership-aware messaging, and controlled shutdown. This is model-directed wave dispatch, not an autonomous persistent scheduler: there is no cross-session synchronization, dedicated visual team manager, automatic conflict repair, or dynamic-workflow script runner.
- Worktree isolation can keep independent edits apart, but it is an explicit execution choice, not an automatic coordination guarantee.

### 5. Integrations, skills, and extensions

- MCP stdio and Streamable HTTP support, server configuration, OAuth flows where supported, resources, prompt exposure, deferred tool discovery, and an MCP server mode.
- Hooks, custom slash commands, output styles, layered memory, auto memory, a reviewed capability catalog, and portable Agent Skills.
- Inspect/import flows recognize Claude Code, Codex, Gemini CLI and portable-skill layouts. Imported Markdown prompts and standard text resources can be supported, while native hooks, scripts, dependency lifecycle execution, full command semantics, and all ecosystem manifest features are not automatically activated. This is **not** drop-in compatibility with every third-party plugin.
- An optional OpenHands bridge can delegate to a separately configured, running Agent Server; OASIS does not install or provision that remote service for you.
- A GitHub Action supports `@oasis`-triggered issue/PR workflows.

### 6. Browser workspace and public site

- `oasis web` serves a local-hosted authenticated agent runtime with streamed responses, visible tool activity, approvals, saved sessions, and a workspace command runner.
- Non-loopback use expects TLS certificates unless the operator explicitly opts into insecure LAN HTTP. Device certificate/trust onboarding and real-device security tests remain incomplete.
- The browser dashboard's projects/tasks/notes use browser local storage. They do **not** sync with CLI workspace data or the agent shared-task board.
- Browser GitHub access reuses the host's GitHub CLI login (`gh auth login`); it is not embedded GitHub OAuth or a GitHub App integration.
- The static public site is served through GitHub Pages. It is not a desktop/mobile app or a remote cloud-agent service.

## Code inventory

All 59 files listed here are in `src/` and participate in the shipped codebase. This categorization is for navigation, not a guarantee that every combination is end-to-end tested.

| Subsystem | Source modules |
| --- | --- |
| Agent loop, coordination, sessions, memory and recovery | `agent.mjs`, `agent-tasks.mjs`, `auto-memory.mjs`, `auto-mode.mjs`, `backups.mjs`, `checkpoints.mjs`, `context.mjs`, `memory.mjs`, `session-tools.mjs`, `sessions.mjs`, `shared-tasks.mjs`, `subagents.mjs` |
| CLI and interaction | `cli.mjs`, `clipboard-path.mjs`, `clipboard.mjs`, `commands.mjs`, `completion.mjs`, `headless.mjs`, `input-history.mjs`, `line-editor.mjs`, `markdown.mjs`, `output-styles.mjs`, `slash.mjs`, `status-line.mjs`, `terminal-ui.mjs`, `update.mjs` |
| Configuration, policy and safety | `config.mjs`, `doctor.mjs`, `hooks.mjs`, `permissions.mjs`, `sandbox.mjs`, `settings.mjs` |
| Workspace tools, Git and verification | `diagnostics.mjs`, `eval.mjs`, `git-tools.mjs`, `images.mjs`, `installer.mjs`, `json-schema.mjs`, `lsp.mjs`, `notebook.mjs`, `pdf.mjs`, `power-tools.mjs`, `pricing.mjs`, `tools.mjs`, `worktrees.mjs` |
| Providers, protocols and integrations | `cloud-providers.mjs`, `extensions.mjs`, `github-action.mjs`, `mcp-auth-commands.mjs`, `mcp-extras.mjs`, `mcp-oauth.mjs`, `mcp-project.mjs`, `mcp-serve.mjs`, `mcp.mjs`, `plugins.mjs`, `sdk.mjs`, `telemetry.mjs`, `web-search.mjs`, `web.mjs` |

Repository-level verification also covers `index.html`, `manifest.webmanifest`, `sw.js`, the public landing page and its metadata checks, `action.yml`, CI workflows, 15 bundled skill guides, the test suite and 21 evaluation fixtures.

## Highest-impact remaining gaps

Prioritized by the risk they pose to release confidence and everyday usefulness—not by how exciting or visible a new feature would be.

1. **Make CI deterministic and uniformly green.** The same `FileChanged` hook test failed in homepage validation while the quality workflow passed on the same commit. Reproduce, identify the cause and make the check deterministic before declaring the current baseline green.
2. **Measure real coding outcomes.** The 21-task suite is too small and too utility-heavy to measure repository-level software work. Build a reproducible OASIS-vs-Claude Code task suite with pinned repos/models where possible, acceptance tests, repeated trials, costs/timing, and reviewed diffs.
3. **Validate product journeys across platforms.** The Linux/Node 22 PTY smoke and Linux Chromium chat smoke are useful, but they do not prove native PTY cleanup on Windows/macOS or first-run/update/uninstall behavior for every desktop installer. Termux remains experimental for PTY.
4. **Finish multi-agent lifecycle visibility.** Teams, leases, activity events, bounded worktree dispatch, and tmux panes exist. The remaining gaps are a visual agent/run monitor, durable pause/resume across process restarts, cross-session messaging, and conflict-aware integration. Avoid claiming self-coordinating persistent teams.
5. **Only then expand remote surfaces.** Remote/mobile/hosted sessions need authenticated identity, trusted-device management, workspace isolation, execution policy, reconnect/recovery, and audit trails—not simply a network-accessible web server.
6. **Continue platform/safety work.** No Windows OS sandbox exists; the optional Linux/macOS sandbox is off by default. A native Gemini adapter and JetBrains plugin remain gaps. Desktop builds currently succeed but are unsigned.

See [Next milestone](NEXT_MILESTONE.md) for the task-level checklist and acceptance criteria.

## Safety and release-readiness boundaries

- The optional OS sandbox is disabled by default and currently targets Linux and macOS. There is no Windows sandbox. Without the sandbox, approved project scripts execute with the host user's OS privileges.
- Permission prompts and path checks reduce risk but are not a substitute for OS isolation. A local model does not make code execution safe.
- Third-party plugin imports are safety-reviewed subsets; detection does not mean full runtime compatibility.
- History compaction is heuristic. Long sessions still need provider-by-provider and long-horizon evaluation for continuity.
- The browser command panel has a PTY-backed path with a bundled xterm.js renderer. The web runtime supports HTTPS with user-provided certificate/key files for non-loopback access; broader terminal lifecycle and real-device TLS validation remain open.
- CI is mixed on the audited commit: Quality Checks and desktop packaging passed, but homepage/repository validation failed the `FileChanged` hook test. Coverage also does not establish a full security audit, real-device support, cross-platform usability, or equivalence with Claude Code's code quality.

## Source references

- [Current implementation baseline](https://github.com/FAHTHIZ/oasis/commit/eeb5e7ee623ed18dc9c7fcca79b9ebd0503e25c4)
- [Latest Quality Checks](https://github.com/FAHTHIZ/oasis/actions/runs/40795987277)
- [Latest homepage/repository validation — failure to investigate](https://github.com/FAHTHIZ/oasis/actions/runs/40795987174)
- [Latest desktop installer build](https://github.com/FAHTHIZ/oasis/actions/runs/40795987139)
- [Alpha-confidence milestone](NEXT_MILESTONE.md)
- [Claude Code agent/workflow documentation](https://code.claude.com/docs/en/agents)
- [Claude Code Remote Control documentation](https://code.claude.com/docs/en/remote-control)
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices)

## PTY milestone update (October 28, 2026)

The agent runtime now has a real PTY session manager wired into the approved `run_command` path. Set `interactive=true` to start a persistent interactive session; `terminal_read`, `terminal_input`, `terminal_resize`, `terminal_interrupt`, `terminal_stop`, and `terminal_list` control it. The manager bounds captured output and input, limits active sessions, tracks exit status, supports incremental reads and stops sessions when the parent OASIS session closes. The native `node-pty` binding is optional and lazy-loaded; ordinary commands keep working if it is unavailable.

This is **partial terminal and desktop-install groundwork, not completion of the whole gap**. The browser now has an xterm.js renderer connected to authenticated PTY routes. Native PTY integration is tested on Linux/Node 22, while Windows/macOS process behavior and child-process-tree cleanup remain open. Desktop install packaging is scaffolded for Windows, macOS and Linux, but platform build artifacts must pass and signing credentials are not configured, so a verified signed release has not shipped.
