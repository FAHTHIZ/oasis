# OASIS user guide

This guide helps you choose an interface, connect a model, open a project and review the work OASIS produces. OASIS is a local-first runtime: the computer running it owns the project workspace and executes its tools.

## 1. Choose an interface

| If you want to… | Use | What it means |
|---|---|---|
| Work directly in a terminal | **Terminal session** | The interactive CLI runs in your shell and works on the current project. |
| Use a browser as the workspace UI | **Browser workspace** | A local OASIS server serves the UI; the agent and project remain on the host. |
| Use a native desktop window | **Desktop application** | Electron hosts the local runtime and opens a project folder you select. |
| Work from an editor | **Editor integration** | The editor connects to the OASIS runtime. |
| Embed OASIS in another Node.js app | **SDK** | Use the public Node.js API. |

The terminal, browser and desktop interfaces are separate entry points. The browser is not a hosted OASIS account, and the terminal is not a browser tab.

## 2. Install OASIS

### Desktop

1. Open [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases/latest).
2. Choose the installer for your OS and CPU architecture.
3. Verify the file against SHA256SUMS attached to that release.
4. Install OASIS and launch it.

The release page lists only assets that were actually published. If a platform asset is missing, do not substitute an unrelated CI artifact.

### Terminal

Requirements: Node.js 22.15 or newer and Git.

\`\`\`sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
\`\`\`

Run oasis --help to see available commands.

## 3. Configure a model provider

OASIS is a runtime, not an inference service. Select a provider and model you are authorised to use. Depending on the interface, configure the endpoint, model identifier and credential in the provider setup flow or user configuration.

Before entering a credential:
- Verify the provider URL and model name.
- Understand whether prompts and project context may be sent to that provider.
- Do not commit credentials to project files, shell history, reports or screenshots.
- Start with a small, non-sensitive project.

See the [configuration reference](CONFIGURATION.md) for provider protocols, fallback models and task-aware routing.

## 4. Terminal session

The terminal session is OASIS's native command-line interface. It runs in your shell and does not require the browser workspace.

\`\`\`sh
cd /path/to/your/project
oasis connect
oasis
\`\`\`

Use oasis for the interactive session. Use oasis exec for a non-interactive task in scripts or automation. Use oasis doctor to inspect the local environment and oasis update to update a script-installed version.

Keep the terminal open while the session is active. The process has the permissions of the account running it, subject to OASIS's configured permission and sandbox controls.

## 5. Browser workspace

Start the browser workspace on the computer that contains the project:

\`\`\`sh
cd /path/to/your/project
oasis web --open
\`\`\`

OASIS opens the local workspace in your browser. The browser displays the interface; the runtime, project files and command execution remain on the host. Browser job/event history exists only for that runtime process and is cleared on restart; saved chat sessions are stored separately.

For phone or tablet access, follow [Mobile and tablet setup](../MOBILE.md). Keep access on a trusted private network and do not expose the workspace directly to the public internet.

## 6. Desktop application

The desktop application starts the local runtime and asks you to choose a project folder. It uses the same workspace UI as the connected browser experience, but the app manages the local host process and window lifecycle.

- Select a project folder you trust.
- Configure a model provider in the setup flow.
- Review permission requests before approving commands or file changes.
- Keep the application updated from the verified GitHub Releases page.

## 7. Review every task

For a reliable first task, choose a bounded change with an observable outcome, such as explaining a function, fixing a reproducible bug or adding a focused test.

1. State the requested outcome and relevant constraints.
2. Review commands and requested permissions before approving them.
3. Inspect the files OASIS changed.
4. Read the diff and check for unrelated edits.
5. Run relevant tests and inspect their exit status and output.
6. Commit only after you understand and accept the final diff.

A model saying “done” is not a test result. See [Benchmark methodology](BENCHMARKS.md) for the difference between deterministic checks and live task evaluations.

## 8. Security boundaries

- Approval prompts are not a replacement for operating-system isolation.
- Without an active sandbox backend, commands may run with the permissions of the OASIS process.
- Linux, macOS and container sandbox backends have platform-specific prerequisites.
- MCP servers, plugins, hooks and imported skills can execute third-party code. Review their source and permissions before enabling them.
- Hosted providers may receive prompts, project context or tool output.

Read [SECURITY.md](../SECURITY.md) before connecting sensitive workspaces.

## Troubleshooting

| Problem | What to check |
|---|---|
| Provider connection fails | Verify the endpoint, model name, network access and provider credentials. Never paste API keys into an issue. |
| A command asks for approval | Inspect the command, arguments and working directory before deciding. |
| Sandbox unavailable | Do not assume isolation is active; check oasis doctor and the security policy. |
| The result is incorrect | Inspect the diff, ask for a narrow correction and rerun the relevant test. |
| Desktop installer is missing | Check [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases); tags and temporary Actions artifacts are not public downloads. |
| Phone cannot connect | Confirm the host runtime is running and both devices are on the same trusted private network. See [MOBILE.md](../MOBILE.md). |

## Further reading

- [Downloads and releases](RELEASES.md)
- [Interfaces and deployment](INTERFACES.md)
- [Configuration](CONFIGURATION.md)
- [Architecture](ARCHITECTURE.md)
- [Security policy](../SECURITY.md)
- [Support](../SUPPORT.md)
