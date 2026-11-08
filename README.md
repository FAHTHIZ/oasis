<p align="center">
  <img src="assets/oasis-icon.svg" alt="OASIS app icon" width="84">
</p>
<h1 align="center">OASIS</h1>
<p align="center">
  <strong>The open-source coding agent for any model.</strong><br>
  Work in your terminal or a web app. Bring your own model, your Claude Code plugins and your MCP servers.<br>
  OASIS supplies the tools, subagents, permissions and a check that the work was actually verified.
</p>
<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img alt="Quality checks" src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/FAHTHIZ/oasis/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/FAHTHIZ/oasis?style=flat-square&color=3FE07A"></a>
  <img alt="Node.js 22.15 or newer" src="https://img.shields.io/badge/Node.js-22.15%2B-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-1f2937?style=flat-square">
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/github/license/FAHTHIZ/oasis?style=flat-square"></a>
</p>
<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#two-ways-to-work">Terminal and web</a> ·
  <a href="#plugins-mcp-and-models">Plugins and models</a> ·
  <a href="#tested-like-a-real-user">Real-user tests</a> ·
  <a href="#benchmarks">Benchmarks</a> ·
  <a href="#how-it-compares">Comparison</a> ·
  <a href="docs/README.md">Docs</a>
</p>

<p align="center">
  <img src="assets/screenshots/web-task-dark.png" alt="The OASIS web app in dark mode after a real gpt-oss-20b run: a list of completed steps (read slug.mjs, edited it, wrote a test, reviewed the diff, ran the tests), the agent's summary, and the Files panel showing the changed files." width="100%">
  <br><sub>The OASIS web app after an unscripted run with a free 20B model. Recorded 8 November 2026.</sub>
</p>

## Why OASIS

- **Any model, no lock-in.** OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Bedrock, Vertex AI, Foundry, any OpenAI-compatible endpoint, gateways such as [OmniRoute](https://github.com/cheaper-inference/omniroute), or a local server (Ollama, LM Studio, llama.cpp, vLLM). Backup models and failover are built in.
- **Your Claude Code setup works as is.** `CLAUDE.md`, `.claude/agents`, skills, slash commands, hooks, settings, `.mcp.json` and Claude Code plugins from any marketplace load without conversion.
- **It checks its own work.** After the agent edits code, a verification step sends it back if it claims success without reviewing its diff or running the checks. Every edit is checkpointed, so Undo always works.
- **A real agent system.** Parallel, background and resumable subagents, agent teams with a shared task board, and a separate git worktree per agent when you want isolation.
- **Safety you can read.** Clear permission modes, shell-command risk analysis, protected paths, secret scanning, guarded network tools and optional OS or container sandboxes.

## Install

**Desktop app** (includes the web app and everything it needs):

| Windows | macOS | Linux |
| --- | --- | --- |
| [x64 `.exe`](https://github.com/FAHTHIZ/oasis/releases/latest) · [ARM64 `.exe`](https://github.com/FAHTHIZ/oasis/releases/latest) | [Apple Silicon `.dmg`](https://github.com/FAHTHIZ/oasis/releases/latest) · [Intel `.dmg`](https://github.com/FAHTHIZ/oasis/releases/latest) | [`.AppImage`](https://github.com/FAHTHIZ/oasis/releases/latest) · [`.deb`](https://github.com/FAHTHIZ/oasis/releases/latest) (x64 and ARM64) |

The macOS app is not code-signed yet: confirm the first launch under System Settings → Privacy & Security.

**Command line** (needs Node.js 22.15+ and Git):

| Method | Command |
| --- | --- |
| macOS, Linux | `curl -fsSL https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.sh \| sh` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/FAHTHIZ/oasis/main/scripts/install.ps1 \| iex` |
| Homebrew | `brew tap fahthiz/oasis https://github.com/FAHTHIZ/oasis && brew install fahthiz/oasis/oasis-cli` |
| From source | `git clone https://github.com/FAHTHIZ/oasis.git && cd oasis && npm install && npm install --global .` |

The install scripts take the latest stable release, ask before changing anything, and finish with `oasis doctor`. Each release ships a `SHA256SUMS` file. See [Downloads and releases](docs/RELEASES.md).

## Quick start

```sh
cd your-project
oasis connect        # paste an API key, a model link or a local server address
oasis                # work in the terminal
oasis web --open     # or open the web app on this folder
```

Then ask in plain words: "find out why the login test fails and fix it". OASIS reads the code, edits the files, runs the checks and shows you the diff. `/rewind` (or <kbd>Esc</kbd> <kbd>Esc</kbd>) undoes a turn.

For scripts and CI:

```sh
oasis -p "summarize the open TODOs"                                  # one-shot
oasis exec --output-format stream-json "fix the lint errors" > run.jsonl
oasis -p --permission-mode dont-ask "review this diff"               # never waits on an approval
```

## Two ways to work

OASIS has two interfaces, both on the same runtime, sessions and settings. Start a task in the terminal and continue it in the browser under **Chats → Earlier on this computer**.

<table>
  <tr>
    <th width="50%">Terminal — <code>oasis</code></th>
    <th width="50%">Web app — <code>oasis web --open</code></th>
  </tr>
  <tr>
    <td><a href="assets/demo/oasis-real-model-demo.mp4"><img src="assets/demo/oasis-real-model-demo.gif" alt="Unscripted OASIS terminal run with gpt-oss-20b: the agent reads a file, fixes a bug, adds a test, runs it after approval and is sent back to review its changes."></a></td>
    <td><img src="assets/screenshots/web-approval-dark.png" alt="The OASIS web app asking for approval before a step in a real run."></td>
  </tr>
  <tr>
    <td>Streaming diffs with word highlights, inline images, <code>/tasks</code>, <code>/rewind</code>, <code>/export</code> to Markdown or HTML. <code>oasis -p</code> and <code>oasis exec</code> for scripts, with JSON output and <code>--output-schema</code>.</td>
    <td>Step-by-step activity, Files and Changes panels, a real terminal (<kbd>Ctrl</kbd>+<kbd>&#96;</kbd>), plan mode, Undo, cost and context meters, <code>/</code> and <code>@</code> autocomplete, voice input, and one-click Claude Code plugins.</td>
  </tr>
</table>

The web app runs on your own computer, not a hosted service. The desktop app is the same web app in a native window. To use it from a phone on your network, see [Mobile and tablet setup](MOBILE.md). There is no native Android or iOS app.

<table>
  <tr>
    <td width="50%"><img src="assets/screenshots/web-welcome-light.png" alt="The OASIS web app welcome screen in light mode, with suggested first tasks."></td>
    <td width="22%"><img src="assets/screenshots/web-phone-dark.png" alt="The OASIS web app at phone width in dark mode."></td>
    <td width="28%"><img src="assets/screenshots/real-model-pdf.png" alt="The OASIS web app reading an uploaded PDF and summarising it."></td>
  </tr>
  <tr>
    <td><sub>Light theme</sub></td>
    <td><sub>Phone width</sub></td>
    <td><sub>Reading an uploaded PDF</sub></td>
  </tr>
</table>

OASIS also plugs into other tools: VS Code, Cursor and Windsurf (`oasis ide install`), Zed and JetBrains through the Agent Client Protocol (`oasis acp`), a Node.js SDK, a GitHub Action, and Telegram, Slack or Discord gateways. See [Interfaces](docs/INTERFACES.md).

## Plugins, MCP and models

### Claude Code plugins

Open **Plugins** in the web app, add Anthropic's official marketplace (about 300 plugins) and install with one click. Or use the terminal:

```sh
oasis plugin marketplace add anthropics/claude-plugins-official
oasis plugin install superpowers@claude-plugins-official
oasis -p "/commit-commands:commit"
```

Plugin commands, agents, skills, hooks, MCP servers and language servers load the way they do in Claude Code. These popular plugins were installed and used in OASIS on 8 November 2026:

| Plugin | What it adds | Checked in OASIS |
| --- | --- | --- |
| superpowers | Planning, TDD and debugging skills, session-start hook | Skills listed and used; hook ran |
| frontend-design, feature-dev, code-review, pr-review-toolkit, code-simplifier | Agents, skills and commands | Loaded |
| security-guidance | Security hooks | Session-start hook ran (about 10 s) |
| hookify | Your own hooks from plain language | PreToolUse and PostToolUse ran |
| commit-commands | `/commit`, `/commit-push-pr` | Committed in a live run |
| context7, playwright, github, figma | MCP servers | Installed; playwright starts. context7 and figma ask you to sign in (`oasis mcp login context7`); github needs `GITHUB_PERSONAL_ACCESS_TOKEN` |
| typescript-lsp | TypeScript language server | Loaded |
| claude-md-management, ralph-loop | Commands and hooks | Loaded |

Plugins are not free. With 16 plugins on, each request used to carry 46 tools and 36.5k characters of tool schemas. OASIS now keeps large MCP servers behind `tool_search` until the model asks for them, which cuts that to 21 tools and 16.5k characters (about 5,000 fewer tokens per request). Plugin prompt text and skills still add up, so turn off the ones you don't use.

### Codex and Gemini CLI plugins

`oasis add` also takes Codex plugins (`.codex-plugin/plugin.json`), Agent Plugins and Gemini CLI extensions, and converts them to Claude Code plugins on install:

```sh
oasis add BuilderIO/skills
oasis add owner/marketplace#plugin-name
```

Checked on 9 November 2026: BuilderIO/skills, n8n-io/skills, DataDog/pup and NVIDIA/nvidia-kaggle installed with all 78 of their skills. Bundled MCP servers start from the plugin folder the way Codex starts them. Some Codex plugins still need their own setup first: nexu-io/codex-slides needs `pnpm install` inside the plugin, and Storybloq needs the `storybloq` program on your PATH.

### MCP servers

```sh
oasis mcp search filesystem                            # the official MCP Registry
oasis mcp add everything -- npx -y @modelcontextprotocol/server-everything
oasis mcp add --transport http docs https://example.com/mcp
oasis mcp serve                                        # expose OASIS tools to other MCP clients
```

Stdio, HTTP and SSE, with OAuth (`oasis mcp login`), elicitation and MCP Tasks. The web app manages servers under **Settings → Tools**. Project `.mcp.json` servers wait until you trust the workspace.

### Models and providers

`oasis connect` takes an API key, a model page link or a server address. It works out the provider, lists the models, tests the best ones with a real tool call and saves the first that works plus backups.

```sh
oasis connect                              # paste a key (kept out of shell history)
oasis connect --from-env gemini            # use GEMINI_API_KEY
oasis connect http://localhost:11434       # Ollama, LM Studio, llama.cpp or vLLM
oasis connect http://127.0.0.1:20128/v1    # an OmniRoute gateway
```

OpenAI Responses, Chat Completions and Anthropic Messages protocols; prompt caching; automatic compaction; spend limits (`--max-budget-usd`). See [Model providers](docs/CONFIGURATION.md#model-providers).

## Tested like a real user

These runs used the released app the way a person would: type a request, approve steps, read the answer. Real providers, no scripted model. Recorded 5–8 November 2026.

| What we asked | Where | Model | Result |
| --- | --- | --- | --- |
| "Build a small to-do web app in index.html" | Web app | gpt-oss-20b (free) | Working app in about 6 minutes |
| "math.mjs add() is wrong. Fix it and add a test, then run it." | `oasis -p` | gpt-oss-20b | Fixed, test written and passing, exit 0. About 10 minutes, mostly provider wait. |
| "slugify() only replaces the first space. Fix it, add a test, run the tests." | Web app, Ask first | gpt-oss-20b | Fixed with a global regex, test added, 1 passing. 409 s, 2 approvals. Screenshot above. |
| Fix a bug and run the tests after approval | Terminal | gpt-oss-20b | Passed |
| Read an uploaded PDF | Web app | gpt-oss-20b | Passed in 49 s |
| Install 16 Claude Code plugins and use them | Web app and terminal | gpt-oss-20b | All installed; hooks, skills and MCP servers ran |
| Call an MCP tool in auto mode | Terminal | gpt-oss-20b | Passed |
| Delegate to an `explore` subagent in a worktree | Terminal | gpt-oss-20b | Passed; worktree removed afterwards |
| Continue a terminal session in the browser | Web app | gpt-oss-20b | Passed |

Everything that went wrong in these runs became a fix with a regression test. Examples: a streamed reply glued onto the next one, the agent telling the user about its internal checks, a keyless endpoint that kept asking for a key, activity cards that all said "Completed a project step". See the [Changelog](CHANGELOG.md).

Known rough edges: free endpoints are slow (35–140 s per request), and with small models the verification step sometimes produces a second, longer summary after the first. `oasis -p` used to print nothing until it finished; it now shows one line per step.

## Benchmarks

`scripts/bench-live.mjs` runs OASIS and other agents on the same tasks, model and gateway, and checks each result with a hidden verifier. Latest live run, through OmniRoute with `nemotron-3-ultra-550b` (free tier, one trial):

| Task | OASIS | Claude Code 2.1.319 |
| --- | --- | --- |
| `clamp-integer` (small) | Pass · 44 s · 55k tokens | Pass · 121 s · 52k tokens |
| `safe-relative-path` (medium) | Fail · 28 s · 121k tokens | Fail · 59 s · 50k tokens |

Two tasks and one trial cannot rank agents, and OASIS does not guarantee that every model will solve every task: results depend heavily on the model. The free tier allowed about 50 requests a day. A larger run with a strong model is the next step. Raw results: [bench/results/live-2026-11-08-omniroute](bench/results/live-2026-11-08-omniroute/README.md). Method: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## How it compares

| | OASIS | Claude Code | Codex CLI | Gemini CLI | OpenCode | Hermes Agent |
| --- | --- | --- | --- | --- | --- | --- |
| Open source | Yes | No | Yes | Yes | Yes | Yes |
| Any model | Yes | Anthropic | OpenAI first | Google | Yes | Yes |
| Runs Claude Code plugins | Yes, plus Codex plugins and Gemini extensions | Yes | Own plugins | Own extensions | Own plugins | Own skills |
| Web interface | Local web app | Cloud | Cloud | No | Local web app and desktop | Messaging apps |
| Subagents | Parallel, background, resumable, teams | Yes | Yes | Yes | Yes | Yes |
| Checks its work before it says done | Built in | With hooks | Not built in | Not built in | Not built in | Not built in |

OASIS still trails in model-specific tuning, hosted cloud runs, community size and real-world hours. The full comparison, with sources, is in [docs/COMPARISON.md](docs/COMPARISON.md).

## How it works

```mermaid
flowchart LR
    U[You] --> I[Terminal · Web app]
    I --> S[Session and turn loop]
    S <--> M[Any model provider]
    S --> P{Permissions and safety checks}
    P --> T[Tools · MCP · Skills · Plugins]
    T --> W[Your project: files, git, processes]
    S --> A[Subagents and teams]
    A --> P
    S --> V[Verification: diff review, tests, LSP]
    V --> S
    S <--> D[(Sessions · memory · checkpoints)]
```

The model proposes replies and tool calls. OASIS decides which tools exist, which calls need approval, what goes back to the model and what counts as verified. See [Architecture](docs/ARCHITECTURE.md).

## Security

OASIS can read and change files, run commands and send context to your model provider, with your account's permissions.

- Permission modes go from `plan` (read-only) to `dont-ask` (never waits, denies anything not allowed). The default runs read-only commands freely and asks before other commands, installs, deletions and new websites.
- The OS sandbox (bubblewrap, macOS Seatbelt, Docker or Podman) is optional. `oasis doctor` tells you whether it's on.
- Project settings that loosen permissions, run hooks or start MCP servers apply only after you trust the workspace.
- Plugins, hooks and MCP servers can run third-party code. Review them before turning them on.
- Approval prompts are not a replacement for operating-system isolation. Use the sandbox, a container or a throwaway machine for untrusted code.

Read the [security policy](SECURITY.md) before using OASIS on sensitive code.

## Development

```sh
npm install
npm test           # about 2,300 tests
npm run check      # tests, benchmark regressions, eval validation
npm run lint
```

CI also runs platform security tests, a live Docker sandbox test, native PTY tests and a browser test that drives the web app (a task with an approval, plus color-contrast checks in dark, light and phone views). Contributions are welcome: start with the [Contributing guide](CONTRIBUTING.md).

## Documentation

| Get started | Go deeper | Project |
| --- | --- | --- |
| [User guide](docs/USER-GUIDE.md) | [Architecture](docs/ARCHITECTURE.md) | [Changelog](CHANGELOG.md) |
| [First run](docs/FIRST-RUN.md) | [Configuration](docs/CONFIGURATION.md) | [Contributing](CONTRIBUTING.md) |
| [Interfaces](docs/INTERFACES.md) | [Subagents](docs/SUBAGENTS.md) | [Security](SECURITY.md) |
| [Downloads](docs/RELEASES.md) | [Comparison](docs/COMPARISON.md) | [Support](SUPPORT.md) |
| [Mobile setup](MOBILE.md) | [Benchmarks](docs/BENCHMARKS.md) | [Brand guidelines](BRAND.md) |

## License

[Apache License 2.0](LICENSE).
