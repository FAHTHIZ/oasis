# Oasis OSS

**An open-source, plain-English coding agent plus a local-first project workspace.**

Oasis is being built to turn requests like “inspect this project, install the missing tool, implement the feature, and run the tests” into a verified, multi-step workflow. Use the CLI directly or start `oasis web` to connect a mobile-friendly browser chat and approval-gated command runner to the local agent runtime. The separate static dashboard still keeps projects, tasks, and notes in browser storage.

## Install the terminal agent

Requirements: Node.js 22+ and npm. Git is required for installing directly from this repository.

~~~bash
npm install -g git+https://github.com/gtxnrg-ship-it/Oasis.git#main
oasis setup
oasis doctor
oasis
~~~

During setup, choose the native OpenAI Responses API (the default), native Anthropic Messages API, or OpenAI-compatible chat completions. The default OpenAI model is `gpt-6.1-sol`; choose a model name that supports tools for any other provider. Key input is hidden. The key is stored in the user-level Oasis configuration file with restrictive POSIX permissions where supported—not in this repository.

### Try the connected browser agent on the development branch

The integrated browser runtime is currently on the open development branch, not yet in the default `main` branch. To try these changes before they are merged:

~~~bash
npm install -g git+https://github.com/gtxnrg-ship-it/Oasis.git#feat/eval-harness
oasis setup
cd /path/to/your/project
oasis web
~~~

Open the local URL printed by Oasis, paste the one-time connection token into **Agent → Connect runtime**, and describe the work in plain English. Keep the terminal process running while you use the browser. The token is generated for that running server and is not your model API key. In **GitHub**, use **Check connection** and **Refresh repositories** to view repositories available to the host's GitHub CLI login, then choose one and approve the clone. Oasis clones into `.oasis/workspaces/` under the launch workspace and switches the agent and command runner into the clone. To enable this, install GitHub CLI (`gh`) on the host and run `gh auth login` once in its terminal. This is a host-CLI connection, not browser OAuth; the app never asks you to paste a GitHub token.

For phone access from a computer, both devices must be on the same trusted private Wi-Fi. Start `oasis web --host 0.0.0.0`, open `http://<computer-LAN-IP>:3917` on the phone, and paste the token. **This HTTP bridge is not encrypted. Do not use it on public/untrusted Wi-Fi, do not port-forward it, and never expose it to the public Internet.** The safe default is localhost-only. Android/Termux installation and real-device behavior still need cross-platform testing.

Supported provider shapes:
- Native OpenAI Responses API (`openai-responses`), recommended for current OpenAI reasoning models that require Responses for tool calling.
- OpenAI-compatible chat completions endpoints, including compatible gateways and local endpoints that expose the same API.
- Native Anthropic Messages API endpoints. Select `anthropic` during `oasis setup`.
- Local Ollama-style endpoints such as \`http://localhost:11434/v1\`, provided the selected model supports tool calls. Leave the API key blank for a local endpoint.
- Environment overrides: \`OASIS_BASE_URL\`, \`OASIS_MODEL\`, and \`OASIS_API_KEY\`. \`OPENAI_API_KEY\` is also accepted.

Oasis does not include an API subscription or a model. A provider must be reachable and the selected model must support tool calling.

## Use it in plain English

~~~bash
oasis "Explain this repository and identify the next useful improvement"
oasis "Find the bug in the task filter, fix it, and run the relevant tests"
oasis "Install pnpm"
oasis "Install Playwright and set up browser tests"
oasis skills list
oasis skills install debugging
oasis plugins list
oasis plugins install code-quality
oasis mcp list
~~~

A simple request such as \`oasis install pnpm\` uses the package installer directly and does not require an AI API. Compound tasks are routed through the agent and need a configured model.

## What is implemented

### Terminal agent
- Interactive sessions and one-shot plain-English tasks.
- Multi-step native OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic Messages tool-calling loops.
- Optional MCP stdio server integration with explicit configuration and approval for each external tool call.
- Workspace file listing, glob matching, literal search, line-ranged reads, exact-string `edit_file` patches, whole-file writes, and approved deletes.
- Command execution through an executable plus argument array, without shell expansion.
- Package installation for npm, Python/pip, system package managers, Cargo, and Go when supported on the host.
- Public HTTP/HTTPS documentation fetches with private-network URL checks and response limits.
- Bundled skills for debugging, code review, testing, environment setup, and shipping features.
- A curated capability-bundle installer (`oasis plugins list/install/remove`) that installs bundled workflow skills as a unit; the agent can install a bundle in natural language after approval.
- Project instructions from \`OASIS.md\`, \`AGENTS.md\`, \`CLAUDE.md\`, and installed \`.oasis/skills/*/SKILL.md\` files.
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
- An integrated argv-based command runner that captures command output and requires per-command approval.
- GitHub CLI integration to check the host's existing authentication, list up to 30 repositories accessible to that account, clone a selected repo after approval, and switch the active agent workspace.

## Plugins, integrations, and installation

Oasis separates three things that are often all called “plugins”:

- **Skills** are reusable workflow instructions that guide the agent through tasks such as debugging, testing, code review, and release preparation.
- **Capability bundles** package related built-in skills so they can be installed and removed together. Browse with `oasis plugins list`; install with `oasis plugins install code-quality`; remove with `oasis plugins remove code-quality`. Bundles are copied into the current workspace under `.oasis/`.
- **MCP integrations** connect Oasis to external tools and services. List them with `oasis mcp list`; configure an approved stdio server with `oasis mcp add NAME -- EXECUTABLE ARG...`. External integrations may execute code or access data, so inspect their source, requested environment variables, and permissions before enabling them.

Why plugins matter: they save repeated setup, make workflows consistent, connect the agent to tools it cannot access by itself, and let a team share tested procedures. They do not automatically make the model smarter, grant a service account, or provide a paid model/API subscription.

The initial Oasis plugin catalog is intentionally small and reviewed. Its bundles install workflow text only: they do not silently run setup scripts, install packages, start servers, or grant credentials. Remote marketplaces, signed/versioned third-party bundles, permission-scoped connectors, and the integrated mobile chat-to-runtime workspace are still future work—not features this release claims to have.

For testing the current PR branch directly, install with:

~~~bash
npm install -g git+https://github.com/gtxnrg-ship-it/Oasis.git#feat/eval-harness
oasis setup
oasis doctor
oasis plugins list
oasis
~~~

This installs the terminal agent. The existing static PWA is a separate project dashboard; it is **not yet** the integrated mobile chat and terminal UI, and it cannot execute commands on the phone merely by being installed.

## Safety model

Oasis is a local developer tool, not a security sandbox.

- File tools are confined to the selected workspace and reject paths that escape via traversal or symlinks.
- Common secret files, private keys, and credential files are excluded from file tools.
- Existing files are snapshotted before the agent overwrites them. File deletions require a separate interactive approval and are snapshotted first.
- Shell interpreters and several high-impact destructive executables are blocked by the general command tool. Commands and package installs require approval by default.
- \`--yes\` (or \`OASIS_AUTO_APPROVE=1\`) auto-approves supported command/install actions. Do not use it for an untrusted repository; explicitly destructive operations remain blocked, and file deletion still requires interactive approval.
- Child processes do not inherit common API keys, tokens, passwords, and credential variables by default. Use \`OASIS_COMMAND_ENV_ALLOWLIST\` only when a command genuinely needs a specifically named variable.
- Web fetching rejects localhost/private-network targets, does not follow redirects automatically, and caps response size.
- Project instructions, skill files, repository contents, and web pages are untrusted input and cannot override Oasis's safety rules.

These guards reduce risk but cannot guarantee that every third-party package or project script is safe. Code executed by the OS still runs with the user's operating-system permissions. Review the requested operation, keep backups, and use an isolated development environment for untrusted code.

## Useful commands

| Command | Purpose |
|---|---|
| \`oasis\` | Start an interactive coding session |
| \`oasis "task"\` | Run a plain-English task |
| \`oasis setup\` | Configure a provider |
| \`oasis doctor\` | Check Node, package managers, and provider config |
| \`oasis init\` | Create an \`OASIS.md\` project context file |
| \`oasis plan \"task\"\` | Inspect the workspace and create a read-only implementation plan |
| \`/plan task\` | Plan within an interactive session without file writes or commands |
| Git tools | Read-only status and diff inspection; whole-worktree diffs exclude common secret-bearing paths |
| \`oasis install PACKAGE\` | Install a tool or package |
| \`oasis skills list\` | List bundled and workspace skills |
| \`oasis skills install NAME\` | Install a bundled skill into the workspace |
| \`oasis backups\` | List recoverable file snapshots |
| \`oasis restore BACKUP_ID\` | Restore a snapshot after confirmation |
| \`oasis config\` | Show provider settings without revealing the key |
| \`oasis update\` | Update the CLI from this public repository |

Options: \`--workspace PATH\` chooses the workspace and \`--yes\` explicitly enables automatic approval for supported actions.

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

No build step or package installation is needed for the static workspace. Open \`index.html\` in a modern browser, or run:

~~~bash
python -m http.server 8000
~~~

Then open \`http://localhost:8000\`.

## Development and verification

Node.js 22 or newer:

~~~bash
npm run check
npm pack --dry-run
~~~

The test suite checks provider configuration, install intent parsing, exact text edits and backup safety, glob matching, ranged reads, workspace boundaries, secret-file protection, command approvals, environment filtering, private URL rejection, MCP calls, optional session persistence, and simulated model/tool-call cycles for OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic.

A passing test suite is not a full security audit or a substitute for exercising the CLI on Linux, macOS, Windows, Android/Termux, or against real model providers.

## Known limitations — not claimed as finished

- The built-in capability catalog contains reviewed workflow-skill bundles only; a remote plugin marketplace, signed package manifests, version pinning, updates/rollback, and automated installation of third-party integrations are not yet implemented.
- No OS-level sandbox or container isolation is provided.
- Saved conversations are opt-in and workspace-scoped. Oasis provides read-only plan mode (`oasis plan \"task\"` or `/plan task`), first-class Git status/diff inspection, and between-turn history compaction using a tool-free model summary with a bounded local fallback if summarization fails. Compaction does not run in the middle of a tool loop, so an unusually long single task can still exceed provider context limits; streaming output is not implemented.
- MCP servers start from the user-level config and may execute third-party code; review sources and tool permissions before adding one.
- Read-only workspace tool calls can run in parallel, while commands, edits, installs, deletes, and external MCP calls run sequentially. Automatic context compaction now runs between turns, but parallel specialist-agent orchestration, streaming token output, mid-turn compaction, and advanced conflict handling are not implemented.
- The agent runtime is reachable from the browser only when `oasis web` is running; opening the static GitHub Pages site or `index.html` alone does not provide runtime execution.
- GitHub connection currently reuses GitHub CLI authentication (`gh auth login`) on the host; embedded GitHub OAuth, organization-wide discovery beyond the first 30 API results, creating repositories, branch/push/PR workflows, and fine-grained GitHub App scopes are not implemented yet.
- The Terminal panel is an argv-based command runner, not a full interactive PTY: shell chaining, shell interpreters, TUI programs, and interactive prompts are not supported by the web bridge yet.
- Browser projects/tasks/notes still use browser local storage and do not sync with the CLI workspace. Agent sessions are stored separately in the user-level Oasis session directory.
- GitHub Pages validation runs in CI, but public deployment is opt-in. A repository owner must enable Pages and set the repository variable `OASIS_ENABLE_PAGES` to `true`; a passing workflow does not prove the site is live.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [the runtime architecture](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
