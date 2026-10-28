# Oasis OSS

<p align="center">
  <img src="assets/oasis-icon.svg" alt="Oasis logo" width="88" />
</p>

<p align="center"><strong>An open-source coding agent and local-first developer workspace.</strong></p>
<p align="center">CLI · Browser workspace · Multi-provider tools · MCP · Skills · Subagents</p>

<p align="center">
  <a href="https://github.com/gtxnrg-ship-it/oasis/actions/workflows/quality.yml"><img src="https://github.com/gtxnrg-ship-it/oasis/actions/workflows/quality.yml/badge.svg?branch=main" alt="Quality checks" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" alt="Node.js 22 or newer" /></a>
</p>

Oasis turns plain-English software requests into multi-step workflows. It can inspect a project, make focused file changes, run approved commands and tests, and report what changed. Work directly in the terminal or start the local browser agent with `oasis web`.

## Get started

**Requirements:** Node.js 22 or newer and Git.

```bash
npm install -g git+https://github.com/gtxnrg-ship-it/oasis.git#main
oasis
```

On first launch, follow the guided setup to choose a model provider. Oasis does not include a model or API subscription; your selected provider must support tool calling.

## Try it

From the project you want Oasis to work on:

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
| **Coding agent** | Multi-step model/tool loops, workspace file operations, command approvals, file snapshots, checkpoints, rewind, and resumable sessions. |
| **Model choice** | OpenAI Responses, Anthropic Messages, compatible endpoints, and supported cloud or local providers such as OpenRouter, Gemini, Ollama, Bedrock, Vertex, and compatible gateways. |
| **Extensions** | MCP integrations, reviewed capability bundles, portable Agent Skills, hooks, layered memory, custom commands, and bounded subagents. |
| **Browser workspace** | A local projects/tasks/notes dashboard plus authenticated agent chat, visible tool activity, and approval prompts. |
| **Automation and SDK** | Headless/JSON workflows for scripts and CI, a Node.js SDK, and optional delegation to an existing OpenHands server. |

## Safety and current limits

Oasis uses workspace-bound file tools, secret-file exclusions, snapshots, and approval gates to reduce risk. Commands normally run with your operating-system permissions; the optional OS sandbox is disabled by default and currently targets Linux and macOS. These safeguards are not a guarantee that untrusted code is safe—review operations and use an isolated workspace for unfamiliar projects.

Some boundaries are intentional and documented: full native compatibility with third-party coding-agent plugin systems and a general remote plugin marketplace are not implemented; Windows sandbox/container isolation is not available; the browser command runner is not a full interactive terminal; and the browser dashboard’s projects/tasks/notes do not sync with the CLI workspace. The browser’s GitHub connection currently uses the host’s GitHub CLI login.

## Documentation

[**Detailed user guide**](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md) · [GitHub Action](docs/github-action.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

## Development

```bash
git clone https://github.com/gtxnrg-ship-it/oasis.git
cd oasis
npm run check
```

The check runs the site validator, test suite, and evaluation-fixture validation. It is useful feedback, not a full security audit or a substitute for testing on each target platform and with real providers.

## License

MIT — see [LICENSE](LICENSE).
