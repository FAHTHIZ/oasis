# OASIS

<p align="center">
  <img src="assets/oasis-readme-banner.svg" alt="OASIS — Code. Automate. Flourish. — open-source coding agent and local-first developer workspace" width="100%" />
</p>

<p align="center"><strong>Code. Automate. Flourish.</strong></p>
<p align="center">An open-source AI coding agent and local-first developer workspace.</p>
<p align="center">CLI · Browser workspace · Multi-provider tools · MCP · Skills · Subagents</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main" alt="Quality checks" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" alt="Node.js 22 or newer" /></a>
</p>

OASIS is an open-source AI coding agent and local-first developer workspace for multi-step software development. It can inspect a codebase, plan and apply focused changes, run approved shell commands and tests, and report what changed. Use the CLI coding assistant in your terminal or open the local browser workspace with `oasis web`. Connect supported model providers and extend the agent with Model Context Protocol (MCP) tools, reusable skills, hooks, and bounded subagents.

## Get started

**Requirements:** Node.js 22 or newer and Git.

```bash
npm install -g git+https://github.com/FAHTHIZ/oasis.git#main
oasis
```

On first launch, follow the guided setup to choose a model provider. OASIS does not include a model or API subscription; your selected provider must support tool calling.

## Try it

From the project you want OASIS to work on:

```bash
cd /path/to/your/project
oasis "Inspect this project and identify the next useful improvement"
```

For a more direct example:

```bash
oasis "Find the bug in the task filter, fix it, and run the relevant tests"
```

To use the browser interface, run `oasis web` in that project and open the local address printed in the terminal. Check your provider with `oasis doctor --test-provider`.

## What’s included

| Area | What it does |
| --- | --- |
| **Terminal** | A fast interactive editor with history search, Tab completion for commands and `@files`, Shift+Tab permission modes, `!` shell mode, image paste, streaming Markdown and diffs, type-ahead, and Esc to interrupt. Press `?` for shortcuts. |
| **Workflows** | `/goal` keeps working until a condition is met, `/batch` runs parallel worktree subagents, `/simplify`, `/verify`, `/btw` side questions, `/schedule` in-session cron, and the bundled [Ponytail](https://github.com/DietrichGebert/ponytail) lean mode (`/ponytail`). |
| **Coding agent** | Multi-step model/tool loops, workspace file operations, command approvals, file snapshots, checkpoints, rewind, sessions saved by default, and USD cost tracking with budget limits. |
| **Model choice** | OpenAI Responses, Anthropic Messages, compatible endpoints, and supported cloud or local providers such as OpenRouter, Gemini, Ollama, Bedrock, Vertex, and compatible gateways. |
| **Extensions** | MCP integrations, reviewed capability bundles, portable Agent Skills, hooks, layered memory, custom commands, and bounded subagents. |
| **Browser workspace** | A local projects/tasks/notes dashboard plus authenticated agent chat, visible tool activity, and approval prompts. |
| **Automation and SDK** | Headless/JSON workflows for scripts and CI, a Node.js SDK, and optional delegation to an existing OpenHands server. |

## Safety and current limits

OASIS uses workspace-bound file tools, secret-file exclusions, snapshots, and approval gates to reduce risk. Commands normally run with your operating-system permissions; the optional OS sandbox is disabled by default and currently targets Linux and macOS. These safeguards are not a guarantee that untrusted code is safe—review operations and use an isolated workspace for unfamiliar projects.

Some boundaries are intentional and documented: full native compatibility with third-party coding-agent plugin systems and a general remote plugin marketplace are not implemented; Windows sandbox/container isolation is not available; the browser command runner is not a full interactive terminal; and the browser dashboard’s projects/tasks/notes do not sync with the CLI workspace. The browser’s GitHub connection currently uses the host’s GitHub CLI login.

## Documentation

[**Detailed user guide**](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md) · [Compared with Claude Code](docs/CLAUDE_CODE_GAP.md) · [GitHub Action](docs/github-action.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

## Development

```bash
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm run check
```

The check runs the site validator, test suite, and evaluation-fixture validation. It is useful feedback, not a full security audit or a substitute for testing on each target platform and with real providers.

## License

MIT — see [LICENSE](LICENSE).
