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

The Antigravity folders accept `<name>.md` or `<name>/agent.md`. Antigravity tool names map to OASIS tools: `view_file` and `view_code_item` to `read_file`, `replace_file_content` to `edit_file`, `grep_search` to `grep` and `search_files`, `find_by_name` to `glob_files`, `list_dir` to `list_files`, and `codebase_search` to `grep`, `search_files` and `repo_map`. `model: flash` and `model: pro` inherit the session model, because those tier names do not identify a model on other providers. `subagent: false` keeps an agent out of the `task` tool; it can still run as the main agent with `--agent`. `commandExecutionPolicy: off` removes the shell tools. Skill paths such as `skills/security-checklist` load the skill of that name.

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
| `environment` | `desktop` gives the agent its own virtual screen (Linux, Xvfb), with the `computer` tool and a visible browser on it, so it can do GUI and web work in parallel with other agents without touching your screen. The `task` call can set it too. See [Agent environments](COMPUTER_USE.md#agent-environments). |
| `effort` | `low`, `medium`, `high`, or `max` reasoning effort for this agent only. |
| `color` | Display color: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`. |
| `hooks` | Hooks that apply only while this agent runs, in the settings format. A `Stop` hook runs as `SubagentStop`. Project agent files add hooks only in a trusted workspace; plugin agents can't set them. |
| `initialPrompt` | When the agent runs as the main session agent (`--agent` or the `agent` setting), this is submitted as the first turn, or prepended to the prompt you give. Ignored for plugin agents and subagent runs. |
| `mcpServers` | MCP servers for this agent. A name refers to a server that is already configured (subagents share the parent's servers anyway). An inline definition (`name: { command, args, env }` or `type: http`/`sse` with `url`) is connected when the agent's turn starts and closed when it ends; its tools are visible only to this agent. Project agent files start inline servers only in a trusted workspace; plugin agents can't set them. |
| `autoCompactWindow` | Token count from 100,000 to 1,000,000. The agent compacts its history as if its context window were this size; it never raises the window. |
| `omitClaudeMd` | `true` starts the agent without the `CLAUDE.md` / `OASIS.md` project instructions, for agents that get everything from the prompt. |

Not read: `experimental` (its only option, `cacheTtl`, is specific to Anthropic's prompt cache). Unknown fields are ignored, as in Claude Code.

Definition files are read when the session starts. When `task` names an agent the session does not know, OASIS reads them again first, so a file written during the session (by you or by the agent) works without a restart.

## Agents defined during a session

The main agent can create a specialist for the job at hand with `agent_define`, then launch it with `task` like any other agent, as often as needed and in parallel. It is meant for work where several tasks need the same expertise or rules (a reviewer with a checklist, a researcher held to primary sources, a tester for one framework), so the instructions are written once instead of in every task prompt.

| Field | Meaning |
| --- | --- |
| `name` | Lowercase id, 2-41 characters. Names of built-in agents and of agents from files, plugins or `--agents` cannot be reused |
| `description` | When to use it; shown in the `task` tool |
| `instructions` | Its system instructions, up to 20,000 characters |
| `tools`, `disallowed_tools` | Tool names it may or may not use. Unknown names are refused, `task` cannot be given, and it never gets a tool its parent does not have |
| `model`, `effort`, `max_turns` | As in the front matter; the model must pass `availableModels` and `deniedModels` |
| `domains` | `code`, `research`, `analysis`: what its reports are [checked](#checked-reports) against |
| `remove` | Delete the session agent with this name |

A definition has no hooks, MCP servers or permission mode, whatever is passed. Definitions are saved with the session and come back when it is resumed; to keep one for future sessions, save it as `.oasis/agents/NAME.md`. Subagents cannot define agents. At most 20 per session.

## Structured output

Pass `output_schema` (a JSON Schema object) to `task` when the parent needs machine-readable results. The child is told to reply with matching JSON. If its report does not validate, it gets exactly one correction turn. The result then carries either `structured` (the parsed value) or `schema_errors`.

## Checked reports

The parent sees only the child's report, so OASIS checks a report that says tests or builds pass against the child's own tool results. If the child ran no test, check, lint or build command, if its last one failed, or if it edited files after the last passing one, the `task` result carries `unverified_claim` with the reason and a note telling the parent to run the check itself. Background agents' completion notices include the same reason. The report text is not changed. This catches claims, not wrong code: a child that ran a passing but irrelevant test is not flagged.

The same check covers sources and numbers. A report that cites a URL the child never fetched (a search result it did not open counts as not fetched) is flagged, and so is a computed number no execution printed when the agent declares `domain: analysis` in its definition or ran code without any test. A report with any of these comes back with `report_status: "rejected"` and `verification_issues` listing each reason. See [Evidence and contracts](AGENT-NETWORK.md#evidence-and-contracts).

A subagent started from plan mode or by a read-only subagent is read-only too, and cannot be given a deploy, publish, push or release step. See [Spawn-time scope check](AGENT-NETWORK.md#spawn-time-scope-check).

## Experience

Source: `src/agent-experience.mjs`. Every finished subagent run is recorded locally in `<config>/sessions/agent-experience.sqlite` (file mode 0600): agent type, model, a redacted head of the task, tool calls, tokens, cost, time, and an outcome OASIS decides from its own record, never from the agent's words:

| Outcome | Meaning |
| --- | --- |
| `verified` | Completed, and the evidence ledger holds a passing check after the last edit, fetched pages or executions behind it |
| `clean` | Completed with no checkable claims and none rejected |
| `unverified` / `rejected` | Completed, but the [checked-report gate](#checked-reports) flagged or rejected claims |
| `partial`, `failed`, `stalled`, `cancelled` | Hit its step limit, errored, went silent, or was stopped |

When an agent of the same type starts work in the same project (worktrees count as the same project), the closest earlier runs from other sessions, at most three, ranked with BM25 over the task text, go into its system prompt as `EXPERIENCE FROM EARLIER RUNS`: what was asked, the outcome, and either the head of the report or why it failed. Rejected and unverified reports are never recalled, secrets and `<private>` blocks are redacted before anything is stored, per-session ids such as `task_3` are masked, and the section is capped at 2,400 characters and labelled as quoted data, not instructions.

`oasis agents experience` prints the track record of each agent type, model and task domain (research, code, review, analysis, writing, computer, ops): runs, success and verified rates, failures, average tokens, cost and time. `--all` covers every project, `--type NAME` one agent, `--json` the raw numbers, and `--forget` deletes this project's rows (with `--all`, every row). The [control room](CONTROL_ROOM.md) shows the same per type and model. Rows are kept 180 days, at most 20,000.

### Choosing models from experience

With `"modelRouting": { "subagents": "experience" }` (or `OASIS_SUBAGENT_ROUTING=experience`), a subagent with no `model` on the `task` call or in its definition starts on the cheapest model you already configured (the routing `easyModel`, `strongModel` and `routes`, the `subagentModels` list, and `availableModels`) whose record for this agent type on this kind of work is as good as the default model's. Both need at least `subagentMinRuns` runs (default 5), and "as good" compares the lower bound of the 90% Wilson interval of the success rate, allowing a 5-point drop, so a lucky streak of two runs does not count. A model with no known price is never preferred, zero-budget mode only considers free routes, and the model policy (`availableModels`, `deniedModels`) still applies. Without enough history the default stays. The `task` result names the model and the reason in `model` and `model_route`. If a background agent on a model picked this way stalls, its automatic restart runs on the session's own model instead (once, like cascade escalation), and the stalled run counts against the cheaper model's record. It is off by default.

```json
{ "modelRouting": { "subagents": "experience", "subagentModels": ["CHEAP_MODEL", "MID_MODEL"], "subagentMinRuns": 8 } }
```

`OASIS_AGENT_EXPERIENCE=0`, or `"agentExperience": false` in any settings file, turns recording, recall and experience routing off.

## Shared knowledge board

The main agent and every subagent of a session share one knowledge board, so parallel agents stop rediscovering the same facts. `knowledge_post` adds a finding (a claim, optional detail, sources and tags); `knowledge_search` finds them by keyword, tag, author or status. Read-only agents such as `explore` can post too, since posting changes only the session's board, never the workspace. A new subagent starts with the findings most relevant to its task in its system prompt.

Each post is checked against the poster's own tool results with the same contracts as a [checked report](#checked-reports). A finding that cites a page the agent never fetched, says tests pass without a passing check, or gives computed numbers no execution printed is refused, with the reason. Accepted findings are labelled:

| Status | Meaning |
| --- | --- |
| `grounded` | OASIS tied it to evidence: every cited URL was fetched, its numbers were printed by a command or fetched page, or a passing check backs a claim that checks pass |
| `noted` | nothing the runtime could check, such as something read in a file; a lead to verify |

When a second agent posts the same finding, it is recorded as corroboration instead of a duplicate; the author can refine its own finding by posting it again. The author or the main agent can withdraw one with `knowledge_post` and `retract: "k_N"`. The board holds up to 200 findings, is saved with the session and comes back on resume. It is not durable memory: the main agent decides what to keep with `memory_save`. Findings are written by agents, so they are shown as leads, never as instructions.

## Background agents and teams

- `run_in_background: true` returns an id immediately. The parent is notified when the agent finishes.
- `agent_status` (with `wait_seconds` to block), `send_message` to steer or resume, and `agent_stop` to cancel.
- `team_create` groups agents around a shared task board. Members coordinate with `team_send_message` and the `task_*` tools.
- Background agents cannot ask for approval on the spot. A call outside the allowed rules is parked: the agent goes on without it, `/tasks` shows it as waiting for approval, and you answer later with `/tasks approve agent_N` or `/tasks deny agent_N`, even after a restart. Approving lets that exact call run once. See [Waiting approvals](AGENT-NETWORK.md#waiting-approvals).
- A stall monitor stops a background agent after 450 seconds with no model or tool activity (1200 seconds while a tool is still running). Its status becomes `stalled` and its last written text is kept as a partial report. Change the idle limit with `OASIS_SUBAGENT_STALL_SECONDS` or the `subagentStallSeconds` setting; `0` turns it off.
- Automatic recovery: a background agent that stalls, or fails on something that clears by itself (a dropped connection, a provider outage or rate limit that outlasted the request retries), is restarted once from its own conversation, with a note telling it what happened and, after a stall, not to repeat a command that hung. A stall on a model chosen by experience routing restarts on the session's model. After a failure it waits 20 seconds first. The parent hears only the final outcome, with the restart named in the notice, and `agent_status` shows `recovering` and `auto_recoveries`. Stopping the agent while it waits keeps it stopped. Cancelled agents, agents whose worktree was already cleaned up, agents working a shared-board task (the board hands the task out again) and failures a restart would repeat (budget, hard quota, permissions, invalid requests) are reported as they are. Set `subagentAutoRecover` (0-3 restarts, default 1) or `OASIS_SUBAGENT_AUTO_RECOVER`; `0` turns it off.
- At most 8 subagents work at once across the whole network (`OASIS_NETWORK_MAX_RUNNING`), at most 8 per parent (`OASIS_SUBAGENT_MAX_CHILDREN`), and `OASIS_PROVIDER_SLOTS=host=N` limits how many use one provider. Extra subagents wait their turn and their result says why; see the [scheduler](AGENT-NETWORK.md#scheduler).
- Every subagent's start, end and spending is also written to the [network ledger](AGENT-NETWORK.md#network-ledger). If OASIS is killed mid-turn, the workers it had started come back as `interrupted` when the session is resumed, never as running. `OASIS_NEURON_LEDGER=0` turns the ledger off.
- Every subagent request streams, even with nothing on screen. If a provider goes silent mid-request, it fails after `OASIS_STREAM_IDLE_SECONDS` (default 300, or 600 at high reasoning effort) and is retried, instead of blocking for the 600-second header timeout. Set `OASIS_SUBAGENT_STREAM=0` for a provider that cannot stream.

## Safety boundaries

Subagents can launch their own subagents up to three layers below the main conversation, as in Claude Code. Change the limit with `subagentMaxDepth` (1-5), `OASIS_SUBAGENT_MAX_DEPTH`, or Claude Code's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; `1` turns nesting off. At the limit the `task` tool is withheld. Read-only agents never get it, so they can't gain write access through a child. To stop one agent from delegating, leave `Agent` out of its `tools` or add it to `disallowedTools`. The 8-agent background cap is shared across the whole tree; each agent can still run up to 6 in parallel. To run fewer at once, for example on a rate-limited provider, set `subagentMaxParallel` (1-6) in your user settings or `OASIS_SUBAGENT_MAX_PARALLEL`; extra `task` calls from the same reply wait for a free slot, in order. Subagents cannot ask the user questions, enter plan mode, schedule cron jobs, or write shared durable memory. They suggest memory and skill candidates in their report for the parent to review. Their spend counts toward the parent's `--max-budget-usd`. An agent definition can also cap one run with `budgetTokens`, `budgetUsd`, `budgetRequests`, `budgetSteps` and `budgetChildren` (or `OASIS_SUBAGENT_BUDGET="tokens=200000,usd=0.5"` for all of them); the budget is reserved from the parent's and the unspent part is returned when the run ends. See [Budget algebra](AGENT-NETWORK.md#budget-algebra). `SubagentStart` and `SubagentStop` hooks run around every child.
