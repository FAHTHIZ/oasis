<!-- OASIS product overview. Current lifecycle and release qualification: docs/PROJECT_PLAN.md -->

<p align="center">
  <img src="assets/oasis-readme-portal.svg" alt="OASIS — Code. Automate. Flourish." width="100%" />
</p>

<h1 align="center">OASIS</h1>
<p align="center"><strong>The open-source coding agent whose safety and reliability live in the runtime, not the prompt.</strong><br/>Any model, from a 4B model on your laptop to the frontier.</p>

<p align="center">
  <a href="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml"><img src="https://github.com/FAHTHIZ/oasis/actions/workflows/quality.yml/badge.svg?branch=main" alt="Quality checks" /></a>
  <a href="https://github.com/FAHTHIZ/oasis/releases/latest"><img src="https://img.shields.io/badge/version-1.0.0-8A7CFF.svg?style=flat" alt="Version 1.0.0" /></a>
  <img src="https://img.shields.io/badge/stage-stable-2EA44F.svg?style=flat" alt="Stable" />
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933.svg?style=flat&logo=node.js&logoColor=white" alt="Node.js 22 or newer" />
  <img src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555.svg?style=flat" alt="macOS, Linux and Windows" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license" /></a>
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="#terminal-or-browser">Web UI</a> ·
  <a href="#measured-not-claimed">Benchmarks</a> ·
  <a href="#a-one-minute-tour">Tour</a> ·
  <a href="docs/USER_GUIDE_MAP.md">User guide</a> ·
  <a href="https://github.com/FAHTHIZ/oasis/releases/latest">Downloads</a>
</p>

<p align="center">
  <a href="assets/demo/oasis-terminal-demo.mp4"><img src="assets/demo/oasis-terminal-demo.gif" alt="OASIS in a terminal: it finds a time-zone bug, fixes it with a one-line change, adds a regression test, runs the tests after approval, reviews its diff, then refuses a destructive git clean" width="100%" /></a>
  <br/><sub>Real OASIS 1.0 runtime, tools, approval prompt and safety policy; the model's replies are scripted so anyone can reproduce it with <a href="scripts/demo/">scripts/demo/</a>. <a href="assets/demo/oasis-terminal-demo.mp4">MP4</a> · <a href="assets/demo/oasis-terminal-demo.cast">asciicast</a></sub>
</p>

## Why OASIS

A coding agent is a model plus a harness. The model decides what to do; the harness decides what actually happens to your repository. Most of what people hate about coding agents is harness failure: tool calls that don't parse, edits that miss by one space, `rm -rf` in auto mode, "done" without running a test, a function replaced by `// ... rest unchanged`, a terminal that looks frozen for two minutes.

OASIS fixes each of those in the runtime, so the fix holds whichever model you connect.

<table>
<tr>
<td width="50%" valign="top">

**Any model, really.** Claude, GPT, Gemini, DeepSeek, OpenRouter, Bedrock, Vertex, Azure Foundry, or a local Ollama, LM Studio, llama.cpp or vLLM server. Small models get a compact prompt, a 13-tool profile and tool-call repair, so even a 4B local model drives the tools; whether its code is right is still up to the model. In our live runs on a 2-CPU cloud machine with no GPU, Qwen3-4B passed two of four hidden-test tasks (`parse-boolean-flag` and `dedupe-names`). `clamp-integer` failed in all three tries. `safe-task-id` passed once in two tries, but that code fails the stricter verifier added afterwards ([field runs](docs/BENCHMARKS.md#small-local-model-field-runs-2026-11-01)).

</td>
<td width="50%" valign="top">

**Safety you don't have to trust the model for.** Every shell line is parsed into commands and scored. Deleting your home folder, force pushes and publishing are refused even with approvals off, including when hidden inside `bash -c`, `eval`, `$(…)`, `ssh host '…'` or inline Python/Node code. `reset --hard` and `clean -fdx` always need a person, even in bypass mode, and the working tree is snapshotted first. Plan mode is enforced by the runtime, not requested in the prompt.

</td>
</tr>
<tr>
<td valign="top">

**"Done" means verified.** The agent can't finish until it has reviewed its own diff and run a relevant check. It is told when it claims a file it never wrote, weakens a test to make it pass, or repeats the same failing fix.

</td>
<td valign="top">

**Your workflow, kept.** Accepts Claude Code's CLI flags (`-p`, `--output-format stream-json`, `--allowedTools`, `--mcp-config`) and Codex and Gemini CLI ones (`exec`, `--full-auto`, `--sandbox`, `--yolo`, `--output-schema`) and Aider's (`--message`, `--test-cmd --auto-test`, `--auto-commits`), reads `AGENTS.md` and `CLAUDE.md`, loads Claude Code plugins, and imports MCP servers, instructions and commands from Codex, Gemini CLI and Cursor.

</td>
</tr>
</table>

## Terminal or browser

Same agent, same safety policy, two front ends. `oasis web` opens a local browser workspace: chat on the left, live activity grouped by step, approval cards that show the exact command or diff, and a Changes panel to review everything before you keep it. Type while it works and the agent reads your message at its next step (shown here: "Keep the CLI output format unchanged").

<p align="center">
  <a href="assets/demo/oasis-web-demo.mp4"><img src="assets/demo/oasis-web-demo.gif" alt="OASIS web workspace: the user asks for a bug fix, sends a steering message while the agent works, approves two edits and a test run, then reviews the diff in the Changes panel" width="100%" /></a>
  <br/><sub>Real OASIS web server, browser UI and tools; scripted model replies, reproducible with <a href="scripts/demo/record-web-demo.mjs">scripts/demo/record-web-demo.mjs</a>. <a href="assets/demo/oasis-web-demo.mp4">MP4</a></sub>
</p>

| | Terminal (`oasis`) | Browser (`oasis web`) | Editor |
| --- | --- | --- | --- |
| Steer while it works | Enter (Tab queues) | Enter (Alt+Enter queues) | VS Code chat panel |
| Review changes | `/diff`, inline diffs | Changes panel, per-file diffs | Native diff view, accept or reject |
| Approvals | Inline prompt | Approval card with the exact command or diff | Inline in the panel |
| Images | Ctrl+V pastes a screenshot, or `@screenshot.png` | Paste, drag and drop, or attach | Attach button or `@screenshot.png` in the chat panel |
| Low-power devices | Lite or no animation on 2-CPU, SSH, Linux console, CI, screen readers | Respects reduced-motion, works as an offline-capable PWA | Editor theme |

## Install

**Requirements:** Node.js 22 or newer and Git.

```bash
git clone https://github.com/FAHTHIZ/oasis.git && cd oasis && npm install && npm install -g .
oasis setup                 # pick a provider, or point it at a local model
cd ~/your-project && oasis
```

That installs the current `main`. Other ways in:

| Option | How |
| --- | --- |
| **Pinned stable CLI** | The [checksum-verified installer](docs/INSTALL.md#command-line-installation) resolves the latest stable `v*` tag to an immutable commit. No stable tag has been published yet (see [Status](#status-and-boundaries)), so it stops with an error until `v1.0.0` is released; use the source install above meanwhile. |
| **Desktop app** | Windows x64, macOS arm64 and Linux x86_64 installers are built by CI and attached to the [latest release](https://github.com/FAHTHIZ/oasis/releases/latest) with `SHA256SUMS` once one is published (none yet). Until then, build locally with `npm run desktop:dist`. They are not code-signed, so SmartScreen and Gatekeeper warn on first launch; [verify the checksum](docs/INSTALL.md) first. |
| **Local model, no API key** | `llama-server -m qwen3-4b-instruct-q4_k_m.gguf --jinja -c 16384 --port 8080`, then `OASIS_BASE_URL=http://127.0.0.1:8080/v1 OASIS_MODEL=qwen3-4b oasis`. OASIS reads the loaded context window and picks the right profile. Ollama and LM Studio work the same way. |
| **Coming from another agent** | `oasis import codex`, `oasis import gemini` or `oasis import cursor` (add `--dry-run` to preview). Existing `CLAUDE.md` / `AGENTS.md` files are picked up as they are. |
| **Android** | The CLI runs in Termux; see the [Termux guide](docs/TERMUX.md) for what is and isn't supported. |

## Measured, not claimed

The [model-free harness benchmark](docs/BENCHMARKS.md#model-free-harness-benchmark-2026-11-01) feeds the runtime outputs that real models actually produce and scores what happens. It needs no model or API key and runs in seconds: `npm run bench:harness`.

| What the model sends | No harness layer | OASIS, on held-out cases it was never tuned on |
| --- | --- | --- |
| Malformed or text-only tool calls (fences, comments, Python literals, Hermes/Qwen tags) | 1 of 20 run | **18 of 20 run**, 0 false runs |
| Edits whose `old_string` drifted (indentation, spacing, quotes, CRLF, BOM) | 2 of 12 apply | **11 of 12 apply**, 0 wrong writes |
| Destructive shell commands with approvals switched off | 0 of 31 stopped | **22 of 31 stopped** (23 with a scorer fix), every everyday command still runs |
| Placeholder rewrites, weakened tests, leaked secrets | 0 of 23 caught | **16 of 23 caught**, 0 false alarms |

Every miss above was then fixed and turned into a regression test, so the current runtime scores 100% on all three case sets except one deliberate secret-scanner miss. Those post-fix numbers measure tuning, not generalization, which is why the table shows the untuned ones.

The agent evaluator has **50 tasks**: 33 focused fixtures plus 17 repository-level bug reports and multi-file features, scored by hidden assertions the agent never sees (`oasis eval`). Head-to-head runs against Claude Code, Codex CLI and Gemini CLI on the same tasks are built into the [eval runner](docs/BENCHMARKS.md#run-claude-code-on-the-same-fixtures) (`--claude-code`, `--codex`, `--gemini-cli`) but have not been published yet, so OASIS does not claim to beat them. Live runs with small local models, including the failures, are in [Benchmarks](docs/BENCHMARKS.md).

## What it fixes

| Common frustration with coding agents | What OASIS does |
|---|---|
| "It said it was done, but never ran the tests." | A post-edit verification gate: the agent must review its diff and run a relevant check before it can finish, and any later edit resets that. |
| "Ten patches, and the same error every time." | Fix-thrash detection. On the 3rd identical failure after edits the agent is told to step back and diagnose; on the 5th, to change approach or ask you. |
| "It changed the test to match the broken code." | Weakened-test detection (skips, `.only`, deleted tests, removed assertions, an exact check swapped for `toBeDefined()`). |
| "It replaced my function with `// ... rest unchanged`." | A change guard blocks placeholder edits and flags large, unexplained deletions. |
| "It ran `rm -rf` while I wasn't watching." | Catastrophic commands (home or system folders, raw disk writes, publishing, force pushes) are refused. High-risk ones (`curl \| sh`, `terraform destroy`, `kubectl delete`, `DROP TABLE`) always ask, even in bypass mode. |
| "It ran a destructive git command." | `push --force` is refused. `reset --hard` and `clean -x` always need a person, even in bypass mode (the direct command tool refuses `reset --hard` and `clean -f` outright). Other work-discarding commands need your approval, and the working tree is saved under `refs/oasis/safety/` first. |
| "It edited files in plan mode." | Plan mode is enforced in the runtime: only read-only tools run. |
| "It committed my API key." | Commit secret scanning, including a raw `git commit` typed through the shell. |
| "It looks frozen. Is it doing anything?" | A live status line shows what it is waiting for, elapsed time, context sent and `esc to stop`. Local models get 15 minutes to read a long prompt instead of timing out. |
| "I can't tell what that command did." | Every tool call gets a one-line outcome: `✓ exit 0 · 20 passed, 0 failed`, `10 matches in 4 files`, `2 files changed, +6 -1`. Blocks and failures show in red. |
| "The connection dropped and it ran my tool twice." | Dropped streams restart the reply. Tools run only after a reply completes, so a restart can never run a tool twice. |
| "Tool definitions eat my context." | Rarely used tool schemas and MCP tools load only when needed. `/context` shows where the window goes and `/cost` what it cost. |
| "I have to wait for it to finish before I can correct it." | Type while it works and press Enter: the agent reads the message at its next step, adjusts and keeps going. Nothing you send is dropped. |
| "My local model times out on long prompts." | Requests to llama.cpp, Ollama, LM Studio or vLLM on your machine skip Node's hidden 300-second header timeout, and wait up to 15 minutes for the first token by default. The context window is read from Ollama, LM Studio and llama-server on their default ports, and a request that overflows the window is resized from the server's error instead of failing. |
| "I switched tabs and missed that it was waiting on me." | When a turn that ran 15 s or more finishes or needs approval, OASIS notifies you: a desktop notification in iTerm2, WezTerm, Ghostty, Windows Terminal and kitty, the bell elsewhere, and a tab badge plus optional notification in the browser. `OASIS_NOTIFY=off` turns it off. |
| "I want every change in Git history, like Aider." | `/auto-commit on` (or `OASIS_AUTO_COMMIT=1`) commits each turn's changed files as `oasis: <your request>`, and only those files; your own staged work stays out. |
| "It forgot my rules after compacting." | Compaction only summarizes the conversation. The system prompt, including `AGENTS.md` / `CLAUDE.md`, stays word for word. `/compact` shows a preview before changing anything, `/compact preserve rule: …` pins other text verbatim into every summary, and `/compact undo` brings the full history back. |
| "I want to undo what it just did." | `/undo` reverts the last turn's file and conversation changes; `Esc Esc` or `/rewind` jumps to any checkpoint. |
| "Animations stutter over SSH and on my old laptop." | Motion adapts: smooth on capable machines, a light pulse on low-power hardware, SSH and the Linux console, none in CI, for screen readers or with `OASIS_REDUCED_MOTION=1`. |

Each row describes implemented, tested runtime behavior.

## A one-minute tour

```bash
oasis                                   # interactive session in this folder
oasis "fix the failing date tests"      # start with a task, then keep talking
oasis plan "add rate limiting"          # read-only plan, nothing is changed
oasis -w feature-x                      # work in a new git worktree on its own branch
oasis -p "summarize this diff" --output-format json < changes.diff   # scripts and CI
oasis --bg "upgrade the test runner"    # background session: oasis bg list | logs | send | attach
oasis web                               # local browser workspace with a Changes panel
oasis doctor --test-provider            # check the setup, including live tool calling
```

| In a session | Does |
| --- | --- |
| `@file` · `!cmd` · `#note` | Mention a file · run a shell command yourself · save a memory |
| `Shift+Tab` | Cycle permission mode: default → accept edits → plan → auto |
| `Esc` · `Esc Esc` · `Ctrl+C` | Stop the current step · rewind · interrupt (twice at an empty prompt to quit) |
| `Enter` · `Tab` while it works | Steer: the agent reads your message at its next step and keeps going · queue it for after the turn |
| `Ctrl+K` · `Ctrl+R` · `Ctrl+G` | Command palette · search prompt history · write a long prompt in your editor |
| `/undo` · `/rewind` · `/diff` | Undo the last turn · pick a checkpoint · review changes |
| `/test` · `/verify` · `/review` | Run the tests and hand failures to the agent · run the app to confirm a change · review the diff |
| `/model` · `/context` · `/cost` | Switch model · see context use · see spend |
| `/init` · `/memory` · `/keys` | Create `OASIS.md` project instructions · manage memory · all shortcuts |

Full reference: [keyboard shortcuts](docs/KEYS.md) and the [user guide](docs/USER_GUIDE_MAP.md).

## Built for small and local models

OASIS assumes the model might be small, quantized, or running on your laptop:

- **Real context windows.** OASIS reads the window actually loaded in Ollama, LM Studio and llama.cpp, and the provider's `/models` listing for hosted and self-hosted models (DeepSeek, OpenRouter, vLLM). If the first request still overflows, it reads the size (and, for llama-server, the server itself) from the error, switches to the compact prompt and small tool set, and retries; that costs one rejected request, not a prompt read.
- **Small-context profile.** At 16K or less: a compact system prompt (about 1.3K tokens), 13 essential tools (about 3.7K tokens for the whole first request, versus about 15K by default, counted with the Qwen3 tokenizer in an empty repository), earlier compaction and trimmed tool results. Everything else stays reachable through `tool_search`.
- **Tool-call repair.** Almost-valid JSON (code fences, comments, unquoted keys, trailing commas, Python literals, missing braces) is repaired, and tool calls written as text (Hermes, Qwen, Llama and XML formats) are executed. Unrepairable calls get an error that explains how to resend them.
- **Forgiving edits.** Matching tolerates indentation, spacing and quote drift while preserving CRLF, BOMs and your formatting. Ambiguous matches are refused, never guessed.
- **Coaching.** When a model describes a change instead of making it, claims a file it never wrote, quits after one error or stops without checking its work, OASIS tells it so and, on small models, runs the review step itself.

See [local models and small context windows](docs/USER_GUIDE.md#local-models-and-small-context-windows) and [tool-call repair](docs/USER_GUIDE.md#tool-call-repair-for-smaller-models).

## It learns from experience—with your approval

OASIS separates durable memory from reusable procedural knowledge. After a non-trivial task is actually verified, the agent can propose a portable skill that captures the repeatable method, required capabilities, permission boundaries, and success criteria. The proposal stays local and inactive until you inspect it and explicitly promote it.

```text
/learning list
/learning show PROPOSAL_ID
/learning approve PROPOSAL_ID
/learning reject PROPOSAL_ID [reason]
```

Project proposals stay with one workspace; user-scope proposals are reserved for workflows that genuinely apply across projects. Promotion refuses to overwrite or shadow an existing skill. It does not fine-tune model weights, prove the agent's evidence, or grant permissions—OASIS's runtime checks remain authoritative. See [Learning from experience](docs/LEARNING.md) for storage, controls, and limitations.

## Everything in the box

| Area | Included |
|---|---|
| **Agent runtime** | Multi-step tool loop, planning, codebase map, edits, verification gate, completion reports, fallback model, budget limits. |
| **Workspace** | File search, read, write and edit; Git tools; snapshots, backups, diffs, checkpoints and rewind; isolated worktrees. |
| **Safety** | Permission modes and rules, shell-risk analysis, protected paths, secret shield, bounded output, process cleanup, optional OS sandbox on Linux and macOS. |
| **Verification** | Project checks, diagnostics and language servers, diff review, weakened-test and placeholder detection, auto-test, claim checks. |
| **Context** | Saved and resumable sessions, `OASIS.md` / `AGENTS.md` / `CLAUDE.md` instructions, memory, compaction with must-keep context, rule refresh. |
| **Learning** | Verified-work skill proposals, user/project scope, review-before-promotion, secret screening, and collision-safe portable skill creation. |
| **Teams of agents** | Bounded subagents, specialist reviewers, shared task boards, background sessions, tmux teammate panes, workflows. |
| **Integrations** | MCP (client over stdio, Streamable HTTP and SSE; server mode; OAuth), hooks, Agent Skills and skills.sh, plugins (including Claude Code plugins), web search, Chrome browser tool, GitHub Action, VS Code / Cursor / Windsurf bridge, and an [Agent Client Protocol](docs/USER_GUIDE.md#zed-jetbrains-neovim-and-other-acp-editors) server (`oasis acp`) for Zed, JetBrains, Neovim and Emacs. |
| **Surfaces** | Terminal CLI, headless mode with JSON and stream-JSON, local browser workspace (image paste, dictation, `!` shell commands, steering, live diffs), Electron desktop app, SDK. |
| **Accessibility** | Screen-reader mode (`--ax-screen-reader`), reduced motion, `NO_COLOR`, colorblind-friendly and light themes, `--calm` output. |

Capabilities are shared across surfaces but not identical on every OS, provider or editor; check the [support matrix](docs/PROJECT_PLAN.md#support-and-qualification-matrix) before relying on a platform-specific path.

## How it fits together

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

The model reasons and requests tools. OASIS owns the tool contracts, workspace checks, permission decisions, process execution, state and the evidence returned to you. See [Architecture](docs/ARCHITECTURE.md) and the [source map](src/README.md).

## Status and boundaries

> **Current lifecycle — OASIS 1.0, stable channel, not yet published.** `main` carries version `1.0.0` on the stable channel, and CI runs the 1.0 gates in the [project plan](docs/PROJECT_PLAN.md): Quality Checks (Node 22/24/26 on Windows, macOS and Linux, browser E2E with accessibility checks), installer checks, desktop packaging and public-site validation. The `v1.0.0` tag and GitHub Release have not been created yet (checked November 4, 2026: no releases and no `v*` tags), so the release links and the stable installer will not work until a maintainer runs the manual release job.

What 1.0 does not claim: the desktop installers are unsigned (SHA-256 checksums are provided), clean-machine install, update and uninstall are verified on CI runners rather than by hand on physical machines, and the 50-task evaluator runs on small projects, so it is a regression suite rather than a broad benchmark.

<details>
<summary><strong>Surfaces</strong></summary>

| Surface | Position |
|---|---|
| **CLI** | Primary workflow; Node.js 22+. |
| **Browser workspace** | Local, authenticated, backed by the shared runtime; not a hosted service. Some browser-side project, task and note state is separate from CLI state. |
| **Desktop** | Windows x64, macOS arm64 and Linux x86_64, built and packaged in CI from the release commit. Unsigned, with SHA-256 checksums. |
| **VS Code-family editors** | Supported integration; not every editor extension ecosystem is covered. |
| **ACP editors (Zed, JetBrains, Neovim, Emacs)** | `oasis acp` implements the core Agent Client Protocol; editor-side `fs/*` and terminal capabilities are not used yet. |
| **SDK and GitHub Action** | Programmatic and repository automation; unattended use still needs deliberate permissions and isolation. |
| **Android / Termux** | The CLI can be tried in Termux; Android is not a fully qualified platform and there is no native APK. |

</details>

<details>
<summary><strong>Security boundaries</strong></summary>

OASIS provides layered controls, not a guarantee that arbitrary model output, repository code, commands, packages, MCP servers, hooks, skills or plugins are safe.

- Approved commands run with the operating-system permissions of the user who launched OASIS.
- Optional Linux/macOS OS sandboxing is off by default and does not isolate filesystem reads. Native Windows OS sandboxing is not implemented. An optional container backend (`"backend": "docker"` or `"podman"`) runs commands in a throwaway container with only the workspace mounted, on any OS including Windows (Docker Desktop); it has unit coverage for the generated arguments but has not yet been exercised against a live engine in CI.
- Approval prompts and workspace checks are not operating-system isolation.
- Third-party integrations can run code with your permissions. Enable only sources you trust.
- The browser workspace keeps some local data in browser storage, unencrypted by OASIS.
- Keep the runtime on loopback unless TLS, authentication, trusted devices and the threat model have been reviewed.

Read [SECURITY.md](SECURITY.md), [Privacy](docs/PRIVACY.md) and the dated [security and reliability audit](docs/SECURITY_RELIABILITY_AUDIT.md).

</details>

## Documentation

| Need | Reference |
|---|---|
| Install, update, uninstall | [Installation](docs/INSTALL.md) · [Termux](docs/TERMUX.md) |
| Learn by task | [User-guide map](docs/USER_GUIDE_MAP.md) |
| Every command, setting, tool and integration | [Complete user guide](docs/USER_GUIDE.md) · [Keys](docs/KEYS.md) |
| Workflows, skills and plugins | [Workflows and skills](docs/WORKFLOWS_AND_SKILLS.md) |
| What has and hasn't been measured | [Benchmarks](docs/BENCHMARKS.md) · [Competitive analysis](docs/research/COMPETITIVE_ANALYSIS_2026-10-31.md) |
| Scope, support matrix, release gates | [Project plan](docs/PROJECT_PLAN.md) |
| How it works inside | [Architecture](docs/ARCHITECTURE.md) · [Source map](src/README.md) · [Test map](test/README.md) |
| Security and privacy | [Security policy](SECURITY.md) · [Privacy](docs/PRIVACY.md) |
| Maintaining the repository | [Maintenance guide](docs/REPOSITORY_MAINTENANCE.md) |
| Release history | [Changelog](CHANGELOG.md) · [1.0.0 release notes](docs/releases/v1.0.0.md) |

## Contributing

```bash
npm install
npm test               # unit and integration tests
npm run check          # everything CI runs: site checks, tests, harness benchmark, eval validation
```

Use `npm test` rather than bare `node --test`, which also picks up helper servers and archived fixtures. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [test map](test/README.md). Bug reports with a failing case are the most useful kind; harness misses become regression tests.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
