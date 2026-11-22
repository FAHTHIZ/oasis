# Frequently asked questions

Short answers with links to the guide that covers each topic. For error
messages and fixes, see [Troubleshooting](TROUBLESHOOTING.md).

## General

### What is OASIS?

An open-source (Apache-2.0), model-agnostic agent platform and runtime. It
plans, acts with real tools and verifies its work across software development,
research, data analysis, writing, automation and browser or desktop use, with
any model you connect. One npm package,
`oasis-oss`, gives you the terminal agent (`oasis`), the browser workspace
(`oasis web`) and an SDK. A desktop app wraps the same runtime in an Electron
window. See the [User guide](USER-GUIDE.md), [Workflows](WORKFLOWS.md) and
[Capabilities and status](CAPABILITIES.md).

### Which models does it work with?

Any provider that speaks OpenAI Chat Completions, OpenAI Responses or
Anthropic Messages (Gemini, Groq, OpenRouter and most hosted APIs offer one of
these), and local OpenAI-compatible servers such as Ollama, LM Studio,
llama.cpp and vLLM. `oasis
connect` takes an API key, a model link or a local server address. See
[Configuration](CONFIGURATION.md) and [Provider transport](architecture/provider-transport.md).

### Does it cost anything?

OASIS is free. Model providers bill you for what you use. `oasis
--zero-budget` limits a session to free and local models and refuses paid
requests; request and token budgets cap spend otherwise. See
[Inference](INFERENCE.md).

### Can I use it without the internet?

Yes, with a local model server on the same machine or network. Web search
and remote providers then stay unavailable.

### Which operating systems are supported?

Linux is verified by tests and live runs. Windows and macOS are tested in CI
(security and runtime tests, installer scripts) but not by hand. The desktop
installers for all three are built in CI and are not code-signed. The status
table in the [README](../README.md#project-status) is the current record.

## Data and privacy

### Where does OASIS keep my data?

Settings, saved keys and sessions are in the config folder: `~/.config/oasis`
on Linux and macOS (or `$XDG_CONFIG_HOME/oasis`), `%APPDATA%\oasis` on
Windows, or `OASIS_CONFIG_DIR` if set. Project settings, commands and skills
you add live under `.oasis/` in the project. `oasis purge --dry-run` lists the
OASIS state kept for a project.

### What is sent to the model provider?

The conversation, the project instructions it loaded, and the tool results it
needs (file contents, command output). Nothing is sent anywhere else unless
you turn it on. See the [Security model](SECURITY.md).

### Is there telemetry?

No, unless you set `OASIS_ENABLE_TELEMETRY=1`. Telemetry is then sent over
OpenTelemetry to the endpoint you configure, not to the OASIS project. See
[Configuration](CONFIGURATION.md#telemetry-opentelemetry).

## Safety

### Can the agent break my machine?

It runs with your account's permissions. By default it runs read-only commands
freely and asks before other commands, installs, deletions and new websites.
`/rewind` and checkpoints undo file changes, not side effects of commands.
For untrusted code, turn on the OS sandbox (bubblewrap, macOS Seatbelt, Docker
or Podman) or use a container. See [First run](FIRST-RUN.md) and the
[Security model](SECURITY.md).

### How do I know it really ran the tests?

OASIS records which test, build and lint commands ran in the turn and how
they exited, plus diff review and LSP diagnostics. When a change was not
verified, a `-p` run ends with a "Not verified" note, and
`--require-verified` makes it exit 1. See the [User guide](USER-GUIDE.md).

## Working with other tools

### I already use another agent tool. Do I lose my setup?

No. OASIS reads `CLAUDE.md`, `.claude/skills`, `.claude/commands`, Claude
Code hooks and Claude Code plugins, and `AGENTS.md` and other agents' rule
files from Cursor, Codex, Gemini CLI, OpenCode, Goose and others where they
are. `oasis import` copies settings, memories and skills across. See
[Compatibility](COMPATIBILITY.md) and [Extending OASIS](EXTENDING.md).

### Does it work in my editor?

Through the Agent Client Protocol (Zed, JetBrains and others), the VS Code
family extension in `ide/`, and the Codex App Server protocol. See
[Interfaces](INTERFACES.md).

### Can it run several agents at once?

Yes: subagents, background agents, teams with a shared task board, and git
worktrees to keep their changes apart. See [Subagents](SUBAGENTS.md).

## Project

### How do I report a bug or a security issue?

Bugs: the [bug report form](https://github.com/FAHTHIZ/oasis/issues/new?template=bug_report.yml).
Security issues: follow the [security policy](../SECURITY.md); do not open a
public issue.

### How do I contribute?

Read the [Contributing guide](../CONTRIBUTING.md). Run `npm test`, `npm run
check` and `npm run lint` before opening a pull request.
