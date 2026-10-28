# OASIS vs Claude Code — current gap analysis

**Comparison audited:** October 28, 2026  
**OASIS implementation baseline:** [`1da39af90f36629a706e0d452c1b5d5bbaeccc44`](https://github.com/FAHTHIZ/oasis/commit/1da39af90f36629a706e0d452c1b5d5bbaeccc44)  
**Verification:** the new dispatcher and hook-policy regression tests are included in this baseline; its CI run was pending when this note was updated. The prior green baseline passed 328 Node tests, 21/21 evaluation fixtures, the Node.js 22/24/26 matrix, and authenticated browser chat E2E. Do not treat prior results as validation of the new dispatcher. See [Current status](CURRENT_STATUS.md).

This comparison is based on the current OASIS source tree and the current official Claude Code documentation linked at the end. Feature similarity does not prove equivalent coding quality, speed, reliability, or safety.

## Verdict

OASIS already implements a broad share of the **single-machine CLI coding loop**: multi-step tool calling, workspace file operations, approvals, context handling, Git tools, subagents, MCP, hooks, skills, saved sessions, headless mode and an SDK. It also has model-provider flexibility and a local browser workspace.

It is **not** a drop-in Claude Code replacement across all workflows, and it is not yet at full feature parity. A real PTY session API and browser xterm.js rendering are now in place, but process cleanup and cross-platform validation are incomplete. Other major gaps include multi-agent team coordination, IDE/Chrome/cloud/mobile integrations, unsigned desktop packaging, no embedded GitHub OAuth, a partial extension-compatibility layer, no Windows sandbox, and no native Gemini adapter.

## Side-by-side capability check

| Area | OASIS today | Claude Code documented capability | OASIS status |
| --- | --- | --- | --- |
| Agentic coding loop | Multi-step model/tool calls; scoped file operations; command approvals; snapshots/checkpoints; Git and test tools; token/cost controls | Multi-step repository work with tool calls, approvals, terminal operations and verification | Core loop exists; comparative coding quality is not benchmarked |
| Model providers | OpenAI Responses, compatible Chat Completions, Anthropic Messages, Bedrock, Vertex, Microsoft Foundry, compatible gateways and local models | Anthropic models through supported first-party and third-party hosting routes | OASIS is broader in provider choice; Claude on Bedrock, Vertex and Microsoft Foundry all work with Claude Code's env vars; only a native Gemini adapter is absent |
| Interactive terminal | Custom CLI editor plus persistent PTY agent sessions; browser uses bundled xterm.js with input/ANSI/resize | Full-featured terminal UI and background-process workflows | **Partial:** PTY lifecycle API exists; cross-platform process cleanup and full workflow validation remain |
| Subagents | Built-in/custom subagents, up to six parallel child runs, background status/steering/cancel, optional worktree isolation | Subagents, agent view, agent teams, dynamic workflows and longer-running project sessions | Useful delegation exists; no visual agent manager or cloud project orchestration |
| Multi-agent coordination | Shared dependency-aware tasks, exclusive time-limited claims/releases, peer-to-peer messages, agent status/cancel, optional isolated worktrees, named teams with roster and controlled shutdown | Subagents plus agent teams with shared tasks, teammate messaging, worktree isolation and lifecycle controls | **Partial:** core coordination is implemented; no autonomous task scheduler, cross-session team sync, or dedicated visual team monitor |
| Code intelligence | Language-server navigation/references/hover/symbols/call hierarchy plus detected diagnostics and linters | Terminal/IDE code context and corresponding tool capabilities depending on surface | Substantial local functionality; language/platform breadth still needs validation |
| Extensions | MCP stdio/Streamable HTTP, OAuth where supported, resources/prompts, hooks, skills, slash commands and reviewed imports | Plugins, MCP, skills, hooks, subagents and commands; full integrated setup in supported surfaces | Closed for the Claude Code plugin format: marketplaces, `name@marketplace` installs, commands, agents, skills, hooks and MCP servers run natively (see sprint table) |
| Browser workspace | Local-hosted authenticated web agent with streamed events, approvals and host-GitHub-CLI repository cloning; separate local-storage dashboard | Web/desktop/IDE/mobile surfaces, Remote Control and cloud-backed projects/routines | Local web UI exists; no equivalent cloud/remote lifecycle, embedded GitHub OAuth, or dashboard/CLI data sync |
| IDEs | VS Code / Cursor / Windsurf extension (`oasis ide install`): auto-connect from integrated terminals, selection context, native diff Accept/Reject for edit approvals, IDE diagnostics tool, @file#lines references | Official VS Code and JetBrains integrations with editor-specific context/diff workflows | **Closed for VS Code family** (including the in-editor chat panel); no JetBrains plugin yet |
| Other surfaces | CLI + local browser runtime + GitHub Action | Desktop, web/cloud, mobile, Chrome, Slack and CI integrations | **Major gap** |
| Safety | Workspace/path checks, secret exclusions, approvals, opt-in Linux/macOS sandbox, snapshots and explicit untrusted extension handling | Permission modes, hooks and tool-execution safeguards integrated across supported surfaces | Useful safeguards exist, but no Windows sandbox and no claim of complete OS isolation |
| Evaluation | Built-in fixture runner; 21 small tasks; cost/time/token output | Official workflow and agent features; no equivalent OASIS-vs-Claude measured result is available from this repo | Good regression smoke harness; not a ranking benchmark |

## Agent-team parity: what is implemented and what remains

OASIS now has several core coordination mechanisms: an exclusive lease-based task board, peer-to-peer messages between running agents, per-agent status and cancellation, named teams, team rosters, membership-aware messaging, and a shutdown operation that blocks new members and requests cancellation of running workers. Team membership is selected when the main coordinator launches a worker with the `team_id` returned by `team_create`. The CLI `/teams` command shows the roster.

This still is not full Claude Code agent-team or dynamic-workflow parity:
- `dispatch_ready_tasks` now launches a bounded wave of dependency-ready tasks as background general-purpose agents in separate Git worktrees. It skips active leases and tasks already assigned to running workers; each task ID appears in agent status/events. Repeated model-directed calls can launch later waves as prerequisites complete.
- The dispatcher remains **explicitly opt-in and session-scoped**. `dispatch_ready_tasks` can set `auto_dispatch: true` to refill freed slots and launch newly unblocked tasks as workers finish. It records each task worker's branch/commit and will not dispatch downstream work against changed prerequisite code until that commit is an ancestor of the main checkout; it pauses and asks for review/integration instead. Failed, cancelled, or incomplete workers also pause the chain and release the incomplete task's lease when safe. The live worker chain does not survive process/session restarts; saved sessions now preserve a sanitized recovery checkpoint when auto-dispatch was active, and a resumed session marks it interrupted rather than silently restarting workers. OASIS still has no persistent scheduler/service or repeatable workflow script and never merges branches automatically.
- Teams are scoped to one OASIS session. They do not coordinate across independent sessions or machines.
- There is no dedicated visual agent/team monitor or automatic resolution of overlapping file edits. Worktree merge preflight reports overlap/conflicts; integration remains reviewable and approval-gated.
- Background workers cannot prompt for per-tool approval. Their edits and commands remain subject to the inherited permission mode and explicit allow rules.
- Team shutdown requests cancellation; a team becomes closed after its active workers exit. It does not promise instantaneous process termination.
- Agent teams and dynamic workflows remain a capability comparison, not a claim of equal coding quality. The 21-fixture suite is not an apples-to-apples benchmark.

The agent lifecycle emits a bounded, session-local activity timeline through `agent_events`, including worker starts/completions/failures/cancellations, team lifecycle, and queued peer/parent messages. Shared task claims can be renewed through `task_renew`; failed or cancelled dispatched workers now release their task lease immediately. This closes the first model-directed dispatch milestone, but not autonomous scheduling, persistent workflows, a visual monitor, or conflict repair.

## Core-loop parity sprint (October 28, 2026)

These changes close gaps in the everyday agent loop — the part users notice first when switching from Claude Code. Each item ships with regression tests.

| Gap | Claude Code behavior | OASIS now |
| --- | --- | --- |
| Output-token ceiling | 32k output tokens by default on current models; `CLAUDE_CODE_MAX_OUTPUT_TOKENS` override; recovers when a reply is cut off | **Closed.** Model-aware 32k/16k/8k defaults, `maxOutputTokens` / `OASIS_MAX_OUTPUT_TOKENS` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. A `max_tokens` / `length` / `max_output_tokens` stop on Anthropic, Chat Completions or Responses no longer fails the turn or runs a half-written tool call: the incomplete call is dropped and the model resumes in smaller steps (max 3 recoveries per turn). A provider 400 naming a smaller cap is learned for the session. |
| Read-before-edit and stale-file protection | Edit/Write refuse files not read this session, and files modified since they were read | **Closed.** Session file-state tracking (mtime + size + SHA-256). Overwrites require a prior read; every edit/overwrite is refused if the file changed on disk since it was read (content-hash check avoids false positives from touch/format no-ops). The agent's own writes refresh state. `requireReadBeforeEdit: "strict"` matches Claude Code exactly; the default also allows exact-match edits of unread files. |
| Plugins and marketplaces | `/plugin marketplace add`, `/plugin install name@market`, enable/disable/update/validate; plugins ship commands, agents, skills, hooks, MCP servers | **Closed.** `oasis plugin ...` and `/plugin ...` with the same verbs. Claude Code `marketplace.json` / `plugin.json` layouts, relative/github/url/git-subdir sources, `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`, `enabledPlugins` across user and trusted project settings, `--plugin-dir`, and plugins already installed by Claude Code are all honored. Verified against `anthropics/claude-code` (12 plugins). Also loaded: plugin LSP servers (`.lsp.json`, `extensionToLanguage`), monitors (`monitors/monitors.json`), output styles (`plugin:style`), `bin/` executables on `PATH`, the `settings.json` default `agent` (plus `--agent NAME`), and `userConfig` with `${user_config.KEY}`, `CLAUDE_PLUGIN_OPTION_*` and private storage for sensitive values (`oasis plugin config`, `oasis plugin show`). Not yet: npm sources, monitors, themes, channels. |
| IDE integration | VS Code/JetBrains extensions: selection context, diff review, diagnostics (`mcp__ide__getDiagnostics`), auto-connect from IDE terminals, `/ide` | **Closed for VS Code, Cursor, Windsurf.** Token-authenticated loopback bridge + lock-file discovery, `[ide] Selected N lines` context, edit approvals as native diffs with Accept/Reject, `ide_get_diagnostics` / `ide_open_file`, Ctrl/Cmd+Esc launch, Ctrl/Cmd+Alt+K `@file#L` references, dependency-free VSIX build, and an in-editor chat panel (streaming replies, inline Allow/Always/Deny approvals, Stop/interrupt, add-selection) over a Claude-SDK-style stream-json control protocol (`--permission-prompt-tool stdio`). JetBrains not yet. |
| Hooks parity | 25+ events, command/http/mcp_tool/prompt/agent handlers, `if` rules, async hooks, `onFailure`, exact-vs-regex matchers, `updatedToolOutput` | **Closed for the single-session loop.** All five handler types; `if` permission-rule filters; exec-form `args`; `async`/`asyncRewake` with next-request delivery; `onFailure: "block"`; Claude Code matcher semantics with `mcp__server__tool` names; `updatedToolOutput`; `PermissionDenied` retry; `impossible` Stop verdicts. New events: `PostToolBatch`, `PermissionDenied`, `StopFailure`, `UserPromptExpansion`, `InstructionsLoaded`, `TaskCreated`, `TaskCompleted`, `PreModelSwitch`, `PostModelSwitch`, `DirectoryAdded`, plus `FileChanged` (matcher files and `watchPaths`), `ConfigChange` (with live settings reload), `WorktreeCreate`/`WorktreeRemove` (hook-provided worktrees for non-git VCSs), `TeammateIdle` and `Setup` (`--init`, `--init-only`, `--maintenance`). `Elicitation`/`ElicitationResult` hooks can answer or override MCP elicitation requests. |
| Vim mode | `/vim` / `editorMode: "vim"`: INSERT/NORMAL, motions, operators, text objects | **Closed.** Same toggle and setting (Claude Code's `~/.claude.json` honored), mode indicator, `hjkl wbe WBE 0^$ gg G fFtT;,`, `d/c/y` + motions/text objects (`iw aw i" i( i{ ...`), `dd cc yy D C Y x X s S r ~ J p P u .`, counts, history on `j`/`k`. |
| Keybindings | `~/.claude/keybindings.json`, contexts, chords, `null` unbind, `/keybindings`, Ctrl+G external editor, Ctrl+S stash | **Closed** for the prompt contexts (Global, Chat, Autocomplete, HistorySearch). It reads Claude Code's file plus an OASIS override, hot-reloads, supports 3 s chords, `command:NAME` actions, reserved-key warnings and `/keybindings init`. Dialog contexts (Confirmation, Transcript, pickers) are parsed but not yet bindable. |
| MCP client features | Elicitation (form and URL), `roots/list`, `notifications/tools/list_changed`, `ping`, server log messages | **Closed.** OASIS now advertises `roots` and `elicitation` (protocol 2025-06-18) over stdio and Streamable HTTP, including server requests sent on the SSE response stream. Elicitations show a validated terminal form or a URL prompt. `Elicitation`/`ElicitationResult` hooks can answer them, and they are declined in headless runs. Tool lists refresh live when a server announces changes. MCP sampling is not supported, as in Claude Code. |
| Editor chat panel + SDK control protocol | Claude Code VS Code panel; SDK `control_request` `can_use_tool` / `interrupt` | **Closed.** OASIS sidebar and editor-tab chat with streaming text, tool rows, permission cards, Stop, New chat and Add Selection; `oasis -p --input-format stream-json --permission-prompt-tool stdio` answers approvals and interrupts over stdin/stdout for any host. |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_RESOURCE` / `_BASE_URL`, `_API_KEY`, `_AUTH_TOKEN`, Entra ID default credentials | **Closed.** Native `foundry` protocol with the same env vars and auth order (bearer > API key > `az` Entra token), resource-name validation, deployment-name models, streaming, setup preset. |
| Monitor tool + background notifications + plugin monitors | `Monitor` tool (command or WebSocket, events wake Claude), background-task completion notices, plugin `monitors/monitors.json` | **Closed.** `monitor` tool (argv command under Bash rules, or `ws`), line filter, batching, deadlines/persistent, idle-session wake, headless follow-up turns; automatic exit notices for background commands; plugin monitors with `always` / `on-skill-invoke:` triggers and `plugin validate` checks. |
| Channels + MCP server instructions | `--channels`, `notifications/claude/channel`, permission relay, `channelsEnabled`, server `instructions` in context | **Closed.** Same capability keys, notification methods, `<channel>` format, meta-key rules, five-letter relay ids, first-verdict-wins relay with sanitized/redacted previews, dev-channel confirmation, `channelsEnabled: false`, idle wake. Server `instructions` are added to the system prompt. |
| npm plugin sources | Marketplace entries with `source: { source: "npm", package, version, registry }` | **Closed.** `npm pack` (scripts never run) + `tar`, version ranges, custom https registry (http only for localhost), resolved version and integrity recorded in `installed_plugins.json`. |

## Ranked next improvements

This order is intentionally ranked by impact and architectural leverage rather than ease.

### 1. Real PTY and terminal lifecycle — implementation started, not closed

The CLI agent now supports a persistent PTY session API over the optional `node-pty` component. An approved `run_command` call can set `interactive=true`, then `terminal_read`, `terminal_input`, `terminal_resize`, `terminal_interrupt`, `terminal_stop`, and `terminal_list` manage the session. The manager bounds captured output and input, retains incremental offsets, tracks exit codes, caps active sessions, and closes sessions when OASIS closes.

The gap is not closed yet. The first native integration smoke test targets Linux/Node 22; Windows/macOS compatibility, child-process-tree cleanup, robust reconnection semantics, browser terminal transport and UI, and a beginner-friendly signed installer are still missing. The native dependency is optional to preserve CLI usability when local compilation fails. Closure requires native PTY tests on supported operating systems, deterministic cancellation and cleanup tests, permission/sandbox enforcement tests, interactive fixtures, bounded output verification and browser/CLI end-to-end behavior.

### 2. Automated team dispatch and visibility

Lease-based claiming/renewal, peer messaging, named teams, lifecycle events, and approval-gated worktree merge are implemented. `dispatch_ready_tasks` launches bounded waves in separate worktrees; opt-in automatic chaining fills freed slots but records prerequisite branch/commit provenance and defers dependent tasks until upstream commits are integrated into the main checkout. Failure/cancellation or incomplete work pauses chaining, and no branch is merged automatically. Remaining work is persistence across process restarts, visual monitoring, cross-session coordination, and richer conflict-aware review; this is not a claim that agents self-coordinate autonomously.

### 3. IDE integration — VS Code family shipped

The VS Code extension (`ide/vscode`, installed with `oasis ide install`) provides an authenticated local bridge, selection context, diff review for edit approvals, diagnostics and open-file tools, and session launch/continue commands. The chat panel (activity bar view and editor tab) shipped too, driven by `control_request`/`control_response` messages on stdio. Remaining: JetBrains plugin on the same RPC methods, and Marketplace publishing.

### 4. Remote and cross-surface lifecycle

Cloud/remote sessions, mobile steering, desktop, Chrome and Slack require process lifecycle, authentication, access scopes, workspace isolation, auditability and resumable jobs. A LAN-accessible `oasis web` server is not equivalent to those hosted services.

### 5. Remaining platform and ecosystem gaps

A native Gemini adapter; PowerShell and Windows sandboxing; plugin themes, OS-keychain storage for sensitive plugin options.

### 6. Terminal experience polish

Vim mode shipped (`/vim`, `editorMode`, with operators, motions, text objects, counts, registers and `.` repeat). Customizable keybindings (Claude Code's `keybindings.json`), the Ctrl+G external editor and the Ctrl+S prompt stash also shipped. Remaining: full-screen transcript, themes and bindable dialog contexts. These matter, but do not close the PTY, agent coordination or surface-access gaps above.

## What OASIS already does well

- MIT-licensed source and user choice across hosted and local model providers.
- Local-first CLI plus an authenticated browser agent without requiring OASIS model credentials to be shared with the browser.
- Built-in coding-agent regression fixtures and opt-in OpenTelemetry export.
- A broad tool layer for workspace editing, LSP/diagnostics, MCP, skills, hooks, notebooks, PDFs, Git and worktrees.
- Shared dependency-aware session task board, now present and tested, with honest documented limits.
- Bounded agent/team activity timeline, queryable by agent or team, to make coordination and failures auditable within a session.

## Evaluation and readiness caveats

- The **328 passing tests** demonstrate tested code paths, not 328 user-level end-to-end workflows.
- The **21 evaluation fixtures** are a smoke suite of small tasks, mostly standalone utilities. They are not a full-repository benchmark or an apples-to-apples Claude Code comparison.
- The authenticated browser E2E job is Linux Chromium; it does not establish mobile/Termux, Windows, cross-browser, real-device TLS, or live-cloud-provider readiness.
- The optional OS sandbox is disabled by default and currently targets Linux/macOS. Approved code can run with host privileges when it is off.
- History compaction is bounded and heuristic, so long-horizon continuity still requires evaluation across providers and long coding tasks.

## Official Claude Code sources checked October 28, 2026

- [Run agents in parallel](https://code.claude.com/docs/en/agents) — subagents, agent view, agent teams, dynamic workflows and projects.
- [Agent teams](https://code.claude.com/docs/en/agent-teams) — shared task lists, task claims, teammate messaging, experimental status and known limitations.
- [Platforms and integrations](https://code.claude.com/docs/en/platforms) — CLI, Desktop, VS Code, JetBrains, web, mobile, Chrome, Slack and CI/CD.
- [Commands](https://code.claude.com/docs/en/commands) — workflow commands including `/batch`, agent workflows, review and session controls.
- [Claude Code release changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) — implementation/release changes should be re-checked before each future parity audit.
