# OASIS documentation

OASIS is an open-source, model-agnostic agent platform and runtime. The root
[README](../README.md) is the overview and install entry point; this page maps
every guide.

## Start here

| If you want to… | Read |
| --- | --- |
| Install OASIS and finish a first task | [User guide](USER-GUIDE.md) · [First run](FIRST-RUN.md) |
| See what OASIS can do beyond code | [Workflows](WORKFLOWS.md) |
| Know what is stable, unreleased or experimental | [Capabilities and status](CAPABILITIES.md) |
| Use the terminal agent day to day | [Terminal guide](TERMINAL.md) |
| Choose between the terminal, web app, desktop app and editors | [Interfaces](INTERFACES.md) |
| Connect a model, add backups, cap spend | [Configuration](CONFIGURATION.md) · [Inference](INFERENCE.md) |
| Add skills, MCP servers, plugins or hooks | [Extending OASIS](EXTENDING.md) |
| Fix something that does not work | [Troubleshooting](TROUBLESHOOTING.md) · [FAQ](FAQ.md) |

## Guides

- [User guide](USER-GUIDE.md): install, connect a provider, use each interface, review results.
- [Workflows](WORKFLOWS.md): research, data analysis, writing, automation, chat, browser and desktop use, multi-agent work and software tasks.
- [Capabilities and status](CAPABILITIES.md): what is stable, released but lightly tested, unreleased, experimental or pending, and the known limitations.
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
- [Memory](MEMORY.md): durable notes across sessions, recall and freshness, and belief revision when a fact changes.
- [Troubleshooting](TROUBLESHOOTING.md): diagnostics and fixes for install, providers, the web app, the sandbox.
- [FAQ](FAQ.md): short answers on models, cost, data, safety and compatibility.

## How it works

- [Architecture](ARCHITECTURE.md): runtime components, a typical turn, persistence and trust boundaries.
- [Security model](SECURITY.md): what OASIS enforces, what is outside its controls, recommended setup.
- [Provider transport](architecture/provider-transport.md): protocol-specific requests and streaming.
- [Agent network](AGENT-NETWORK.md): how subagents are scheduled, budgeted, cancelled and checked.
- [Receipts](RECEIPTS.md): signed, replayable proof of what an agent run did, checkable by anyone with `oasis receipt verify`.
- [Effects](EFFECTS.md): predicted versus observed changes for shell commands, and rewinding them.
- [Durable execution](DURABLE-EXECUTION.md): the intent journal and how in-doubt actions are reconciled after a crash.
- [Reliability laboratory](RELIABILITY-LAB.md): fault injection (`OASIS_FAULTS`), the scenario scorecard, and live reconciliation of failed calls.
- [Task model](TASK-MODEL.md): the task contract every request is read into, its acceptance criteria and how outcomes are decided.
- [Compatibility](COMPATIBILITY.md): the Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Goose and other agent files and protocols OASIS reads or speaks.

## Development evidence

For contributors and anyone checking the engineering claims. These pages are
historical records with dates and limits, not product rankings.

- [Benchmarks](development/BENCHMARKS.md): model-free harness results, token and memory measurements, same-model gateway runs and their limits. Raw data is in `bench/results/`.
- [Real-world runs](development/REAL-WORLD-RUNS.md): unscripted tasks with real providers, plugins checked, what went wrong.

## Project records

- [Changelog](../CHANGELOG.md) · [Contributing](../CONTRIBUTING.md) · [Security policy](../SECURITY.md) · [Support](../SUPPORT.md) · [Code of Conduct](../CODE_OF_CONDUCT.md) · [Brand](BRAND.md) · [Third-party notices](../THIRD-PARTY-NOTICES.md)

## Documentation policy

Documentation describes behaviour that exists in the source and is covered by
tests, or it states the limitation. Planned work is labelled as planned.
`test/docs-file-references.test.mjs` fails when a current doc names a repository
file that does not exist or links to a missing file or heading.
