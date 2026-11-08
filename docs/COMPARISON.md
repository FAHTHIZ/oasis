# OASIS compared with Claude Code and Hermes Agent

This page compares the agent harness, not the models. Claude Code runs Anthropic's models. OASIS and Hermes Agent run whatever model you connect. On the same task, the model usually matters more than the harness, so a harness comparison can't tell you which tool will solve your task.

Sources: the [Claude Code subagent docs](https://code.claude.com/docs/en/sub-agents.md), [agent teams](https://code.claude.com/docs/en/agent-teams/), the [Agent SDK subagent docs](https://code.claude.com/docs/en/agent-sdk/subagents), and the [Hermes delegation guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation). Last reviewed November 2026.

## Where OASIS matches

| Area | Claude Code | OASIS |
| --- | --- | --- |
| Built-in subagents | Explore, Plan, general-purpose | `explore`, `plan`, `general-purpose`, plus `code-review` and `security-review` |
| Agent files | `.claude/agents/*.md` front matter | Reads the same files and fields: `tools`, `disallowedTools`, `model`, `maxTurns`, `permissionMode`, `skills`, `memory`, `background`, `isolation`, `effort`, `color` |
| Parallel and background agents | Yes | Yes: 6 parallel, 8 background, with `agent_status`, `send_message` and `agent_stop` |
| Agent teams | Shared task list, messaging | Shared task board with leases, teammate messages, tmux panes |
| Worktree isolation | `isolation: worktree` | Same, and changes are committed on the agent's branch |
| Hooks | Full lifecycle hook set | Same event names, including `SubagentStart` and `SubagentStop` |
| Project instructions, skills, commands, plugins, MCP | `CLAUDE.md`, `.claude/*`, `.mcp.json` | Reads all of these without conversion |
| Headless mode | `claude -p`, `--output-format stream-json` | `oasis -p` / `oasis exec`, same output formats, `--output-schema` |
| Checkpoints and rewind | Yes | Yes |

## Where OASIS goes further

- **Any provider.** OpenAI-compatible, Anthropic, Gemini and local servers, with fallback models and task-aware routing to a cheaper model for simple read-only requests.
- **Structured subagent output.** `output_schema` on `task`, with one correction turn (from Hermes). The Claude Code subagent docs don't describe a per-call schema for a subagent's report.
- **Stall monitor.** Background agents that go silent are stopped as `stalled`, and their partial report is kept (from Hermes).
- **Verification gate.** The agent is sent back when it reports success without reviewing its diff or running checks.
- **Interfaces.** A local browser workspace, a desktop app, ACP for Zed and JetBrains, and Telegram, Discord and Slack gateways come in the same package.

## Where OASIS still lags, and why

| Gap | Why it matters | Reason |
| --- | --- | --- |
| Model quality and tuning | Claude Code's prompts and tool schemas are tuned for Claude models, and that tuning accounts for much of its reliability. | OASIS has to work across many models, so it can't tune for one family the same way. |
| Edits in default mode | Claude Code asks before every edit in `default` mode. OASIS applies edits inside the workspace without asking. Edits are checkpointed and can be rewound, and protected config paths still prompt. | A deliberate choice for speed. Use `plan` mode or `ask` rules for `edit_file` if you want Claude Code's behaviour. |
| Field maturity | Claude Code is used by a very large population, and its edge cases get found quickly. | OASIS has 2,200+ automated tests and adversarial suites, but far fewer real-world hours. |
| Nested delegation | Hermes can let orchestrator agents spawn children, with a depth limit. | OASIS, like Claude Code, keeps delegation one level deep, which is simpler and easier to bound. |
| Code signing | macOS warns on first launch of unsigned apps. | OASIS macOS packages are not code-signed yet. |
| Monolithic core | `src/agent.mjs` is still about 6,800 lines, which slows review. | Splitting it is planned; shared pieces like the SSRF-guarded HTTP client have been extracted first. |

## How to check these claims

- `npm test`: the full suite (about 2,260 tests).
- `node --test test/subagent-definitions.test.mjs`: front matter, memory, `output_schema` and the stall monitor.
- `oasis doctor --test-provider`: a live tool-call check against your own model.
