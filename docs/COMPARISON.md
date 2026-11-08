# OASIS compared with other agent harnesses

This page compares harnesses, not models. Claude Code runs Anthropic's models and Gemini CLI runs Google's. Codex is built around OpenAI's models. OASIS, OpenCode, Goose, Pi and Hermes Agent run whatever model you connect. On a given task the model usually matters more than the harness, so a harness comparison can't tell you which tool will solve your task.

Last reviewed November 2026. Sources are linked in each section. Where a page didn't say something, this page doesn't claim it.

## At a glance

| | OASIS | Claude Code | Codex | Gemini CLI | OpenCode | Goose |
| --- | --- | --- | --- | --- | --- | --- |
| License | Open source | Proprietary | Apache-2.0 | Apache-2.0 | Open source | Apache-2.0 |
| Models | Any: OpenAI-compatible, Anthropic, Gemini, Bedrock, Vertex, Foundry, local | Anthropic | ChatGPT plan or API key | Gemini API, Vertex AI, Code Assist | Many providers | 15+ providers |
| Terminal UI | Yes | Yes | Yes | Yes | Yes | Yes |
| Web interface | Yes, local | Cloud sessions | Codex Web (cloud) | No | Yes, local (`opencode web`) | No |
| Desktop app | Yes | Yes | Yes | No | Beta | Yes |
| MCP | Yes, including MCP Tasks | Yes | Yes | Yes | Yes | Yes |
| Subagents | Yes: parallel, background, resumable, teams, worktrees | Yes | Agent command center | Yes: built-in and custom, parallel | `general` subagent | No |
| Claude Code plugins | Yes, from any marketplace, with a one-click installer in the web app | Yes | No (own plugin format) | No (own extensions) | No (own plugins) | No |

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
| Hooks | Full lifecycle hook set | Same event names, including `SubagentStart` and `SubagentStop` |
| Instructions, skills, commands, plugins, MCP | `CLAUDE.md`, `.claude/*`, `.mcp.json` | Reads all of these without conversion |
| Permission modes | `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk` | The same modes, plus `permissions.denyInsteadOfPrompting` |
| MCP Tasks | Long tool calls run as background tasks (2.1.319) | The same, with `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` honoured; running tasks are listed in `/tasks` |
| Headless | `claude -p`, `stream-json` | `oasis -p` / `oasis exec`, the same output formats, `--output-schema` |
| Checkpoints and rewind | Yes | Yes |
| Model env variables | `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_EFFORT` | Honoured |

## Codex

[Codex](https://github.com/openai/codex) is open source and runs in the terminal, in IDEs, as a desktop app and as Codex Web in the cloud. Its [0.167 release](https://github.com/openai/codex/releases) added an agent command center and image previews while composing.

- OASIS matches it on local execution, approval modes, MCP, image input, IDE integration (over ACP) and a desktop app. OASIS's live agent monitor and `/tasks` cover what the command center shows.
- Codex's advantage is Codex Web, hosted cloud execution. OASIS has no hosted service: the browser workspace and phone access connect to your own computer.

## Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli) covers MCP, sandboxing, checkpointing and headless `json` / `stream-json` output, with a VS Code companion. It runs Google's models only. Since v0.36 it has [subagents](https://developers.googleblog.com/en/subagents-have-arrived-in-gemini-cli/): built-in `codebase_investigator`, `cli_help` and `generalist`, custom agents in `.gemini/agents`, parallel runs and remote A2A agents. OASIS runs Gemini models too, with thought-signature replay, and adds background and resumable agents, teams, worktree isolation and other providers.

## OpenCode

[OpenCode](https://github.com/sst/opencode) has a `build` agent, a read-only `plan` agent and a `general` subagent invoked with `@general`, plus a desktop app and a local [web app](https://opencode.ai/docs) (`opencode web`, `opencode pair`). It is the closest open-source competitor and has a much larger community. OASIS has the same split (default and `plan` modes, built-in subagents) and adds background, resumable and team agents, worktree isolation, Claude Code plugin compatibility and a verification step after edits.

## Goose

[Goose](https://github.com/block/goose) works with more than 15 providers, has a desktop app and a CLI, and connects to MCP extensions. OASIS has the same provider freedom and MCP support. Its strengths over Goose are coding-specific: diff review and verification gates, checkpoints and rewind, worktree agents and Claude Code configuration compatibility.

## Pi and Hermes Agent

[Pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) is deliberately minimal and shaped some features OASIS has adopted: HTML session export (`/export FILE.html`, and **Download this chat** in the browser) and a footer that shows cost and context. From [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation), OASIS adopted structured subagent output (`output_schema` with one correction turn) and the stall monitor, which stops background agents that go silent and keeps their partial report.

## Where OASIS goes further

- **Any provider.** OpenAI-compatible, Anthropic, Gemini, cloud and local servers. Fallback models and task-aware routing send simple read-only requests to a cheaper model.
- **Verification gate.** The agent is sent back when it reports success without reviewing its diff or running checks.
- **Two interfaces, one runtime.** The terminal and a local web app (interactive terminal, Files and Changes panels, plugin installer), which the desktop app wraps. Sessions move between them. ACP, editor, SDK and messaging integrations connect to the same runtime.
- **Claude Code plugins.** Installed and used from Anthropic's official marketplace on 8 November 2026: superpowers, frontend-design, code-review, context7, playwright, hookify, security-guidance and others, including their hooks, skills and MCP servers.
- **Terminal integration.** Inline images (Kitty and iTerm2) and OSC 9;4 progress in the tab or taskbar.

## Where OASIS still lags, and why

| Gap | Why it matters | Reason |
| --- | --- | --- |
| Model tuning | Claude Code's prompts and tool schemas are tuned for Claude models, and much of its reliability comes from that tuning. | OASIS works across many model families, so it can't tune for one the same way. |
| Hosted cloud execution | Codex Web and Claude Code cloud sessions run tasks without your computer being on. | OASIS runs only where you install it. Phone access goes through your own computer. |
| Field maturity | Claude Code and Codex are used by very large populations, so their edge cases get found quickly. | OASIS has about 2,300 automated tests and adversarial suites, but far fewer real-world hours. |
| Edits in default mode | Claude Code asks before every edit in `default` mode. OASIS applies edits inside the workspace without asking (they are checkpointed and can be rewound, and protected config paths still prompt). | A deliberate choice for speed. Use `plan` mode or `ask` rules for `edit_file` to get Claude Code's behaviour. |
| Code signing | macOS warns on first launch of unsigned apps. | OASIS macOS packages are not code-signed yet. |
| Plugin cost | Each enabled plugin adds tools and prompt text. With 16 on, tool schemas fell from 36.5k to 16.5k characters once large MCP servers moved behind `tool_search`. | Plugin prompt text (skills, hook output) is still loaded eagerly. |
| Core size | `src/agent.mjs` is about 5,500 lines, down from 6,800, and the turn loop alone is about 1,000 lines. | Splitting continues. Provider retry, request shaping, model budgets, turn guards, compaction, tool results and steering are already separate modules, and the doctor, update, uninstall, mcp, extensions, sessions, background and provider-setup commands moved out of `src/cli.mjs` (now about 3,100 lines, from 4,100). |

## How to check these claims

- `npm test` runs the full suite (about 2,300 tests).
- `node --test test/subagent-definitions.test.mjs` covers front matter, memory, `output_schema` and the stall monitor.
- `node --test test/mcp-tasks.test.mjs` covers MCP Tasks, background tasks and `/tasks`.
- `oasis doctor --test-provider` runs a live tool-call check against your own model.
