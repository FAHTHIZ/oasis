# Oasis vs Claude Code: gap analysis

Audited October 28, 2026 against the public [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) and [Claude Code docs overview](https://code.claude.com/docs/en/overview). Each "have" item was checked in `src/`, not only in the README.

## Short answer

For the core terminal loop (read, search, edit, run, plan, subagents, permissions, hooks, MCP, memory, rewind, headless), Oasis is close to Claude Code. A rough estimate is 70–75% of what a single developer uses day to day. The biggest gaps in agent power are a real **LSP tool**, **background agents you can keep talking to**, **GitHub branch/PR workflows**, and a deeper **MCP** feature set (resources, prompts, OAuth). Claude Code also runs on surfaces Oasis has no equivalent for: cloud sessions, IDE plugins, Chrome control, Slack, and mobile.

## What Oasis already matches

| Area | Oasis today |
|---|---|
| File tools | read (ranged, images, notebooks), write, edit, multi_edit, notebook_edit, glob, grep (ripgrep), delete |
| Commands | argv `run_command`, opt-in `run_shell`, background processes with output/kill/list |
| Code intelligence | `lsp` tool: definition, references, hover, implementation, type definition, document/workspace symbols, call hierarchy, diagnostics, with 12 built-in language servers plus custom ones |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_branch`, `git_push`, `create_pull_request` (gh), `/commit`, `/pr`, `/review [PR]` |
| Code checks | `diagnostics` tool (tsc, ESLint, Ruff, mypy, Pyright, go vet, cargo, JS/JSON syntax), `/diagnostics`, `oasis diagnostics` |
| Web | `fetch_url`, `web_search` (keyless or Tavily/Brave/SearXNG) |
| Planning | plan mode, `exit_plan_mode`, `todo_write` checklists persisted with sessions |
| Questions | `ask_user_question` with multiple choice in the terminal and browser |
| Subagents | background agents (`run_in_background`, `agent_status`, `send_message` steering and resume, `agent_stop`, `/tasks`), `task` tool, custom agents from `.claude/agents` and `.oasis/agents`, per-agent tools and model, worktree isolation |
| Permissions | default / acceptEdits / plan / bypassPermissions modes, Claude Code rule syntax (`Bash(npm test:*)`, `Edit(src/**)`), deny > ask > allow |
| Sandbox | bubblewrap (Linux), sandbox-exec (macOS), secret env scrubbing |
| Hooks | PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, SessionStart, SessionEnd, PreCompact, Notification (command hooks, exit-code 2 blocking, JSON decisions) |
| MCP | stdio and Streamable HTTP, `.mcp.json`, per-call approval, `/mcp` |
| Memory | OASIS.md / AGENTS.md / CLAUDE.md hierarchy, `# note` quick memory, `/memory`, `/init` |
| Sessions | `--continue`, `--resume`, `/resume`, `/export`, `/compact`, mid-turn microcompaction, `/rewind` checkpoints |
| Headless | `-p`, `--output-format text/json/stream-json`, `--max-turns`, `--allowedTools`, `--append-system-prompt`, piped stdin |
| Models | OpenAI Responses, OpenAI-compatible, native Anthropic; thinking keywords, reasoning effort, prompt caching, vision |
| UX | slash commands, custom Markdown commands with `$ARGUMENTS`, @file mentions, output styles, status line, `--add-dir` |
| Extras Claude Code lacks | authenticated browser workspace (`oasis web`), coding-agent eval harness, OmniRoute/Ollama setup, OpenHands delegation |

## What is missing, by priority

### P1 — agent power (biggest impact on real coding tasks)

1. ~~**LSP tool.**~~ Done: the `lsp` tool.
2. ~~**Background agents and messaging.**~~ Done: `run_in_background`, `agent_status`, `send_message`, `agent_stop`, `/tasks`.
3. ~~**Git and PR workflow.**~~ Done: `git_log`, `git_commit`, `git_branch`, `git_push`, `create_pull_request`, `/commit`, `/pr`.
4. **MCP depth.** Missing: resources (`resources/list`/`read`, `@server:resource` mentions), prompts as slash commands (`/mcp__server__prompt`), OAuth for remote servers, and `oasis mcp serve`, which exposes Oasis tools to other clients.
5. **Skill and command frontmatter.** Missing: `context: fork` (run a skill in a subagent), inline `` !`cmd` `` shell output in commands, `model`/`effort` per command, and hot reload.
6. **Hooks breadth.** Missing events: PostToolUseFailure, SubagentStart, PostCompact, PermissionRequest, CwdChanged, FileChanged, WorktreeCreate/Remove, and others. Missing hook types: `http`, `prompt` (model-evaluated), and `mcp_tool`.
7. **Auto memory.** Claude Code saves learnings across sessions automatically. Oasis only saves `# note` entries the user writes.
8. **PDF reading.** `read_file` should extract text from PDF page ranges.
9. **Headless extras.** Missing: `--json-schema` structured output, `--permission-prompts none`, `--bare`, and `-w/--worktree` for the main session.

### P2 — everyday UX

- Slash commands: `/copy`, `/loop`, `/cd`, `/doctor`, `/effort`, `/branch` (`/fork`), `/usage` (with `/cost` as an alias), `/config`, `/skills`, `/sandbox`, `/tasks`, `/undo` (alias of `/rewind`), `/release-notes`.
- Terminal: Vim mode, configurable keybindings, image paste from the clipboard, fullscreen/transcript view.
- Auto mode: a permission mode where a cheap model classifies each action as safe or needing approval.

### P3 — providers and integrations

- Bedrock, Vertex AI, and Azure Foundry provider adapters, plus native Gemini (Gemini currently runs through the OpenAI-compatible endpoint).
- VS Code and JetBrains extensions (inline diffs, selection context, IDE diagnostics).
- GitHub Actions workflow (`@oasis` on issues and PRs), similar to Claude Code's GitHub app.
- OpenTelemetry metrics and traces, and an importable SDK (`package.json` `exports`) for building agents on Oasis.
- Browser control (Playwright) for debugging live web apps.

### P4 — platform features (out of scope for a local tool)

Cloud sessions, Remote Control, Slack, the mobile app, and cloud scheduled tasks rely on Anthropic infrastructure. `oasis web` on the LAN with TLS already covers part of the remote-control use case.

## Suggested build order

1. ~~LSP tool~~ (done)
2. ~~Git commit/branch/PR tools and `/pr`~~ (done)
3. ~~Background subagents with `/tasks` and `send_message`~~ (done)
4. Missing slash commands (`/copy`, `/doctor`, `/effort`, `/usage`, `/undo`, `/loop`, `/cd`, `/skills`, `/config`)
5. MCP resources, prompts, and OAuth
6. PDF reading, `--json-schema`, `--worktree`, `--permission-prompts none`
7. Hook events and types, skill `context: fork`, and inline `` !`cmd` ``
8. Auto memory and auto mode classifier
9. Bedrock/Vertex adapters, VS Code extension, GitHub Action
