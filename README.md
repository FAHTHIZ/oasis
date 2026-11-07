<p align="center">
  <img src="assets/oasis-icon.svg" alt="OASIS portal mark" width="88">
</p>

<h1 align="center">OASIS</h1>

<p align="center">
  <strong>An open-source, model-agnostic coding-agent runtime.</strong><br>
  Bring your own model. OASIS provides the tools, permissions, coordination and verification around it.
</p>

<p align="center">
  <img src="assets/oasis-readme-hero.svg" alt="The layered OASIS portal grounded on a dark, reflective floor." width="100%">
</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img alt="Quality checks" src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/desktop-build.yml"><img alt="Desktop installer builds" src="https://img.shields.io/github/actions/workflow/status/FAHTHIZ/oasis/desktop-build.yml?branch=main&style=flat-square"></a>
  <img alt="Node.js 22.15 or newer" src="https://img.shields.io/badge/Node.js-22.15%2B-339933?style=flat-square&logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/github/license/FAHTHIZ/oasis?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://fahthiz.github.io/oasis/">Website</a> ·
  <a href="https://github.com/FAHTHIZ/oasis/releases">Releases</a> ·
  <a href="#install-the-cli">CLI quick start</a> ·
  <a href="https://github.com/FAHTHIZ/oasis/releases">Desktop downloads</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="BRAND.md">Brand guidelines</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

---

OASIS is an open-source coding-agent runtime and development workspace. It connects a model provider to a project and supplies the runtime around it: workspace tools, command execution, permissions, agent coordination, recovery and verification.

OASIS is the harness and application layer, not a model provider. The model still determines much of the reasoning and code quality; OASIS does not guarantee that every model will solve every task.

## See a real model run

<p align="center">
  <a href="assets/demo/oasis-real-model-demo.mp4"><img src="assets/demo/oasis-real-model-demo.gif" alt="Unscripted OASIS run with gpt-oss-20b: the agent reads a file, fixes a bug, adds a test, runs the test after approval, and is sent back by the verification gate to review its changes." width="100%"></a>
  <br><sub>Unscripted <code>gpt-oss-20b</code> run recorded on 5 November 2026. Rate-limit waits from the free endpoint were shortened; the model's mistakes and the verification gate's send-back are preserved. The original run took 6m 19s, used 7 tool calls and reported 50.9k tokens. <a href="assets/demo/oasis-real-model-demo.cast">Raw terminal recording</a>.</sub>
</p>

## Download and install

### Desktop application

OASIS includes an Electron desktop target, and GitHub Actions builds platform installers. **Public GitHub Release assets are not currently published**: the `v1.1.0` tag exists, but it has no associated GitHub Release as checked on November 7, 2026. The [Releases page](https://github.com/FAHTHIZ/oasis/releases) is the source of truth for future downloads. A source tag or temporary CI artifact is not the same as a published installer.

To run the desktop application from a source checkout:

```sh
npm install
npm run desktop:dev
```

To build a distributable for the current machine, use `npm run desktop:dist`. Platform-specific packaging prerequisites may apply.

When a future GitHub Release is published, its installer assets will include `SHA256SUMS`. Verify any downloaded package against that file before installing it.

### Install the CLI

**Requirements:** Node.js 22.15 or newer and Git.

Install from the source checkout:

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
```

Then open a project and start OASIS:

```sh
cd /path/to/your/project
oasis connect
oasis
```

Useful diagnostics and maintenance commands:

```sh
oasis doctor
oasis update
```

OASIS does not bundle a model or a hosted inference account. You choose the provider, credentials and model, and are responsible for reviewing the provider's data-handling terms.

### Phone and tablet

There is no native Android APK or iOS App Store package. The available options are:

- **Connected workspace:** run `oasis web --host 0.0.0.0` on a computer containing the project, then connect from a phone on the same trusted private network. Keep the computer and OASIS running; do not expose the workspace directly to the public internet.
- **Advanced Android use:** run the CLI from Termux with Node.js 22.15 or newer and Git. This is a manual, power-user setup—not a one-click Android installer. See [Mobile and tablet setup](MOBILE.md).

The [OASIS website](https://fahthiz.github.io/oasis/) is the public product overview. The GitHub repository remains the canonical source, and the [Releases page](https://github.com/FAHTHIZ/oasis/releases) is the source of truth for whether desktop installer assets have actually been published.

## Interfaces

OASIS has several interfaces over a shared runtime. They do not all have the same execution environment or permissions.

| Interface | Entry point | Purpose and boundary |
|---|---|---|
| **CLI and headless runner** | `oasis`, `oasis exec` | Runs against a project on the machine hosting the process. Supports interactive and non-interactive workflows. |
| **Connected browser workspace** | `oasis web --open` | Browser UI connected to a local OASIS runtime. Project access and command execution remain on the host computer. |
| **Normal browser session** | `oasis web --open` | Opens the regular workspace UI connected to the local OASIS runtime; project files and commands remain on the host. |
| **Desktop application** | `npm run desktop:dev` | Electron host for the local runtime and workspace; public GitHub installers are not yet published. |
| **Editor integration** | `oasis ide install` | VS Code-family extension with editor context, diagnostics and diff review. |
| **Agent Client Protocol** | `oasis acp` | Connects OASIS to compatible ACP clients. |
| **Node.js SDK** | `src/sdk.mjs` | Embeds OASIS sessions, tools and agent workflows in Node.js applications. |
| **GitHub Action and messaging gateways** | `action.yml` and `src/gateway-*.mjs` | Runs configured repository tasks and messaging integrations. |

For the differences between these interfaces, see [Interfaces and deployment](docs/INTERFACES.md).

## Runtime capabilities

- **Model runtime:** provider adapters, streaming, model configuration, retry and fallback handling, context management and usage tracking.
- **Workspace operations:** file reading, search, editing, patching, command execution, process management and Git operations.
- **Permissions and safety:** approval modes, command-risk analysis, protected paths, secret scanning and optional OS/container sandbox integrations.
- **Task-aware routing:** optionally send clearly simple, read-only requests to a lower-cost model while keeping complex or tool-requiring work on the stronger configured model; see the [routing configuration](docs/CONFIGURATION.md#task-aware-model-routing).
- **Agent coordination:** subagents, specialist reviews, shared tasks, background sessions, MCP servers, hooks, plugins and Agent Skills.
- **Verification and recovery:** diagnostics, language-server integration, test execution, diff review, session history, checkpoints and worktree-based isolation.
- **Additional workflows:** web retrieval, browser-related tools, PDF and image handling, voice features and automation integrations.

Capabilities depend on the interface, operating system, provider and configuration. The optional sandbox is not enabled in every setup and is not a universal security boundary.

## Security model

OASIS can read and modify project files, execute commands and send context to configured providers or external services. Treat it as software with access to the permissions of the process running it.

- Approval prompts are not a replacement for operating-system isolation. Commands may run with the permissions of the OASIS process.
- Do not assume a sandbox is active unless OASIS reports that it is available and enabled. Backend availability and isolation strength vary by platform.
- MCP servers, hooks, plugins and imported extensions may execute third-party code. Review their source and permissions before enabling them.
- Hosted providers and external services may receive prompts, project context or tool output.
- Keep important work under version control, maintain backups and review diffs before accepting changes.

Read the [security policy](SECURITY.md) before using OASIS with sensitive projects. The implementation boundaries are described in [Architecture](docs/ARCHITECTURE.md).

## Development and validation

Requirements: Node.js 22.15 or newer and Git.

```sh
npm install
npm test
npm run check
```

Deterministic harness checks:

```sh
npm run bench:harness
npm run bench:tokens
```

- `npm test` runs the Node.js test suite.
- `npm run check` runs site and public-surface checks, the test suite, benchmark-regression checks and evaluation-fixture validation.
- CI adds platform-specific security regressions, a live Docker sandbox test, native PTY coverage and browser end-to-end checks.

A passing test suite is evidence for the cases it exercises. It is not proof that the software is defect-free, security-certified, qualified on every platform or equivalent to another coding agent. See [Benchmark methodology](docs/BENCHMARKS.md) before interpreting benchmark results.

## Documentation

- [Documentation index](docs/README.md)
- [Whole-system replacement roadmap](docs/REPLACEMENT-ROADMAP.md)
- [Architecture alternatives](docs/ARCHITECTURE-ALTERNATIVES.md)
- [Agent runtime alternatives](docs/AGENT-RUNTIME-ALTERNATIVES.md)
- [Project-quality benchmark](docs/PROJECT-QUALITY-BENCHMARK.md)
- [Brand guidelines](BRAND.md)
- [Architecture and runtime boundaries](docs/ARCHITECTURE.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Interfaces and deployment](docs/INTERFACES.md)
- [Benchmark methodology](docs/BENCHMARKS.md)
- [Mobile and tablet setup](MOBILE.md)
- [Contributing guide](CONTRIBUTING.md)
- [Support and troubleshooting](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Project links

- [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases)
- [Issue tracker](https://github.com/FAHTHIZ/oasis/issues)
- [GitHub Discussions](https://github.com/FAHTHIZ/oasis/discussions)
- [Source code](https://github.com/FAHTHIZ/oasis)

## License

OASIS is distributed under the [Apache License 2.0](LICENSE).
