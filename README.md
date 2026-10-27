# Oasis OSS

**An open-source, plain-English coding agent plus a local-first project workspace.**

Oasis is being built to turn requests like “inspect this project, install the missing tool, implement the feature, and run the tests” into a verified, multi-step workflow. Its terminal runtime is the main agent interface; the browser app remains a lightweight workspace for projects, tasks, and notes.

## Install the terminal agent

Requirements: Node.js 20+ and npm. Git is required for installing directly from this repository.

~~~bash
npm install -g git+https://github.com/gtxnrg-ship-it/Oasis.git#main
oasis setup
oasis doctor
oasis
~~~

During setup, enter an OpenAI-compatible chat-completions base URL, a model name that supports tool calling, and an API key. Key input is hidden. The key is stored in the user-level Oasis configuration file with restrictive POSIX permissions where supported—not in this repository.

Supported provider shapes:
- OpenAI-compatible chat completions endpoints, including compatible gateways and local endpoints that expose the same API.
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
~~~

A simple request such as \`oasis install pnpm\` uses the package installer directly and does not require an AI API. Compound tasks are routed through the agent and need a configured model.

## What is implemented

### Terminal agent
- Interactive sessions and one-shot plain-English tasks.
- A multi-step OpenAI-compatible tool-calling loop.
- Workspace file listing, literal search, and bounded text reads/writes.
- Command execution through an executable plus argument array, without shell expansion.
- Package installation for npm, Python/pip, system package managers, Cargo, and Go when supported on the host.
- Public HTTP/HTTPS documentation fetches with private-network URL checks and response limits.
- Bundled skills for debugging, code review, testing, environment setup, and shipping features.
- Project instructions from \`OASIS.md\`, \`AGENTS.md\`, \`CLAUDE.md\`, and installed \`.oasis/skills/*/SKILL.md\` files.
- Automatic snapshots before overwriting files, plus snapshot listing and restore commands.
- Environment diagnosis, workspace initialization, provider configuration, and self-update.

### Browser workspace
- Responsive project dashboard with statistics.
- Project creation, filtering, progress, completion/reopen, and removal.
- Task creation, completion, priorities, project association, search, and deletion.
- Notes that save locally, plus JSON export/import.
- Light/dark themes and an installable PWA shell with a service worker for offline caching.

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
| \`oasis install PACKAGE\` | Install a tool or package |
| \`oasis skills list\` | List bundled and workspace skills |
| \`oasis skills install NAME\` | Install a bundled skill into the workspace |
| \`oasis backups\` | List recoverable file snapshots |
| \`oasis restore BACKUP_ID\` | Restore a snapshot after confirmation |
| \`oasis config\` | Show provider settings without revealing the key |
| \`oasis update\` | Update the CLI from this public repository |

Options: \`--workspace PATH\` chooses the workspace and \`--yes\` explicitly enables automatic approval for supported actions.

## Run the browser workspace

No build step or package installation is needed for the static workspace. Open \`index.html\` in a modern browser, or run:

~~~bash
python -m http.server 8000
~~~

Then open \`http://localhost:8000\`.

## Development and verification

Node.js 20 or newer:

~~~bash
npm run check
npm pack --dry-run
~~~

The test suite checks URL validation, configuration file permissions, install intent parsing, package-name validation, workspace boundaries, secret-file protection, snapshots and restore, approval requirements, command environment filtering, private URL rejection, and a full simulated model/tool-call cycle against a local fixture server. The browser integrity script checks the static UI, JavaScript syntax, PWA manifest, icon, and service worker.

A passing test suite is not a full security audit or a substitute for exercising the CLI on Linux, macOS, Windows, Android/Termux, or against real model providers.

## Known limitations — not claimed as finished

- Oasis uses OpenAI-compatible tool calling in this version; it does not yet implement the native Anthropic Messages API.
- MCP server configuration, a plugin marketplace, and external integrations are not yet implemented.
- No OS-level sandbox or container isolation is provided.
- Agent sessions are kept in memory for the current process; durable cross-session conversation history is not implemented.
- Tool calls are sequential. Parallel agent orchestration, automatic compaction strategies, streaming token output, and advanced conflict handling are not implemented.
- The CLI and browser dashboard are separate interfaces; they do not currently share live project/task state.
- GitHub Pages deployment must be enabled in the repository's Pages settings. A workflow file alone does not prove the site is live.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [the runtime architecture](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
