# OASIS documentation

Find the right guide without knowing the repository. The root
[README](../README.md) is the project overview and install entry point.

## Start here

| If you want to… | Read |
| --- | --- |
| Install OASIS and finish a first task | [User guide](USER-GUIDE.md) · [First run](FIRST-RUN.md) |
| Use the terminal agent day to day | [Terminal guide](TERMINAL.md) |
| Choose between the terminal, web app, desktop app and editors | [Interfaces](INTERFACES.md) |
| Connect a model, add backups, cap spend | [Configuration](CONFIGURATION.md) · [Inference](INFERENCE.md) |
| Add skills, MCP servers, plugins or hooks | [Extending OASIS](EXTENDING.md) |
| Fix something that does not work | [Troubleshooting](TROUBLESHOOTING.md) · [FAQ](FAQ.md) |

## Guides

- [User guide](USER-GUIDE.md): install, connect a provider, use each interface, review results.
- [First run](FIRST-RUN.md): provider setup, workspace trust, permissions and verification.
- [Terminal guide](TERMINAL.md): input prefixes, keys, permission modes, commands, scripts and CI.
- [Interfaces](INTERFACES.md): web app, ACP editors, VS Code family, Codex App Server, Cursor Cloud Agents API, SDK, CI, chat gateways.
- [Execution backends](EXECUTION-BACKENDS.md): where commands run: the OS sandbox, Docker or Podman, any machine over SSH, or a Daytona cloud sandbox.
- [Computer use](COMPUTER_USE.md): let the agent see the screen and use the mouse and keyboard, with setup for Linux, macOS and Windows.
- [Messaging gateways](GATEWAYS.md): Telegram, WhatsApp, Discord, Slack, Mattermost, Matrix, Signal and email setup, chat commands, typed approvals and routine delivery.
- [Desktop app](DESKTOP.md): installers, unsigned first launch, key storage, updates, uninstall.
- [Remote access](REMOTE-ACCESS.md): run the web app on a server and use connected browser sessions from another device, securely.
- [Downloads and releases](RELEASES.md): npm tarball, install scripts, Homebrew, checksums.
- [Configuration](CONFIGURATION.md): providers, gateways, fallback models, routing, output, search, MCP options, telemetry.
- [Inference](INFERENCE.md): zero-budget mode, request and token budgets, the quota ledger.
- [Extending OASIS](EXTENDING.md): project instructions, skills, MCP, connected apps, plugins, commands, hooks, settings files.
- [Control room](CONTROL_ROOM.md): every agent on this computer, with its screen and browser, history, spend and the machine's load, in the web app or `oasis control-room`.
- [A2A](A2A.md): serve OASIS to other agents over the Agent2Agent protocol, and call remote A2A agents.
- [Subagents](SUBAGENTS.md): built-in and custom agents, background agents, teams and worktrees.
- [Troubleshooting](TROUBLESHOOTING.md): diagnostics and fixes for install, providers, the web app, the sandbox.
- [FAQ](FAQ.md): short answers on models, cost, data, safety and compatibility.

## How it works

- [Architecture](ARCHITECTURE.md): runtime components, a typical turn, persistence and trust boundaries.
- [Security model](SECURITY.md): what OASIS enforces, what is outside its controls, recommended setup.
- [Provider transport](architecture/provider-transport.md): protocol-specific requests and streaming.
- [Agent network](OASIS-NEURON-NETWORK.md): how subagents are scheduled, budgeted, cancelled and checked.

## Evidence

- [Benchmarks](BENCHMARKS.md): model-free harness results, same-model head-to-head runs and their limits.
- [Real-world runs](REAL-WORLD-RUNS.md): unscripted tasks with real providers, plugins checked, what went wrong.
- [Comparison](COMPARISON.md): features against Claude Code, Codex, Gemini CLI, OpenCode, Goose and others, with sources.

## Project records

- [Changelog](../CHANGELOG.md) · [Contributing](../CONTRIBUTING.md) · [Security policy](../SECURITY.md) · [Support](../SUPPORT.md) · [Code of Conduct](../CODE_OF_CONDUCT.md) · [Brand](BRAND.md) · [Third-party notices](../THIRD-PARTY-NOTICES.md)

## Documentation policy

Documentation describes behaviour that exists in the source and is covered by
tests, or it states the limitation. Planned work is labelled as planned.
`test/docs-file-references.test.mjs` fails when a current doc names a repository
file that does not exist or links to a missing file or heading.
