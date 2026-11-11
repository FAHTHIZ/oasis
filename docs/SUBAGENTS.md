# Subagents

A subagent is a focused child agent with its own context window. The parent calls the `task` tool, the child works through its own tool loop, and only its final report comes back. Several `task` calls in one model response run in parallel (up to 6 at once), and up to 8 can run in the background.

Oasis reads the same agent definition format as Claude Code, so existing `.claude/agents/*.md` files work unchanged.

## Built-in agents

| Agent | Tools | Use it for |
| --- | --- | --- |
| `general-purpose` | All parent tools | Self-contained multi-step work that would otherwise fill the main context |
| `explore` | Read-only | Finding files and symbols, answering "how does this work" with paths and line numbers |
| `plan` | Read-only | A numbered implementation plan with files, order of work, tests, and risks |
| `code-review` | Read-only | Independent review of a diff for bugs, regressions, and missing tests |
| `security-review` | Read-only | Trust boundaries, permissions, secrets, filesystem and network access |

Names are matched case-insensitively, so `Explore` and `Plan` work too.

## Custom agents

Create a Markdown file with front matter. Later locations override earlier ones:

1. `~/.claude/agents/`
2. `~/.gemini/config/agents/` (Google Antigravity)
3. `~/.config/oasis/agents/`
4. `<project>/.claude/agents/`
5. `<project>/.agents/agents/` (Google Antigravity)
6. `<project>/.oasis/agents/`
7. Enabled Claude Code plugins (named `plugin:agent`)

The Antigravity folders accept `<name>.md` or `<name>/agent.md`. Antigravity tool names map to OASIS tools: `view_file` and `view_code_item` to `read_file`, `replace_file_content` to `edit_file`, `grep_search` to `grep` and `search_files`, `find_by_name` to `glob_files`, `list_dir` to `list_files`, and `codebase_search` to `semantic_search`. `model: flash` and `model: pro` inherit the session model, because those tier names do not identify a model on other providers. `subagent: false` keeps an agent out of the `task` tool; it can still run as the main agent with `--agent`. `commandExecutionPolicy: off` removes the shell tools. Skill paths such as `skills/security-checklist` load the skill of that name.

You can also pass agents for one session as JSON with `--agents`.

```markdown
---
name: test-runner
description: Use after code changes to run the tests and fix failures.
tools: Read, Grep, Glob, Bash, Edit
disallowedTools: Write
model: inherit
maxTurns: 40
skills: [lint-rules]
memory: project
effort: medium
color: green
---
You are a test specialist. Run the relevant tests, fix failures at the root cause,
and report the commands you ran with their results.
```

### Front matter reference

| Field | Meaning |
| --- | --- |
| `name` | Lowercase identifier. Defaults to the file name. |
| `description` | When the parent should pick this agent. Shown in the `task` tool. |
| `tools` | Allowlist. Claude Code names (`Read`, `Bash`, `Edit`, ...) map to Oasis tools. Omit for all parent tools. |
| `disallowedTools` | Denylist, applied before `tools`, so it always wins. |
| `model` | Model id, or `inherit` (the default). A per-call `model` argument overrides it. |
| `maxTurns` | Tool-step cap for one run. When reached, the report is marked `partial` and `send_message` can resume the agent. |
| `permissionMode` | `plan` keeps the agent read-only. Modes that would loosen approvals are ignored, and plugin agents cannot set one. |
| `skills` | Up to 32 skills preloaded into the agent's prompt (64 KB total). |
| `memory` | `user` (`~/.claude/agent-memory/<name>/`), `project` (`.claude/agent-memory/<name>/`), or `local` (`.claude/agent-memory-local/<name>/`). The first 200 lines of `MEMORY.md` are injected on every run. |
| `background` | `true` runs the agent in the background unless the call sets `run_in_background`. |
| `isolation` | `worktree` gives the agent its own git worktree and branch. Oasis commits its changes there when it finishes. |
| `effort` | `low`, `medium`, `high`, or `max` reasoning effort for this agent only. |
| `color` | Display color: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`. |
| `hooks` | Hooks that apply only while this agent runs, in the settings format. A `Stop` hook runs as `SubagentStop`. Project agent files add hooks only in a trusted workspace; plugin agents can't set them. |
| `initialPrompt` | When the agent runs as the main session agent (`--agent` or the `agent` setting), this is submitted as the first turn, or prepended to the prompt you give. Ignored for plugin agents and subagent runs. |
| `mcpServers` | MCP servers for this agent. A name refers to a server that is already configured (subagents share the parent's servers anyway). An inline definition (`name: { command, args, env }` or `type: http`/`sse` with `url`) is connected when the agent's turn starts and closed when it ends; its tools are visible only to this agent. Project agent files start inline servers only in a trusted workspace; plugin agents can't set them. |
| `autoCompactWindow` | Token count from 100,000 to 1,000,000. The agent compacts its history as if its context window were this size; it never raises the window. |
| `omitClaudeMd` | `true` starts the agent without the `CLAUDE.md` / `OASIS.md` project instructions, for agents that get everything from the prompt. |

Not read: `experimental` (its only option, `cacheTtl`, is specific to Anthropic's prompt cache). Unknown fields are ignored, as in Claude Code.

## Structured output

Pass `output_schema` (a JSON Schema object) to `task` when the parent needs machine-readable results. The child is told to reply with matching JSON. If its report does not validate, it gets exactly one correction turn. The result then carries either `structured` (the parsed value) or `schema_errors`.

## Background agents and teams

- `run_in_background: true` returns an id immediately. The parent is notified when the agent finishes.
- `agent_status` (with `wait_seconds` to block), `send_message` to steer or resume, and `agent_stop` to cancel.
- `team_create` groups agents around a shared task board. Members coordinate with `team_send_message` and the `task_*` tools.
- Background agents cannot ask for approval. Any action outside the allowed rules is denied.
- A stall monitor stops a background agent after 450 seconds with no model or tool activity (1200 seconds while a tool is still running). Its status becomes `stalled` and its last written text is kept as a partial report. Change the idle limit with `OASIS_SUBAGENT_STALL_SECONDS` or the `subagentStallSeconds` setting; `0` turns it off.
- Every subagent request streams, even with nothing on screen. If a provider goes silent mid-request, it fails after `OASIS_STREAM_IDLE_SECONDS` (default 120) and is retried, instead of blocking for the 600-second header timeout. Set `OASIS_SUBAGENT_STREAM=0` for a provider that cannot stream.

## Safety boundaries

Subagents can launch their own subagents up to three layers below the main conversation, as in Claude Code. Change the limit with `subagentMaxDepth` (1-5), `OASIS_SUBAGENT_MAX_DEPTH`, or Claude Code's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; `1` turns nesting off. At the limit the `task` tool is withheld. Read-only agents never get it, so they can't gain write access through a child. To stop one agent from delegating, leave `Agent` out of its `tools` or add it to `disallowedTools`. The 8-agent background cap is shared across the whole tree; each agent can still run up to 6 in parallel. Subagents cannot ask the user questions, enter plan mode, schedule cron jobs, or write shared durable memory. They suggest memory and skill candidates in their report for the parent to review. Their spend counts toward the parent's `--max-budget-usd`. `SubagentStart` and `SubagentStop` hooks run around every child.
