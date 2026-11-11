# OASIS compared with other agent harnesses

This page compares harnesses, not models. Claude Code runs Anthropic's models and Gemini CLI runs Google's. Codex is built around OpenAI's models. OASIS, OpenCode, Goose, Pi and Hermes Agent run whatever model you connect. On a given task the model usually matters more than the harness, so a harness comparison can't tell you which tool will solve your task.

Last reviewed November 2026. Sources are linked in each section. Where a page didn't say something, this page doesn't claim it.

## At a glance

| | OASIS | Claude Code | Codex | Gemini CLI | OpenCode | Goose |
| --- | --- | --- | --- | --- | --- | --- |
| License | Open source | Proprietary | Apache-2.0 | Apache-2.0 | Open source | Apache-2.0 |
| Models | Any: OpenAI-compatible, Anthropic, Gemini, Bedrock, Vertex, Foundry, local | Anthropic | ChatGPT plan or API key | Gemini API, Vertex AI, Code Assist | Many providers | 15+ providers |
| Terminal UI | Yes | Yes | Yes | Yes | Yes | Yes |
| Web interface | Yes, self-hosted and remote-ready (HTTPS, access key, reconnects to running tasks) | Cloud sessions | Codex Web (cloud) | No | Yes, local (`opencode web`) | No |
| Desktop app | Yes (Windows, macOS, Linux; unsigned, same runtime as `oasis web`) | Yes | Yes | No | Beta | Yes |
| Unattended scheduled tasks | Yes, on your own machine or server: cron, RFC 5545 RRULEs, intervals, one-offs and signed webhooks, run by `oasis schedule daemon`, `oasis web` or `oasis gateway`; the agent can create them with approval | Yes: cloud tasks (schedule, API, GitHub events) and local Desktop tasks | Yes: Codex app automations | Not found in the docs reviewed | Not found in the docs reviewed | Not found in the docs reviewed |
| MCP | Yes, including MCP Tasks | Yes | Yes | Yes | Yes | Yes |
| Subagents | Yes: parallel, background, resumable, teams, worktrees | Yes | Agent command center | Yes: built-in and custom, parallel | `general` subagent | No |
| Claude Code plugins | Yes, from any marketplace, with a one-click installer in the web app; Codex plugins and Gemini CLI extensions are converted on install | Yes | No (own plugin format) | No (own extensions) | No (own plugins) | No |

Scheduling sources: [Claude Code scheduled tasks](https://code.claude.com/docs/en/routines), [Claude Code Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks.md), [Codex app announcement](https://openai.com/en-US/index/introducing-the-codex-app/), [Codex automations](https://openai.com/academy/codex-automations).

Sources: [Gemini CLI subagents](https://developers.googleblog.com/en/subagents-have-arrived-in-gemini-cli/), [OpenCode web](https://opencode.ai/docs), [Codex README](https://github.com/openai/codex), [Codex releases](https://github.com/openai/codex/releases), [Gemini CLI README](https://github.com/google-gemini/gemini-cli), [OpenCode README](https://github.com/sst/opencode), [Goose README](https://github.com/block/goose), [Claude Code changelog](https://code.claude.com/docs/en/changelog).

## Claude Code

Claude Code is the reference point for agent behaviour, and OASIS reads its configuration files directly. Sources: the [subagent docs](https://code.claude.com/docs/en/sub-agents.md), [agent teams](https://code.claude.com/docs/en/agent-teams/) and the [changelog](https://code.claude.com/docs/en/changelog) up to 2.1.319.

| Area | Claude Code | OASIS |
| --- | --- | --- |
| Built-in subagents | Explore, Plan, general-purpose | `explore`, `plan`, `general-purpose`, plus `code-review` and `security-review` |
| Agent files | `.claude/agents/*.md` front matter | The same files and fields: `tools`, `disallowedTools`, `model`, `maxTurns`, `permissionMode`, `skills`, `memory`, `background`, `isolation`, `effort`, `color`, `hooks`, `omitClaudeMd`, `initialPrompt`, `mcpServers`, `autoCompactWindow` |
| Parallel and background agents | Yes | 6 parallel and 8 background, with `agent_status`, `send_message` and `agent_stop` |
| Finished subagents | `/tasks` "Earlier in this session", reopen and message | The same: `/tasks` groups them, and `/tasks send ID MESSAGE` resumes one with its saved conversation, including after a restart |
| Agent teams | Shared task list, messaging | Shared task board with leases, teammate messages, tmux panes |
| Worktree isolation | `isolation: worktree` | Same, and changes are committed on the agent's branch |
| Nested delegation | Up to 3 layers, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | Same default and variable; read-only agents stay leaves |
| Hooks | Full lifecycle hook set | Same event names, including `SubagentStart`, `SubagentStop`, `PreModelSwitch`, `PostModelSwitch` and `DirectoryAdded` |
| Instructions, skills, commands, plugins, MCP | `CLAUDE.md`, `.claude/*`, `.mcp.json` | Reads all of these without conversion |
| Sandbox settings | `sandbox.network.*`, `sandbox.filesystem.*`, `excludedCommands` | Domain lists, `allowWrite`, `denyWrite`, `denyRead`, `failIfUnavailable` honoured; no `excludedCommands` or `allowRead` yet |
| Git context and attribution | `includeGitInstructions`, `attribution` | Honoured; OASIS adds no attribution unless `attribution` sets it |
| Instruction exclusions | `claudeMdExcludes` | Honoured, for instruction files, rules and nested CLAUDE.md |
| Model policy | `availableModels`, `deniedModels`, `availableModelsMatch`, `modelOverrides` | Honoured |
| Thinking switch | `alwaysThinkingEnabled`, `MAX_THINKING_TOKENS` | Honoured |
| MCP policy | `allowedMcpServers`, `deniedMcpServers`, `.mcp.json` approval keys | Honoured; trusting a workspace approves all its `.mcp.json` servers (no per-server prompt) |
| Permission modes | `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk` | The same modes, plus `permissions.denyInsteadOfPrompting` |
| MCP Tasks | Long tool calls run as background tasks (2.1.319) | The same, with `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` honoured; running tasks are listed in `/tasks` |
| Headless | `claude -p`, `stream-json` | `oasis -p` / `oasis exec`, the same output formats, `--output-schema` |
| Checkpoints and rewind | Yes | Yes |
| Model env variables | `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_EFFORT` | Honoured |

## Codex

[Codex](https://github.com/openai/codex) is open source and runs in the terminal, in IDEs, as a desktop app and as Codex Web in the cloud. Its [0.167 release](https://github.com/openai/codex/releases) added an agent command center and image previews while composing.

- OASIS matches it on local execution, approval modes, MCP, image input, IDE integration (over ACP) and a desktop app (unsigned builds). OASIS's live agent monitor and `/tasks` cover what the command center shows.
- Embedding: `oasis app-server` speaks the core of the [Codex App Server protocol](https://learn.chatgpt.com/docs/app-server): threads, turns, steering, interrupts, item events and command and file-change approvals over JSONL on stdio. A client built for `codex app-server` can drive OASIS with any model. `thread/fork` copies a thread's history into a new one, threads can be archived, unarchived, deleted, unloaded and compacted, `skills/list` and `mcpServerStatus/list` report skills and MCP servers, and `review/start` runs OASIS's code review inline. `--listen ws://IP:PORT` adds the WebSocket transport with health probes, `Origin` rejection and capability-token or signed JWT (HS256) auth, and `--listen unix://[PATH]` serves it over a private Unix socket (mode 600) as Codex does. `fs/*` and `command/exec` (streaming, stdin, PTY, terminate) are implemented, confined to the workspace folders and run through OASIS's sandbox. Also implemented: `fuzzyFileSearch`, `thread/turns/list`, `thread/shellCommand`, `gitDiffToRemote`, `config/read` (read-only, secrets redacted), `hooks/list` and `account/read`. Not implemented: account login, rate-limit and usage methods (OASIS has no OpenAI account), config writes, plugin, marketplace and app methods, realtime and fuzzy-search sessions, and MCP methods other than the status list.
- Codex's advantage is Codex Web, hosted cloud execution. OASIS has no hosted service: the web app, from any device, connects to your own computer or server.

Codex also has [`/goal`](https://learn.chatgpt.com/docs/cli/slash-commands): a persistent objective with pause, resume, edit and clear. OASIS's `/goal` has the same lifecycle (`/goal pause`, `/goal resume`, `/goal edit`, `/goal clear`). A goal that was running when the session was saved comes back paused, and resuming keeps the turn count and the last check.

## Cursor CLI

[Cursor CLI](https://cursor.com/docs/cli/changelog) is proprietary and runs Cursor's model catalog (Auto routing by default, with some bring-your-own-key options such as Bedrock). It has plan and ask modes, MCP, hooks, subagents, and a handoff that pushes a local conversation to a [Cloud Agent](https://cursor.com/changelog/cli-jan-16-2026) to keep running. OASIS has no hosted cloud. It runs wherever you install it, and the self-hosted web app reaches it from any browser.

## IDE agents: Cursor, Devin Desktop (Windsurf), Antigravity, OpenHands

OASIS reads these tools' project files where they are, so a repository set up for one of them works without running `oasis import`. Sources: [Devin Desktop rules](https://docs.windsurf.com/windsurf/cascade/memories), [Cascade workflows and ignore files](https://docs.windsurf.com/windsurf/cascade/workflows), [Cursor ignore files](https://cursor.com/docs/context/ignore-files), [OpenHands skills](https://docs.openhands.dev/overview/skills).

| File | Source tool | OASIS |
| --- | --- | --- |
| `.cursor/rules/*.mdc` (`alwaysApply`, `globs`, `description`), `.cursorrules` | Cursor | Read with the same activation: always, glob-scoped, on request, manual |
| `.devin/rules/*.md`, `.windsurf/rules/*.md` (`trigger:`), `.devin/global_rules.md`, `~/.devin/rules`, `.windsurfrules` | Devin Desktop / Windsurf | Read with the same triggers |
| `AGENTS.md`, `AGENT.md`, `AGENTS.local.md`, per folder | Devin Desktop, Cursor, Codex | Read |
| `.agent/rules`, `.agents/rules`, `~/.gemini/antigravity-cli/rules`, `~/.gemini/antigravity-cli/plugins/*/rules` | Antigravity | Read with the same triggers |
| `.cursor/commands`, `~/.cursor/commands` | Cursor | Slash commands |
| `.devin/workflows`, `.windsurf/workflows` (up to the git root), `~/.codeium/windsurf/global_workflows` | Devin Desktop / Windsurf | Slash commands; workflows a workflow calls are appended. Sub-folder workflow folders are not scanned |
| `.agents/workflows`, `.agent/workflows`, `~/.gemini/config/workflows` | Antigravity | Slash commands; `// turbo` auto-run markers are not honoured |
| `.cursorignore`, `.devinignore`, `.codeiumignore`, `~/.codeium/.codeiumignore`, `.geminiignore`, `.aiexclude`, `.aiderignore` | Cursor, Devin Desktop / Windsurf, Gemini CLI / Code Assist, Aider | Agent file tools refuse covered paths; listings, search and `@` mentions skip them. Shell commands are not blocked (Cursor does not block them either). Cursor's built-in default ignore list is not copied |
| `.openhands/microagents/*.md`, `.openhands/skills/*.md`, `~/.openhands/skills`, `~/.openhands/microagents` | OpenHands | No triggers: always-on; `paths:`: path-scoped; `triggers:`: keyword-injected once per conversation with OpenHands' whole-word matching. Task `inputs:` are not prompted for |
| Skill folders: `.cursor/skills`, `.codex/skills`, `.devin/skills`, `.windsurf/skills`, `.agent/skills`, `.openhands/skills`, `~/.agents/skills`, `~/.cursor/skills`, `~/.config/devin/skills`, `~/.gemini/config/skills` (and Antigravity's legacy, CLI and plugin `skills/` folders), `~/.openhands/skills` | Cursor, Codex, Devin Desktop, Antigravity, OpenHands | Listed and loadable as skills, with their `references/` files. Antigravity's scan of parent folders up to the repository root is not done |
| `.cursor/worktrees.json`, `.windsurf/hooks.json` `post_setup_worktree`, `.openhands/setup.sh` | Cursor, Windsurf, OpenHands | Run in each new OASIS worktree, trusted workspaces only (the source tools run them without a trust step; OpenHands runs setup.sh at every session start in its sandbox, OASIS only for new worktrees). `.openhands/pre-commit.sh` is not installed as a git hook |

## Terminal agents: Gemini CLI, OpenCode, Goose, Aider, Roo Code, Kilo Code

Files from these tools that OASIS reads where they are (no `oasis import` step). `oasis import gemini|opencode|cline` still converts their settings into OASIS files.

| File | From | How OASIS uses it |
| --- | --- | --- |
| `.gemini/commands/**/*.toml`, `~/.gemini/commands` | Gemini CLI | Slash commands with Gemini's `{{args}}`, `!{...}` and `@{...}` rules ([custom commands](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md)). Gemini asks before each `!{...}`; OASIS runs it for user commands, for project commands only in trusted workspaces, and never past a deny or ask rule. Images and PDFs in `@{...}` are skipped, not attached |

## Kimi Code CLI

[Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) is MIT-licensed TypeScript and the successor to the archived Python Kimi CLI. It is tuned for Kimi models and has `/goal`, `!` shell mode, built-in coder, explore and plan subagents, a local web UI and ACP ([introduction](https://www.kimi.ai/resources/kimi-code-introduction)). OASIS covers the same ground (`/goal`, `!` shell mode, explore, plan and general-purpose subagents, a web app and ACP) for any model provider, and also runs Claude Code plugins.

## Gemini CLI

Gemini CLI is now for Gemini Code Assist enterprise users. Free and Google AI Pro users were moved to Antigravity CLI ([Gemini CLI README](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/README.md)).

[Gemini CLI](https://github.com/google-gemini/gemini-cli) covers MCP, sandboxing, checkpointing and headless `json` / `stream-json` output, with a VS Code companion. It runs Google's models only. Since v0.36 it has [subagents](https://developers.googleblog.com/en/subagents-have-arrived-in-gemini-cli/): built-in `codebase_investigator`, `cli_help` and `generalist`, custom agents in `.gemini/agents`, parallel runs and remote A2A agents. OASIS runs Gemini models too, with thought-signature replay, and adds background and resumable agents, teams, worktree isolation and other providers.

## OpenCode

[OpenCode](https://github.com/anomalyco/opencode) has a `build` agent, a read-only `plan` agent and a `general` subagent invoked with `@general`, plus a desktop app and a local [web app](https://opencode.ai/docs) (`opencode web`, `opencode pair`). It is the closest open-source competitor and has a much larger community. OASIS has the same split (default and `plan` modes, built-in subagents) and adds background, resumable and team agents, worktree isolation, Claude Code plugin compatibility and a verification step after edits.

## Goose

[Goose](https://github.com/block/goose) works with more than 15 providers, has a desktop app and a CLI, and connects to MCP extensions. OASIS has the same provider freedom and MCP support. Its strengths over Goose are coding-specific: diff review and verification gates, checkpoints and rewind, worktree agents and Claude Code configuration compatibility.

## Pi and Hermes Agent

[Pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) is deliberately minimal and shaped some features OASIS has adopted: HTML session export (`/export FILE.html`, and **Download this chat** in the browser) and a footer that shows cost and context. From [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation), OASIS adopted structured subagent output (`output_schema` with one correction turn) and the stall monitor, which stops background agents that go silent and keeps their partial report.

## Where OASIS goes further

- **Any provider.** OpenAI-compatible, Anthropic, Gemini, cloud and local servers. Fallback models and task-aware routing send simple read-only requests to a cheaper model.
- **Verification gate.** The agent is sent back when it reports success without reviewing its diff or running checks. A "tests pass" claim made when no check ran is sent back too, and an answer that still can't be verified ends with "Not verified: … Run `npm test` to confirm." (Found in a real run: the model wrote a fake passing test log after `npm test` was not approved.)
- **Two interfaces, one runtime.** The terminal and a self-hosted web app (live timeline with expandable steps, task sidebar, interactive terminal, Files and Changes panels, plugin installer) that works the same on a laptop or a phone. Sessions move between them. ACP, editor, SDK and messaging integrations connect to the same runtime.
- **Claude Code plugins.** Installed and used from Anthropic's official marketplace on 8 November 2026: superpowers, frontend-design, code-review, context7, playwright, hookify, security-guidance and others, including their hooks, skills and MCP servers.
- **Codex plugins.** On 9 November 2026, BuilderIO/skills, n8n-io/skills, DataDog/pup and NVIDIA/nvidia-kaggle installed with `oasis add` (78 skills). Codex-only plugins install too, and their MCP servers resolve a relative `cwd`, `./` commands and `${PLUGIN_ROOT}` against the plugin folder, as Codex does ([Codex source](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/agent_plugin_config.rs)). Plugins that need their own dependencies (nexu-io/codex-slides needs `pnpm install`) or programs (Storybloq) still need that setup.
- **Terminal integration.** Inline images (Kitty and iTerm2) and OSC 9;4 progress in the tab or taskbar.

## Where OASIS still lags, and why

| Gap | Why it matters | Reason |
| --- | --- | --- |
| Model tuning | Claude Code's prompts and tool schemas are tuned for Claude models, and much of its reliability comes from that tuning. | OASIS works across many model families, so it can't tune for one the same way. |
| Hosted cloud execution | Codex Web and Claude Code cloud sessions (including cloud scheduled tasks) run without your computer being on. OASIS routines need an OASIS process running on a machine you control. | OASIS runs only where you install it. Remote access from any browser goes through your own computer or server. |
| Field maturity | Claude Code and Codex are used by very large populations, so their edge cases get found quickly. | OASIS has about 2,350 automated tests and adversarial suites, but far fewer real-world hours. |
| Edits in default mode | Claude Code asks before every edit in `default` mode. OASIS applies edits inside the workspace without asking (they are checkpointed and can be rewound, and protected config paths still prompt). | A deliberate choice for speed. Use `plan` mode or `ask` rules for `edit_file` to get Claude Code's behaviour. |
| Code signing | macOS warns on first launch of unsigned apps. | OASIS macOS packages are not code-signed yet. |
| Plugin cost | Each enabled plugin adds tools and prompt text. With 16 on, tool schemas fell from 36.5k to 16.5k characters once large MCP servers moved behind `tool_search`. | Plugin prompt text (skills, hook output) is still loaded eagerly. |
| Core size | `src/agent.mjs` is about 5,500 lines, down from 6,800, and the turn loop alone is about 1,000 lines. | Splitting continues. Provider retry, request shaping, model budgets, turn guards, compaction, tool results and steering are already separate modules, and the doctor, update, uninstall, mcp, extensions, sessions, background and provider-setup commands moved out of `src/cli.mjs` (now about 3,100 lines, from 4,100). |

## How to check these claims

- `npm test` runs the full suite (about 2,350 tests).
- `node --test test/subagent-definitions.test.mjs` covers front matter, memory, `output_schema` and the stall monitor.
- `node --test test/mcp-tasks.test.mjs` covers MCP Tasks, background tasks and `/tasks`.
- `oasis doctor --test-provider` runs a live tool-call check against your own model.
