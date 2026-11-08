**Downloads:** [Windows (.exe)](https://github.com/FAHTHIZ/oasis/releases/latest) · [macOS (.dmg)](https://github.com/FAHTHIZ/oasis/releases/latest) · [Linux (.AppImage / .deb)](https://github.com/FAHTHIZ/oasis/releases/latest) · [All releases](https://github.com/FAHTHIZ/oasis/releases)

<sub>Choose the asset matching your operating system and CPU architecture. Release assets are published only after the same-commit quality, installer and packaging gates pass.</sub>

<p align="center">
  <img src="assets/oasis-icon.svg" alt="OASIS app icon" width="88">
</p>
<h1 align="center">OASIS</h1>
<p align="center">
  <strong>An open-source, model-agnostic coding-agent runtime.</strong><br>
  Bring your own model. OASIS provides the tools, permissions, coordination and verification around it.
</p>
<p align="center"><img src="assets/oasis-readme-hero.svg" alt="The layered OASIS portal grounded on a dark, reflective floor." width="100%"></p>
<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img alt="Quality checks" src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/desktop-build.yml"><img alt="Desktop installer builds" src="https://img.shields.io/github/actions/workflow/status/FAHTHIZ/oasis/desktop-build.yml?branch=main&style=flat-square"></a>
  <img alt="Node.js 22.15 or newer" src="https://img.shields.io/badge/Node.js-22.15%2B-339933?style=flat-square&logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/github/license/FAHTHIZ/oasis?style=flat-square"></a>
</p>
<p align="center">
  <a href="#download-and-install-oasis">Downloads</a> · <a href="#terminal-session">Terminal</a> · <a href="#browser-workspace">Browser workspace</a> · <a href="#desktop-application">Desktop app</a> · <a href="docs/USER-GUIDE.md">User guide</a> · <a href="docs/README.md">Documentation</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="SECURITY.md">Security</a>
</p>

---

OASIS is an open-source coding-agent runtime and development workspace. It connects a model provider to a project and supplies the execution layer around it: workspace tools, command execution, permissions, agent coordination, recovery and verification.

OASIS is the harness and application layer, not a model provider. The model still determines much of the reasoning and code quality; OASIS does not guarantee that every model will solve every task.

## Quick start

```sh
git clone https://github.com/FAHTHIZ/oasis.git && cd oasis
npm install && npm install --global .      # or download an installer below
cd /path/to/your/project
oasis connect                              # choose a provider and model
oasis                                      # interactive terminal session
```

One-shot and scripted runs use the headless runner:

```sh
oasis exec "fix the failing test in src/parser and explain the root cause"
oasis exec --output-format stream-json "summarize the open TODOs" > run.jsonl
```

## Why OASIS

- **Any model.** OpenAI-compatible, Anthropic, Gemini, local servers and routers. Fallback models, task-aware routing, cost budgets and usage tracking come built in.
- **A full agent system.** Built-in `explore`, `plan`, `general-purpose`, `code-review` and `security-review` subagents, custom agents in Markdown, background agents, agent teams with a shared task board, and worktree isolation. See [Subagents](docs/SUBAGENTS.md).
- **Claude Code compatible.** Existing `CLAUDE.md`, `.claude/agents`, `.claude/skills`, `.claude/commands`, `.claude/settings.json`, `.mcp.json`, hooks and plugins work without conversion.
- **Safety you can inspect.** Approval modes, AST-based shell risk analysis, protected paths, secret scanning, SSRF-guarded network tools and optional OS or container sandboxes.
- **Verification first.** Language servers, test runs, diff review, checkpoints with rewind, and a verification gate that sends the agent back when it skips checks.

## See a real model run

<p align="center">
  <a href="assets/demo/oasis-real-model-demo.mp4"><img src="assets/demo/oasis-real-model-demo.gif" alt="Unscripted OASIS run with gpt-oss-20b: the agent reads a file, fixes a bug, adds a test, runs the test after approval, and is sent back by the verification gate to review its changes." width="100%"></a>
  <br><sub>Unscripted gpt-oss-20b run recorded on 5 November 2026. Rate-limit waits from the free endpoint were shortened; the model's mistakes and the verification gate's send-back are preserved. The original run took 6m 19s, used 7 tool calls and reported 50.9k tokens. <a href="assets/demo/oasis-real-model-demo.cast">Raw terminal recording</a>.</sub>
</p>

## Choose your OASIS experience

The terminal is a native CLI session; the browser is a UI connected to a runtime on your machine; the desktop app packages that local experience in an Electron window.

| Interface | Start it with | Where the agent and project run |
|---|---|---|
| **Terminal session** | oasis | In your terminal, on the computer running OASIS. |
| **Browser workspace** | `oasis web --open` | In the local OASIS runtime on the host computer; the browser is the interface. |
| **Desktop application** | Open the installed OASIS app | In the desktop host process, against the folder you choose. |
| **Editor integration** | oasis ide install | Through the editor host and connected OASIS runtime. |
| **Agent Client Protocol** | oasis acp | In the OASIS ACP process started by the compatible client. |
| **Node.js SDK** | src/sdk.mjs | Inside the Node.js application embedding OASIS. |
| **GitHub Action and messaging gateways** | action.yml / configured gateway | On the configured automation runner or gateway host. |

## Download and install OASIS

**GitHub Releases is the download source of truth.** Each platform link at the top opens the latest release page. Download only an asset listed under that release, and verify it against the attached SHA256SUMS file.

| Platform | Primary installer | Additional builds |
|---|---|---|
| Windows | .exe installer (x64) | ARM64 when its optional CI build succeeds |
| macOS / MacBook | .dmg disk image (Apple Silicon) | Intel x64 when its optional CI build succeeds |
| Linux | .AppImage and .deb (x64) | ARM64 when its optional CI build succeeds |

The release pipeline validates the source, builds the platform packages, generates SHA-256 checksums and publishes installers only after the required same-commit gates pass. A tag or short-lived Actions artifact is not a public release.

For Homebrew:

```sh
brew tap fahthiz/oasis https://github.com/FAHTHIZ/oasis
brew install --cask fahthiz/oasis/oasis
brew install fahthiz/oasis/oasis-cli
```

See [Downloads and releases](docs/RELEASES.md) for asset names, checksum verification, architecture notes and mobile availability.

## Terminal session

The terminal interface is a separate, first-class OASIS experience. It runs directly in your shell; it is not the browser UI embedded in a terminal panel. The CLI and headless runner are distinct modes: the interactive `oasis` command is for a human-driven terminal session; `oasis exec` is for scripts and automation.

Requirements: Node.js 22.15 or newer and Git.

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
```

Open a project and start the interactive terminal session:

```sh
cd /path/to/your/project
oasis connect
oasis
```

For non-interactive scripts and automation, use oasis exec. For diagnostics and maintenance:

```sh
oasis doctor
oasis update
```

Run oasis --help for the complete command list. See the [Terminal section of the user guide](docs/USER-GUIDE.md#terminal-session).

## Browser workspace

OASIS includes a browser-based workspace served by the local runtime. It is not a hosted website or remote SaaS service: by default, the browser connects to the OASIS process running on the computer that owns the project.

```sh
cd /path/to/your/project
oasis web --open
```

The browser provides the workspace UI while file access, tool execution and model requests remain in the host runtime. To connect a phone or another device, follow [Mobile and tablet setup](MOBILE.md) and use only a trusted private network. Do not expose the workspace directly to the public internet.

There is no native Android APK or iOS App Store package. Advanced Android users can run the CLI manually in Termux; this is not a one-click mobile installer.

## Desktop application

The Electron desktop app starts the local OASIS runtime, lets you choose a project folder and opens the same workspace experience in a native window.

1. Open [the latest GitHub Release](https://github.com/FAHTHIZ/oasis/releases/latest).
2. Download the installer for your operating system and architecture.
3. Verify its checksum using the release's SHA256SUMS.
4. Install and launch OASIS, then choose the project folder.

For developers building from source:

```sh
npm install
npm run desktop:dev
```

Build a distributable for the current machine with npm run desktop:dist. Platform packaging prerequisites may apply. The current macOS packages are not code-signed; macOS may ask you to confirm the first launch in Privacy & Security.

## Agent system

| Capability | What OASIS provides |
|---|---|
| Subagents | `task` tool with parallel calls (up to 6), per-agent tools, model, effort and turn limits |
| Custom agents | Markdown + front matter in `.oasis/agents` or `.claude/agents`: `tools`, `disallowedTools`, `maxTurns`, `skills`, `memory`, `isolation`, `background` |
| Structured results | `output_schema` validation with one automatic correction turn |
| Background work | Up to 8 background agents, `agent_status`, `send_message` to steer or resume, `agent_stop`, stall monitor |
| Teams | Shared task board with leases, direct teammate messages, optional tmux panes |
| Isolation | Per-agent git worktrees, committed on their own branch when the agent finishes |
| Lifecycle hooks | `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse` and the rest of the Claude Code hook set |

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

Read the [security policy](SECURITY.md) before using OASIS with sensitive projects. Implementation boundaries are described in [Architecture](docs/ARCHITECTURE.md).

## Development and validation

Requirements: Node.js 22.15 or newer and Git.

```sh
npm install
npm test
npm run check
npm run lint
```

Deterministic harness checks:

```sh
npm run bench:harness
npm run bench:tokens
```

- npm test runs the Node.js test suite.
- npm run check runs browser-app integrity checks, evaluation-fixture validation, the test suite, benchmark-regression checks and evaluation validation.
- CI adds platform-specific security regressions, a live Docker sandbox test, native PTY coverage and browser end-to-end checks.

A passing test suite is evidence for the cases it exercises. It is not proof that the software is defect-free, security-certified, qualified on every platform or equivalent to another coding agent. See [Benchmark methodology](docs/BENCHMARKS.md) before interpreting benchmark results.

## Documentation

- [Start here: User guide](docs/USER-GUIDE.md)
- [Downloads and releases](docs/RELEASES.md)
- [Documentation index](docs/README.md)
- [First-run guide](docs/FIRST-RUN.md)
- [Architecture and runtime boundaries](docs/ARCHITECTURE.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Subagents and agent teams](docs/SUBAGENTS.md)
- [Interfaces and deployment](docs/INTERFACES.md)
- [Benchmark methodology](docs/BENCHMARKS.md)
- [Engineering scorecard](docs/ENGINEERING-SCORECARD.md)
- [Whole-system replacement roadmap](docs/REPLACEMENT-ROADMAP.md)
- [Architecture alternatives](docs/ARCHITECTURE-ALTERNATIVES.md)
- [Agent runtime alternatives](docs/AGENT-RUNTIME-ALTERNATIVES.md)
- [Project-quality benchmark](docs/PROJECT-QUALITY-BENCHMARK.md)
- [Brand guidelines](BRAND.md)
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
