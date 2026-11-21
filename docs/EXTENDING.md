# Extending OASIS: skills, MCP, plugins and hooks

OASIS reads the same extension formats as Claude Code, so an existing setup works
without conversion. Everything below is optional; OASIS works with none of it.

Extensions can run third-party code with your account's permissions. Review a
skill, plugin, hook or MCP server before turning it on. Project-level extensions
(`.mcp.json`, project hooks, project settings that loosen permissions) wait until
you run `oasis trust` in that folder. `--safe-mode` starts a session with all of
them off.

## Project instructions

`oasis init` writes an `OASIS.md` with the project's build and test commands.
OASIS also reads `AGENTS.md`, `CLAUDE.md` (and `CLAUDE.local.md`), plus the rule
files of other agents (Cursor, Windsurf/Devin Desktop, Gemini CLI, Goose, Roo,
Kilo, Cline, OpenHands), from the git root down to the current folder.

## Skills

A skill is a folder with a `SKILL.md` file (YAML front matter with `name` and
`description`, then instructions). The model sees each skill's description and
loads the full text only when it needs it.

| Location | Scope |
| --- | --- |
| `.agents/skills/`, `.oasis/skills/`, `.claude/skills/` | This project |
| `~/.config/agents/skills/`, `~/.claude/skills/` | Every project |
| Installed plugins | While the plugin is enabled |

```sh
oasis skills list                         # what this session can see
oasis skills find testing                 # search the skills.sh index
oasis skills add OWNER/REPO --skill NAME  # install one skill (--global for every project)
oasis skills install verify               # one of the bundled skills in skills/
oasis skills remove NAME
```

`oasis skills add` reads every file of a skill before copying it and never runs
any of them. Lines that pipe a download into a shell, use `sudo`, or edit shell
start-up files are listed as warnings. A skill with a high-risk line (a reverse
shell, decoding and running hidden code, reading SSH keys, sending environment
variables away, `rm -rf ~`, telling the agent to hide what it does, invisible
direction-control characters, or switching OASIS permissions to bypass) is not
installed; the report shows each file and line. After reading it you can install
anyway with `--allow-risky`. The agent's install tool has no such override. The
audit matches patterns, so it does not prove a skill is safe; review what you
install. Plugin installs use the same audit (see [Plugins](#plugins)).

In a session, `/skills` lists them and `/skill-doctor` checks a skill's front
matter and file references.

## MCP servers

Stdio, streamable HTTP and SSE servers are supported, with OAuth sign-in,
elicitation and MCP Tasks.

```sh
oasis mcp search filesystem               # the official MCP Registry
oasis mcp install NAME                    # add a registry server, pinned to a version
oasis mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .
oasis mcp add --transport http docs https://example.com/mcp
oasis mcp login docs                      # OAuth for a remote server
oasis mcp list | get NAME | enable NAME | disable NAME | remove NAME
```

A project can ship servers in `.mcp.json` (Claude Code's format, with `${VAR}`
expansion from your environment). They load only in a trusted workspace.

Protections applied to every server:

- Tool descriptions are cleaned of invisible characters. A description that reads
  like instructions to the agent, or points it at credential files, is withheld
  and the tool is marked.
- Each tool definition is fingerprinted on first use (`mcp-pins.json` in the
  config folder). If a server later changes a definition, calls to that tool need
  a person in every permission mode.
- MCP servers run as ordinary processes outside the OS sandbox. Treat them as
  trusted code.

Filters, lazy start and long-running tools are in
[Configuration](CONFIGURATION.md#mcp-tool-filters). `oasis mcp serve` exposes
OASIS's own tools to other MCP clients.

## Connected apps

`/connect github` (or "connect Linear" in plain words) shows a Connect card; you
approve access on the service's own page. 48 apps are built in, and any remote MCP
server in the official registry can be added by name. See
[Configuration](CONFIGURATION.md#connected-apps).

## Plugins

OASIS installs Claude Code plugins from marketplaces. Commands, agents, skills,
hooks, MCP servers and language servers inside them load as they do in Claude
Code.

```sh
oasis plugin marketplace add anthropics/claude-plugins-official
oasis plugin install NAME@MARKETPLACE
oasis plugin list | show | enable | disable | update | uninstall NAME
oasis plugin validate ./my-plugin
oasis add OWNER/REPO                      # also converts Codex plugins and Gemini CLI extensions
```

Plugins run hooks and MCP servers with your permissions, so OASIS reads every
copied file before it registers or enables one, using the same rules as skills.
Warnings are printed with the install; a high-risk line refuses it and removes
the copy. After reading the report, `oasis plugin install NAME@MARKETPLACE
--allow-risky` (or `oasis add SOURCE --allow-risky`, `oasis plugin update NAME
--allow-risky`) installs it anyway. Installs started by the agent, the web app
or `/add` have no override. A clean audit is not a safety review.

The web app has the same catalogue under **Plugins**. Built-in capability bundles
(`oasis plugins list`) are separate, smaller packs maintained in this repository
under `plugins/`.

### Domain packs

Two plugins in this repository add agents whose reports OASIS checks on return
(see [Evidence and contracts](OASIS-NEURON-NETWORK.md#evidence-and-contracts)):

- `plugins/oasis-research`: `oasis_web_search` and `oasis_fetch_url` MCP tools,
  the `oasis-research:researcher` and `oasis-research:fact-checker` agents
  (`domain: research`, no write or shell tools), the deep-research skill and
  `/oasis-research:research`. A report that cites a page the agent never
  fetched comes back rejected.
- `plugins/oasis-analysis`: the `oasis-analysis:analyst` agent
  (`domain: analysis`), the data-analysis skill and `/oasis-analysis:analyze`.
  Every decimal, percentage or larger number in its report must have been
  printed by code it ran.

Load one for a session with `oasis --plugin-dir plugins/oasis-research` (from
the npm package, `$(npm root -g)/oasis-oss/plugins/...`), or install it from a
marketplace that lists it. An installed copy finds OASIS's modules through
`OASIS_PACKAGE_ROOT`, which OASIS sets for plugin MCP servers. Uninstalling a
pack removes its agents and leaves everything else as it was.

## Custom slash commands and agents

- Commands: Markdown files in `.oasis/commands/` or `.claude/commands/` (and the
  user-level equivalents). `$ARGUMENTS` and `$1`… are replaced; inline shell runs
  only in trusted workspaces. Cursor commands, Gemini CLI TOML commands, OpenCode
  commands and Windsurf/Antigravity workflows load in place.
- Subagents: Markdown files in `.oasis/agents/` or `.claude/agents/` with
  `description`, `tools` and an optional `model`. See [Subagents](SUBAGENTS.md).

## Hooks

Hooks run a command (or an HTTP request) on agent events. They are configured in
`settings.json` under `hooks`, in Claude Code's format, and listed with `/hooks`
or `oasis permissions`.

Supported events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PostToolBatch`, `PermissionRequest`, `PermissionDenied`, `UserPromptSubmit`,
`UserPromptExpansion`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`,
`SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `Notification`,
`CwdChanged`, `DirectoryAdded`, `InstructionsLoaded`, `TaskCreated`,
`TaskCompleted`, `PreModelSwitch`, `PostModelSwitch`, `FileChanged`,
`ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `TeammateIdle`, `Setup`,
`Elicitation`, `ElicitationResult`, `MessageDisplay`.

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "edit_file|write_file", "hooks": [{ "type": "command", "command": "jq -r '.tool_input.path // empty' | xargs -r npx prettier --write" }] }
    ]
  }
}
```

The hook receives the event as JSON on stdin (for tool events `tool_name`, `tool_input` and `session_id`)
and runs in the project folder with `OASIS_PROJECT_DIR` (and
`CLAUDE_PROJECT_DIR`) set. A `PreToolUse` hook can allow, ask or deny a call. Project hooks run only after
`oasis trust`; managed policy can disable all hooks (`disableAllHooks`) or limit
them (`allowManagedHooksOnly`, `allowedHttpHookUrls`).

## Settings files

Later files win: user `~/.config/oasis/settings.json` (and `~/.claude/settings.json`),
project `.claude/settings.json` and `.oasis/settings.json`, then local
`.claude/settings.local.json` and `.oasis/settings.local.json`. Managed
(organisation) settings override all of them. `oasis config list` shows the
result.
