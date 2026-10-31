<!-- OASIS README | Product overview and entry point -->

<p align="center">
  <img src="assets/oasis-readme-portal.svg" alt="OASIS — Code. Automate. Flourish." width="100%" />
</p>

<h1 align="center">OASIS</h1>
<p align="center"><strong>Code. Automate. Flourish.</strong></p>
<p align="center">An open-source, local-first AI coding agent and developer workspace.</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main" alt="Quality checks" /></a>
  <img src="https://img.shields.io/badge/status-beta-7CFF5E.svg?style=flat" alt="Beta software" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license" /></a>
</p>

OASIS brings your chosen AI model into a real development workspace. It can explore a repository, plan work, edit files, run approved commands, use developer tools, coordinate bounded agent tasks, and help verify the result—all through one runtime.

**You bring the model. OASIS provides the workspace, agent runtime, tools, controls, integrations, and interfaces.** It is not a model of its own or a hosted AI service.

> **Current stage: Beta.** The source package is version `0.4.0`, but that version has not been tagged or published. The only version tag currently present is `v0.3.0`; no public GitHub Release assets are available to download. See [Beta status and current limits](#beta-status-and-current-limits).

<p align="center">
  <a href="#getting-started"><strong>Get started</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/USER_GUIDE.md">Read the user guide</a>
  &nbsp;·&nbsp;
  <a href="docs/PROJECT_PLAN.md">See project status</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/FAHTHIZ/oasis/releases">Release page</a>
</p>

---

## Navigate

[Overview](#what-is-oasis) · [Capabilities](#what-you-can-do) · [Architecture](#how-it-fits-together) · [Interfaces](#ways-to-use-oasis) · [Models](#model-and-provider-choice) · [Control and safety](#control-and-safety) · [Getting started](#getting-started) · [Beta status](#beta-status-and-current-limits) · [Documentation](#documentation) · [Development](#development)

## What is OASIS?

OASIS is a coding-agent runtime connected to your project—not just a chat window that suggests code. You ask for work in natural language; the selected model reasons about the task and requests tools; OASIS applies its execution rules, operates on the configured workspace, returns tool results, and helps you inspect what changed.

The same underlying runtime is available through multiple developer surfaces. You can choose a supported hosted model, a compatible API endpoint, or a local model service such as Ollama without rebuilding your workflow around a single model vendor.

### What you can do

| Capability | What it brings to the workspace |
|---|---|
| **Explore and understand code** | Read files, search a repository, inspect project structure, and follow relationships across a codebase. |
| **Plan and change projects** | Break work into steps, edit files, review diffs, and use snapshots or isolated worktrees where supported. |
| **Run and verify work** | Execute approved commands, inspect bounded output, run project checks, and collect diagnostics where configured. |
| **Coordinate agent tasks** | Delegate bounded sub-tasks, use specialist read-only reviews, and track dependencies through a task board. |
| **Keep useful context** | Save sessions, load layered project instructions and memory, compact older history, and use checkpoints and rewind. |
| **Automate repeatable work** | Build sandboxed JavaScript workflows with structured inputs and results, phases, pipelines, and parallel steps. |
| **Connect developer tools** | Use MCP servers, hooks, Agent Skills, supported extension-import formats, local plugin packages, and web-search integrations. |
| **Choose how to work** | Use the terminal CLI, local browser workspace, desktop packaging, VS Code-compatible integration, SDK, or GitHub Action. |

These describe implemented product areas, not a promise that every provider, integration, operating system, or end-to-end workflow has identical coverage. See the [implementation inventory and open gates](docs/PROJECT_PLAN.md).

## How it fits together

OASIS is the orchestration and control layer between your project and the model you select.

```mermaid
flowchart TD
    Person["You and your project"] --> Surface["CLI · Browser · Desktop · VS Code"]
    Surface --> Runtime["OASIS agent runtime"]
    Runtime <--> Model["Selected hosted or local model"]
    Runtime --> Context["Project instructions · Sessions · Memory"]
    Runtime --> Policy["Permissions · Approvals · Risk checks"]
    Policy --> Tools["Files · Git · Terminal · Browser · MCP · Workflows"]
    Tools --> Workspace["Project files and development environment"]
    Workspace --> Verify["Tests · Diagnostics · Builds · Diff review"]
    Verify --> Runtime
```

The model reasons and proposes tool calls. OASIS manages the local execution loop, tool contracts, permission decisions, workspace boundaries, session state, and results returned to the model. That separation lets you change providers without replacing the workspace.

## Ways to use OASIS

| Surface | Best for | What to know |
|---|---|---|
| **Terminal CLI** | Interactive coding, one-shot tasks, provider setup, diagnostics, and automation. | Requires Node.js 22 or newer. Native PTY support is optional and platform-dependent. |
| **Local browser workspace** | A visual, chat-first workspace with project tools, approvals, terminal, changes, and run monitoring. | Connects to a locally running OASIS runtime; it is not a hosted cloud workspace. Browser projects, tasks, and notes do not fully sync with CLI state. |
| **Desktop app** | An Electron app with a project-folder picker and local backend. | Windows, macOS, and Linux packaging is configured; builds are unsigned and public installers are not yet published. |
| **VS Code-compatible integration** | Bringing the OASIS runtime into a supported editor workflow. | It is not a full IDE suite. JetBrains support is not currently shipped. |
| **SDK and GitHub Action** | Using OASIS from scripts and repository automation. | Unattended runs need careful configuration; approval prompts are not a replacement for OS-level isolation. |

The browser workspace and desktop app run locally. If you choose a hosted model or search provider, the relevant prompt, code context, or search query is sent to that provider. Review [Privacy notes](docs/PRIVACY.md) before using OASIS with sensitive projects.

## Model and provider choice

OASIS does not bundle an AI model, API subscription, or hosted inference service. You connect a provider or compatible endpoint, or use a model service running on your own computer.

Supported setup paths include:

- **Hosted providers:** OpenAI, Anthropic, Google Gemini, and OpenRouter.
- **Local inference:** Ollama running on your own machine.
- **Compatible gateways:** OpenAI-compatible endpoints and gateways such as OmniRoute.

The runtime includes OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic Messages protocol paths, alongside documented cloud-provider adapters. Exact capabilities—including tool calling, streaming, context size, and pricing—depend on the model and endpoint you select.

Optional easy/strong model routing can assign simpler and harder tasks to different configured models. Cost figures are estimates based on configured prices and observed usage; they are not guaranteed savings or proof of equivalent answer quality.

See [installation and provider setup](docs/INSTALL.md) and the [configuration reference](docs/USER_GUIDE.md).

## Control and safety

OASIS is designed to make consequential actions visible and reviewable:

- **Permission modes and rules** determine whether tools are allowed, require approval, or are denied.
- **Command-risk checks** add scrutiny to potentially destructive or ambiguous commands.
- **Workspace safeguards** constrain supported file operations, handle sensitive paths, and provide snapshots or worktree isolation.
- **Bounded execution** limits supported tool output and helps manage child processes.
- **Verification records** distinguish passing checks from missing tools, timeouts, or unavailable diagnostics.
- **Review and recovery** provide diffs, checkpoints, backups, and rewind for supported file changes.
- **Integration controls** keep MCP activation and sensitive setup explicit. Imported instructions and third-party code still need scrutiny.

> **Important security boundary:** OASIS runs approved commands with the operating-system permissions of the user who launched it. Approval prompts and workspace checks are useful controls, but they are **not an operating-system sandbox**.

The optional OS sandbox currently targets Linux and macOS, is disabled by default, and does not provide full filesystem-read isolation. OASIS-native OS sandboxing for Windows is not implemented. MCP servers, hooks, plugins, executable skills, and other third-party tools may have access beyond the protections offered by OASIS's file tools. Use trusted projects, review approval prompts, and do not treat Beta software as a security boundary.

Read [SECURITY.md](SECURITY.md), the [security and reliability audit](docs/SECURITY_RELIABILITY_AUDIT.md), and [Privacy notes](docs/PRIVACY.md).

## Getting started

Choose the path that matches your device and workflow:

| I want to… | Start here |
|---|---|
| Check desktop availability and installation guidance | [Desktop app guide](docs/INSTALL.md#desktop-app--no-terminal-required) |
| Install the CLI on macOS, Linux, or Windows | [CLI installation](docs/INSTALL.md#command-line-installation) |
| Try OASIS on Android through Termux | [Android / Termux guide](docs/TERMUX.md) |
| Learn commands, tools, integrations, and settings | [Detailed user guide](docs/USER_GUIDE.md) |

**Desktop download note:** Desktop packages are built by CI, but public desktop download assets are not currently published. Check the [GitHub releases page](https://github.com/FAHTHIZ/oasis/releases) for availability. Until a release with assets is published, use the CLI installation path. The prepared 0.4.0 notes are not a downloadable installer release.

### Try a first task

Open a project folder you understand and begin with a read-only request:

> Read this repository. Explain its main parts and how they connect. Do not change any files yet.

Once you have reviewed the explanation, try a small, bounded task:

> Find one clear bug. Explain the evidence and a minimal fix, change only the necessary files, and run the relevant tests. Tell me clearly if you cannot verify the result.

Review proposed file changes and commands before approving them.

## Beta status and current limits

OASIS is in **Beta**. The core runtime and several major product surfaces are implemented, but implementation does not mean every workflow is production-certified. The current boundaries are:

| Area | Current status |
|---|---|
| **Release distribution** | Source package version 0.4.0 is prepared but not tagged or published. No public GitHub Release assets are available. |
| **Desktop** | Installers are unsigned; automatic updates and publisher signing/provenance are not configured. Clean-machine install, first-run, update, and uninstall testing remain release gates. |
| **OS isolation** | Optional Linux/macOS sandboxing is off by default and is not full filesystem-read isolation. Native Windows OS sandboxing is not implemented. |
| **Android** | There is no native Android APK. The CLI can be tried in Termux, but native PTY support and background execution are not guaranteed. |
| **Browser and CLI state** | Browser projects, tasks, and notes do not fully synchronize with CLI state. |
| **Agent recovery** | Run history can persist, but a process restart does not resurrect killed workers or pending approvals. Durable pause/resume and complete lease recovery remain open. |
| **Extensions** | OASIS supports specific skill and extension paths; it does not claim universal drop-in compatibility with every plugin manifest, executable hook lifecycle, or marketplace. |
| **Benchmark evidence** | The 33-task evaluator is a regression/smoke suite, not a representative repository-scale coding benchmark. No matched live-model head-to-head result or parity, speed, accuracy, or token-savings claim is published. |

The next milestone is a production-oriented release. It depends on passing release gates for same-commit CI, platform installers, clean-machine first-run, critical browser workflows, security boundaries, and documentation that matches the shipped build. Follow the [project plan and release checklist](docs/PROJECT_PLAN.md) for current progress.

## Documentation

The README is the product overview. The guides below are the detailed reference—open only the subject you need.

| Guide | What it covers |
|---|---|
| [Project plan and release status](docs/PROJECT_PLAN.md) | Implemented areas, known boundaries, priorities, and release acceptance gates. |
| [Architecture](docs/ARCHITECTURE.md) | Runtime components, data flow, and trust boundaries. |
| [User guide](docs/USER_GUIDE.md) | Commands, configuration, tools, integrations, and workflows. |
| [Installation](docs/INSTALL.md) | CLI setup, desktop availability, updates, and troubleshooting. |
| [Termux guide](docs/TERMUX.md) | Android CLI setup and platform limitations. |
| [Security policy](SECURITY.md) | How to report a security vulnerability. |
| [Security and reliability audit](docs/SECURITY_RELIABILITY_AUDIT.md) | Source-review findings, fixes, remaining risks, and verification limits. |
| [Privacy notes](docs/PRIVACY.md) | Provider data flows, local storage, API keys, and integrations. |
| [Benchmarks](docs/BENCHMARKS.md) | Evaluation fixtures and reproducible comparison methodology. |
| [Workflows and skills](docs/WORKFLOWS_AND_SKILLS.md) | Automation, slash commands, and reusable instructions. |
| [Keyboard shortcuts](docs/KEYS.md) | Terminal shortcuts and keybinding behavior. |
| [Brand guide](docs/BRAND.md) | OASIS identity and interface palette. |
| [Repository maintenance](docs/REPOSITORY_MAINTENANCE.md) | Canonical file ownership and repository upkeep. |
| [Research notes](docs/research/README.md) | Historical comparisons and design research, clearly separated from shipped capabilities. |
| [Contributing](CONTRIBUTING.md) | Development setup and contribution practices. |

## Development

Requirements: **Node.js 22 or newer**.

```bash
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm run check
```

The check pipeline validates the site and public metadata, evaluation controls, the Node test suite, and evaluation fixtures and negative controls. GitHub Actions adds version-matrix, browser, installer, and desktop-package checks. Always inspect results for the exact commit being reviewed; a green run from an older commit is historical evidence, not proof for a newer one.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [project plan](docs/PROJECT_PLAN.md) before changing behavior. Keep changes focused, add tests for fixes, document what you ran, and state clearly what you could not verify.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
