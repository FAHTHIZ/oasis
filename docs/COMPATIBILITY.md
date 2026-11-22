# Compatibility with other agent tools

OASIS reads the configuration other agent tools already keep in a repository
or home folder, and speaks several of their protocols, so existing setups keep
working when you point them at any model. This page lists exactly what is read
or implemented and what is not. It is a compatibility reference, not a ranking:
on a given task the model you connect usually matters more than the harness.

Last reviewed November 2026. Each section links the upstream documentation it
was checked against. Anything not listed here is not claimed.

## Claude Code configuration

OASIS reads Claude Code's files where they are: `CLAUDE.md`, `.claude/agents`,
`.claude/skills`, `.claude/commands`, hooks, settings, plugins and `.mcp.json`.
Checked against the [subagent docs](https://code.claude.com/docs/en/sub-agents.md),
[agent teams](https://code.claude.com/docs/en/agent-teams/) and the
[changelog](https://code.claude.com/docs/en/changelog) up to 2.1.319.

| Area | Claude Code setting or behaviour | What OASIS does |
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
| Sandbox settings | `sandbox.network.*`, `sandbox.filesystem.*`, `excludedCommands` | Domain lists, `allowWrite`, `denyWrite`, `denyRead`, `allowRead`, `allowManagedReadPathsOnly`, `excludedCommands`, `failIfUnavailable`, `credentials` `deny` entries, the Unix-socket, local-binding and proxy-port keys, and the admin-required repository locks honoured (`mask` is applied as `deny`: no substituting proxy). Stricter than Claude Code: a repository can never set the socket, binding or proxy keys, and never reopen a path your own settings deny reading. Not read: `strictAllowlist` (OASIS never prompts for a host), `tlsTerminate`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation` |
| Git context and attribution | `includeGitInstructions`, `attribution` | Honoured; OASIS adds no attribution unless `attribution` sets it |
| Instruction exclusions | `claudeMdExcludes` | Honoured, for instruction files, rules and nested CLAUDE.md |
| Model policy | `availableModels`, `deniedModels`, `availableModelsMatch`, `modelOverrides` | Honoured |
| Thinking switch | `alwaysThinkingEnabled`, `MAX_THINKING_TOKENS` | Honoured |
| Plan files | `plansDirectory` (default `~/.claude/plans`) | Honoured when set; nothing is saved when unset |
| Worktree layout | `worktree.symlinkDirectories`, `sparsePaths`, `baseRef` (default `fresh`) | Honoured; default base is `head` |
| SDK query controls | `Query.setModel()`, `setPermissionMode()`, `interrupt()`, `setMaxThinkingTokens()` | Same method names on the `query()` generator, plus `supportedModels()`, `mcpServerStatus()` and `close()`; single-prompt only, no streaming input |
| Spinner verbs | `spinnerVerbs` | Honoured for the terminal's wait line |
| File suggestion | `fileSuggestion` command for `@` completion | Honoured in the terminal, with the status line trust and managed-only gates |
| Subagent status line | `subagentStatusLine` command renders each subagent row | Honoured for the `/tasks` list and the running-subagent rows above the terminal prompt (same payload and `{"id","content"}` lines; same trust and hook gates as the status line) |
| Skill visibility | `skillOverrides`, `disableBundledSkills`, `disableSkillShellExecution` | Honoured, for both `` !`cmd` `` and ```` ```! ```` blocks |
| MCP policy | `allowedMcpServers`, `deniedMcpServers`, `.mcp.json` approval keys | Honoured; trusting a workspace approves all its `.mcp.json` servers (no per-server prompt) |
| Permission modes | `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk` | The same modes, plus `permissions.denyInsteadOfPrompting` |
| MCP Tasks | Long tool calls run as background tasks (2.1.319) | The same, with `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` honoured; running tasks are listed in `/tasks` |
| Headless | `claude -p`, `stream-json` | `oasis -p` / `oasis exec`, the same `text` / `json` / `stream-json` options and `result` event fields; streamed `assistant` events carry Claude-style `message.content`, but tool calls are OASIS's own top-level `tool_use` / `tool_result` events rather than content blocks; `--output-schema`; `oasis exec --json` emits the Codex exec JSONL stream so the Codex TypeScript SDK runs OASIS via `codexPathOverride` (tested against the SDK's argument and event contract, and checked by hand with `@openai/codex-sdk` 0.167.1) |
| Checkpoints and rewind | Yes | Yes |
| Model env variables | `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_EFFORT` | Honoured |

Claude Code plugins install from any marketplace (`oasis add`, or **Plugins**
in the web app) with their commands, agents, skills, hooks and MCP servers. See
[Extending OASIS](EXTENDING.md).

## Codex App Server and Codex plugins

[Codex](https://github.com/openai/codex) is open source and runs in the terminal, in IDEs, as a desktop app and as Codex Web in the cloud. Its [0.167 release](https://github.com/openai/codex/releases) added an agent command center and image previews while composing.

`oasis app-server` speaks the core of the [Codex App Server protocol](https://learn.chatgpt.com/docs/app-server): threads, turns, steering, interrupts, item events and command and file-change approvals over JSONL on stdio. A client built for `codex app-server` can drive OASIS with any model. `thread/fork` copies a thread's history into a new one, threads can be archived, unarchived, deleted, unloaded and compacted, `skills/list` and `mcpServerStatus/list` report skills and MCP servers, and `review/start` runs OASIS's code review inline. `--listen ws://IP:PORT` adds the WebSocket transport with health probes, `Origin` rejection and capability-token or signed JWT (HS256) auth, and `--listen unix://[PATH]` serves it over a private Unix socket (mode 600) as Codex does. `fs/*` and `command/exec` (streaming, stdin, PTY, terminate) are implemented, confined to the workspace folders and run through OASIS's sandbox. Also implemented: `fuzzyFileSearch`, `thread/turns/list`, `thread/shellCommand`, `gitDiffToRemote`, `config/read` (read-only, secrets redacted), `hooks/list` and `account/read`. Not implemented: account login, rate-limit and usage methods (OASIS has no OpenAI account), config writes, plugin, marketplace and app methods, realtime and fuzzy-search sessions, and MCP methods other than the status list.

`/goal` follows the same lifecycle as Codex's [`/goal`](https://learn.chatgpt.com/docs/cli/slash-commands) (`/goal pause`, `/goal resume`, `/goal edit`, `/goal clear`). A goal that was running when the session was saved comes back paused, and resuming keeps the turn count and the last check.

Codex plugins and Gemini CLI extensions are converted on install. Codex plugin
MCP servers resolve a relative `cwd`, `./` commands and `${PLUGIN_ROOT}`
against the plugin folder, as Codex does. Plugins that need their own
dependencies or programs still need that setup.

## Cursor Cloud Agents API

Scripts written for Cursor's [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) can call `oasis web` instead: it answers the v1 and v0 REST endpoints (agents, runs, follow-ups, steering, cancel, the run event stream, usage, conversation and signed `statusChange` webhooks) with the OASIS web access key as the API key, and runs the agent in the folder the server serves with any configured model. Cursor's Cloud Agents also clone repositories, create branches and open pull requests on hosted machines. OASIS does none of that: those fields return a 4xx naming the field. Details are in [Interfaces](INTERFACES.md#cursor-cloud-agents-api).

## Editor and IDE agent files

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

## Terminal agent files

Files from these tools that OASIS reads where they are (no `oasis import` step). `oasis import gemini|opencode|cline` still converts their settings into OASIS files.

| File | From | How OASIS uses it |
| --- | --- | --- |
| `.gemini/commands/**/*.toml`, `~/.gemini/commands` | Gemini CLI | Slash commands with Gemini's `{{args}}`, `!{...}` and `@{...}` rules ([custom commands](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md)). Gemini asks before each `!{...}`; OASIS runs it for user commands, for project commands only in trusted workspaces, and never past a deny or ask rule. Images and PDFs in `@{...}` are skipped, not attached |
| `.gemini/agents/*.md`, `~/.gemini/agents` | Gemini CLI | Subagents for the task tool; Gemini tool names mapped, `max_turns` honoured. Remote (A2A) agent files are not read (add them to `a2aAgents` for the `remote_agent` tool, see [A2A](A2A.md)); `temperature` and `timeout_mins` are not supported, and the model id is not carried over |
| `.opencode/agents`, `.opencode/agent`, `~/.config/opencode/agents` | OpenCode | `subagent`/`all` agents are task subagents; `primary` agents run with `oasis --agent`. Tool switches and whole-tool deny rules remove tools; per-command `ask`/`allow` patterns and `opencode.json` `agents` entries are not read; the model id is not carried over |
| `.roomodes`, `.kilocodemodes` (with `.roo/rules-{slug}/`, `.roorules-{slug}`, `.clinerules-{slug}`, `.kilocode/rules-{slug}/`) | Roo Code, Kilo Code | Each mode is an agent (`oasis --agent SLUG` or the task tool). Missing `read`/`edit`/`command` groups remove those tools; `fileRegex` is an instruction only; `mcp`/`browser` groups and global `custom_modes.yaml` are not handled. Roo switches the whole session's mode; OASIS runs a mode as the main agent or as a subagent |
| `.kilo/agents`, `.kilo/agent`, `.kilocode/agents`, `~/.config/kilo/agent` | Kilo Code | Read like OpenCode agents |
| `~/.roo/rules/`, `.roorules`, `.kilocode/rules/`, `.roo/commands/`, `~/.roo/commands/` | Roo Code, Kilo Code | Always-on rules (`.roorules` only when `.roo/rules/` is empty) and slash commands; a command's `mode:` is not applied |
| `.goosehints` (workspace, parents up to the git root, subfolders, `~/.config/goose/`) | Goose | Always-on rules, nested hints when the agent works in that folder ([goosehints](https://block.github.io/goose/docs/guides/context-engineering/using-goosehints)). `CONTEXT_FILE_NAMES` is not read |
| Recipes (`*.yaml`, `*.json`; workspace or `GOOSE_RECIPE_PATH`) | Goose | `/recipe NAME key=value` renders instructions and prompt with parameters ([recipe reference](https://block.github.io/goose/docs/guides/recipes/recipe-reference)); `user_prompt` and missing required values are asked for in the terminal and web app. Extensions, sub-recipes, retry and settings are not run; GitHub recipe repos are not fetched |
| `.opencode/commands`, `.opencode/command`, `~/.config/opencode/commands`, `opencode.json` `commands` | OpenCode | Slash commands with OpenCode's `$ARGUMENTS`/`$N`, `` !`cmd` `` and append rules ([commands](https://opencode.ai/docs/commands/)); `agent`/`model` are not applied |
| `instructions` in `opencode.json(c)`, `kilo.json(c)` | OpenCode, Kilo Code | Listed files and globs become always-on rules ([rules](https://opencode.ai/docs/rules/)); URLs are not fetched |
| `.aider.conf.yml` `read:` (home, git root, workspace) | Aider | Listed files become always-on rules ([YAML config](https://aider.chat/docs/config/aider_conf.html)); other Aider options are not read |
| `context.fileName` in `.gemini/settings.json`, `~/.gemini/settings.json` | Gemini CLI | Extra context-file names loaded from the workspace, `~/.gemini/` and subfolders on demand ([GEMINI.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/gemini-md.md)). `GEMINI.md` still loads even when the list leaves it out |

## Imports and data formats

- `oasis import codex|gemini|cursor|claude|hermes|openclaw|opencode|antigravity|windsurf|cline`
  copies another tool's MCP servers, instructions, commands, rules, skills and
  memories into OASIS files (`--dry-run` shows the plan first).
- `oasis sessions export --compress` and `oasis batch --compress` write
  compressed trajectories; `--format hermes` writes the ShareGPT
  function-calling records Hermes Agent saves.
- `/export FILE.html` writes a self-contained session page, and the web app
  offers **Download this chat**.
- Gemini CLI remote (A2A) agent files are not read; add remote agents to
  `a2aAgents` for the `remote_agent` tool instead (see [A2A](A2A.md)).

## How to check these claims

- `npm test` runs the full suite.
- `node --test test/subagent-definitions.test.mjs` covers agent front matter,
  memory, `output_schema` and the stall monitor.
- `node --test test/mcp-tasks.test.mjs` covers MCP Tasks and `/tasks`.
- `oasis doctor --test-provider` runs a live tool-call check against your model.
