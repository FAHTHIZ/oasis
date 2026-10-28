# Oasis OSS — Detailed User Guide

For the project overview and quickest start, see the [main README](../README.md). For an audited implementation inventory and truthful statement of known gaps, see [Current status](CURRENT_STATUS.md). This guide keeps the full setup, configuration, integration, safety, CLI, and developer reference in one place.

---

## Install the terminal agent

Requirements: Node.js 22+ and npm. Git is required for installing directly from this repository.

~~~bash
npm install -g git+https://github.com/FAHTHIZ/oasis.git#main
oasis
~~~

To update later, run `oasis update`. It compares your installed commit with GitHub `main` and installs the newer version after you confirm. `oasis update --check` only reports the versions, and `--yes` skips the prompt.

When you launch `oasis` for the first time without a configured model, Oasis offers guided setup with OmniRoute as the default starting point. You can accept, choose another provider, or skip and later run `/setup` or type “install OmniRoute” in the terminal prompt. The same guided setup is offered when launching `oasis web` or starting a one-shot task from an interactive terminal without a provider. Software installation, gateway startup, and provider changes are confirmed and verified; free/keyless model routes depend on upstream availability and limits. To change providers later, run `oasis setup`; to check live tool calling, run `oasis doctor --test-provider`.

During setup, choose a provider preset or a custom endpoint: **OmniRoute**, OpenAI, Anthropic, OpenRouter, Google Gemini, or local Ollama. OmniRoute uses the local OpenAI-compatible endpoint `http://127.0.0.1:20128/v1` with model `auto`; `oasis setup` can install and start the gateway after approval, then verifies tool calling before changing the provider configuration. Some OmniRoute configurations require a local endpoint key from the gateway dashboard. OpenRouter uses `https://openrouter.ai/api/v1`; Gemini uses `https://generativelanguage.googleapis.com/v1beta/openai/`; local Ollama uses `http://localhost:11434/v1`. For OpenRouter and Ollama, enter the exact model ID available to your account or local server. The browser provider form includes an OmniRoute preset for an already-running gateway.

**Setup verifies before saving.** Oasis sends a small test prompt with one inert tool schema and saves provider credentials only after the model returns the expected tool-call response. The probe is inspected but never executed. A failed test does not overwrite the current config. Key input is hidden in the CLI and the browser setup form only accepts credentials from the same device over localhost. Secrets are stored in the user-level Oasis configuration file with restrictive POSIX permissions where supported—not in this repository.

### Use the connected browser agent from main

The authenticated browser runtime and extension hub are included in the default `main` installation. From the project you want Oasis to operate on:

~~~bash
oasis setup
cd /path/to/your/project
oasis web
~~~

Open the local URL printed by Oasis, paste its one-time connection token into **Agent → Connect runtime**, and describe your task in plain English. The token is generated for that running server and is not your model API key. The **Model provider** panel can test and save a provider; provider keys are accepted only from the same device over localhost. For a phone-to-computer connection, configure model credentials in the host terminal with `oasis setup` instead. GitHub browsing and cloning reuse the host's GitHub CLI login: install `gh`, run `gh auth login`, then use **Check connection** and **Refresh repositories**. Repository cloning requires approval and switches new agent tasks to the clone under `.oasis/workspaces/`.

For access from another device, prefer HTTPS with a certificate trusted by the phone and with a subject alternative name matching the computer's LAN IP. Oasis supports `oasis web --host 0.0.0.0 --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem`. Non-loopback plaintext requires an explicit `--allow-insecure-lan` opt-in, which exposes traffic and bearer tokens to network observation. Do not port-forward the bridge or expose it to the public Internet. Real Android/Termux and device-trust workflows still need additional platform testing.

Supported provider shapes:

- Native OpenAI Responses API (`openai-responses`), recommended for current OpenAI reasoning models that require Responses for tool calling.
- OpenAI-compatible chat completions endpoints, including compatible gateways and local endpoints that expose the same API.
- Native Anthropic Messages API endpoints. Select `anthropic` during `oasis setup`.
- Claude on AWS Bedrock (`bedrock`) and Google Vertex AI (`vertex`). Pick the preset in `oasis setup`, or set `CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1` (or `OASIS_USE_BEDROCK` / `OASIS_USE_VERTEX`) with a model ID in `OASIS_MODEL` or `ANTHROPIC_MODEL`, so an existing Claude Code cloud setup works without changes. Bedrock signs requests with AWS SigV4 from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` or an `AWS_PROFILE` in `~/.aws/credentials`, or uses a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`. The region comes from `AWS_REGION`. Vertex uses `ANTHROPIC_VERTEX_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) and `CLOUD_ML_REGION` (default `us-east5`, or `global`). Its token comes from `GOOGLE_OAUTH_ACCESS_TOKEN`, or from `gcloud auth print-access-token` (cached for 45 minutes). Vertex replies stream. Bedrock replies arrive in one piece. Thinking, prompt caching, vision and tools all work as they do with native Anthropic.
- Claude on Microsoft Foundry (`foundry`, Azure). Pick the `foundry` preset or set `CLAUDE_CODE_USE_FOUNDRY=1` (or `OASIS_USE_FOUNDRY=1`) with `ANTHROPIC_FOUNDRY_RESOURCE=my-resource` (the resource name only) or `ANTHROPIC_FOUNDRY_BASE_URL=https://my-resource.services.ai.azure.com/anthropic` (also works for an API Management gateway). The model is your deployment name, from `OASIS_MODEL`, `ANTHROPIC_MODEL` or `ANTHROPIC_DEFAULT_SONNET_MODEL`. Auth order matches Claude Code: `ANTHROPIC_FOUNDRY_AUTH_TOKEN` (an Entra ID bearer token), then `ANTHROPIC_FOUNDRY_API_KEY`, then `az account get-access-token --resource https://ai.azure.com` from an `az login` session (cached for 45 minutes). Replies stream.
- Local Ollama-style endpoints such as `http://localhost:11434/v1`, provided the selected model supports tool calls. Leave the API key blank for a local endpoint.
- Environment overrides: `OASIS_BASE_URL`, `OASIS_MODEL`, and `OASIS_API_KEY`. Provider-specific keys are recognised for matching presets: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), and `OLLAMA_API_KEY` for Ollama Cloud. Run `oasis doctor --test-provider` to send a live inert-tool probe without executing the tool; a successful check confirms the model can call tools.

Oasis does not include an API subscription or a model. A provider must be reachable and the selected model must support tool calling.

## Use it in plain English

~~~bash
oasis "Explain this repository and identify the next useful improvement"
oasis "Find the bug in the task filter, fix it, and run the relevant tests"
oasis "Install pnpm"
oasis "Install Playwright and set up browser tests"
oasis skills list
oasis skills install debugging
oasis skills find frontend-design
oasis skills inspect vercel-labs/agent-skills
oasis skills add vercel-labs/agent-skills --skill web-design-guidelines
oasis skills add vercel-labs/agent-skills --all --global
oasis "Set up OmniRoute and connect it as my model provider"
oasis "Add the web-design-guidelines skill from vercel-labs/agent-skills to this project"
oasis "Install the code-quality capability plugin"
oasis plugins list
oasis plugins install code-quality
# Other reviewed bundles include mobile-development, web-app-development, api-development, and security-review.
oasis mcp list
oasis "Configure the filesystem MCP server using the reviewed executable and arguments, then show me its available tools"
oasis extensions inspect https://github.com/owner/repository
oasis extensions mcp-import https://github.com/owner/repository
oasis extensions update https://github.com/owner/repository --scope project
oasis extensions list
oasis extensions rollback agents --commit 0123456789abcdef0123456789abcdef01234567 --scope project
~~~

A simple request such as `oasis install pnpm` uses the package installer directly and does not require an AI API. Compound tasks are routed through the agent and need a configured model. Once the model is live, requests such as “set up OmniRoute”, “add this Agent Skill”, or “install the code-quality plugin” can be made in the same chat; Oasis selects the appropriate setup tool and asks for approval before installing packages, switching providers, or importing external instructions. Provider credentials are never requested through chat messages. The Skills commands integrate the pinned Vercel Skills CLI on demand: `find` searches skills.sh, `inspect` lists a source's skills, and `add` installs only the chosen skill (or all skills when explicitly requested) into the universal `.agents/skills/` path or its global equivalent. Oasis loads those standard `SKILL.md` files in new sessions and treats them as external/untrusted instructions. The external CLI requires Node.js 22.20+; telemetry is disabled for Oasis-launched runs.

## What is implemented

### Terminal agent
- Interactive sessions and one-shot plain-English tasks.
- Multi-step native OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic Messages tool-calling loops, with incremental text streaming in the browser, safe cancellation of active model requests/commands, and a JSON-response fallback for gateways that do not stream.
- Chat-driven provider switching and OmniRoute bootstrap: the agent can request approved CLI installation/startup, probe the gateway with a non-executed tool call, and change the user-level provider only after verification succeeds. Free routes and provider quotas depend on the gateway and upstream service.
- MCP stdio server integration configured either by CLI or normal chat; chat setup requires a dedicated manual approval, validates the server handshake before persistence, and exposes discovered tools in the current session. Every MCP tool call still requires its own approval by default.
- Workspace file listing, glob matching, literal search, line-ranged reads, exact-string `edit_file` patches, whole-file writes, and approved deletes.
- Command execution through an executable plus argument array, without shell expansion; an optional `run_shell` tool (enabled by settings or the OS sandbox) handles pipes and `&&`. Long-running commands can run in the background.
- Package installation for npm, Python/pip, system package managers, Cargo, and Go when supported on the host.
- Public HTTP/HTTPS documentation fetches with private-network URL checks and response limits.
- Bundled skills for debugging, code review, testing, environment setup, shipping features, mobile development, web app development, API development, and security review.
- A curated capability-bundle installer (`oasis plugins list/install/remove`) that installs bundled workflow skills as a unit; the agent can install a bundle in natural language after approval.
- Bounded specialist reviews for code quality, security, architecture, and test strategy. Each reviewer is a separate read-only model session with no edit, command, package-install, or MCP tools; a per-task cap prevents unbounded delegation.
- Layered memory from user, project, and local files (`OASIS.md`, `AGENTS.md`, `CLAUDE.md`, `OASIS.local.md`), plus skills from `.oasis/skills/`, Claude Code's `.claude/skills/` (project) and `~/.claude/skills/` (personal, wins over project), `.agents/skills/` and enabled plugins. `${CLAUDE_SKILL_DIR}` in a skill expands to its folder. Like Claude Code, Oasis also reads `CLAUDE.md`/`AGENTS.md`/`OASIS.md`/`CLAUDE.local.md` in directories above the workspace (monorepos; `OASIS_DISABLE_PARENT_MEMORY=1` turns this off) and every Markdown file under `.claude/rules/` and `~/.claude/rules/`; a `paths:` front-matter list marks a rule as applying to matching files. `CLAUDE.md` (or `AGENTS.md`, `OASIS.md`, `CLAUDE.local.md`) files in subfolders load on demand: the first time the agent reads or edits a file in that folder, the folder's instructions are attached to the result, once per session (`OASIS_DISABLE_NESTED_MEMORY=1` turns this off).
- Claude Code-style permission rules and modes, lifecycle hooks, parallel subagents with custom agent files, custom slash commands, `@file` mentions, per-turn checkpoints with `/rewind`, and a headless `oasis -p` mode for scripts and CI.
- Automatic snapshots before edits and overwrites, plus snapshot listing and restore commands.
- Workspace-scoped saved sessions (on by default) that can be resumed, renamed or deleted; skill descriptions load first and full skill guides load only on demand.
- Environment diagnosis, workspace initialization, provider configuration, and self-update.

### Browser workspace
- Responsive project dashboard with statistics.
- Project creation, filtering, progress, completion/reopen, and removal.
- Task creation, completion, priorities, project association, search, and deletion.
- Notes that save locally, plus JSON export/import.
- Light/dark themes and an installable PWA shell with a service worker for offline static assets.
- A connected Agent page when served by `oasis web`: authenticated chat, resumable saved chat history, visible tool activity, and browser-based approval for commands, installs, deletion, and capability-bundle installation.
- OmniRoute provider preset for an already-running local gateway; provider keys remain restricted to the local browser session and are never echoed by the runtime.
- An integrated argv-based command runner that captures command output and requires per-command approval.
- GitHub CLI integration to check the host's existing authentication, list up to 30 repositories accessible to that account, clone a selected repo after approval, and switch the active agent workspace.

## Plugins, integrations, and installation

Oasis separates three things that are often all called “plugins”:

- **Skills** are reusable workflow instructions that guide the agent through tasks such as debugging, testing, code review, and release preparation.
- **Capability bundles** package related built-in skills so they can be installed and removed together. Browse with `oasis plugins list`; install with `oasis plugins install code-quality`; remove with `oasis plugins remove code-quality`. Bundles are copied into the current workspace under `.oasis/`.
- **Claude Code plugins** run natively — no conversion. Add any Claude Code marketplace and install from it exactly as in Claude Code:

  ```bash
  oasis plugin marketplace add anthropics/claude-code   # GitHub owner/repo, git URL (#ref), or local path
  oasis plugin install feature-dev@claude-code-plugins
  oasis plugin list | enable NAME | disable NAME | update [NAME] | uninstall NAME
  oasis plugin validate ./my-plugin                      # check a plugin or marketplace you are writing
  oasis --plugin-dir ./my-plugin                         # load a plugin for one session while developing
  ```

  Inside a session use `/plugin ...` with the same arguments. An enabled plugin contributes namespaced slash commands (`/feature-dev:feature-dev`), subagents (`feature-dev:code-reviewer`), Agent Skills, hooks (`hooks/hooks.json`, run with `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, and `CLAUDE_PROJECT_DIR` set) and MCP servers (`.mcp.json`, with `${CLAUDE_PLUGIN_ROOT}` expanded). Marketplace entries may use relative, `github`, `url`, or `git-subdir` sources, `metadata.pluginRoot`, and `strict: false`. Enablement uses Claude Code's `"enabledPlugins": {"name@marketplace": true}` key: user settings always apply; a project's `.claude/settings.json` can enable plugins once you `oasis trust` the workspace. Plugins you already installed and enabled in Claude Code (`~/.claude/plugins`) load automatically. Plugins run hooks and MCP servers with your permissions, just as in Claude Code, so install only plugins you trust. Set `OASIS_PLUGINS=off` to disable all plugins for a run.

  Marketplace entries may point at npm packages: `"source": { "source": "npm", "package": "@acme/plugin", "version": "^2.0.0", "registry": "https://npm.example.com" }`. Oasis runs `npm pack --ignore-scripts`, unpacks the tarball into the plugin cache and records the resolved version and integrity hash. `npm` and `tar` must be on `PATH`.

  Plugins can also ship the rest of Claude Code's component types, and OASIS loads them too:

  - **LSP servers** (`.lsp.json` or `lspServers` in `plugin.json`, Claude Code's `extensionToLanguage` format) power the `lsp` tool for those file types. Starting one still needs approval once per session, and servers in your own settings take precedence for the same extension.
  - **Monitors** (`monitors/monitors.json`, or `experimental.monitors` in `plugin.json`: a path or an inline array of `{ name, command, description, when }`) are background watches that start with the interactive session (`when: "always"`, the default) or the first time a skill runs (`when: "on-skill-invoke:deploy"`). Each stdout line becomes an event for the agent. `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are expanded; `${user_config.*}` is not allowed. They don't run in `-p` mode, and `OASIS_DISABLE_PLUGIN_MONITORS=1` turns them off.
  - **Output styles** (`output-styles/*.md`) appear as `plugin-name:style` in `/output-style`, `--output-style`, and the `outputStyle` setting.
  - **Executables** in `bin/` are on `PATH` for `run_command` and `run_shell` while the plugin is enabled.
  - **A default agent**: `"agent"` in the plugin's `settings.json` runs the main session as that agent (its instructions and tool list). Override it with `--agent NAME`, or set `"agent"` in your own settings. `--bare` ignores it.
  - **userConfig options**: `oasis plugin config NAME` lists them; `oasis plugin config NAME KEY=VALUE` sets one. Values substitute into `${user_config.KEY}` in MCP and LSP configs and are exported to hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`. Non-sensitive values go to `pluginConfigs` in user settings (Claude Code's `pluginConfigs` are read too). Sensitive options are stored in the OS keychain (macOS Keychain via `security`, Linux Secret Service via `secret-tool`) and never written to `settings.json`. Without a keychain (Windows, headless Linux) they fall back to a 0600 file under the OASIS config directory; `OASIS_SECURE_STORAGE=file|keychain|libsecret` forces a backend.

  `oasis plugin show NAME` lists everything one plugin provides, plus any missing required options.
- **MCP integrations** connect Oasis to external tools and services. List them with `oasis mcp list`; configure an approved stdio server with `oasis mcp add NAME -- EXECUTABLE ARG...`, or describe the exact executable and argument list to Oasis in chat. Chat configuration always asks for manual approval—even when `--yes` is active—starts the server only after approval, and makes its discovered tools available in that session. External integrations may execute code or access data, so inspect their source, requested environment variables, and permissions before enabling them.

Why plugins matter: they save repeated setup, make workflows consistent, connect the agent to tools it cannot access by itself, and let a team share tested procedures. They do not automatically make the model smarter, grant a service account, or provide a paid model/API subscription.

The initial Oasis plugin catalog is intentionally small and reviewed. Its bundles install workflow text only: they do not silently run setup scripts, install packages, start servers, or grant credentials. The GitHub extension inspector detects Agent Skills and common Claude Code, Codex, and Gemini CLI markers and reports commands, MCP declarations, hooks, and executable components that are not activated. For recognized portable Agent Skills, Oasis also preserves bounded text references/assets and exposes them through integrity-checked resource access. Scripts remain unimported and inactive. The mobile-friendly Agent page and authenticated local runtime bridge are included in main. Signed third-party bundles, broader connector lifecycle management, embedded GitHub OAuth, and a full interactive terminal are still future work—not features Oasis claims to have.

The `main` installation contains both the terminal agent and the connected browser workspace. Opening `index.html` directly still provides only the static projects/tasks/notes dashboard; local agent execution requires the `oasis web` runtime to be running.

## VS Code, Cursor, and Windsurf

OASIS connects to VS Code (and forks) the way Claude Code does:

```bash
oasis ide install      # builds the extension and installs it with code / cursor / windsurf
oasis ide package      # or just build oasis-vscode.vsix ("Extensions: Install from VSIX...")
oasis ide              # show whether an IDE bridge is available for this folder
```

Reload the editor, then run `oasis` in its integrated terminal or press Ctrl/Cmd+Esc ("OASIS: Run in Terminal"). It connects automatically; from an outside terminal use `/ide`. Once connected:

- **Selection context**: the code you have selected (or the file you are in) is attached to each prompt, shown as `[ide] Selected 12 lines from src/app.ts`.
- **Diff review**: edit approvals for `edit_file`, `multi_edit`, and `write_file` open in VS Code's diff view; choose **Accept** or **Reject** in the editor. Auto-approved edits (`acceptEdits`, allow rules, `--yes`) are not interrupted.
- **Diagnostics**: the agent can call `ide_get_diagnostics` to read the editor's language-server errors after editing, and `ide_open_file` to show you code at a line.
- **File references**: Ctrl/Cmd+Alt+K inserts `@path#L10-20` for the current selection into the OASIS terminal.
- **Chat panel**: click the OASIS icon in the activity bar (or Ctrl/Cmd+Shift+Esc, or "OASIS: Open Chat in Editor") for an in-editor chat, like Claude Code's VS Code panel. Replies stream in as they are written, tool calls appear inline, and approvals show as **Allow / Always allow / Deny** cards (edits still open as native diffs). **Stop** or Esc interrupts the running turn; **New chat** starts a fresh session. Ctrl/Cmd+Alt+L ("OASIS: Add Selection to Chat") adds an `@path#L10-20` reference to the chat box. The panel runs the CLI in the workspace folder, so your settings, hooks, MCP servers and plugins all apply. Set `oasis.command` if `oasis` is not on your PATH.

The bridge listens only on 127.0.0.1, requires a random bearer token stored in a 0600 lock file under the OASIS config directory (`ide/<port>.lock`), and rejects browser origins. Set `OASIS_IDE=off` to never connect.

## Optional OpenHands delegation

Oasis can delegate a bounded task to an already-running OpenHands Agent Server. This is an optional bridge, not an OpenHands installation wizard or a replacement for Oasis's own runtime. Set the connection details in the environment used to start Oasis:

~~~bash
export OPENHANDS_AGENT_SERVER_URL=http://127.0.0.1:8000
export OPENHANDS_AGENT_PROFILE_ID=your-reviewed-agent-profile
# If the server requires session authentication, set OPENHANDS_SESSION_API_KEY
# in your local environment/secret manager; never paste it into an Oasis prompt.
# For a remote HTTPS server, also set the absolute workspace path as seen by that server:
# export OPENHANDS_WORKSPACE_PATH=/workspace/project
oasis "Delegate a code review to OpenHands"
~~~

OPENHANDS_AGENT_PROFILE_ID must identify an Agent Profile already configured on the server, including its model provider and credentials. Oasis never sends its own provider key to OpenHands. A local server can use the current workspace path by default; a remote server must use HTTPS and an explicit OPENHANDS_WORKSPACE_PATH, because the path on your computer may not exist on the server.

Delegation always asks for explicit approval, even with --yes. The conversation requests OpenHands' AlwaysConfirm policy and a Git worktree where supported. If OpenHands pauses for its own tool confirmation, you must review and approve it in OpenHands' interface; Oasis will not accept those actions on your behalf. Non-Git workspaces can fall back to a shared directory. If a delegated task is still running when Oasis stops waiting, Oasis returns its conversation ID instead of silently resubmitting it. Review delegated changes in the OpenHands workspace before integrating them.

## Safety model

Oasis is a local developer tool. By default commands run with your normal user permissions; turn on the optional OS sandbox (see [Command safety and OS sandbox](#command-safety-and-os-sandbox)) to confine them to the workspace.

- File tools are confined to the selected workspace and reject paths that escape via traversal or symlinks.
- Common secret files, private keys, and credential files are excluded from file tools.
- Existing files are snapshotted before the agent overwrites them. File deletions require a separate interactive approval and are snapshotted first.
- Shell interpreters and several high-impact destructive executables are blocked by the general command tool. Commands and package installs require approval by default.
- `--yes` (or `OASIS_AUTO_APPROVE=1`) auto-approves supported command/install actions. Do not use it for an untrusted repository; explicitly destructive operations remain blocked, and file deletion still requires interactive approval.
- Child processes do not inherit common API keys, tokens, passwords, and credential variables by default. Use `OASIS_COMMAND_ENV_ALLOWLIST` only when a command genuinely needs a specifically named variable.
- Web fetching rejects localhost/private-network targets, does not follow redirects automatically, and caps response size.
- Project instructions, skill files, repository contents, and web pages are untrusted input and cannot override Oasis's safety rules.

These guards reduce risk but cannot guarantee that every third-party package or project script is safe. Code executed by the OS still runs with the user's operating-system permissions. Review the requested operation, keep backups, and use an isolated development environment for untrusted code.

## Permission rules and modes

Oasis reads layered settings in the same format as Claude Code, so an existing `.claude/settings.json` works as-is:

| File | Scope |
|---|---|
| `~/.claude/settings.json` (Claude Code; skip with `OASIS_IGNORE_CLAUDE_SETTINGS=1`) | You, every project |
| `~/.config/oasis/settings.json` (wins over the Claude file) | You, every project |
| `.oasis/settings.json`, `.claude/settings.json` | Project (shared) |
| `.oasis/settings.local.json`, `.claude/settings.local.json` | Project (personal) |
| `managed-settings.json` (`/etc/claude-code/`, `/Library/Application Support/ClaudeCode/`, `C:\Program Files\ClaudeCode\`, or the `/etc/oasis/` equivalents; `OASIS_MANAGED_SETTINGS` overrides the path) | Organization policy, loads last and wins |

The `env` key sets environment variables for every session (`{ "env": { "ANTHROPIC_MODEL": "...", "NODE_ENV": "test" } }`); it is applied before the provider loads, and an untrusted project cannot set it. `"apiKeyHelper": "/path/to/get-key.sh"` runs a command whose output is the model API key, as in Claude Code: it is used when no key is set, cached for 5 minutes (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`), and re-run when the provider rejects the key; project files can set it only after `oasis trust`. `permissions.disableBypassPermissionsMode: "disable"` blocks `--dangerously-skip-permissions`, `--permission-mode bypassPermissions` and `/mode bypassPermissions`.

~~~json
{
  "permissions": {
    "allow": ["run_command(npm test:*)", "run_command(git status)", "Edit(src/**)"],
    "ask":   ["run_command(git push:*)"],
    "deny":  ["Read(secrets/**)", "WebFetch(domain:internal.example.com)"],
    "defaultMode": "default"
  }
}
~~~

Precedence is deny > ask > allow. `name(prefix:*)` matches a command prefix, file rules take globs, `fetch_url(domain:x)` matches a domain and its subdomains, and `mcp_server` matches every tool of one MCP server. Claude Code names (`Bash`, `Edit`, `Write`, `Read`, `WebFetch`, `Grep`, `Glob`) are accepted as aliases. At a command prompt you can answer `a` to always allow that command prefix for the rest of the session.

Modes: `default`, `acceptEdits`, `plan` (read-only), `auto`, and `bypassPermissions` (same as `--yes`). Set one per run with `--permission-mode`, or add rules for one run with `--allowedTools` / `--disallowedTools`.

In `auto` mode, a classifier model looks at every action that would normally ask you. Routine steps toward your request (tests, builds, linters, read-only git) run on their own. Risky ones (`rm -rf`, force pushes, uploads, reading secrets, `curl | sh`, CI or infrastructure changes) are blocked, and the agent is told why so it can find a safer way. Anything unclear still comes to you. The classifier only sees your own messages and the pending action, never tool output, so instructions planted in files or web pages can't talk it into approving something. Deny rules, ask rules, hooks, and high-risk command checks still come first. After 3 blocks in a row (or 20 in a session), auto mode pauses and asks you. Use `/mode log` to see its recent decisions. It also works unattended: `oasis -p "fix the build" --permission-mode auto` reports each decision as an `auto_mode` event in `stream-json`. Choose a cheaper classifier and add your own rules in user settings:

~~~json
{ "autoMode": { "model": "gpt-4.1-mini", "rules": ["Never touch files under infra/", "git push to feature branches is fine"] } }
~~~

**Trust:** a cloned repository can ship any settings file. Project rules that make Oasis stricter (`deny`, `ask`) always apply. Rules that loosen it (`allow`, hooks, mode, sandbox) apply only after you run `oasis trust` in that workspace. `oasis permissions` shows the effective policy.


In `plan` mode (`--permission-mode plan` or `/mode plan`), Oasis researches with read-only tools, then presents its plan and asks whether to start. Say yes and it leaves plan mode and implements the plan in the same turn; say no and it stays in plan mode so you can ask for changes.
## Project MCP servers (.mcp.json)

Oasis reads a Claude Code-style `.mcp.json` at the workspace root, so a team can share MCP servers through the repository:

```json
{
  "mcpServers": {
    "postgres": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"], "env": { "DATABASE_URL": "${DATABASE_URL}" } },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
  }
}
```

- `stdio` (the default) and Streamable `http` transports are supported. SSE-only servers are reported as unsupported.
- `${VAR}` and `${VAR:-default}` are expanded from your environment. A missing variable disables only that server, with a clear message.
- Remote servers must use HTTPS unless they are on localhost.
- Project servers start only after you run `oasis trust` for the workspace. A user-level server with the same name wins.
- `<oasis config>/mcp.json` holds user-scope servers in the same `{ "mcpServers": { ... } }` format as `.mcp.json` (http servers, stdio `env` values and `${VAR}` expansion work); `oasis import` writes it, and you can edit it by hand.
- Servers you added with Claude Code's `claude mcp add` are picked up from `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) without a trust step: `projects[<this folder>].mcpServers` (local scope) beats `.mcp.json`, and top-level `mcpServers` (user scope) comes last. Set `OASIS_IGNORE_CLAUDE_MCP=1` to skip them.
- `oasis mcp list` and `/mcp` show both user and project servers. Every MCP tool call still asks for approval unless your permission rules allow it.
- Resources: when a server offers resources, Oasis gets read-only `list_mcp_resources` and `read_mcp_resource` tools (`ListMcpResourcesTool` and `ReadMcpResourceTool` in permission rules), and you can pull one into your message with `@server:uri`, for example `summarize @docs:notes://todo`.
- Serve: `oasis mcp serve` turns Oasis into an MCP server on stdio, so Claude Desktop, Cursor, VS Code or another agent can use its tools (read, grep, glob, git, `lsp`, `diagnostics`, web fetch) in the folder it starts in. Edits need `--allow-edits` and commands need `--allow-commands`; the client asks you before each call, and secret files stay blocked. Example client config: `{"mcpServers": {"oasis": {"command": "oasis", "args": ["mcp", "serve", "--allow-edits"], "cwd": "/path/to/project"}}}`.
- Sign-in: remote HTTP servers that use OAuth (GitHub, Linear, Notion, Sentry and others) are supported. If a server needs sign-in, `/mcp` says so; run `oasis mcp login NAME` (or `/mcp login NAME` in the terminal), approve in the browser, and its tools load right away. Oasis finds the authorization server on its own, registers itself when the server allows it, uses PKCE and a loopback redirect, and refreshes tokens automatically. Tokens live in `~/.config/oasis/mcp-auth.json` (mode 600), never in the project or the conversation. If a server needs a pre-registered app, add `"oauth": {"clientId": "...", "scopes": ["..."], "callbackPort": 8765}` to its `.mcp.json` entry. `oasis mcp logout NAME` deletes the token.
- Prompts: each server prompt becomes a command named `/mcp__server__prompt`. Pass arguments in order or as `name=value`, for example `/mcp__github__review_pr 123 focus=security`. `/mcp` lists the prompts and resources of each server.

### MCP elicitation, roots and live tool lists

MCP servers can ask you for input while one of their tools runs, through MCP elicitation. OASIS shows the request in the terminal. A form request asks for each field in turn (enums as numbered choices, booleans as y/n, numbers and emails validated, defaults on Enter), and you can decline or cancel. A URL request offers to open the link in your browser. Headless runs (`-p`, SDK) decline elicitations unless a hook answers them:

```json
{ "hooks": { "Elicitation": [{ "matcher": "my-server", "hooks": [{ "type": "command", "command": "./answer-elicitation.sh" }] }] } }
```

An `Elicitation` hook gets `mcp_server_name`, `message`, `mode` and `requested_schema` (or `url`). It can reply with `hookSpecificOutput.action` (`accept`, `decline` or `cancel`) plus `content`, or exit 2 to decline. `ElicitationResult` hooks see the final answer and can change or block it before it goes back to the server.

Servers can also call `roots/list`, which returns the workspace and any `--add-dir` directories as `file://` roots. When a server sends `notifications/tools/list_changed`, OASIS re-reads its tools mid-session and the model sees the new list on its next request.

### Channels: messages pushed into your session

Like Claude Code's channels, an MCP server can push chat messages, webhooks or alerts into a running interactive session. Start OASIS with `--channels server:NAME` (a server from `.mcp.json`, `--mcp-config` or user config) or `--channels plugin:telegram@claude-plugins-official` (every channel server in that plugin). `--dangerously-load-development-channels LIST` does the same after you confirm a local-development warning. Channels are ignored with `-p`.

- The server declares `capabilities.experimental["claude/channel"] = {}` and sends `notifications/claude/channel` with `{ content, meta }`. The agent sees `<channel source="NAME" key="value">content</channel>`; `meta` keys that aren't letters, digits or `_` are dropped. If you're idle at the prompt, OASIS starts a turn so the agent reacts right away; otherwise the message joins the current turn at its next step.
- Replies use the server's ordinary MCP tools (for example `reply` with a `chat_id`).
- Permission relay: if the server also declares `"claude/channel/permission": {}`, each approval prompt is sent to it as `notifications/claude/channel/permission_request` (`request_id` of five letters a–z without `l`, `tool_name`, a sanitized `description` and `input_preview` with known token formats masked). The first answer wins: the terminal prompt, or `notifications/claude/channel/permission` with `{ request_id, behavior: "allow" | "deny" }`. Unknown or reused ids are ignored.
- Messages from servers you didn't opt in are dropped silently, and `"channelsEnabled": false` in any settings file turns channels off. Anyone who can reach a channel can put text in front of the agent, so only enable channels that check who the sender is.

Every connected MCP server's `instructions` (from its `initialize` reply) are now added to the system prompt under "MCP server instructions", as Claude Code does.

## Output styles

`/output-style` changes how Oasis talks while it works:
- `default`: concise engineering answers.
- `explanatory`: adds short insight notes about the codebase and the choices it makes.
- `learning`: leaves small `TODO(human)` pieces for you to write, then explains them.

Add your own as Markdown in `.oasis/output-styles/NAME.md` (or `.claude/output-styles/`, `~/.config/oasis/output-styles/`, `~/.claude/output-styles/`). Use front matter with `name` and `description`; the body is the instruction. Set a default with `"outputStyle": "explanatory"` in `.oasis/settings.json` or your user settings.

## Status line

Show your own status line above the input prompt, using the same settings format as Claude Code:

```json
{ "statusLine": { "type": "command", "command": "~/.config/oasis/statusline.sh" } }
```

The command receives JSON on stdin with `model`, `cwd`, `workspace`, `output_style`, `permission_mode`, `cost` (token totals), and `session_id`. Oasis shows the first line of its output; ANSI colors are kept in a terminal. A project-level status line runs only after `oasis trust`.

## Hooks

Hooks run your own shell commands at points in the agent lifecycle, using Claude Code's format:

~~~json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Edit|Write|multi_edit", "hooks": [{ "type": "command", "command": "npx prettier --write \"$(jq -r .tool_input.path)\"" }] }],
    "PreToolUse":  [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/check-command.sh", "timeout": 30 }] }],
    "Stop":        [{ "hooks": [{ "type": "command", "command": "npm test --silent || (echo 'tests fail' >&2; exit 2)" }] }]
  }
}
~~~

Events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`, `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`, `TaskCreated`, `TaskCompleted`, `InstructionsLoaded`, `PreModelSwitch`, `PostModelSwitch`, `DirectoryAdded`, `SubagentStart`, `SubagentStop`, `SessionStart` (`startup`, `resume`, `compact`), `SessionEnd`, `PreCompact`, `PostCompact`, `Notification` (`permission_prompt`), `CwdChanged` (after `/cd`), `FileChanged`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `TeammateIdle` and `Setup`. Each hook gets a JSON payload on stdin (`tool_name`, `tool_input`, `tool_response`, `error`, `prompt`, `agent_type`, `trigger`, `cwd`, ...). Exit code `2` blocks: it stops a tool call, rejects a prompt, makes the agent keep working after `Stop`, or cancels a manual `/compact` from `PreCompact`. stderr is passed to the model. JSON output supports `decision`, `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`), `updatedInput`, and `additionalContext`. A `PermissionRequest` hook answers an approval prompt before you see it with `{"hookSpecificOutput": {"decision": {"behavior": "allow"}}}` or `"deny"` plus a `message`. This works for background agents too. `PreCompact` context is kept in the summary, and `SessionStart` with matcher `compact` can re-add context after compaction. Matchers compare against the tool name (Oasis or Claude Code names), the session source, the compaction trigger, the notification type, or the subagent type. Hooks run with secrets removed from the environment, and project hooks only run in trusted workspaces.

Besides `command`, there are two more hook types:

~~~json
{ "type": "http", "url": "https://policy.internal/hook", "headers": { "Authorization": "Bearer $POLICY_TOKEN" }, "allowedEnvVars": ["POLICY_TOKEN"], "timeout": 30 }
{ "type": "prompt", "prompt": "Block edits to migrations unless the user asked for them. $ARGUMENTS", "model": "gpt-4.1-mini" }
~~~

An `http` hook POSTs the payload as JSON, and its response body is read like a command's stdout. A failed request or a non-2xx status is a non-blocking error; only a JSON decision can block. Headers can use only the environment variables listed in `allowedEnvVars`. A `prompt` hook asks the model (optionally a cheaper `model`) whether the payload meets your policy. `$ARGUMENTS` is replaced with the payload, and a reply of `{"ok": false, "reason": "..."}` blocks like exit code 2.

Two more types match Claude Code:

~~~json
{ "type": "mcp_tool", "server": "scanner", "tool": "scan_file", "input": { "path": "${tool_input.path}" } }
{ "type": "agent", "prompt": "Verify the unit tests pass before stopping. $ARGUMENTS", "timeout": 120 }
~~~

An `mcp_tool` hook calls a tool on an already connected MCP server (`${tool_input.path}`-style placeholders come from the payload), and its text output is read like stdout. An `agent` hook is a `prompt` hook backed by a read-only verifier subagent that can read files and search the workspace before answering `{"ok": ...}`. On `Stop`, `{"ok": false, "impossible": true}` lets the turn end when the condition cannot be met.

Handler options (any type unless noted):

- `"if": "Bash(git *)"`: run only when the tool call matches one permission rule (tool events only). File patterns without `/`, such as `Edit(*.ts)`, match at any depth.
- `"args": ["--strict", "${CLAUDE_PROJECT_DIR}"]` (command): run `command` directly with these arguments and no shell. `"shell": "powershell"` runs it with PowerShell.
- `"async": true` (command): run in the background without delaying the agent. JSON `additionalContext`/`systemMessage` reaches the model on its next request. `"asyncRewake": true` also feeds a background exit-2 result back as a reminder.
- `"onFailure": "block"`: treat a crash, timeout, or non-2 exit as a block (not for `Stop`, `SubagentStop`, or `TaskCompleted`).
- `"timeout"` in seconds. Defaults: 600 for command, http and mcp_tool; 30 for prompt and for `UserPromptSubmit`; 60 for agent.

Matchers follow Claude Code: a matcher made only of letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name or list (`Edit|Write`; `Edit` no longer matches `MultiEdit`). Anything else is an unanchored regular expression (`mcp__memory__.*`, `^Notebook`). MCP tools are seen as `mcp__<server>__<tool>`.

More events:

| Event | When | Can block |
|---|---|---|
| `PostToolBatch` | after a batch of parallel tool calls, before the next model request (`tool_calls` list) | yes: `decision: "block"` ends the turn |
| `PermissionDenied` | auto mode refused a tool call | no; `hookSpecificOutput.retry: true` tells the model it may retry |
| `StopFailure` | the turn ended on an API error; matcher `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `model_not_found`, `overloaded`, `unknown` | no |
| `UserPromptExpansion` | a typed custom `/command` expanded into a prompt; matcher is the command name | yes |
| `InstructionsLoaded` | a CLAUDE.md / AGENTS.md / memory file loaded at session start; matcher `session_start` | no |
| `TaskCreated` / `TaskCompleted` | a shared task is created / marked completed | yes: creation is rolled back, completion is refused |
| `PreModelSwitch` / `PostModelSwitch` | `/model` changes the model; matcher is the new model | Pre: `permissionDecision` deny/ask |
| `DirectoryAdded` | `/add-dir` added a directory | no |
| `FileChanged` | a watched file was added, changed or removed (`file_path`, `event`: `add`/`change`/`unlink`). Literal names in the matcher (`.envrc\|.env`) are watched relative to the project; the matcher filters by basename | no; `hookSpecificOutput.watchPaths` (absolute paths) replaces the dynamic watch list |
| `ConfigChange` | a user, project or local settings file, or a skills directory, changed while the session runs (`source`, `file_path`); matcher is the source | yes: exit 2 or `decision: "block"` keeps the old settings |
| `WorktreeCreate` | an isolated worktree is needed (`--worktree`, `isolation: "worktree"` agents); input `name` | replaces git: print the absolute path of the new directory as the last stdout line (or `hookSpecificOutput.worktreePath`); any non-zero exit fails creation |
| `WorktreeRemove` | a hook-created worktree is cleaned up; input `worktree_path` | no git fallback: without this hook the directory is kept |
| `TeammateIdle` | a team member finished its turn (`teammate_name`, `team_name`); no matcher | yes: exit 2 sends stderr back and the teammate keeps working; `continue: false` stops it |
| `Setup` | `oasis --init`, `--init-only` or `--maintenance` (`trigger`: `init` / `maintenance`); command hooks only | no |
| `Elicitation` / `ElicitationResult` | an MCP server asks for user input; matcher is the server name | yes: answer with `hookSpecificOutput.action`/`content`, or exit 2 to decline |

Interactive sessions also pick up settings edits live: when a settings file changes (and no `ConfigChange` hook blocks it), hooks, permission rules and auto-mode settings reload without a restart. `SessionStart` and `CwdChanged` hooks can return `hookSpecificOutput.watchPaths` to start watching extra files for `FileChanged`.

`PostToolUse` can also replace what the model sees with `hookSpecificOutput.updatedToolOutput` (for example to redact secrets). A `PermissionRequest` is decided only by JSON; a bare exit 2 is ignored unless `onFailure` is `"block"`.

## The interactive terminal

Run `oasis` in a project to open the interactive prompt. Press `?` on an empty line for shortcuts, or run `/keybindings`.

| Keys | What they do |
| --- | --- |
| Enter | Send |
| Shift+Enter, Alt+Enter, Ctrl+J, or `\` then Enter | New line (`/terminal-setup` explains Shift+Enter for VS Code, Alacritty, Apple Terminal and tmux) |
| ↑ / ↓, Ctrl+R | History for this workspace (saved in `~/.oasis/history.jsonl`; `OASIS_NO_HISTORY=1` turns it off), reverse search |
| Tab | Complete `/commands`, skills and `@files` (fuzzy; secret files are skipped) |
| Shift+Tab | Cycle permission modes: default → acceptEdits → plan → auto |
| `!command` | Run a shell command yourself; its output goes into your next message as context |
| `#note` | Save a memory note |
| Ctrl+V | Paste an image from the clipboard |
| Esc | While a turn runs: interrupt it. Anything you type meanwhile is queued as the next message |
| Esc Esc | Clear the input, or rewind when it is empty |
| Ctrl+L, Ctrl+D | Clear the screen, exit |

### Vim mode

`/vim` turns on vim editing for the prompt (`/vim off` turns it off). The choice is saved as `"editorMode": "vim"` in your user settings, and Claude Code's `editorMode` in `~/.claude.json` is honored too. The input starts in INSERT mode. Esc switches to NORMAL, and the current mode shows under the prompt. Enter sends from either mode.

`/theme` lists and switches color themes, Claude Code style: `dark` (default), `light`, `dark-daltonized`, `light-daltonized` (color-blind friendly), `dark-ansi`, `light-ansi` (16-color terminals) and `auto`, which picks light or dark from `COLORFGBG` (override with `OASIS_TERMINAL_BACKGROUND=light|dark`). The choice is saved as `"theme"` in your user settings; `OASIS_THEME` overrides it and Claude Code's `~/.claude.json` `theme` is honored. Custom themes are the same JSON files Claude Code reads from `~/.claude/themes/` (or `<OASIS config>/themes/`), selected as `custom:<slug>`. Saving the file while Oasis runs reloads the theme in place (plugin themes too; `OASIS_DISABLE_THEME_RELOAD=1` turns this off):

More Claude Code commands:

- `/diff [PATH] [--stat]` shows uncommitted changes (against `HEAD`) and untracked files.
- `/autocompact PERCENT|off|reset` moves the auto-compaction trigger for this session; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (or `OASIS_AUTOCOMPACT_PCT`) sets it for every session.
- `/reload-plugins` and `/reload-skills` rebuild the session from current settings, plugins, skills, agents, hooks and MCP servers without losing the conversation (running background commands are stopped).
- `/list-agents` (alias `/peers`) lists running subagents, teams and background processes.
- `/statusline [what to show]` has the agent write and register a status line script; `/update-config DESCRIPTION` has it edit the right `settings.json`.
- Aliases: `/settings` (`/config`), `/checkpoint` (`/rewind`), `/continue` (`/resume`), `/allowed-tools` (`/permissions`), `/stats` (`/usage`), `/checkup` (`/doctor`), `/code-review` (`/review`).

```json
{ "name": "Dracula", "base": "dark", "overrides": { "claude": "#bd93f9", "error": "#ff5555", "success": "#50fa7b" } }
```

Colors accept `#rrggbb`, `#rgb`, `rgb(r,g,b)`, `ansi256(n)` and `ansi:<name>` (for example `ansi:cyanBright`); unknown tokens and bad values are ignored. Oasis paints `claude`/`claudeShimmer` (logo, prompt and tool accents), `success`, `error`, `warning`, `planMode`, `autoAccept`, `bashBorder`, `inactive`, `diffAdded`/`diffRemoved` (diff backgrounds) and the code tokens `code`, `link`, `keyword`, `number`. Plugins ship themes in `themes/` (or `experimental.themes`), selected as `plugin:<plugin>:<slug>`, and `oasis plugin validate` checks their bases, tokens and colors.

| NORMAL keys | |
| --- | --- |
| `h l j k`, `w b e W B E`, `0 ^ $`, `gg G` | Move. `j`/`k` on the first or last line walk the input history |
| `f F t T` + char, `;` `,` | Find a character on the line, repeat the find |
| `d c y` + motion, `dd cc yy`, `D C Y` | Delete, change, or yank (counts work: `d2w`, `3dd`) |
| `iw aw iW aW`, `i" a" i' a'`, `i( a( i[ a[ i{ a{ i< a<` | Text objects after an operator (`ciw`, `da(`, `di"`) |
| `x X s S r ~ J` | Delete, substitute, replace, toggle case, join lines |
| `i a I A o O` | Back to INSERT |
| `p P u .` | Put, undo, repeat the last change (including the typed text of `cw…`) |

Esc in NORMAL mode keeps its usual role, so Esc Esc still clears the input or rewinds. Ctrl shortcuts, Tab, and Shift+Tab work the same in both modes.

### Keybindings, external editor and stash

Ctrl+O opens the full transcript in a full-screen pager, the way Claude Code's transcript mode does: every prompt, reply, reasoning block, tool call (with pretty-printed arguments) and tool result, expanded. Scroll with ↑/↓ or j/k, page with Space/b, jump with g/G, and return with q, Esc or Ctrl+O. Your half-typed prompt is kept. Rebind it with `app:toggleTranscript` in `keybindings.json`.

Ctrl+G (or Ctrl+X Ctrl+E) opens the current prompt in `$VISUAL` / `$EDITOR` (falling back to `vi`, or `notepad` on Windows). Save and quit, and the edited text comes back as the prompt. Ctrl+S stashes a half-written prompt so you can send something else first. The stash comes back at the next prompt, or right away if you press Ctrl+S on an empty prompt.

Every shortcut can be rebound in Claude Code's `keybindings.json` format. OASIS reads `~/.claude/keybindings.json` (or `$CLAUDE_CONFIG_DIR`) and then `<oasis config>/keybindings.json`, and the second file wins. Changes apply at the next prompt. `/keybindings init` creates the file with an example, and `/keybindings` lists your custom bindings, any warnings and the files that were loaded.

```json
{
  "bindings": [
    { "context": "Chat", "bindings": {
      "ctrl+e": "chat:externalEditor",
      "ctrl+x ctrl+c": "command:compact",
      "ctrl+s": null
    } },
    { "context": "HistorySearch", "bindings": { "enter": "historySearch:execute" } }
  ]
}
```

- Contexts: `Global`, `Chat`, `Autocomplete`, `HistorySearch`. Other Claude Code contexts are accepted but have no effect yet.
- Keystrokes: `ctrl`, `shift`, `alt`/`opt`/`meta` and `cmd`/`super` modifiers with letters, `enter`, `escape`, `tab`, `space`, arrows, `home`/`end`, `pageup`/`pagedown`, `backspace` and `delete`. A bare uppercase letter such as `K` means Shift+K.
- Chords are space-separated (`ctrl+k ctrl+s`), and you have 3 seconds between keys.
- `null` unbinds a key. `command:NAME` runs `/NAME`.
- Actions: `app:interrupt`, `app:exit`, `app:toggleTodos`, `app:toggleTranscript`, `app:redraw`, `chat:submit`, `chat:newline`, `chat:cancel`, `chat:clearInput`, `chat:cycleMode`, `chat:undo`, `chat:externalEditor`, `chat:stash`, `chat:imagePaste`, `chat:modelPicker`, `history:search`, `history:previous`, `history:next`, `autocomplete:accept`, `autocomplete:dismiss`, `historySearch:next`, `historySearch:accept`, `historySearch:cancel` and `historySearch:execute`.
- Ctrl+C, Ctrl+D, Ctrl+M, Ctrl+[, Ctrl+I and Ctrl+H are reserved and cannot be rebound.
- In history search, Enter accepts the match into the prompt by default. Bind `enter` to `historySearch:execute` to send it right away, as Claude Code does.

Replies render as Markdown with syntax-highlighted code, and edits show as colored diffs. Settings: `OASIS_NO_ANIMATION=1` skips the startup animation, `OASIS_SIMPLE_INPUT=1` uses a plain line reader, `OASIS_PLAIN_OUTPUT=1` prints raw text, and `NO_COLOR` turns off colors.

### Workflow commands

- `/goal CONDITION` keeps working across turns until a separate check says the condition is met and verified, up to 20 turns (`OASIS_GOAL_MAX_TURNS`). `/goal` shows the status, and `/goal clear` stops it.
- Model aliases work everywhere a model is named (`--model`, `/model`, the `model` setting, agent front matter, `--advisor`): `opus`, `sonnet`, `haiku`, `fable`, `best` (Fable, else Opus), `opusplan` (Opus while in plan mode, Sonnet otherwise) and the `[1m]` suffix. They resolve per provider (Anthropic API, Bedrock, Vertex, Foundry) to the current recommended model; pin versions with `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `ANTHROPIC_DEFAULT_FABLE_MODEL`, which also map aliases on OpenAI-compatible endpoints. `/model default` goes back to the configured model.
- The advisor lets the working model consult a second, stronger model mid-task: set `"advisorModel": "opus"` in settings, pass `--advisor MODEL`, or use `/advisor MODEL` (`/advisor off` to stop, `/advisor` for usage). The agent gets an `advisor` tool; the advisor sees the conversation, answers with guidance only and never runs tools. `OASIS_ADVISOR_MODEL` sets it from the environment.
- `"availableModels": ["sonnet", "haiku", "gpt-5"]` limits which models people can choose (put it in managed settings to enforce it for a team). Entries can be aliases, family names (`opus` allows every Opus id) or exact ids; `default` is always allowed. `/model`, `/advisor`, `advisorModel` and agent `model:` front matter outside the list are refused, and a disallowed startup model falls back to the first entry with a `[settings]` notice.
- `/insights [DAYS]` (or `oasis insights [DAYS]`) writes an HTML report on your saved sessions from the last 30 days (or DAYS) on this machine to `<oasis config>/insights/`: project areas, tools, file types, slash commands, models, activity by day and hour, failing tools, correction-like prompts, and suggestions. Statistics are computed locally; inside a session, the current model also writes a two-paragraph summary from those statistics only (no transcripts are sent).
- `oasis import [codex|gemini|cursor] [--dry-run] [--yes]` (or `/import`) brings your setup over from other agents and never overwrites existing files:
  - OpenAI Codex: `[mcp_servers.*]` from `~/.codex/config.toml` (including `bearer_token_env_var`), `~/.codex/AGENTS.md` and `~/.codex/prompts/*.md`.
  - Gemini CLI: `mcpServers` from `~/.gemini/settings.json` and `.gemini/settings.json`, `GEMINI.md` files, and `commands/**/*.toml` (`{{args}}` becomes `$ARGUMENTS`, `!{cmd}` becomes `` !`cmd` ``).
  - Cursor: `~/.cursor/mcp.json` and `.cursor/mcp.json`, `.cursorrules`, `.cursor/rules/*.mdc` (`globs` become `paths:` in `.claude/rules/`) and `.cursor/commands/*.md`.
  - User servers go to `<oasis config>/mcp.json`, project servers to `.mcp.json`, user instructions are appended to `<oasis config>/OASIS.md`, and commands go to `<oasis config>/commands` or `.oasis/commands`. Gemini SSE-only servers are imported but are listed as not usable, because Oasis speaks stdio and streamable HTTP.
- PowerShell: the agent gets a `powershell` tool on Windows (it finds `pwsh.exe`, falling back to `powershell.exe`; set `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` to turn it off) and on macOS/Linux when you set `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` (or `OASIS_POWERSHELL=1`) with `pwsh` on PATH. It works like `run_shell`: approvals, `PowerShell(git push:*)` permission rules, background mode, the OS sandbox outside Windows, and hooks see the tool as `PowerShell` (match `Bash|PowerShell`). Profiles are not loaded, Windows uses `-ExecutionPolicy Bypass` for the process only (`CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY=1` keeps your policy), and exit code 1 from `rg`, `grep`, `findstr` or `git diff` is labelled as "no match", not a failure. `"defaultShell": "powershell"` in settings sends `!` commands through PowerShell; `"shell": "powershell"` on a command hook runs that hook in PowerShell.
- `/color red|blue|green|yellow|purple|orange|pink|cyan|random|default` colors this session's prompt so parallel terminals are easy to tell apart. `/focus` shows a full-screen view of the last prompt, one line per tool call (with `+added -removed` line counts for edits) and the final response; press Enter to return.
- Background sessions free the terminal while Oasis keeps working. `oasis --bg "TASK"` starts one; `/background [one more instruction]` (or `/bg`) saves the current conversation and hands it to one, then exits. `oasis bg list` shows runs, `oasis bg logs ID --follow` streams progress, `oasis bg attach ID` continues the conversation in your terminal (stopping it first if it is still running), and `oasis bg stop ID` / `oasis bg rm ID` clean up. Background sessions cannot prompt you, so only tools that your permission mode and allow rules permit will run; the conversation is saved, so `oasis --resume SESSION_ID` also works.
- `/subtask TASK` starts a background subagent that gets a copy of the whole conversation so far, works on TASK while you keep going, and reports back to this conversation when it finishes (`/tasks` shows progress). Like other background agents it cannot ask you for approval, so tools your permission rules don't allow are refused.
- `/btw QUESTION` asks about the session without adding to the conversation and without tools. `/recap` gives a one-line summary.
- `/batch INSTRUCTION` plans a large change as independent units. After you approve, it runs them in parallel subagents, each in its own git worktree.
- `/simplify [target]` runs four parallel read-only reviewers (reuse, simplification, efficiency, abstraction), then applies fixes that don't change behavior.
- `/verify [what]` builds and runs the app to confirm a change works, instead of relying only on tests.
- `/schedule "*/30 * * * *" check CI and fix failures` schedules a prompt in this session. `/schedule list` and `/schedule delete ID` manage them. The agent can also schedule prompts itself with `cron_create`. Scheduled prompts run when the prompt is idle and stop when you exit.
- `/rename NAME` names the session for `/resume`. `/stop` stops background agents and processes.
- `/fewer-permission-prompts` finds read-only commands you approve often and proposes adding them to your allowlist.
- `/privacy-settings` shows what is sent where.
- `/ponytail [lite|full|ultra|off]` turns on the bundled [Ponytail](https://github.com/DietrichGebert/ponytail) lean mode: the smallest complete change, keeping tests, validation and security. `/ponytail-review`, `/ponytail-audit` and `/ponytail-debt` find over-engineering.

### Agent tools for long tasks

- `monitor_command` waits on a background command until its output matches a pattern, it exits, or a timeout passes. Use it for dev servers and builds.
- `enter_plan_mode` lets the agent switch itself to plan mode for risky work.
- `notify` sends a terminal or desktop notification.
- `tool_search` applies when MCP servers expose more than 25 tools: they are deferred, and the agent loads the ones it needs. Use `OASIS_TOOL_SEARCH=on` to always defer, `off` to never defer, or `OASIS_TOOL_SEARCH_THRESHOLD=N` to change the limit.

### Sessions and cost

Sessions are saved by default. `oasis -c` continues the latest one, `oasis -r ID` resumes one, and `--no-session-persistence` (or `OASIS_PERSIST_SESSIONS=0`) skips saving. `/cost` shows tokens and an estimated USD cost. `--max-budget-usd 2` stops a run at that spend. Local models count as free. Set `OASIS_PRICE_INPUT` and `OASIS_PRICE_OUTPUT` (USD per million tokens) to override pricing.

## Slash commands, @mentions, and memory

Inside `oasis`, type `/help` to see everything. Built-in commands include `/compact [focus]`, `/context`, `/cost`, `/model [id]`, `/mode [default|acceptEdits|plan|auto|bypassPermissions|log]`, `/permissions`, `/agents`, `/commands`, `/hooks`, `/bashes`, `/todos`, `/memory`, `/mcp`, `/init`, `/plan`, and `/clear`.

More session commands:

- `/effort [low|medium|high|max|auto]` sets how hard the model thinks for the rest of the session (also `oasis --effort high`). Prompt words like "ultrathink" can still raise a single turn.
- `/copy [N]` copies the last reply (or the Nth most recent) to the clipboard using pbcopy, wl-copy, xclip, xsel or clip, and falls back to the OSC 52 terminal escape over SSH.
- `/undo [N]` is shorthand for `/rewind N`. `/usage` is the same as `/cost`.
- `/fork` (or `/branch`) saves the conversation so far and continues in a copy, so you can try another approach and `/resume` the original later.
- `/loop [30s|5m|1h] [x5] PROMPT` runs a prompt now and again on an interval (for example `/loop 5m check whether CI passed`). Ctrl+C stops it.
- `/cd PATH` switches the workspace and starts a fresh conversation there.
- `/sandbox [on|off|network on|network off]` changes the OS sandbox for the current session.
- `/skills`, `/config`, `/doctor` and `/release-notes` list skills, show effective settings and where they come from, check the workspace (tools, checkers, language servers, sandbox, context use), and show recent Oasis changes.

More built-ins:
- `/review [PR number | git ref]` runs a read-only code review of your pending changes, a branch, or a GitHub pull request (through `gh`).
- `/security-review` does the same with a security focus.
- `/export [file]` saves the conversation as Markdown inside the workspace.
- `/resume` lists saved sessions; `/resume N` or `/resume ID` switches to one.
- A custom command with the same name, such as `.oasis/commands/review.md`, replaces the built-in review prompt.

Custom commands are Markdown files, compatible with Claude Code. `.oasis/commands/review.md` becomes `/review`, and `.oasis/commands/git/pr.md` becomes `/git:pr`. Oasis also reads `.claude/commands/`, `~/.config/oasis/commands/`, and `~/.claude/commands/`.

~~~markdown
---
description: Open a pull request for the current branch
argument-hint: [title]
model: optional-model-id
---
Create a PR titled "$ARGUMENTS". Follow @CONTRIBUTING.md
~~~

Use `$ARGUMENTS` for everything after the command and `$1` to `$9` for single words. Writing `@path/to/file` in any prompt or command includes that file (or a directory listing). Secret files such as `.env` and paths outside the workspace are never included.

More front matter, also compatible with Claude Code:

~~~markdown
---
description: Review what changed
allowed-tools: Bash(git diff:*), Bash(git status:*)
effort: high
context: fork
agent: Explore
---
Changed files:
!`git status --short`

Review these changes for bugs: $ARGUMENTS
~~~

- `` !`cmd` `` runs the shell command and puts its output into the prompt before it is sent. This works for your own commands (`~/.config/oasis/commands`, `~/.claude/commands`). Project commands can only do it in trusted workspaces. If `allowed-tools` lists `Bash(...)` rules, each command must match one, and your deny rules always apply. Secrets are removed from the command's environment.
- `allowed-tools` grants those tools without asking, but only while the command runs. `effort` sets the reasoning effort for that run.
- `context: fork` runs the command in a subagent (`agent:` picks which one, by default `general-purpose`). The main conversation only gets the report.
- Skills work the same way. Type `/skill-name args` to run a skill directly. A skill whose `SKILL.md` has `context: fork` always runs in a subagent, even when the model loads it itself, so its instructions don't fill the main context.
- `oasis -p "/review src"` expands custom commands and skills in headless mode too.

Memory files are loaded into every session, from broadest to most specific:

| Scope | Files |
| --- | --- |
| User (all projects) | `~/.config/oasis/OASIS.md`, `~/.claude/CLAUDE.md` |
| Project (commit it) | `OASIS.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` |
| Personal (gitignore it) | `OASIS.local.md`, `CLAUDE.local.md` |

A line like `@docs/style.md` inside a memory file includes that file. Start a message with `#` to save a note: `# use pnpm, not npm` appends to `OASIS.md`, `# user: answer briefly` goes to your user memory, and `# local: my dev port is 4000` goes to `OASIS.local.md`.

Press Ctrl+C while a task is running to stop it and return to the prompt (press it again to quit). The conversation stays usable, and `/rewind 1` undoes any file changes the stopped task made.

The terminal streams the model's replies as they arrive. Set `OASIS_NO_STREAM=1` to print each reply only when it is finished.

## Auto memory

Oasis keeps durable notes across sessions on its own, so you don't repeat yourself. The design borrows from two open-source projects: [OpenViking](https://github.com/volcengine/OpenViking) (memory as plain files with a one-line abstract loaded first and the full text read on demand) and [agentmemory](https://github.com/rohitg00/agentmemory) (keyword-ranked recall for each prompt under a token budget, secret redaction, and merging duplicates).

- The agent saves a memory with `memory_save` when you state a preference or correct it, when a decision is made, when it learns a non-obvious project fact (build, test, deploy commands, gotchas), or when a fix took several attempts. It looks memories up with `memory_search` and `memory_read`, and removes wrong ones with `memory_delete`.
- Every session starts with an index of one-line abstracts (about 2,000 tokens at most). On each message, the few most relevant memories are ranked with BM25 and attached in full, and Oasis prints `[memory] Recalled ...`.
- Memories are Markdown files you can read and edit: `~/.config/oasis/memory/projects/<workspace>/<category>/<name>.md` for this workspace and `~/.config/oasis/memory/user/...` for every project. Each folder has a generated `MEMORY.md` index. Categories are preferences, project, decisions, lessons, people and reference.
- Secrets (API keys, tokens, private keys, passwords in URLs) and anything inside `<private>...</private>` are redacted before a memory is written. Near-duplicates merge into the existing memory instead of piling up.
- `/memory` lists them; `/memory search WORDS`, `/memory show ID`, `/memory forget ID`, `/memory add NOTE` (start with `user:` for every project) and `/memory path` manage them. `/remember [focus]` asks the agent to review the conversation and save what is worth keeping. The same commands work as `oasis memory ...` in a terminal.
- Turn it off with `"autoMemory": false` in settings or `OASIS_AUTO_MEMORY=0`.

## Headless mode for scripts and CI

`oasis -p "task"` runs one task without any prompts and prints the answer, like `claude -p`.

~~~bash
oasis -p "summarize what changed in the last commit"
git diff | oasis -p "review this diff for bugs" --output-format json
oasis -p "fix the failing test" --permission-mode acceptEdits --allowedTools "Bash(npm test:*)" --max-turns 30
oasis -p "list TODOs" --output-format stream-json --model gpt-4.1-mini
oasis -p "find bugs in src/" --json-schema @bug-schema.json --output-format json
oasis -w fix-login "fix the login redirect"
~~~

`--bare` starts a minimal session for scripts. It skips project instructions (AGENTS.md, CLAUDE.md, OASIS.md), skills, hooks, MCP servers, and auto memory. Only the model, the built-in tools, and your permission rules remain.

`--json-schema` takes a JSON Schema (inline or `@file.json`). Oasis asks the model for JSON that matches it, validates the reply and retries up to twice. With `--output-format json` the result is in `structured_output`; in text mode only the JSON is printed. If it still fails, the result has subtype `error_max_structured_output_retries`.

`-w/--worktree [NAME]` runs the session (interactive or `-p`) in a new git worktree under `.oasis/worktrees/` on its own `oasis/NAME-*` branch, so your checkout is untouched. When the session ends, a worktree with no changes is removed along with its branch. Otherwise Oasis keeps it and prints how to review, merge or remove it.

- `--output-format text` (default) prints the final answer. `json` prints one object with `result`, `subtype` (`success`, `error_max_turns`, `error_during_execution`), `is_error`, `num_turns`, `usage`, `tool_calls`, `session_id`, and `permission_denials`. `stream-json` prints one JSON event per line (`system`, `tool_use`, `tool_result`, `assistant`, then `result`).
- Piped input is added to the prompt inside `<stdin>` tags.
- With nobody to answer prompts, anything that needs approval is denied and listed in `permission_denials`. Allow what the job needs with `--allowedTools`, settings rules, `--permission-mode`, or `--yes`. High-risk commands stay blocked.
- **Two-way control (stream-json in and out):** with `--input-format stream-json`, each stdin line is a `{"type":"user","message":{...}}` turn in one session. Add `--permission-prompt-tool stdio` and approvals are sent to you as `{"type":"control_request","request_id":"oasis-1","request":{"subtype":"can_use_tool","tool_name":...,"input":...,"message":...,"permission_suggestions":[...]}}`; answer with `{"type":"control_response","response":{"subtype":"success","request_id":"oasis-1","response":{"behavior":"allow"}}}` (`"deny"`, or add `"always":true` to save the suggested rule). Send `{"type":"control_request","request_id":"x","request":{"subtype":"interrupt"}}` to stop the current turn. This is the same protocol Claude Code's SDK uses, and it is what the VS Code chat panel runs on.
- The exit code is 1 when the run fails, so CI steps fail too. Add `--continue` (`-c`) or `--resume ID` to keep a conversation across runs.

## GitHub: mention @oasis

Add [the workflow](examples/oasis-github.yml) to your repository and comment `@oasis fix the flaky login test` on an issue. Oasis makes the change, runs your tests, pushes an `oasis/issue-N-*` branch, opens a pull request that closes the issue, and replies in the thread. On a pull request, it commits to the PR branch. It works with any provider and uses `auto` permission mode by default. Only owners, members, and collaborators can trigger it. Details are in [docs/github-action.md](github-action.md).

## SDK: build on Oasis from Node

Oasis can be imported as a library, much like the Claude Agent SDK, and it works with any model Oasis supports:

~~~js
import { query, tool } from 'oasis-oss';

const weather = tool('weather', 'Current weather for a city',
  { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  async ({ city }) => ({ city, forecast: 'sunny' }));

for await (const event of query({ prompt: 'Plan a picnic in Dhaka', options: { tools: [weather], maxTurns: 10, permissionMode: 'auto' } })) {
  if (event.type === 'assistant') console.log(event.text);
  if (event.type === 'result') console.log(event.subtype, event.usage);
}
~~~

- **Events:** they are the same as `--output-format stream-json`.
- **Tools:** `tool()` defines an in-process tool, and `createToolServer(name, tools)` groups several. Pass `{ needsApproval: true }` to send a tool's calls through `canUseTool(toolName, input)`, which can also approve or deny built-in tools.
- **Options:** `cwd`, `model`, `effort`, `provider` (`{ protocol, baseURL, apiKey }`), `permissionMode`, `allowedTools`, `disallowedTools`, `appendSystemPrompt`, `jsonSchema`, `planOnly`, `abortController`, `resume`, `persistSession`, and `bare`.
- **Shortcut:** `run(prompt, options)` returns just the final result.
- **Lower-level pieces:** the package also exports `createSession`, `runAgentTurn`, `runHooks`, `executeTool`, and `loadSettings`.

## OpenTelemetry

Oasis can export metrics, events and traces over OTLP/HTTP JSON with no extra packages. It is off by default. Turn it on with `OASIS_ENABLE_TELEMETRY=1`; `CLAUDE_CODE_ENABLE_TELEMETRY=1` also works, so an existing Claude Code monitoring setup keeps working.

```bash
export OASIS_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # any OTLP/HTTP collector
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20xyz"
export OTEL_METRICS_EXPORTER=otlp     # otlp | console | none (same for LOGS and TRACES)
```

- **Metrics:** `oasis.session.count`, `oasis.token.usage` (by `type`: input, output, cacheRead, cacheCreation), `oasis.api.duration`, `oasis.api.error.count`, `oasis.tool.count` (by `tool_name` and `success`), `oasis.tool.duration`, `oasis.turn.duration`, `oasis.active_time.total`, `oasis.lines_of_code.count` (added/removed), `oasis.commit.count`, and `oasis.pull_request.count`.
- **Events (logs):** `oasis.session_start`, `oasis.user_prompt` (length only, unless `OTEL_LOG_USER_PROMPTS=1`), `oasis.api_request`, `oasis.api_error`, and `oasis.tool_result` (arguments only with `OTEL_LOG_TOOL_DETAILS=1`).
- **Traces:** each turn is a trace. Every model request and tool call is a child span, and subagent turns nest under the tool call that started them. Events carry the span they happened in. This is something Claude Code's metrics and logs export does not give you.
- Standard variables are honored: `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_METRIC_EXPORT_INTERVAL` (default 60 s), `OTEL_LOGS_EXPORT_INTERVAL` (default 5 s), and per-signal `OTEL_EXPORTER_OTLP_{METRICS,LOGS,TRACES}_ENDPOINT` / `_HEADERS`. Only the HTTP/JSON wire format is supported, not gRPC or protobuf. Data is flushed on exit.

## Checkpoints and /rewind

Before Oasis edits, writes, or deletes a file, it saves that file's original content for the current turn. Type `/rewind` to see recent turns and the files each one changed, then:

- `/rewind 1` undoes the last turn: files go back to how they were and the conversation returns to before that request. Files the turn created are removed.
- `/rewind 3 code` restores files from the last three turns but keeps the conversation.
- `/rewind 1 chat` rewinds only the conversation.

Checkpoints last for the current session. Changes made by shell commands (for example `npm install` or `sed -i`) are not tracked, so use Git for those. The older `oasis backups` / `oasis restore` snapshots still work too.

## Subagents

The `task` tool lets Oasis hand self-contained work to a subagent with its own context window. Only the subagent's final report returns to the main conversation, which keeps long investigations from crowding it out. Several `task` calls in one response run in parallel (up to 6 at once). Built-in agents: `general-purpose` (all tools), `explore` (read-only search), and `plan` (read-only planning).

Define your own in `.oasis/agents/*.md` or `.claude/agents/*.md` (project), or `~/.config/oasis/agents/` / `~/.claude/agents/` (user). Claude Code agent files work unchanged:

~~~markdown
---
name: test-runner
description: Use after code changes to run the test suite and fix failures
tools: Read, Grep, Glob, Bash, Edit
model: inherit
---
You are a test specialist. Run the relevant tests, fix failures, and report results.
~~~

Subagents share the parent's permission rules, hooks (`SubagentStop`), sandbox, and approvals. They cannot start further subagents.

### Asking you questions

When a choice really changes the work (which library, which approach, how much scope), Oasis can stop and ask a multiple-choice question with the `ask_user_question` tool. This is like Claude Code's AskUserQuestion. In the terminal, answer with a number (or several numbers when multiple answers are allowed), type your own answer, or press Enter to skip. In the browser, the question appears as a card with buttons. Headless `-p` runs and subagents never block: the model is told no user is available, so it picks a reasonable option and states the assumption.

### Worktree isolation

For parallel edits, a `task` call can set `"isolation": "worktree"` (or an agent file can set `isolation: worktree` in its front matter). The subagent then works on its own branch, `oasis/<name>`, in `.oasis/worktrees/<name>`. Your checkout is never touched, and agents running at the same time cannot overwrite each other. When the subagent finishes, Oasis commits its changes on that branch and reports the branch, the changed files and the merge command. A worktree with no changes is removed. `/worktrees` lists the branches still waiting for review. The worktrees are added to `.git/info/exclude`, so they stay out of `git status` and search. Normal `finishWorktree` calls run repository hooks; unattended background-worker auto-commits explicitly use `skipHooks: true` so a worker cannot run repository-controlled hook scripts without interactive approval. Those isolated branches remain reviewable, and merging into the user's checkout has a separate review/approval gate.

### Shared task board across the main agent and subagents

The main agent and its child agents have access to one dependency-aware task board for the current session. The model can use these tools:

| Tool | Purpose |
| --- | --- |
| `task_create` | Add a task with a title, optional description, optional owner, and existing prerequisite IDs in `blocked_by`. |
| `task_list` | List tasks, filter by `status` or `owner`, or hide completed work. Each result reports whether it is ready and which prerequisites are still waiting. |
| `task_get` | Read one task and its direct downstream dependents. |
| `task_claim` / `task_renew` / `task_release` | Exclusively claim a ready task with an expiring lease, extend your own live lease, or release a task when blocked/cancelled. |
| `task_update` | Change a title, description, owner, prerequisites, or status (`pending`, `in_progress`, `completed`). |
| `dispatch_ready_tasks` | Launch a bounded wave (1–6, default 3) of ready tasks as background agents in separate worktrees. Optionally pass an active `team_id`. |

Example request to the agent: “Split this migration into shared tasks, record the prerequisite relationships, and keep task status current while you verify each step.” The agent creates task IDs such as `task_1`; a dependent task uses `blocked_by: ["task_1"]`. Oasis rejects missing dependencies, cycles and attempts to start or complete work that is still blocked. The board is limited to 100 tasks, with up to 20 direct prerequisites per task.

**Important limits:** these are model tools, not standalone slash commands or a separate task-board UI. The board is shared between the main session and subagents in that session, and it is persisted with saved sessions; it does not sync across independent Oasis sessions, the browser dashboard’s local-storage tasks, or remote machines. Setting an owner records assignment metadata but does not start or reserve the task; `task_claim` supplies the actual time-limited lease. `dispatch_ready_tasks` launches a single bounded wave; the main model must request another wave after prerequisites complete, so this is not a persistent autonomous scheduler or dynamic-workflow runner. Background workers cannot prompt for per-tool approval: edits/commands requiring a prompt are denied unless the inherited permission mode or explicit allow rules permit them. Branches are not merged by dispatch; review/preflight and approval are required. Use `isolation: "worktree"` for independently editing subagents; a shared task board by itself does not isolate files.

## Longer tasks

Oasis knows the context window of common models (Claude 200K, GPT-4.1 and Gemini 1M, GPT-5 400K, o-series 200K, GPT-4o 128K, and others) and compacts history at about 60% full. Unknown or local models use a conservative 32K. Set `"contextWindow"` in the provider config or `OASIS_CONTEXT_WINDOW` to override it, and `OASIS_COMPACT_THRESHOLD_CHARS` to change when compaction starts.

The default per-task budget is now 60 model steps and 300 tool calls (it was 12 and 30). Raise or lower them with `maxSteps`, `maxToolCalls`, and `maxTokens` in the provider config, or `OASIS_MAX_STEPS`, `OASIS_MAX_TOOL_CALLS`, and `OASIS_MAX_TOKENS`.

## Command safety and OS sandbox

The general `run_command` tool runs one executable with an argument array and no shell. Beyond the executable denylist, Oasis now unwraps wrapper programs (`env`, `xargs`, `timeout`, `nice`, `nohup`, ...) and checks the program they launch, so `env rm` or `xargs rm` are blocked like `rm`. Commands that run inline code or arbitrary programs (`node -e`, `python -c`, `perl -e`, `find -exec/-delete`, `awk 'system()'`, `git -c`, `curl -o`, ...) are classified as **high risk**: they always need an interactive answer, even with `--yes`, unless an explicit permission rule allows them.

Enable the OS sandbox to confine commands to the workspace:

~~~json
// ~/.config/oasis/settings.json
{ "sandbox": { "enabled": true, "network": false } }
~~~

On Linux this uses bubblewrap (`apt install bubblewrap`): the host filesystem is read-only, the workspace is writable, `/tmp` is private, and the network is unshared unless `network` is true. On macOS it uses `sandbox-exec`. Inside the sandbox, normal (not high-risk) commands run without a prompt; set `autoAllowCommands: false` to keep prompting. `OASIS_SANDBOX=1` enables it for one run.

## Extra agent tools

- `grep`: regex search backed by ripgrep (JS fallback) with globs, context lines, and `content` / `files_with_matches` / `count` modes. Secret files are never returned.
- `multi_edit`: several exact-string edits to one file, applied atomically.
- Images: `read_file` on a PNG, JPEG, GIF, or WebP file (up to about 3.7 MB) shows it to vision-capable models, and `@screenshot.png` in a prompt attaches it. This works with OpenAI-compatible, Responses, and Anthropic providers. Only the four most recent images are sent with each request, and images are not written to saved sessions. If your model is text-only, set `OASIS_VISION=off` or `"vision": false` in the provider config.
- Extended thinking (Anthropic protocol): as in Claude Code, "think about" gives about 4k thinking tokens, "think hard" about 10k, and "ultrathink" about 32k for that task. Thinking blocks are replayed with their signatures during tool use. Set a default with `"thinkingBudget": 8000` or `MAX_THINKING_TOKENS`; turn it off with `OASIS_THINKING=off`.
- Output limits: current Claude models (and other modern models) get a 32,000-token output window per response, older 8k models keep 8,192, and GPT-4o gets 16,384. Override with `"maxOutputTokens": 64000`, `OASIS_MAX_OUTPUT_TOKENS`, or Claude Code's `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. If a response is cut off at the limit, OASIS never runs the half-written tool call; it tells the model what happened and asks it to resume in smaller pieces (up to three times per turn). If a provider rejects the limit and names its real maximum, OASIS lowers the cap for the session and retries once.
- File-state safety: OASIS tracks which files the agent has read. Overwriting an existing file with `write_file` requires reading it first, and any edit is refused if the file changed on disk since the agent last saw it (you edited it, a formatter ran, another agent touched it) — the agent re-reads and rebases its change instead of clobbering yours. Set `"requireReadBeforeEdit": "strict"` to require a read before every edit exactly like Claude Code, or `false` / `OASIS_REQUIRE_READ_BEFORE_EDIT=0` to turn the guard off.
- Reasoning effort (OpenAI o-series and gpt-5 models): the same keywords set `reasoning_effort` (chat) or `reasoning.effort` (Responses): "think about" → low, "think hard" → medium, "ultrathink" → high. Set a floor with `"reasoningEffort": "medium"` or `OASIS_REASONING_EFFORT`; setting it explicitly also enables the field for other models.
- Prompt caching: with the Anthropic protocol, Oasis marks the system prompt, tool list, and newest message as cacheable, so long sessions reuse the cached prefix and cost less. Turn it off with `OASIS_PROMPT_CACHE=off` or `"promptCache": false`.
- Extra folders: `oasis --add-dir ../shared-lib` (repeatable), `/add-dir PATH`, or `permissions.additionalDirectories` in trusted settings let file tools read and edit another folder. Secret files and symlink escapes stay blocked there, edits get their own snapshots, and the OS sandbox can write there too.
- PDFs: `read_file` on a `.pdf` returns its text with `--- page N ---` markers. Pass `pages` (`"3"`, `"1-10"`, at most 50 pages per call) for long documents. Oasis uses `pdftotext` (poppler) when it is installed, or set `OASIS_PDFTOTEXT` to its path. Otherwise a built-in extractor handles most text PDFs. Scanned PDFs without a text layer return no text.
- Jupyter notebooks: `read_file` on a `.ipynb` shows each cell with its id, type, and text outputs (images are summarized). `notebook_edit` replaces, inserts, or deletes cells and clears stale outputs. Permission rules can target it as `NotebookEdit`, and it is covered by checkpoints and `/rewind`.
- `web_search`: searches the web for current docs, error messages, and release notes, then `fetch_url` reads a result. It works without a key through DuckDuckGo. For more dependable results set `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, or `OASIS_SEARXNG_URL` (a self-hosted SearXNG). Queries go to that search service; set `OASIS_WEB_SEARCH=off` to remove the tool.
- Background agents: `task` with `run_in_background: true` starts a subagent and returns its id right away, so Oasis keeps working while it runs. Finished agents report back automatically, as a terminal notice and in the model's next step; if you are idle at the prompt, OASIS starts a turn right away so the agent can act on the result. `agent_status` lists agents or reads one report (`wait_seconds` blocks until it finishes). `send_message` steers a running agent mid-task or resumes a finished one with its full earlier context. `agent_stop` cancels one. `/tasks` lists agents and background processes (`/tasks ID`, `/tasks stop ID`). Background agents can't show approval prompts, so anything not already allowed by a rule or bypass mode is denied. Use read-only agents or `isolation: "worktree"` for edits.
- Git workflow tools: `git_log` (read-only history), `git_commit` (stages all changes or chosen paths, passes the message on stdin, refuses secret-looking files such as `.env` and keys, never amends or skips hooks), `git_branch` (create from HEAD or a ref, or switch), `git_push` (sets upstream, never force-pushes), and `create_pull_request` (pushes, then runs `gh pr create` with the body on stdin and the default branch as base). Each one asks for approval. Rules such as `git_commit` or `Git` allow them, and `/commit [hint]` and `/pr [base]` run the whole workflow.
- `lsp`: code intelligence from real language servers, including go to definition, find references, hover (types and docs), implementation, type definition, file outline, workspace symbol search, incoming and outgoing call hierarchy, and per-file diagnostics. You can point at a symbol by name (`symbol: "add"`) or by line and column. Built-in support covers TypeScript/JavaScript (TypeScript 7's `tsc --lsp`, or `typescript-language-server`), Python (Pyright, basedpyright, pylsp), Go (gopls), Rust (rust-analyzer), C/C++ (clangd), Java, Ruby, PHP, Lua, C#, Kotlin, and Swift. Servers start on demand with one approval per session, stay warm, re-sync files edited on disk, and stop when the session ends. Add other servers in trusted settings: `"lspServers": { "zig": { "command": "zls", "extensions": [".zig"] } }`.
- `diagnostics`: runs the project's own type checkers and linters (TypeScript `tsc --noEmit`, ESLint, Ruff, mypy, Pyright, `go vet`, `cargo check`) and returns structured problems with file, line, column, severity, and rule code. Checkers are detected from config files, and project-local binaries (`node_modules/.bin`, `.venv`) are used first. Built-in JavaScript (`node --check`, which parses without running) and JSON syntax checks cover changed files and need no approval. External checkers need the same approval as `run_command`, or a permission rule like `diagnostics` / `Lsp`. The agent is told to run it after edits. You can also run `/diagnostics [paths]` to check and fix, or `oasis diagnostics [PATH...] [--checker NAME] [--json]` from scripts; it exits 1 when there are errors.
- Background processes: `run_command` with `run_in_background: true` starts dev servers or watchers; `command_output`, `kill_command`, and `list_background` manage them. When one exits on its own, the agent gets a notice (exit code plus the tail of unread output), so it doesn't need to poll.
- `monitor` (Claude Code's Monitor tool): watch something in the background and react to each new line without polling, such as tailing a log for errors, polling CI or a PR, or following a long script. Give `command` + `args` (same analysis, Bash permission rules and approvals as `run_command`) or `ws: { url }` to treat WebSocket messages as events. `pattern` keeps only matching lines; `timeout_ms` defaults to 5 minutes (max 1 hour) and `persistent: true` runs until the session ends. Bursts are batched into one `<monitor-event>` and an "ended" event follows. Events are added between steps while the agent works, and when you are idle at the prompt OASIS starts a turn so the agent reacts right away (it waits if you're typing). In `-p` mode the run stays open while the agent's monitors run (capped at 10 minutes) and emits a `system`/`monitor_event` line for each batch. Stop a monitor with `kill_command`.
- Background events wake an idle session everywhere: the interactive CLI, `-p` runs with active monitors, and long-lived `--input-format stream-json` sessions such as the VS Code chat panel. Monitor events, channel messages, finished background commands and finished background agents queue a synthetic turn (emitted as `system`/`background_event`, never replayed as a user message). Stream-json sessions also start `always` plugin monitors unless `OASIS_DISABLE_PLUGIN_MONITORS=1`.

## Useful commands

| Command | Purpose |
|---|---|
| `oasis` | Start an interactive coding session |
| `oasis "task"` | Run a plain-English task |
| `oasis setup` | Configure a provider |
| `oasis doctor` | Check Node, package managers, and provider config |
| `oasis init` | Create an `OASIS.md` project context file |
| `oasis plan "task"` | Inspect the workspace and create a read-only implementation plan |
| `/plan task` | Plan within an interactive session without file writes or commands |
| `oasis -p "task"` | Run one task without prompts; add `--output-format json` for scripts |
| `/help` | List built-in and custom slash commands inside a session |
| `/rewind` | Undo the file changes and conversation of recent turns |
| `oasis permissions` | Show permission rules, hooks, trust, and sandbox status |
| `oasis trust` | Let this workspace's allow rules and hooks apply |
| Git tools | Read-only status and diff inspection; whole-worktree diffs exclude common secret-bearing paths |
| `oasis install PACKAGE` | Install a tool or package |
| `oasis skills list` | List bundled and workspace skills |
| `oasis skills install NAME` | Install a bundled skill into the workspace |
| `oasis backups` | List recoverable file snapshots |
| `oasis restore BACKUP_ID` | Restore a snapshot after confirmation |
| `oasis config` | Show provider settings without revealing the key |
| `oasis update` | Update the CLI from this public repository |

Options: `--workspace PATH` chooses the workspace and `--yes` explicitly enables automatic approval for supported actions.

## Coding-agent evaluations (experimental)

Oasis includes a reference-task harness for measuring completed work instead of relying only on a model's final response.

~~~bash
oasis eval --validate
oasis eval --task config-output-token-limit --trials 3 --yes
~~~

Each task under `evals/tasks/<id>/` contains a pre-change repository snapshot, a plain-English request, a known-good reference patch, and a verifier kept outside the copied workspace. Validation checks that the verifier fails on the unchanged snapshot and passes after the reference patch is applied. The CI quality gate runs this validation on Node.js 22, 24, and 26.

Model runs require explicit `--yes` because agent-generated changes and commands run automatically inside disposable copies. **These copies are not OS sandboxes**: approved code may still access the host's user-level privileges and network. Run only trusted evaluation tasks, and do not use the harness as a security boundary.

Results are written as JSON under the user-level Oasis configuration directory in `eval-results/` (or `OASIS_EVAL_RESULTS_DIR`). To estimate costs, set `OASIS_EVAL_INPUT_USD_PER_MILLION_TOKENS` and `OASIS_EVAL_OUTPUT_USD_PER_MILLION_TOKENS` to the rates for the selected model. These are estimates and do not separate cached-token pricing. The current 21-task suite is an initial smoke benchmark: most are standalone helper tasks, not a representative benchmark of full-project changes. Replace or expand them with real, reviewed Oasis tasks before drawing conclusions about model quality or parity.

## Run the browser workspace

No build step or package installation is needed for the static workspace. Open `index.html` in a modern browser, or run:

~~~bash
python -m http.server 8000
~~~

Then open `http://localhost:8000`.

## Development and verification

Node.js 22 or newer:

~~~bash
npm run check
npm pack --dry-run
~~~

The test suite checks provider configuration, install intent parsing, exact text edits and backup safety, glob matching, ranged reads, workspace boundaries, secret-file protection, command approvals, environment filtering, private URL rejection, MCP calls, optional session persistence, and simulated model/tool-call cycles for OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic.

A passing test suite is not a full security audit or a substitute for exercising the CLI on Linux, macOS, Windows, Android/Termux, or against real model providers.

## Known limitations — not claimed as finished

- The built-in capability catalog contains reviewed workflow-skill bundles only. Oasis can install supported external Agent Skills through the pinned Vercel Skills CLI and import reviewed Markdown prompts from GitHub extensions, but that is not a general remote plugin marketplace. Signed publisher manifests and fully native lifecycle compatibility are not implemented.
- The OS sandbox uses bubblewrap on Linux and sandbox-exec on macOS. It is off by default, and there is no Windows sandbox or container isolation yet.
- Checkpoints only track changes made through Oasis's file tools, and they live in memory for the current session; they are not saved with resumed sessions.
- Saved conversations are on by default and workspace-scoped. Oasis provides read-only plan mode (`oasis plan "task"` or `/plan task`), first-class Git status/diff inspection, and between-turn history compaction using a tool-free model summary with a bounded local fallback if summarization fails. The agent also uses bounded deterministic within-turn microcompaction to prune older bulky tool results when its estimated context nears the configured limit (default estimate 32,768 tokens; set OASIS_CONTEXT_WINDOW for the selected model).
- MCP servers start from the user-level config and may execute third-party code; review sources and tool permissions before adding one.
- Consecutive read-only workspace calls can run concurrently; all other calls act in their original requested order so a later read cannot overtake an earlier edit. A task checklist (`todo_write`) persists with saved sessions. Specialist reviews are available as bounded, read-only second opinions. Parallel subagents (the `task` tool) run in separate contexts, but they share one workspace, so Oasis does not resolve conflicting edits between them; give parallel agents separate files, read-only work, or `"isolation": "worktree"` so each one gets its own branch.
- The agent runtime is reachable from the browser only when `oasis web` is running; opening the static GitHub Pages site or `index.html` alone does not provide runtime execution.
- GitHub connection currently reuses GitHub CLI authentication (`gh auth login`) on the host; embedded GitHub OAuth, organization-wide discovery beyond the first 30 API results, creating repositories, branch/push/PR workflows, and fine-grained GitHub App scopes are not implemented yet.
- The Terminal panel is an argv-based command runner, not a full interactive PTY: shell chaining, shell interpreters, TUI programs, and interactive prompts are not supported by the web bridge yet.
- Browser projects/tasks/notes still use browser local storage and do not sync with the CLI workspace. Agent sessions are stored separately in the user-level Oasis session directory.
- GitHub Pages validation runs in CI, but public deployment is opt-in. A repository owner must enable Pages and set the repository variable `OASIS_ENABLE_PAGES` to `true`; a passing workflow does not prove the site is live.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md), and [the runtime architecture](ARCHITECTURE.md).

## License

MIT. See [LICENSE](../LICENSE).


## Interactive PTY terminal sessions

For commands that need a real terminal (for example, an interactive REPL or an installer prompt), OASIS can start a persistent PTY rather than a one-shot pipe process. The agent uses `run_command` with `interactive: true`; it must still pass normal command safety analysis and approval rules.

The resulting terminal id can be used with:

| Tool | Purpose |
| --- | --- |
| `terminal_read` | Read streamed output by cursor; optionally wait up to 30 seconds for new output. |
| `terminal_input` | Send text/keystrokes to the already-approved process. |
| `terminal_resize` | Change terminal columns/rows. |
| `terminal_interrupt` | Send Ctrl+C. |
| `terminal_stop` | Terminate the terminal process. |
| `terminal_list` | List terminal ids, state and exit status. |

Example agent request: “Run `python` interactively, read its startup banner, evaluate `2 + 2`, show the result, then stop the session.” The command itself remains subject to OASIS's command policy; an interactive flag does not bypass blocked executable checks or approval.

The native `node-pty` component is an optional dependency. See [Install OASIS](INSTALL.md) for supported platforms and native build prerequisites. The CLI session API does not yet mean the browser workspace has a full terminal emulator.
