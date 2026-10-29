---
name: plugin-authoring
description: Reference for writing OASIS / Claude Code plugins: manifest, commands, agents, skills, hooks, MCP and LSP servers, monitors, workflows, marketplaces, and how to test them.
---

# Writing a plugin

OASIS loads Claude Code plugins unchanged. A plugin is a directory:

```
my-plugin/
  .claude-plugin/plugin.json   # manifest (required)
  commands/*.md                # slash commands: /my-plugin:name
  agents/*.md                  # subagents (frontmatter: name, description, tools, model)
  skills/<name>/SKILL.md       # skills (frontmatter: name, description)
  hooks/hooks.json             # { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
  .mcp.json                    # MCP servers ({ "mcpServers": { ... } })
  .lsp.json                    # LSP servers
  monitors/monitors.json       # background monitors that wake the session
  workflows/*.js               # saved dynamic workflows: /my-plugin:name
```

## Manifest

```json
{ "name": "my-plugin", "version": "0.1.0", "description": "What it does", "author": { "name": "You" } }
```

`name` is kebab-case and becomes the namespace. Optional fields: `commands`, `agents`, `hooks`,
`mcpServers` (paths or inline objects that replace the defaults), `userConfig` (values asked for at
enable time, exposed as `${user_config.KEY}` and `CLAUDE_PLUGIN_OPTION_KEY`).

## Paths and environment

- In hooks, MCP and LSP commands use `${CLAUDE_PLUGIN_ROOT}` for files inside the plugin and
  `${CLAUDE_PLUGIN_DATA}` for persistent per-plugin data. `CLAUDE_PROJECT_DIR` is the workspace.
- Commands: Markdown with frontmatter (`description`, `argument-hint`, `allowed-tools`, `model`)
  and `$ARGUMENTS` / `$1` placeholders.

## Test locally

1. `oasis --plugin-dir ./my-plugin` loads it for one session without installing.
2. `oasis plugin validate ./my-plugin` checks the manifest and files.
3. Run each command and check `/hooks`, `/mcp`, `/agents` and `/skills` list your parts.
4. For hooks, run `oasis --debug hooks` and read the hook input/output in the debug log.

## Distribute

Create a marketplace repo with `.claude-plugin/marketplace.json`:
`{ "name": "my-market", "owner": { "name": "You" }, "plugins": [ { "name": "my-plugin", "source": "./my-plugin", "description": "..." } ] }`.
Users add it with `/plugin marketplace add OWNER/REPO` and install with `/plugin install my-plugin@my-market`.
