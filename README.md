# Oasis OSS

**An open-source, plain-English coding agent plus a local-first project workspace.**

Oasis turns requests like “inspect this project, install the missing tool, implement the feature, and run the tests” into a verified, multi-step workflow. Use the CLI directly or start `oasis web` to connect mobile-friendly browser chat, the authenticated agent runtime, and approval-gated command execution. The separate static dashboard keeps projects, tasks, and notes in browser storage.

## Install the terminal agent

Requirements: Node.js 22+ and npm. Git is required for installing directly from this repository.

~~~bash
npm install -g git+https://github.com/gtxnrg-ship-it/Oasis.git#main
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
- Layered memory from user, project, and local files (`OASIS.md`, `AGENTS.md`, `CLAUDE.md`, `OASIS.local.md`), plus installed `.oasis/skills/*/SKILL.md` files.
- Claude Code-style permission rules and modes, lifecycle hooks, parallel subagents with custom agent files, custom slash commands, `@file` mentions, per-turn checkpoints with `/rewind`, and a headless `oasis -p` mode for scripts and CI.
- Automatic snapshots before edits and overwrites, plus snapshot listing and restore commands.
- Optional workspace-scoped saved sessions that can be resumed or deleted; skill descriptions load first and full skill guides load only on demand.
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
- **MCP integrations** connect Oasis to external tools and services. List them with `oasis mcp list`; configure an approved stdio server with `oasis mcp add NAME -- EXECUTABLE ARG...`, or describe the exact executable and argument list to Oasis in chat. Chat configuration always asks for manual approval—even when `--yes` is active—starts the server only after approval, and makes its discovered tools available in that session. External integrations may execute code or access data, so inspect their source, requested environment variables, and permissions before enabling them.

Why plugins matter: they save repeated setup, make workflows consistent, connect the agent to tools it cannot access by itself, and let a team share tested procedures. They do not automatically make the model smarter, grant a service account, or provide a paid model/API subscription.

The initial Oasis plugin catalog is intentionally small and reviewed. Its bundles install workflow text only: they do not silently run setup scripts, install packages, start servers, or grant credentials. The GitHub extension inspector detects Agent Skills and common Claude Code, Codex, and Gemini CLI markers and reports commands, MCP declarations, hooks, and executable components that are not activated. For recognized portable Agent Skills, Oasis also preserves bounded text references/assets and exposes them through integrity-checked resource access. Scripts remain unimported and inactive. Full native plugin compatibility is not implemented yet; inspection is explicit about this gap. The mobile-friendly Agent page and authenticated local runtime bridge are included in main. Remote marketplaces, signed/versioned third-party bundles, broader connector lifecycle management, embedded GitHub OAuth, and a full interactive terminal are still future work—not features Oasis claims to have.

The `main` installation contains both the terminal agent and the connected browser workspace. Opening `index.html` directly still provides only the static projects/tasks/notes dashboard; local agent execution requires the `oasis web` runtime to be running.

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
| `~/.config/oasis/settings.json` | You, every project |
| `.oasis/settings.json`, `.claude/settings.json` | Project (shared) |
| `.oasis/settings.local.json`, `.claude/settings.local.json` | Project (personal) |

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

Modes: `default`, `acceptEdits`, `plan` (read-only), and `bypassPermissions` (same as `--yes`). Set one per run with `--permission-mode`, or add rules for one run with `--allowedTools` / `--disallowedTools`.

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
- `oasis mcp list` and `/mcp` show both user and project servers. Every MCP tool call still asks for approval unless your permission rules allow it.

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

Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`. Each hook gets a JSON payload on stdin (`tool_name`, `tool_input`, `tool_response`, `prompt`, `cwd`, ...). Exit code `2` blocks: it stops a tool call, rejects a prompt, or makes the agent keep working after `Stop`, and stderr is passed to the model. JSON output supports `decision`, `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`), `updatedInput`, and `additionalContext`. Matchers accept Oasis or Claude Code tool names. Hooks run with secrets removed from the environment, and project hooks only run in trusted workspaces.

## Slash commands, @mentions, and memory

Inside `oasis`, type `/help` to see everything. Built-in commands include `/compact [focus]`, `/context`, `/cost`, `/model [id]`, `/mode [default|acceptEdits|plan|bypassPermissions]`, `/permissions`, `/agents`, `/commands`, `/hooks`, `/bashes`, `/todos`, `/memory`, `/mcp`, `/init`, `/plan`, and `/clear`.

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

Memory files are loaded into every session, from broadest to most specific:

| Scope | Files |
| --- | --- |
| User (all projects) | `~/.config/oasis/OASIS.md`, `~/.claude/CLAUDE.md` |
| Project (commit it) | `OASIS.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` |
| Personal (gitignore it) | `OASIS.local.md`, `CLAUDE.local.md` |

A line like `@docs/style.md` inside a memory file includes that file. Start a message with `#` to save a note: `# use pnpm, not npm` appends to `OASIS.md`, `# user: answer briefly` goes to your user memory, and `# local: my dev port is 4000` goes to `OASIS.local.md`.

Press Ctrl+C while a task is running to stop it and return to the prompt (press it again to quit). The conversation stays usable, and `/rewind 1` undoes any file changes the stopped task made.

The terminal streams the model's replies as they arrive. Set `OASIS_NO_STREAM=1` to print each reply only when it is finished.

## Headless mode for scripts and CI

`oasis -p "task"` runs one task without any prompts and prints the answer, like `claude -p`.

~~~bash
oasis -p "summarize what changed in the last commit"
git diff | oasis -p "review this diff for bugs" --output-format json
oasis -p "fix the failing test" --permission-mode acceptEdits --allowedTools "Bash(npm test:*)" --max-turns 30
oasis -p "list TODOs" --output-format stream-json --model gpt-4.1-mini
~~~

- `--output-format text` (default) prints the final answer. `json` prints one object with `result`, `subtype` (`success`, `error_max_turns`, `error_during_execution`), `is_error`, `num_turns`, `usage`, `tool_calls`, `session_id`, and `permission_denials`. `stream-json` prints one JSON event per line (`system`, `tool_use`, `tool_result`, `assistant`, then `result`).
- Piped input is added to the prompt inside `<stdin>` tags.
- With nobody to answer prompts, anything that needs approval is denied and listed in `permission_denials`. Allow what the job needs with `--allowedTools`, settings rules, `--permission-mode`, or `--yes`. High-risk commands stay blocked.
- The exit code is 1 when the run fails, so CI steps fail too. Add `--continue` (`-c`) or `--resume ID` to keep a conversation across runs.

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

For parallel edits, a `task` call can set `"isolation": "worktree"` (or an agent file can set `isolation: worktree` in its front matter). The subagent then works on its own branch, `oasis/<name>`, in `.oasis/worktrees/<name>`. Your checkout is never touched, and agents running at the same time cannot overwrite each other. When the subagent finishes, Oasis commits its changes on that branch and reports the branch, the changed files and the merge command. A worktree with no changes is removed. `/worktrees` lists the branches still waiting for review. The worktrees are added to `.git/info/exclude`, so they stay out of `git status` and search. The commit uses `--no-verify`, so repository hooks are not run for agent commits.

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
- Reasoning effort (OpenAI o-series and gpt-5 models): the same keywords set `reasoning_effort` (chat) or `reasoning.effort` (Responses): "think about" → low, "think hard" → medium, "ultrathink" → high. Set a floor with `"reasoningEffort": "medium"` or `OASIS_REASONING_EFFORT`; setting it explicitly also enables the field for other models.
- Prompt caching: with the Anthropic protocol, Oasis marks the system prompt, tool list, and newest message as cacheable, so long sessions reuse the cached prefix and cost less. Turn it off with `OASIS_PROMPT_CACHE=off` or `"promptCache": false`.
- Extra folders: `oasis --add-dir ../shared-lib` (repeatable), `/add-dir PATH`, or `permissions.additionalDirectories` in trusted settings let file tools read and edit another folder. Secret files and symlink escapes stay blocked there, edits get their own snapshots, and the OS sandbox can write there too.
- Jupyter notebooks: `read_file` on a `.ipynb` shows each cell with its id, type, and text outputs (images are summarized). `notebook_edit` replaces, inserts, or deletes cells and clears stale outputs. Permission rules can target it as `NotebookEdit`, and it is covered by checkpoints and `/rewind`.
- `web_search`: searches the web for current docs, error messages, and release notes, then `fetch_url` reads a result. It works without a key through DuckDuckGo. For more dependable results set `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, or `OASIS_SEARXNG_URL` (a self-hosted SearXNG). Queries go to that search service; set `OASIS_WEB_SEARCH=off` to remove the tool.
- `diagnostics`: runs the project's own type checkers and linters (TypeScript `tsc --noEmit`, ESLint, Ruff, mypy, Pyright, `go vet`, `cargo check`) and returns structured problems with file, line, column, severity, and rule code. Checkers are detected from config files, and project-local binaries (`node_modules/.bin`, `.venv`) are used first. Built-in JavaScript (`node --check`, which parses without running) and JSON syntax checks cover changed files and need no approval. External checkers need the same approval as `run_command`, or a permission rule like `diagnostics` / `Lsp`. The agent is told to run it after edits. You can also run `/diagnostics [paths]` to check and fix, or `oasis diagnostics [PATH...] [--checker NAME] [--json]` from scripts; it exits 1 when there are errors.
- Background processes: `run_command` with `run_in_background: true` starts dev servers or watchers; `command_output`, `kill_command`, and `list_background` manage them.

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
- Saved conversations are opt-in and workspace-scoped. Oasis provides read-only plan mode (`oasis plan "task"` or `/plan task`), first-class Git status/diff inspection, and between-turn history compaction using a tool-free model summary with a bounded local fallback if summarization fails. The agent also uses bounded deterministic within-turn microcompaction to prune older bulky tool results when its estimated context nears the configured limit (default estimate 32,768 tokens; set OASIS_CONTEXT_WINDOW for the selected model).
- MCP servers start from the user-level config and may execute third-party code; review sources and tool permissions before adding one.
- Consecutive read-only workspace calls can run concurrently; all other calls act in their original requested order so a later read cannot overtake an earlier edit. A task checklist (`todo_write`) persists with saved sessions. Specialist reviews are available as bounded, read-only second opinions. Parallel subagents (the `task` tool) run in separate contexts, but they share one workspace, so Oasis does not resolve conflicting edits between them; give parallel agents separate files, read-only work, or `"isolation": "worktree"` so each one gets its own branch.
- The agent runtime is reachable from the browser only when `oasis web` is running; opening the static GitHub Pages site or `index.html` alone does not provide runtime execution.
- GitHub connection currently reuses GitHub CLI authentication (`gh auth login`) on the host; embedded GitHub OAuth, organization-wide discovery beyond the first 30 API results, creating repositories, branch/push/PR workflows, and fine-grained GitHub App scopes are not implemented yet.
- The Terminal panel is an argv-based command runner, not a full interactive PTY: shell chaining, shell interpreters, TUI programs, and interactive prompts are not supported by the web bridge yet.
- Browser projects/tasks/notes still use browser local storage and do not sync with the CLI workspace. Agent sessions are stored separately in the user-level Oasis session directory.
- GitHub Pages validation runs in CI, but public deployment is opt-in. A repository owner must enable Pages and set the repository variable `OASIS_ENABLE_PAGES` to `true`; a passing workflow does not prove the site is live.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [the runtime architecture](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
