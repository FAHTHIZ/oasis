# Oasis vs Claude Code: gap analysis

Audited October 28, 2026, against Claude Code v2.1.x using its [commands reference](https://code.claude.com/docs/en/commands.md), [tools reference](https://code.claude.com/docs/en/tools-reference.md), [CLI reference](https://code.claude.com/docs/en/cli-reference.md) and [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md). Every "have" below was checked in `src/` and covered by tests (319 passing), not taken from older docs.

## Short answer

For a developer working in a terminal on one machine, Oasis now covers almost all of Claude Code's day-to-day loop. That loop includes:

- The interactive editor, history, completion, modes, `!` shell, image paste, Markdown and diff rendering, type-ahead and Esc-to-interrupt.
- Tools, subagents, permissions, hooks, MCP, memory, rewind, headless and SDK.
- Most of the CLI flags.
- The newer workflow commands: `/goal`, `/btw`, `/batch`, `/simplify`, `/verify`, scheduling and tool search.

What remains is mostly UI polish: a full-screen TUI, vim mode, themes and keybinding files. Integration surfaces are the other gap: IDE extensions, Chrome, desktop, cloud and mobile.

## Where Oasis is ahead

| Area | Oasis | Claude Code |
|---|---|---|
| Models | Any provider: OpenAI, Anthropic, Bedrock, Vertex, OpenRouter, Gemini (OpenAI-compatible), Ollama, LM Studio, OmniRoute. Fully offline with a local model. | Anthropic models only (direct, Bedrock, Vertex, Foundry) |
| License | MIT, all source in this repo | Proprietary |
| Cost | `/cost` in USD with per-model pricing, `--max-budget-usd`; local models cost $0 | API pricing or a subscription |
| Extensions | Imports Claude Code plugins, Codex and Gemini extensions, with integrity-checked updates and rollback | Claude plugins only |
| Browser workspace | `oasis web`: authenticated chat with tool activity and approvals, usable from a phone over LAN with TLS | Needs claude.ai or Remote Control (Anthropic cloud) |
| Evaluation | `oasis eval` harness for coding-agent fixtures | None built in |
| Delegation | Optional OpenHands delegation | None |
| Telemetry | None by default; opt-in OTLP with nested traces (turn > request / tool > subagent) | Telemetry on by default; flat OTel events |
| Extra commands | `/commit`, `/pr`, `/diagnostics`, `/undo`, `/todos`, `/bashes`, `/worktrees`, `/remember`, `/mode`, `/cd`, `/privacy-settings` (local, no plan needed), backups/restore/trust | Several exist only as skills or plugins |
| Lean mode | Bundled [Ponytail](https://github.com/DietrichGebert/ponytail) skills (`/ponytail`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`) for the smallest complete change | Not bundled |

## What Oasis matches

| Area | Oasis today |
|---|---|
| Interactive terminal | Multiline editor (Shift+Enter, Alt+Enter, Ctrl+J, trailing `\`), history per workspace in `~/.oasis/history.jsonl`, Ctrl+R search, Tab completion for `/commands` and fuzzy `@files`, Shift+Tab mode cycling, `!` shell mode feeding context into the next message, Ctrl+V image paste, `?` shortcuts, `#` memory, Esc Esc rewind, type-ahead queue, Esc to interrupt, animated startup banner, streaming Markdown with syntax highlighting, colored edit diffs |
| File tools | read (ranged, images, notebooks, PDFs), write, edit, multi_edit, notebook_edit, glob, grep (ripgrep), delete |
| Commands | argv `run_command`, opt-in `run_shell`, background processes, `command_output`, `kill_command`, `list_background`, `monitor_command` (wait for a regex, exit or timeout) |
| Code intelligence | `lsp` (definition, references, hover, implementation, symbols, call hierarchy, diagnostics; 12 built-in servers), `diagnostics` tool |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_branch`, `git_push`, `create_pull_request`, `/commit`, `/pr`, `/review [PR]`, `/security-review`, `--from-pr` |
| Web | `fetch_url`, `web_search` (keyless, Tavily, Brave, SearXNG) |
| Planning | plan mode, `enter_plan_mode`, `exit_plan_mode`, `todo_write`, `/plan` |
| Questions | `ask_user_question` (terminal and browser) |
| Subagents | `task` with custom agents (`.claude/agents`, `.oasis/agents`, `--agents` JSON), per-agent tools and model, worktree isolation, background agents with `agent_status`, `send_message`, `agent_stop`, `/tasks`, `/stop`; up to 6 in parallel |
| Workflows | `/goal` (model-judged condition across turns), `/loop`, `/batch` (plan, then parallel worktree subagents), `/simplify` (four parallel reviewers), `/verify` (run the app), `/btw` and `/recap` (side questions that leave history untouched) |
| Scheduling | `cron_create`, `cron_list`, `cron_delete` and `/schedule`; prompts fire while the editor is idle |
| Tool search | MCP tools are deferred above 25 and loaded on demand with `tool_search` (`OASIS_TOOL_SEARCH=on/off`, `OASIS_TOOL_SEARCH_THRESHOLD`) |
| Notifications | `notify` (OSC 9, notify-send, osascript) and the Notification hook |
| Permissions | default, acceptEdits, plan, auto (classifier), bypassPermissions; Claude Code rule syntax; deny > ask > allow; `/fewer-permission-prompts` |
| Sandbox | bubblewrap (Linux), sandbox-exec (macOS), secret env scrubbing, `/sandbox` |
| Hooks | PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, UserPromptSubmit, Stop, SubagentStart, SubagentStop, SessionStart, SessionEnd, PreCompact, PostCompact, Notification, CwdChanged; command, http and prompt types |
| MCP | stdio and Streamable HTTP, `.mcp.json`, `--mcp-config`, `--strict-mcp-config`, OAuth (`oasis mcp login`), resources, prompts as commands, `oasis mcp serve` |
| Memory | OASIS.md / AGENTS.md / CLAUDE.md hierarchy, `#` notes, `/memory`, `/init`, auto memory with recall and redaction |
| Sessions | Saved by default, `-c`, `-r`, `--session-id`, `-n/--name`, `/rename`, `/resume`, `/fork`, `/export`, `/compact`, `/rewind`, `/undo`, `--no-session-persistence` |
| Headless | `-p`, text/json/stream-json output, `--input-format stream-json`, `--include-partial-messages`, `--replay-user-messages`, `--max-turns`, `--max-budget-usd`, `--json-schema`, `--permission-prompt-tool`, `--fallback-model`, `--allowedTools`, `--disallowedTools`, `--tools`, `--system-prompt(-file)`, `--append-system-prompt(-file)`, `--settings`, `--setting-sources`, `--bare`, `-w/--worktree` |
| SDK and CI | `import { query, tool } from 'oasis-oss'`, GitHub Action (`uses: FAHTHIZ/oasis@main`) |
| Skills | Agent Skills from `.claude/skills` and `.oasis/skills`, `/skill-name`, `context: fork`, inline `` !`cmd` ``, per-skill model, effort and allowed-tools |

## What is still missing

Claude Code has these and Oasis does not yet:

### Terminal UI

- A full-screen TUI with a scrollable transcript (Ctrl+O), and Ctrl+B to send a running command to the background.
- Vim mode (`/vim`), `/theme`, and a user keybindings file.
- `/statusline` setup assistant. A status line itself is already supported in settings.
- An automatic recap after you've been away. `/recap` works on demand.

### Agents

- Agent view, agent teams and visual workflows.
- `/advisor` and `/ultrareview` (multi-agent cloud review).
- Task* tools for a shared task list between agents. Oasis uses `todo_write` per agent.
- EnterWorktree and ExitWorktree for the main session mid-conversation. `-w` works at startup.

### Platform

- A real PTY for interactive commands.
- A PowerShell tool and a Windows sandbox.
- Native Gemini and Azure Foundry adapters. Gemini runs through its OpenAI-compatible endpoint today.
- Hook events FileChanged, WorktreeCreate and WorktreeRemove, and the `mcp_tool` hook type.
- Managed (enterprise) settings, and a `rules/` folder.
- A plugin marketplace (`marketplace.json`). A built-in catalog and Claude plugin import exist.

### Surfaces

- VS Code and JetBrains extensions.
- Chrome control.
- A desktop app.
- Cloud sessions, Remote Control, Slack, mobile, and cloud routines (`/schedule` in Claude Code is cloud-backed; in Oasis it is in-session).

## Build order from here

1. Vim mode, themes and a keybindings file in the line editor.
2. Ctrl+O transcript view and Ctrl+B background for running commands.
3. EnterWorktree/ExitWorktree tools and the `rules/` folder.
4. Native Gemini and Azure adapters.
5. A PTY tool, then PowerShell and Windows sandboxing.
6. A plugin marketplace format.
7. A VS Code extension.
