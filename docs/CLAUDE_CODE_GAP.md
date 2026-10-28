# OASIS vs Claude Code — current gap analysis

**Comparison audited:** October 28, 2026  
**OASIS implementation baseline:** [`eaa828d1fafce684737f4458e1fb3b9b1fe0a901`](https://github.com/FAHTHIZ/oasis/commit/eaa828d1fafce684737f4458e1fb3b9b1fe0a901)  
**Verification:** 328 passing Node tests; 21/21 evaluation fixtures; Node.js 22/24/26 CI checks; authenticated browser chat E2E passed. Details: [Current status](CURRENT_STATUS.md).

This comparison is based on the current OASIS source tree and the current official Claude Code documentation linked at the end. Feature similarity does not prove equivalent coding quality, speed, reliability, or safety.

## Verdict

OASIS already implements a broad share of the **single-machine CLI coding loop**: multi-step tool calling, workspace file operations, approvals, context handling, Git tools, subagents, MCP, hooks, skills, saved sessions, headless mode and an SDK. It also has model-provider flexibility and a local browser workspace.

It is **not** a drop-in Claude Code replacement across all workflows, and it is not yet at full feature parity. The major gaps are no real PTY/full-screen terminal, incomplete multi-agent team coordination, no IDE extensions, no Chrome/desktop/mobile/cloud surfaces, no embedded GitHub OAuth, a partial extension-compatibility layer, no Windows sandbox, and no native Gemini or Azure Foundry adapter.

## Side-by-side capability check

| Area | OASIS today | Claude Code documented capability | OASIS status |
| --- | --- | --- | --- |
| Agentic coding loop | Multi-step model/tool calls; scoped file operations; command approvals; snapshots/checkpoints; Git and test tools; token/cost controls | Multi-step repository work with tool calls, approvals, terminal operations and verification | Core loop exists; comparative coding quality is not benchmarked |
| Model providers | OpenAI Responses, compatible Chat Completions, Anthropic Messages, Bedrock, Vertex, compatible gateways and local models | Anthropic models through supported first-party and third-party hosting routes | OASIS is broader in provider choice; native Gemini/Azure adapters remain absent |
| Interactive terminal | Custom line editor, history, completions, streaming, diffs, background argv commands and optional shell mode | Full-featured CLI interaction plus a fullscreen renderer; terminal and background-command workflows | **Major gap:** no real PTY lifecycle or full-screen TUI |
| Subagents | Built-in/custom subagents, up to six parallel child runs, background status/steering/cancel, optional worktree isolation | Subagents, agent view, agent teams, dynamic workflows and longer-running project sessions | Useful delegation exists; no visual agent manager or cloud project orchestration |
| Shared tasks | `task_create/list/get/update`, dependency validation, owner metadata, status transitions, persistence with saved sessions | Agent teams share a task list; teammates with Task tools can see/claim tasks, and teams support direct messaging | **Partial:** task board exists; no atomic claims/locks, peer messages, lifecycle manager, visible team monitor or conflict-safe coordination |
| Code intelligence | Language-server navigation/references/hover/symbols/call hierarchy plus detected diagnostics and linters | Terminal/IDE code context and corresponding tool capabilities depending on surface | Substantial local functionality; language/platform breadth still needs validation |
| Extensions | MCP stdio/Streamable HTTP, OAuth where supported, resources/prompts, hooks, skills, slash commands and reviewed imports | Plugins, MCP, skills, hooks, subagents and commands; full integrated setup in supported surfaces | Native ecosystem imports are partial, not drop-in plugin compatibility; no general remote marketplace |
| Browser workspace | Local-hosted authenticated web agent with streamed events, approvals and host-GitHub-CLI repository cloning; separate local-storage dashboard | Web/desktop/IDE/mobile surfaces, Remote Control and cloud-backed projects/routines | Local web UI exists; no equivalent cloud/remote lifecycle, embedded GitHub OAuth, or dashboard/CLI data sync |
| IDEs | No native VS Code or JetBrains extension | Official VS Code and JetBrains integrations with editor-specific context/diff workflows | **Major gap** |
| Other surfaces | CLI + local browser runtime + GitHub Action | Desktop, web/cloud, mobile, Chrome, Slack and CI integrations | **Major gap** |
| Safety | Workspace/path checks, secret exclusions, approvals, opt-in Linux/macOS sandbox, snapshots and explicit untrusted extension handling | Permission modes, hooks and tool-execution safeguards integrated across supported surfaces | Useful safeguards exist, but no Windows sandbox and no claim of complete OS isolation |
| Evaluation | Built-in fixture runner; 21 small tasks; cost/time/token output | Official workflow and agent features; no equivalent OASIS-vs-Claude measured result is available from this repo | Good regression smoke harness; not a ranking benchmark |

## The shared task board is a milestone, not agent-team parity

The task board shipped in the implementation baseline is implemented in `src/shared-tasks.mjs`, registered through `src/session-tools.mjs`, and persisted by `src/sessions.mjs`. It lets the main agent and child agents create tasks, inspect them, assign owner metadata, record prerequisite IDs, and update statuses. Cycles and blocked transitions are rejected.

It does **not** yet:
- provide atomic "claim this next task" behavior or task locks;
- automatically schedule tasks or assign a worker to an owner field;
- enable peer-to-peer agent messaging or autonomous team self-coordination;
- manage team create/join/leave/shutdown lifecycles or show a visual agent roster;
- prevent file edits from colliding unless work is explicitly isolated in worktrees;
- synchronize the task board between independent sessions, machines or the browser dashboard's local-storage tasks.

Claude Code documents agent teams as **experimental and disabled by default**. Its official comparison distinguishes subagents (lead-managed delegated workers) from teams (shared tasks plus teammate messages). That is the correct bar for the remaining Oasis coordination work, not a reason to overstate what the current board already does.

## Ranked next improvements

This order is intentionally ranked by impact and architectural leverage rather than ease.

### 1. Real PTY and terminal lifecycle — next foundational target

The current command runner intentionally launches argv processes without a real terminal. That prevents reliable interactive stdin, TUI applications, terminal dimensions/resizing, and full interactive process control. Implementing a PTY behind a clear lifecycle API (start, stream, write input, resize, interrupt/kill, exit status, cleanup) would improve the CLI and browser runtime rather than adding one isolated feature.

Acceptance gates should include deterministic process cleanup, cancellation, bounded output, permission/sandbox enforcement, interactive fixture tests, and platform-specific tests before claiming the PTY is complete.

### 2. Complete multi-agent coordination

Build on the shared dependency-aware board with atomic claims/locks, explicit ownership rules, peer-to-peer message routing, team lifecycle controls, worktree conflict reporting and safe merge/review. Do not describe tasks as auto-claimed or files as conflict-safe until there are tests for those guarantees.

### 3. IDE integration

Start with VS Code: authenticated handoff to the existing runtime, selected-file context, inline/diff review, approval visibility, cancellation, session continuation and shared task state. Add JetBrains only after the common transport/API is stable and tested.

### 4. Remote and cross-surface lifecycle

Cloud/remote sessions, mobile steering, desktop, Chrome and Slack require process lifecycle, authentication, access scopes, workspace isolation, auditability and resumable jobs. A LAN-accessible `oasis web` server is not equivalent to those hosted services.

### 5. Remaining platform and ecosystem gaps

Native Gemini and Azure Foundry adapters; PowerShell and Windows sandboxing; a real plugin-marketplace format and safer lifecycle/secret provisioning for full external ecosystems; broader hook parity.

### 6. Terminal experience polish

Full-screen transcript, vim mode, themes and an editable keybinding configuration. These matter, but do not close the PTY, agent coordination or surface-access gaps above.

## What OASIS already does well

- MIT-licensed source and user choice across hosted and local model providers.
- Local-first CLI plus an authenticated browser agent without requiring OASIS model credentials to be shared with the browser.
- Built-in coding-agent regression fixtures and opt-in OpenTelemetry export.
- A broad tool layer for workspace editing, LSP/diagnostics, MCP, skills, hooks, notebooks, PDFs, Git and worktrees.
- Shared dependency-aware session task board, now present and tested, with honest documented limits.

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
