<!-- OASIS product overview. Current lifecycle and release qualification: docs/PROJECT_PLAN.md -->

<p align="center">
  <img src="assets/oasis-readme-portal.svg" alt="OASIS — Code. Automate. Flourish." width="100%" />
</p>

<h1 align="center">OASIS</h1>
<p align="center"><strong>Code. Automate. Flourish.</strong></p>
<p align="center">An open-source, local-first agentic development workspace.</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main" alt="Quality checks" /></a>
  <img src="https://img.shields.io/badge/version-1.0.0--rc.1-8A7CFF.svg?style=flat" alt="Version 1.0.0 Release Candidate 1" />
  <img src="https://img.shields.io/badge/stage-release%20candidate-5B8DEF.svg?style=flat" alt="Release candidate" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license" /></a>
</p>

**OASIS connects the model you choose to the software you build.** It brings codebase understanding, planning, file changes, controlled command execution, agent coordination, integrations, and verification into one inspectable local runtime.

OASIS is not a model, hosted inference service, or vendor-locked IDE. You choose the model/provider—including a local endpoint—and OASIS supplies the agent runtime, workspace tools, policy controls, memory, automation, and developer surfaces.

> **Current lifecycle — Release Candidate.** The 1.0 feature scope is established. Current work is production qualification: reliability, lifecycle correctness, security-boundary validation, platform verification, accessibility, and documentation. The development package on `main` is `1.0.0-rc.1`; it is not a published stable release. The last published stable desktop/CLI release remains [`v0.4.0`](https://github.com/FAHTHIZ/oasis/releases/tag/v0.4.0) until the 1.0.0 release gates are satisfied.

<p align="center">
  <a href="#quick-start"><strong>Get started</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/USER_GUIDE_MAP.md">User guide</a>
  &nbsp;·&nbsp;
  <a href="docs/PROJECT_PLAN.md">Release qualification</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/FAHTHIZ/oasis/releases">Downloads</a>
</p>

---

<p align="center">
  <img src="assets/demo/oasis-demo.gif" alt="OASIS working through a coding task in the local browser workspace" width="100%" />
  <br/><sub>Reproducible browser-workspace demo. The model response is a scripted local fixture; the workspace, tools, approval flow, verification gate, and Changes panel are the actual OASIS runtime.</sub>
</p>

## Quick start

**Requirements:** Node.js 22 or newer and Git.

### Run the current release-candidate source

```bash
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install -g .

oasis setup
cd ~/your-project
oasis
```

This installs the current `main` source package (`1.0.0-rc.1`). It is the release-candidate development build, not the stable desktop download channel.

### Install the latest stable CLI release

Use the [checksum-verified installer](docs/INSTALL.md#command-line-installation). It resolves the latest stable semantic-version tag to an immutable commit and does not install the moving `main` branch. At this snapshot, that stable tag is `v0.4.0`.

### Download the desktop app

The [published v0.4.0 release](https://github.com/FAHTHIZ/oasis/releases/tag/v0.4.0) contains Windows x64, macOS arm64, and Linux x86_64 installers. These artifacts are unsigned. The 1.0.0 release-candidate source has not yet been published as a desktop installer.

After connecting a provider, start with a repository you understand and ask OASIS to explain the project before approving changes.

## What OASIS provides

| Capability area | What is included |
|---|---|
| **Agent runtime** | Multi-step model/tool orchestration, planning, codebase exploration, edits, tool-result handling, and task completion reporting. |
| **Workspace operations** | File search/read/write/edit/delete, Git inspection, scoped work, snapshots, diffs, and optional isolated worktrees. |
| **Execution policy** | Permission modes, command-risk checks, approval rules, protected paths, bounded output, process cleanup, and optional OS sandbox integration. |
| **Verification** | Project checks, diagnostics, language-server integration where configured, diff review, weakened-test detection, automatic test runs, and claim checks. |
| **Context and continuity** | Saved sessions, project instructions, memory, context estimates, compaction, checkpoints, rewind, and recovery records. |
| **Agent coordination** | Bounded subagents, specialist reviews, task boards, dependency-aware dispatch, monitoring, and workflow automation. |
| **Integrations** | MCP, hooks, Agent Skills, local plugins, extension import/export, search integrations, GitHub automation, and editor bridges. |
| **Developer surfaces** | Terminal CLI, authenticated local browser workspace, Electron desktop shell, VS Code-family integration, SDK, and GitHub Action. |
| **Local-first operation** | Local runtime and workspace; connect hosted or local models under the provider and endpoint policies you choose. |

Capabilities are shared across the product but are not identical on every operating system, provider, editor, or integration. Read the [support and qualification matrix](docs/PROJECT_PLAN.md#support-and-qualification-matrix) before relying on a platform-specific path.

## Product architecture

OASIS separates the user-facing surfaces from the shared runtime and the model provider:

```mermaid
flowchart TD
    User["Developer and project"] --> Surfaces["CLI · Browser · Desktop · Editor · SDK · GitHub Action"]
    Surfaces --> Runtime["Shared OASIS runtime"]
    Runtime <--> Model["Chosen hosted or local model"]
    Runtime --> Context["Instructions · Sessions · Memory · Checkpoints"]
    Runtime --> Policy["Permissions · Approvals · Risk checks"]
    Policy --> Tools["Files · Git · Commands · Browser · MCP · Workflows"]
    Tools --> Project["Project and development environment"]
    Project --> Verify["Tests · Diagnostics · Builds · Diff review"]
    Verify --> Runtime
```

The model reasons and requests tools. OASIS owns tool contracts, workspace checks, permission decisions, process execution, state handling, and the evidence returned to the model and user.

See [Architecture](docs/ARCHITECTURE.md) and the [runtime source map](src/README.md).

## Supported surfaces and boundaries

| Surface | Current position |
|---|---|
| **CLI** | Primary supported developer workflow; Node.js 22+. |
| **Local browser workspace** | Local authenticated interface backed by the shared runtime. It is not a hosted cloud service. Some browser-side project/task/note state remains separate from CLI state. |
| **Desktop** | Published v0.4.0 installers for Windows x64, macOS arm64, and Linux x86_64. Packages are unsigned; clean-machine install/update/uninstall qualification remains open. |
| **VS Code-family integration** | Supported integration path; compatibility is not universal across every editor extension ecosystem. |
| **SDK and GitHub Action** | Programmatic and repository-automation surfaces; unattended use still requires deliberate permissions and isolation. |
| **Android / Termux** | CLI can be tried in Termux, but Android is not a fully qualified platform. There is no native Android APK and native PTY/background behavior is not guaranteed. |

## Security and operating boundaries

OASIS provides layered controls, not a guarantee that arbitrary model output, repository code, commands, packages, MCP servers, hooks, skills, or plugins are safe.

- Approved commands execute with the operating-system permissions of the user who launched OASIS.
- Optional Linux/macOS sandboxing is disabled by default and does not provide full filesystem-read isolation. Native Windows OS sandboxing is not implemented.
- Approval prompts and workspace checks are not equivalent to operating-system isolation.
- Third-party integrations can execute code with the user's permissions. Enable only sources you trust.
- The browser workspace stores some local data in browser storage; that content is not encrypted by OASIS.
- The runtime should remain loopback-only unless TLS, authentication, trusted-device controls, and the deployment threat model have been deliberately reviewed.

Read [SECURITY.md](SECURITY.md), [Privacy](docs/PRIVACY.md), and the dated [security/reliability audit](docs/SECURITY_RELIABILITY_AUDIT.md).

## Release-candidate qualification

The product is in the 1.0 release-candidate phase—not a feature-preview phase. The central scope is established; remaining work is concentrated on proving and refining the complete product journey.

Open release gates include the browser turn-completion/activity-fold E2E regression, same-candidate full CI, clean-machine desktop journeys, unsigned-package policy, and security-boundary review. The 33-task evaluator is a regression/smoke suite, not a representative repository-scale benchmark. No broad model-parity, speed, accuracy, or token-savings claim is made.

The [release-qualification plan](docs/PROJECT_PLAN.md) is the authoritative status and evidence record. A release candidate must not be described as stable or production-ready until its acceptance gates have been demonstrated on the same immutable candidate.

## Documentation

| Need | Reference |
|---|---|
| Product scope, maturity, support matrix, and release gates | [Project and qualification plan](docs/PROJECT_PLAN.md) |
| System boundaries, execution flow, and data ownership | [Architecture](docs/ARCHITECTURE.md) |
| Installation, downloads, update, and uninstall | [Installation](docs/INSTALL.md) |
| Android / Termux | [Termux guide](docs/TERMUX.md) |
| Task-oriented usage navigation | [User-guide map](docs/USER_GUIDE_MAP.md) |
| Full commands, settings, tools, integrations, and workflows | [Complete user guide](docs/USER_GUIDE.md) |
| Security, privacy, and evaluation | [Security policy](SECURITY.md) · [Privacy](docs/PRIVACY.md) · [Benchmarks](docs/BENCHMARKS.md) |
| Workflows, skills, plugins, and shortcuts | [Workflows and skills](docs/WORKFLOWS_AND_SKILLS.md) · [Keys](docs/KEYS.md) |
| Runtime module map and extraction policy | [src/README.md](src/README.md) |
| Test domains and runner conventions | [test/README.md](test/README.md) |
| Repository ownership and maintenance | [Maintenance guide](docs/REPOSITORY_MAINTENANCE.md) |
| Release history | [Changelog](CHANGELOG.md) · [published v0.4.0 notes](docs/releases/v0.4.0.md) · [current 1.0.0-rc.1 candidate notes](docs/releases/v1.0.0-rc.1.md) |

## Development

```bash
npm install
npm test
npm run check
```

Use the explicit `npm test` command; bare `node --test` can discover helper servers and archived fixtures. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [test map](test/README.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE).
