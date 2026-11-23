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

## Plugins from other agents

`oasis add SOURCE` takes a plugin or marketplace written for any of these and
runs it as an OASIS plugin. The approval lists what it brings and, under "Not
carried over", anything OASIS will not run.

| Format | Recognized by | What runs | Not carried over |
| --- | --- | --- | --- |
| OASIS | `.oasis-plugin/plugin.json`, `.oasis-plugin/marketplace.json` | Everything; same fields as Claude Code | Nothing |
| Claude Code | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Commands, agents, skills, hooks, MCP and LSP servers, options, monitors | Nothing known |
| Codex | `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json` | Skills, MCP servers, hooks | App connectors |
| Gemini CLI | `gemini-extension.json` | Commands (TOML), context file (as a skill), settings, hooks, MCP servers | Hook events with no counterpart |
| Agent Plugins | root `plugin.json` with an `agent-plugins.org` `$schema` | Skills, MCP servers, hooks | Surface-specific extensions |
| Cursor ([reference](https://cursor.com/docs/reference/plugins)) | `.cursor-plugin/plugin.json`, `.cursor-plugin/marketplace.json` | Rules (`.mdc`, as skills that state their globs and `alwaysApply`), skills, agents, commands, `mcp.json` servers, hooks (Claude Code events natively; Cursor events through the [hook bridge](#hook-protocol-bridge)) | Tab hooks (`beforeTabFileRead`, `afterTabFileEdit`), `afterAgentThought`, `workspaceOpen`, variables |
| Copilot CLI ([reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)) | `.plugin/plugin.json`, a bare `plugin.json`, `.github/plugin/plugin.json`, and `marketplace.json` in the same places | Agents, skills (and a root `SKILL.md`), commands, `.mcp.json` or `.github/mcp.json`, `lsp.json`, hooks (Claude Code events natively; Copilot events through the [hook bridge](#hook-protocol-bridge)) | `userPromptTransformed`, `preMcpToolCall` |
| Kiro power ([reference](https://kiro.dev/docs/powers/create/)) | `POWER.md` | The guide and `steering/*.md` as one skill, `mcp.json` servers | Keyword-triggered activation (the skill description carries the keywords) |
| MCP Bundle ([reference](https://github.com/modelcontextprotocol/mcpb)) | `manifest.json` with `manifest_version` (or `dxt_version`), a folder or a packed `.mcpb` / `.dxt` file | The server (`${__dirname}` rooted in the plugin, `platform_overrides` applied), `user_config` as plugin options, `prompts` as commands | Tool and prompt lists declared for display, `compatibility` checks |
| Config pack | A repository with another agent's customization files and no plugin manifest: VS Code / Copilot (`.github/prompts/*.prompt.md`, `agents/*.agent.md`, `chatmodes/`, `instructions/*.instructions.md`, `copilot-instructions.md`, `.vscode/mcp.json`, `.github/hooks/*.json`), Continue (`.continue/` blocks, a `config.yaml` with `schema: v1`), Cursor (`.cursor/rules`, `.cursor/mcp.json`, `.cursor/hooks.json`), Windsurf, Cline, OpenCode, Antigravity, Gemini CLI project files, Codex `.codex/config.toml` servers; skills in `.github/skills`, `.agents/skills` and other agents' hidden skill folders come along | Prompts as commands (`${input:x}` as arguments), agents, rules and instructions as skills that state where they apply, MCP servers (`inputs` and Continue secrets as options or environment variables), `.claude/agents` and `.claude/commands` beside them, repository hooks (`.github/hooks/*.json`, `.cursor/hooks.json`) through the [hook bridge](#hook-protocol-bridge) | Tool allow-lists on VS Code agents, OpenCode JS plugins |

### Hook protocol bridge

Cursor ([hooks](https://cursor.com/docs/agent/hooks)), Copilot CLI
([hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference))
and Gemini CLI ([hooks reference](https://geminicli.com/docs/hooks/reference/))
hooks are commands like Claude Code's, but with their own event names, stdin
fields and reply fields. OASIS runs them unchanged: each one is filed under the
Claude Code event that fires at the same moment, and when it runs the payload is
rewritten into the fields that tool sends and the reply is read the way that tool
reads it. A plugin that also ships Claude Code hooks keeps those as they are.

| Hook | Runs on | Its reply |
| --- | --- | --- |
| Cursor `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse` | `PreToolUse` for shell commands, MCP tools, file reads, any tool | `permission` allow, deny or ask; `agent_message` is the reason; `preToolUse` `updated_input` rewrites the call |
| Cursor `afterShellExecution`, `afterMCPExecution`, `afterFileEdit`, `postToolUse`, `postToolUseFailure` | `PostToolUse` / `PostToolUseFailure` | `additional_context` reaches the model; `updated_mcp_tool_output` replaces an MCP result |
| Cursor `beforeSubmitPrompt` | `UserPromptSubmit` | `continue: false` drops the prompt |
| Cursor `stop`, `subagentStop` | `Stop`, `SubagentStop` | `followup_message` keeps the agent working |
| Cursor `sessionStart`, `sessionEnd`, `subagentStart`, `preCompact`, `afterAgentResponse` | the matching event | `additional_context` where Cursor reads it |
| Copilot `preToolUse` | `PreToolUse` (`toolArgs` is a JSON string, as in Copilot) | `permissionDecision`, `permissionDecisionReason`, `modifiedArgs` |
| Copilot `permissionRequest` | `PermissionRequest` | `behavior` allow or deny; `interrupt` stops the agent |
| Copilot `agentStop`, `subagentStop` | `Stop`, `SubagentStop` | `decision: "block"` keeps the agent working |
| Copilot `postToolUse`, `postToolUseFailure`, `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `errorOccurred`, `subagentStart`, `preCompact`, `notification` | the matching event | `additionalContext`; `postToolUse` `modifiedResult` |
| Gemini `BeforeTool` | `PreToolUse`; the matcher is a regular expression over Gemini tool names (`run_shell_command`, `read_file`, `write_file`, `replace`, `glob`, `grep_search`, `list_directory`, `web_fetch`, `google_web_search`, `mcp_SERVER_TOOL`) | `decision` deny or block with `reason`; `hookSpecificOutput.tool_input` is merged over the call's arguments. `allow` is not taken as a grant: OASIS still asks where it would |
| Gemini `AfterTool` | `PostToolUse` | `decision: "deny"` replaces the result with `reason`; `additionalContext` reaches the model; `tailToolCallRequest` is reported and ignored |
| Gemini `BeforeAgent`, `AfterAgent` | `UserPromptSubmit`, `Stop` | `deny` drops the prompt, or asks for another turn with `reason` as the prompt; `continue: false` stops |
| Gemini `SessionStart`, `SessionEnd`, `Notification`, `PreCompress` | the matching event (the matcher is an exact `source`, `reason`, type or `trigger`) | `additionalContext` at session start; `systemMessage` |

Gemini timeouts are milliseconds and become seconds; `hooksConfig.disabled`
skips hooks by `name` and `hooksConfig.enabled: false` skips them all.
`BeforeModel`, `AfterModel` and `BeforeToolSelection` have no OASIS moment and
are reported. Gemini extensions installed as plugins use the same bridge.

Exit codes keep each tool's meaning. Gemini: exit 2 blocks with stderr as the
reason (after a tool it replaces the result), other codes warn. Cursor: exit 2 denies or blocks; a
permission hook whose reply is not JSON blocks the action, and `failClosed:
true` makes a crash or timeout block too; other failures let the action go on.
Copilot: exit 2 denies `preToolUse` and `permissionRequest`, turns stdout into
recovery advice on `postToolUseFailure`, and is only a warning elsewhere; a
`preToolUse` hook that exits non-zero for any other reason denies the call, and
a timeout (30 seconds unless `timeoutSec` says otherwise) lets it go on.
Copilot matchers are anchored (`^(?:PATTERN)$`), as in Copilot. Cursor tool
names (`Shell`, `Read`, `Write`, `MCP:tool`) and Copilot ones (`bash`, `view`,
`edit`, `create`) are what the hook sees and what its `matcher` is compared
with. Hooks get `CURSOR_PROJECT_DIR` and `CURSOR_PLUGIN_ROOT` (Cursor) or
`COPILOT_PLUGIN_ROOT` (Copilot), a Copilot hook's `env` and `cwd` are kept, and
a relative script path runs from the plugin folder. A rewritten `run_command`
line is used only when it is plain words, since a shell line cannot be split
back into a program and arguments safely; otherwise the hook's message says it
was ignored and the original call stands.

Every hook, MCP server and LSP server gets the plugin's folders under each name
these tools use: `OASIS_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` and `PLUGIN_ROOT`;
`OASIS_PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, `PLUGIN_DATA` and
`COPILOT_PLUGIN_DATA`; and `OASIS_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`.
`${NAME}` works for each in manifests, commands and skills.

The same bridge runs hooks a repository already keeps for other agents, read in
place with no install step: `.cursor/hooks.json` (Cursor),
`.github/hooks/*.json` (Copilot CLI and the Copilot coding agent) and the
`hooks` of `.gemini/settings.json` (Gemini CLI) in the project, and the user
files `~/.cursor/hooks.json` and `~/.gemini/settings.json`. Project files load only
in a trusted workspace, like `.claude/settings.json` hooks; the user file always
loads. A relative script path at the start of a command is made absolute (the
project folder, or `~/.cursor` for the user file). Hook policy
(`allowManagedHooksOnly`, `disableAllHooks`) applies to them as to any hook.
Codex hooks (`.codex/hooks.json` and `[hooks]` tables in `.codex/config.toml`,
and the same files in `~/.codex` or `CODEX_HOME`) already use Claude Code's
events and replies, so they run as they are; a matcher naming Codex's
`apply_patch` also matches `Edit`, `Write` and `MultiEdit`, `commandWindows` is
used on Windows, and `[features] hooks = false` turns a layer off. Codex-only
events (`PreModelRequest`, `PostModelRequest`, `Interrupt`) are skipped.
OpenCode plugins run too: JavaScript or TypeScript files (and package folders)
in `.opencode/plugins/` or `.opencode/plugin/` (trusted workspace) and in
`~/.config/opencode/plugins/`. A small host (`src/opencode-plugin-host.mjs`)
loads the plugin, calls its exported functions with `project`, `directory`,
`worktree`, `$` (commands through the system shell) and a `client` whose calls
resolve to empty results, and runs its hooks on the matching OASIS events:

| OpenCode | OASIS event | Effect |
| --- | --- | --- |
| `tool.execute.before` | `PreToolUse` | a throw denies the call with its message; `output.args` changed in place rewrites it (`filePath`, `oldString`, `newString` map to OASIS argument names; tools are `bash`, `read`, `write`, `edit`, `glob`, `grep`, `list`, `webfetch`, `todowrite`, `task`, `SERVER_TOOL` for MCP) |
| `tool.execute.after` | `PostToolUse` | `output.output` changed replaces the result the model sees |
| `event` `file.edited` | `PostToolUse` on edits | observe only |
| `event` `session.idle`, `session.created`, `session.deleted` | `Stop`, `SessionStart`, `SessionEnd` | observe only |

Each call loads the plugin fresh, so module-level state does not carry between
calls. TypeScript plugins need Node.js 22.18 or later (type stripping). OpenCode
V2 plugins (`Plugin.define`), custom `tool` definitions, `chat.*`,
`permission.ask` and `shell.env` are not run.

Because these files now run commands under OASIS too, writing `.codex/hooks.json`
or anything in `.github/hooks/` or `.opencode/plugins/` asks first, like other agents' settings files.
`OASIS_OTHER_AGENT_RULES=0` or `"otherAgentHooks": false` in settings turns this
off.

### Bringing plugins from other agents

`oasis plugin adopt --list` shows the plugins you already installed in Gemini
CLI (`~/.gemini/extensions`), Codex (`~/.codex/plugins/cache`, newest cached
version), Copilot CLI (`~/.copilot/installed-plugins`) and Cursor
(`~/.cursor/plugins`). `oasis plugin adopt --yes` installs them all through
`oasis add`, converted and audited like any other plugin; name some (`oasis
plugin adopt greeter codex:linter --yes`) or use `--from gemini,codex` to
choose. The other agents' folders are only read. Claude Code plugins need no
adopting: OASIS reads Claude Code's own install record.

### Using everything from any MCP client

`oasis mcp serve` turns OASIS into a bridge for agents that only speak MCP.
Every slash command OASIS reads in the workspace and your user folders, in
whatever format it was written (Claude Code plugins, Gemini CLI TOML, Cursor,
VS Code prompt files, Continue, OpenCode, Windsurf workflows), is served as an
MCP prompt (namespaces use `.`, so `/git:commit` is `git.commit`, and the
typed text goes in the `arguments` argument). Skills from every folder OASIS
reads are served through the `list_skills`, `load_skill` and
`read_skill_resource` tools. Register it once in Codex, Gemini CLI, Cursor,
Copilot, Zed or Claude Desktop (`command: oasis`, `args: [mcp, serve]`) and
they all share the same commands and skills without converting anything.
Inline shell in a command (`` !`cmd` ``) only runs with `--allow-commands`;
`--no-prompts` serves tools alone.

`oasis mcp share` does that registration for you. It adds an `oasis` server
to `.mcp.json` (Claude Code), `.cursor/mcp.json`, `.vscode/mcp.json` (VS Code
and Copilot), `.gemini/settings.json`, `.codex/config.toml`, `opencode.json`
and `.zed/settings.json` in the project, keeping comments and other servers.
`--user` writes the user-level files instead (Cursor, Gemini CLI, Codex,
OpenCode, Zed and Copilot CLI's `~/.copilot/mcp-config.json`), `--to
codex,gemini` picks agents, `--dry-run` shows what would change, an existing
entry is kept unless `--force`, and `--remove` takes it out again.

### Exporting a plugin for other agents

`oasis plugin new NAME` starts a plugin that is universal from the first
minute: an example command, skill and agent with the manifests of every agent
below. After editing, `oasis plugin export --in-place` (in the plugin folder)
rewrites only the generated files (other agents' manifests, Gemini TOML
commands, which start with a `# Generated by oasis plugin export` line, and
the Codex and Copilot copies), so a deleted command leaves nothing behind.

Run `oasis plugin inspect [PATH]` first to see, without writing anything,
what OASIS reads from the plugin, what will not run here, and for each
other agent whether the export is full or which parts it leaves out
(`--json` for scripts).

`oasis plugin export [PATH] --out DIR` writes the plugin at PATH (an OASIS or
Claude Code plugin, or anything in the table above) into one folder that
OASIS, Claude Code, Codex, Gemini CLI, Cursor and Copilot CLI can each
install. `--to codex,gemini` limits the targets. Skills and MCP servers are
shared; each target gets its own manifest:

| Target | Manifest | Translated | Left out |
| --- | --- | --- | --- |
| OASIS / Claude Code | `.claude-plugin/plugin.json` | Nothing | Nothing |
| Codex | `.codex-plugin/plugin.json` | Commands and agents as skills (in `codex/skills/`) | Options |
| Gemini CLI | `gemini-extension.json` | Commands as TOML (`$ARGUMENTS` as `{{args}}`), hooks under Gemini event and tool names, options as settings, `${CLAUDE_PLUGIN_ROOT}` as `${extensionPath}` | Hook events with no Gemini counterpart |
| Cursor | `.cursor-plugin/plugin.json`, `mcp.json` | Options as variables | Hooks |
| Copilot CLI | `.plugin/plugin.json` | Agents as `*.agent.md` (in `copilot/agents/`) | Hooks, options |

Claude Code hooks move to `hooks/claude-hooks.json` so agents that read
`hooks/hooks.json` in their own format do not misread them. The command prints
what each target runs as is, what it translated and what it left out.

Pointed at a marketplace (a folder with `.claude-plugin/marketplace.json`, or a
Codex, Cursor or Copilot one), the command exports every plugin the marketplace
keeps in the repository into `plugins/NAME/` and writes a marketplace file for
each agent: `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`
(Codex), `.cursor-plugin/marketplace.json` and `.github/plugin/marketplace.json`
(Copilot CLI). Gemini CLI has no marketplace file; each plugin folder is an
extension on its own. Plugins listed from other repositories are named in the
report and left as they are.

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
| `.github/agents/*.agent.md`, `.github/chatmodes/*.chatmode.md`, and the same files in the VS Code profile's `User/prompts` | VS Code, GitHub Copilot | Agents for the task tool and `oasis --agent NAME`, named after the file; VS Code tool and tool-set names (`search`, `edit`, `runCommands`, `fetch`, ...) become the matching OASIS tools, MCP entries such as `github/*` are dropped, and `infer: false` keeps the agent out of the task tool ([custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)) |
| `.continue/prompts/*.prompt`, `.continue/prompts/*.md`, `~/.continue/prompts` | Continue | Slash commands named after the file; the YAML preamble (above a bare `---` in `.prompt` files) gives the description, `invokable: false` hides one, `{{{ input }}}` takes the typed arguments, `<system>` text becomes a system note, `@path` reads a workspace file, and IDE context such as `{{{ currentFile }}}` or `{{{ diff }}}` becomes a plain request to look it up ([prompt files](https://docs.continue.dev/walkthroughs/prompt-files)) |
| `.github/prompts/*.prompt.md`, VS Code profile `User/prompts/*.prompt.md` | VS Code, GitHub Copilot | Slash commands named after the file; `${input:name}` and `${input:name:placeholder}` take the typed arguments (one input gets all of them, several take one word each and the last the rest); editor variables such as `${selection}` have no value and stay as written ([prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files)) |
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
