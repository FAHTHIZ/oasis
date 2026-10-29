<p align="center">
  <img src="assets/oasis-readme-banner.svg" alt="OASIS — Code. Automate. Flourish. A panoramic lime-green portal and reflective digital workspace for an open-source, local-first AI coding agent." width="100%" />
</p>

<p align="center"><a href="https://fahthiz.github.io/oasis/">Homepage ↗</a> · <a href="docs/INSTALL.md">Install</a> · <a href="docs/USER_GUIDE.md">User guide</a> · <a href="docs/ARCHITECTURE.md">Architecture</a> · <a href="docs/ROADMAP.md">Roadmap</a> · <a href="docs/SECURITY_RELIABILITY_AUDIT.md">Security &amp; reliability</a></p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main" alt="Quality checks" /></a>
  <a href="https://fahthiz.github.io/oasis/"><img src="https://img.shields.io/badge/homepage-OASIS-9BFF55?style=flat" alt="OASIS public homepage" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" alt="Node.js 22 or newer" /></a>
</p>

OASIS is an open-source AI coding agent and local-first developer workspace for multi-step software development. It inspects codebases, plans and applies focused edits, runs approved shell commands and tests, and summarizes what changed. Use the CLI in your terminal or launch the browser workspace with `oasis web`; extend it with supported model providers, Model Context Protocol (MCP) tools, reusable skills, hooks, and bounded subagents.

For the current implementation inventory and explicit limitations, see [Current status](docs/CURRENT_STATUS.md) and [Next milestone](docs/NEXT_MILESTONE.md).

## Get started

**Requirements:** Node.js 22 or newer. Git is not required by the archive-based install; see [the install guide](docs/INSTALL.md) for native PTY prerequisites and current platform caveats.

```bash
npm install --global https://github.com/FAHTHIZ/oasis/archive/refs/heads/main.tar.gz
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
| **Terminal** | A fast interactive editor with history search, Tab completion for commands and `@files`, Shift+Tab permission modes, `!` shell mode, image paste, streaming Markdown and diffs, type-ahead, Esc to interrupt, vim mode, Ctrl+G external editor, Ctrl+S prompt stash, and portable keybinding imports. Interactive agent commands can use persistent PTY sessions with streamed output, input, resize, Ctrl+C and stop controls when the native `node-pty` component is available. Press `?` for shortcuts. |
| **Workflows** | Dynamic JavaScript workflows: the agent writes a JavaScript orchestration script and the `workflow` tool fans it out to many subagents with `agent`/`pipeline`/`parallel`/`phase`, schema-checked results, background runs, resume from saved results, `/workflows`, saved workflows as `/name` commands, the built-in `/deep-research`, and `ultracode` prompts. `/goal` keeps working until a condition is met, `/batch` runs parallel worktree subagents, `/simplify`, `/verify`, `/btw` side questions, `/subtask` forked background agents, `oasis --bg` / `/background` detached sessions (plus `oasis attach|logs|stop|respawn` and `--bg --exec` shell jobs), `--safe-mode` and `--restricted` starts, `oasis purge` local-data cleanup, `/advisor` second-model consults, `oasis import` from Codex/Gemini CLI/Cursor, `/insights` usage reports, a PowerShell tool, a Chrome browser tool (`--chrome`), `/schedule` in-session cron, and the bundled [Ponytail](https://github.com/DietrichGebert/ponytail) lean mode (`/ponytail`). |
| **Coding agent** | Multi-step model/tool loops, workspace file operations, command approvals, file snapshots, checkpoints, rewind, sessions saved by default, and USD cost tracking with budget limits. |
| **Model choice** | OpenAI Responses, Anthropic Messages, compatible endpoints, and supported cloud or local providers such as OpenRouter, Gemini, Ollama, Bedrock, Vertex, Microsoft Foundry, and compatible gateways. |
| **Extensions and agents** | MCP integrations, reviewed capability bundles, portable Agent Skills, hooks, layered memory, custom commands, bounded subagents, and a session-local shared task board with dependencies, expiring claims/renewal, peer messaging, named teams, and bounded `dispatch_ready_tasks` waves in isolated worktrees. Dispatch is model-directed (not an autonomous scheduler), background workers still obey inherited permissions, and branches are not merged automatically. |
| **Browser workspace** | A local projects/tasks/notes dashboard plus authenticated agent chat, persisted task history, approval prompts, and opt-in isolated Git-worktree runs with bounded diff review. Changes stay on a review branch; OASIS does not auto-merge them. |
| **Automation and SDK** | Headless/JSON workflows for scripts and CI, a Node.js SDK, and optional delegation to an existing OpenHands server. |

## Safety and current limits

OASIS uses workspace-bound file tools, secret-file exclusions, snapshots, and approval gates to reduce risk. Commands normally run with your operating-system permissions; the optional OS sandbox is disabled by default and currently targets Linux and macOS. These safeguards are not a guarantee that untrusted code is safe—review operations and use an isolated workspace for unfamiliar projects.

VS Code, Cursor and Windsurf integrate via `oasis ide install` (in-editor chat panel, selection context, diff review, diagnostics). A `monitor` tool watches logs, CI or WebSockets in the background and wakes the agent on each event, and `--channels` lets MCP channel servers (Telegram, Discord, webhooks) push messages into a live session. A plugin and marketplace adapter reads compatible manifests and supports commands, agents, skills, hooks, MCP/LSP servers, monitors, output styles, helper executables, options and themes. Supported plugins can contribute commands, agents, skills, hooks, MCP/LSP servers, monitors, output styles, `bin/` tools, default agents, `userConfig` options and themes; marketplace sources include relative paths, GitHub, git URLs, git subdirectories and npm packages. **Compatibility is feature-by-feature, not a guarantee that every third-party or enterprise plugin behaves unchanged.** Some boundaries are intentional and documented: Windows sandbox/container isolation is not available; the browser now has a PTY-backed xterm.js terminal but cross-platform process cleanup still needs verification; and the browser dashboard’s projects/tasks/notes do not sync with the CLI workspace. The browser’s GitHub connection currently uses the host’s GitHub CLI login.

## Documentation

[**Next milestone**](docs/NEXT_MILESTONE.md) · [**Security/reliability audit**](docs/SECURITY_RELIABILITY_AUDIT.md) · [**Detailed user guide**](docs/USER_GUIDE.md) · [Install guide](docs/INSTALL.md) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md) · [Product readiness](docs/PRODUCT_READINESS.md) · [Capability gates](docs/CAPABILITY_GATES.md) · [GitHub Action](docs/github-action.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

## Web research engine

OASIS includes configurable web search plus a local Claude Code research plugin. It can use Tavily, Brave, Exa, Firecrawl, and a self-hosted SearXNG endpoint; with multiple providers configured it can search in parallel and fuse rankings. The keyless DuckDuckGo fallback remains available when upstream access permits. See [Search and deep-research architecture](docs/SEARCH_RESEARCH.md) for provider setup, plugin installation, limits, and a reproducible baseline-vs-candidate search benchmark.

## Development

```bash
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm run check
```

The latest verified code run, [Quality Checks run 40818083171](https://github.com/FAHTHIZ/oasis/actions/runs/40818083171) on commit `5a53756`, passed **594 Node tests with zero failures**, validated **22 evaluation fixtures**, and passed Node.js 22/24/26, native PTY and authenticated browser E2E. Homepage/repository validation [run 40818083169](https://github.com/FAHTHIZ/oasis/actions/runs/40818083169) passed on the same code commit. The snapshot includes persistent browser task history, restart recovery, isolated browser worktrees and bounded diff review, plus current search/query-planning code. `oasis eval --compare` compares saved reports on shared task IDs, including pass rate, time and cost. `node src/cli.mjs eval --claude-code --trials 3 --yes` runs the same fixtures with the restricted Claude Code CLI adapter; see [Benchmark protocol](docs/BENCHMARKS.md). The 22 fixtures remain a smoke suite—not a representative repository-level coding benchmark, and no live Claude Code comparison is published yet. Recent hardening covers process-tree cancellation, URL/SSRF checks, OAuth DNS pinning, API-key helper isolation, and plugin archive/ZIP validation. Installers remain unsigned, and these checks are not a full security audit. See [Current status](docs/CURRENT_STATUS.md), [Product readiness](docs/PRODUCT_READINESS.md), [Capability gates](docs/CAPABILITY_GATES.md), and [the security/reliability audit](docs/SECURITY_RELIABILITY_AUDIT.md).

## License

MIT — see [LICENSE](LICENSE).
