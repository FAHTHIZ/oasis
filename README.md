<p align="center">
  <img src="assets/oasis-readme-portal.svg" alt="OASIS — Code. Automate. Flourish." width="100%" />
</p>

<h1 align="center">OASIS</h1>
<p align="center"><strong>Code. Automate. Flourish.</strong></p>
<p align="center">An open-source, local-first AI coding agent and developer workspace. Bring the model you choose; keep the project workspace under your control.</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main" alt="Quality checks" /></a>
  <img src="https://img.shields.io/badge/status-beta-7CFF5E.svg?style=flat" alt="Beta software" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license" /></a>
</p>

OASIS is more than a chat panel. It is a coding-agent runtime with a CLI, local authenticated browser workspace, VS Code-compatible integration and desktop application packaging. It connects model reasoning to project files, Git, terminals, diagnostics and extensible tools—with explicit approval and verification paths around real changes.

## What you can do

- **Understand a codebase.** Explore files, search code, inspect Git changes, read project instructions and build context before editing.
- **Plan and implement.** Break work into steps, make focused file changes, run shell or PowerShell commands, inspect diffs and iterate on failures.
- **Verify instead of guessing.** Use configured language servers, tests, linters, builds and type checks. OASIS tracks whether changes were reviewed and whether a recognized check actually ran.
- **Keep work connected.** Save sessions, recall workspace memory, compact long context, use checkpoints and rewind supported file changes.
- **Delegate bounded work.** Use specialist reviewers, subagents, task boards, dependency-aware dispatch, isolated worktrees and sandboxed JavaScript workflows.
- **Extend the workspace.** Connect MCP servers, hooks, Agent Skills, plugin packages, model gateways and editor integrations.

## One engine, several ways to work

| Surface | What it is |
|---|---|
| **Terminal CLI** | Interactive coding agent, one-shot tasks, commands, diagnostics and model/provider setup. |
| **Browser workspace** | Local authenticated chat, project tools, approvals, terminal and run history through `oasis web`. |
| **VS Code integration** | Editor-side chat and runtime connection for a VS Code-compatible environment. |
| **Desktop app** | Electron application for Windows, macOS and Linux, with a project-folder picker and local backend. |

The browser workspace and desktop app run locally. OASIS is not a hosted cloud coding service; remote-provider requests still send the relevant prompt and code context to the provider you configure.

## Choose your model

OASIS does not bundle a model or a paid API subscription. Connect a provider or compatible endpoint, use a local Ollama model, or configure a gateway such as OmniRoute. The runtime includes adapters for OpenAI Responses, OpenAI-compatible Chat Completions and Anthropic Messages, with supported cloud-provider paths documented in the user guide.

Provider setup tests tool calling before saving a new configuration. A failed probe does not replace the existing provider settings. Optional easy/strong model routing is available, but its cost outputs are estimates—not guaranteed savings or proof of equal answer quality.

## Built around control and inspectability

- **Permission-aware execution:** allow/ask/deny rules, command-risk analysis, approval prompts and explicit permission modes.
- **Workspace safeguards:** path checks, snapshots, bounded output, sensitive-path handling and Git worktree isolation options.
- **Truthful verification:** denied actions remain denied; unavailable diagnostics are not shown as clean; new edits invalidate old verification evidence.
- **Extensible, not locked to one provider:** MCP, hooks, skills, plugins, workflows and subagents build on the existing runtime.
- **Open source:** Apache-2.0 licensed. Your model provider and its account terms remain your choice.

## Get started

**Desktop:** download the latest published build from the [OASIS releases page](https://github.com/FAHTHIZ/oasis/releases/latest), then follow the [installation and first-run guide](docs/INSTALL.md).

**CLI:** use the verified installer instructions in [Install OASIS](docs/INSTALL.md). They cover macOS, Linux, Windows PowerShell and Android/Termux.

**First task:** open a project you understand and ask:

> Read this repository. Explain its main parts and how they connect. Do not change any files yet.

After reviewing the explanation, try:

> Find one clear bug. Explain the evidence and a minimal fix, change only the necessary files, and run the relevant tests. Tell me clearly if you cannot verify the result.

## Important Beta boundaries

OASIS is Beta software. Desktop installers are unsigned, and automatic desktop updates are not configured. The optional Linux/macOS OS sandbox is disabled by default and is not full filesystem-read isolation; native Windows OS sandboxing is not implemented. Approval prompts are not a substitute for OS isolation.

There is no native Android APK. The CLI can be tried in Termux, but native PTY and background execution are not guaranteed. The browser workspace does not yet fully synchronize project/task/note state with the CLI. Agent run records can survive restarts, but live worker processes and pending approvals are not resurrected.

The current 33-task evaluator is a regression suite, not a representative repository-scale coding benchmark. No Claude Code parity, speed or accuracy claim is made. See the [project plan and release gates](docs/PROJECT_PLAN.md) for the current engineering priorities.

## Explore OASIS

- [Installation and first run](docs/INSTALL.md)
- [Detailed user guide](docs/USER_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Project plan and release status](docs/PROJECT_PLAN.md)
- [Security and reliability audit](docs/SECURITY_RELIABILITY_AUDIT.md)
- [Privacy notes](docs/PRIVACY.md)
- [Benchmarks and evaluation](docs/BENCHMARKS.md)
- [Repository maintenance and intentional copies](docs/REPOSITORY_MAINTENANCE.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Development

Use Node.js 22 or newer:

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm run check
```

The check pipeline validates the public site and benchmark fixtures, runs the Node test suite and evaluation controls. GitHub Actions adds the supported Node-version matrix, cross-platform security/runtime regressions, browser E2E, installer checks and desktop packaging. A passing automated suite is useful evidence, not a full security audit or proof of every platform journey.

## License

Apache License 2.0. See [LICENSE](LICENSE).
