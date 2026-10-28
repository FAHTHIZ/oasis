# OASIS current implementation status

**Audit date:** October 28, 2026  
**Implementation baseline:** [`1da39af90f36629a706e0d452c1b5d5bbaeccc44`](https://github.com/FAHTHIZ/oasis/commit/1da39af90f36629a706e0d452c1b5d5bbaeccc44)  
**Package version:** `0.3.0` · **Runtime:** Node.js 22+ · **License:** MIT

This is the repository-grounded status page. It distinguishes working code, CI evidence, and incomplete work. A planned feature, detected extension, README statement, or successful unit test is not by itself evidence of production readiness or competitive parity.

## Executive assessment

OASIS is a substantial, local-first coding-agent project with a capable CLI, a local browser workspace, a multi-provider tool-calling runtime, workspace editing, approvals, extension integrations, language tooling, and evaluation fixtures. It is designed for a developer working in a repository on one machine, with a browser-based companion runtime.

**It is not yet at Claude Code feature parity.** The most consequential missing foundations are a real interactive PTY/terminal lifecycle, complete multi-agent coordination, and the IDE/remote surfaces that let a coding agent travel with the developer's workflow. OASIS has a shared task board now, but not a complete agent-team system. Its smoke evaluation suite measures regressions in 21 small tasks; it does not show that OASIS matches Claude Code's coding quality on large projects.

## Verified repository and CI snapshot

The implementation audit enumerated the source tree, module imports/exports, project documentation, test/evaluation layout, browser app, public site, package metadata, and GitHub workflows.

| Evidence | Verified result |
| --- | --- |
| Runtime modules | 60 `.mjs` modules under `src/` |
| Test suite | 47 `*.test.mjs` specifications, plus a shared test helper |
| Node tests | Prior green baseline: **328 passed, 0 failed**; dispatcher/hook regression additions are awaiting this commit's CI result |
| Coding-agent evaluation fixtures | **21/21 validated**; this is a small smoke suite, not a coding-quality benchmark |
| Runtime matrix | Node.js 22, 24, and 26 passed |
| Browser E2E | Authenticated browser chat smoke test passed, including a workspace write/read cycle |
| Package integrity | `npm pack --dry-run` passed; installable package content was checked |
| CI status | Quality Checks and public-site publishing completed successfully for the implementation baseline |
| Package entry points | CLI executable `oasis`, ESM SDK, Node.js 22+ |
| Release maturity | Version `0.3.0`, installed from Git; CI success is not a claim of a mature cross-platform release |

CI details: [Quality Checks run](https://github.com/FAHTHIZ/oasis/actions/runs/40707129933) is running for the dispatcher baseline; the prior verified run was [40679100237](https://github.com/FAHTHIZ/oasis/actions/runs/40679100237). Test counts are regression coverage, **not** independent end-to-end product workflows. The browser test runs in Linux Chromium; it does not prove Android/Termux, Windows, macOS, live provider, or real-device TLS behavior. The CI log also emitted a GitHub Actions runtime-deprecation warning for `actions/checkout@v4` and `actions/setup-node@v4`; upgrade those action versions as a separate maintenance item.

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
- Supported provider paths include Anthropic on AWS Bedrock and Google Vertex, plus compatible gateways and local endpoints such as OpenRouter, Gemini's OpenAI-compatible endpoint, Ollama/LM Studio, and OmniRoute.
- Provider setup verifies an inert tool call before saving settings; configured models must support tool calling.
- Native Gemini and Azure Foundry adapters are not implemented in this baseline. A Gemini-compatible endpoint is not the same as a native Gemini adapter. Live authenticated testing of all cloud accounts is still needed.

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

This ranking considers how much each gap constrains real work and what it unlocks downstream. It is a proposed engineering order, not a promise that later work is trivial.

1. **Finish PTY reliability and portability.** OASIS has a persistent PTY session API and browser xterm.js renderer. The native integration check currently targets Linux/Node 22; Windows/macOS process-tree cleanup, reconnect behavior, and broader end-to-end validation remain open.
2. **Complete multi-agent coordination.** A bounded `dispatch_ready_tasks` wave is now implemented with task-linked workers, isolated worktrees, dependency gating, and lease cleanup on cancellation/failure. Remaining work: autonomous/persistent workflow scheduling, visual monitoring, cross-session coordination, and richer conflict-aware review.
3. **IDE integration.** A VS Code extension would put reviewable diffs, task/session status and the same agent runtime inside the main coding surface.
4. **Remote and cross-surface workflows.** Cloud/remote sessions, mobile steering, desktop, Chrome and chat integrations require a stronger authentication, execution-isolation and lifecycle design than the current local browser bridge.
5. **Platform and extension parity.** Native Gemini/Azure adapters, PowerShell/Windows sandboxing, broad extension runtime compatibility and a remote plugin marketplace.
6. **Terminal polish.** Full-screen transcript, vim mode, themes and editable keybinding files.

## Safety and release-readiness boundaries

- The optional OS sandbox is disabled by default and currently targets Linux and macOS. There is no Windows sandbox. Without the sandbox, approved project scripts execute with the host user's OS privileges.
- Permission prompts and path checks reduce risk but are not a substitute for OS isolation. A local model does not make code execution safe.
- Third-party plugin imports are safety-reviewed subsets; detection does not mean full runtime compatibility.
- History compaction is heuristic. Long sessions still need provider-by-provider and long-horizon evaluation for continuity.
- The browser command panel now supports approved PTY sessions through a locally bundled xterm.js renderer; browser TLS setup for non-loopback access still depends on user-provided certificates.
- Current CI is green, but coverage does not establish a full security audit, real-device support, cross-platform usability, or equivalence with Claude Code's code quality.

## Source references

- [OASIS implementation baseline](https://github.com/FAHTHIZ/oasis/commit/eaa828d1fafce684737f4458e1fb3b9b1fe0a901)
- [Quality Checks workflow](https://github.com/FAHTHIZ/oasis/actions/runs/40679100237)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code approaches to running agents](https://code.claude.com/docs/en/agents)
- [Claude Code platforms and integrations](https://code.claude.com/docs/en/platforms)
- [Claude Code commands](https://code.claude.com/docs/en/commands)
- [Claude Code release changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) — implementation/release changes should be re-checked before each future parity audit.


## PTY milestone update (October 28, 2026)

The agent runtime now has a real PTY session manager wired into the approved `run_command` path. Set `interactive=true` to start a persistent interactive session; `terminal_read`, `terminal_input`, `terminal_resize`, `terminal_interrupt`, `terminal_stop`, and `terminal_list` control it. The manager bounds captured output and input, limits active sessions, tracks exit status, supports incremental reads and stops sessions when the parent OASIS session closes. The native `node-pty` binding is optional and lazy-loaded; ordinary commands keep working if it is unavailable.

This is **partial terminal and desktop-install groundwork, not completion of the whole gap**. The browser now has an xterm.js renderer connected to authenticated PTY routes. Native PTY integration is tested on Linux/Node 22, while Windows/macOS process behavior and child-process-tree cleanup remain open. Desktop install packaging is scaffolded for Windows, macOS and Linux, but platform build artifacts must pass and signing credentials are not configured, so a verified signed release has not shipped.
