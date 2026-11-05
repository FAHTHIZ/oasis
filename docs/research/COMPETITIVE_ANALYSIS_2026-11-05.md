> **Dated supporting research, not a product specification or benchmark result.** This compares documented behavior, not measured task success. Use [BENCHMARKS.md](../BENCHMARKS.md) for measurements.

# Getting started, model choice and plugins: OASIS against eight coding agents — November 5, 2026

**Question.** How many steps does a new user need before an agent is working on their code, on any device, and what happens when the model runs out? We compared OASIS with Claude Code, OpenAI Codex, DeepSeek Harness, Codewhale (formerly DeepSeek-TUI), Qwen Code, Hermes Agent, OpenCode and Gemini CLI.

**OASIS snapshot.** The `main` branch on November 5, 2026, after the universal-app 1.3 work (smart connect, automatic model fallback, built-in plugins, lite mode; the live preview was added and then removed as unnecessary) and the unification work that followed: `oasis web` and the desktop app now serve the same app, the terminal connects from a single paste, and the app gained steering, images and chats. We read the source and ran the tests: `test/app-connect.test.mjs`, `test/app-e2e.test.mjs` (the app on its own, in Chromium against a mock provider), `test/app-runtime-e2e.test.mjs` (the app against a real `oasis web` server) and `test/cli-connect.test.mjs`.

**Method.** We read each competitor's public documentation, changelogs and issue trackers (all linked below). We did not run them side by side. Where a document might be out of date, we say so.

## Summary

| | First run to a working agent | Picks the model for you | Model runs out mid-task | Runs on a phone | Plugins |
|---|---|---|---|---|---|
| **OASIS** (app, desktop, terminal) | Paste a key, model link or server address: into the app's message box, or at the terminal's first run (`oasis connect`) | Yes: detects the provider from the key, ranks the models it can use, tool-tests them | Switches to the next model automatically; the chain is built from the same paste | Yes: the same app runs the agent on the phone, or drives your computer's agent over a private link | 9 built-in, suggested while you type, one tap |
| Claude Code | Sign in or set a key in the terminal | No (Anthropic models; aliases) | Retries; no switch to another provider | Remote: the Code tab in the Claude app drives cloud sessions or your computer | Plugin marketplaces |
| Codex | Sign in with ChatGPT or a key | No | No built-in failover between providers | Desktop app; CLI | Plugin directory (90+), skills, apps, MCP |
| DeepSeek Harness | `npx @deepseek-ai/dsh web`, then configure | No | Not documented | Web UI on your computer; Electron app | Everything is a plugin |
| Codewhale | `/provider`, then `/model` | Uses Ollama automatically when it is serving and nothing else is set up | Not documented | Terminal | Skills |
| Qwen Code | Edit settings or set environment variables | No | Not documented | Desktop, web shell, IDE, chat bots | Extensions (Gemini CLI format) |
| Hermes Agent | `hermes model` wizard | No | Configured fallback chain, one switch per session | Electron desktop; about 20 messaging apps | Skills hub, plugins |
| OpenCode | `/connect`, pick a provider, paste the key, then `/models` | No | Not documented | Terminal, desktop, IDE | Plugins |
| Gemini CLI | Sign in or key | No | Not documented | Terminal | Extensions gallery |

## Getting started

**OASIS.** The first screen of the app is one input: "Paste an API key or a model link". The message box accepts the same thing. What happens next:

1. The key's shape names the provider (`sk-or-` OpenRouter, `sk-ant-` Anthropic, `AIza` Gemini, `hf_` Hugging Face, `gsk_` Groq, `xai-`, `nvapi-`, `csk-`, `fw_`, `tgp_v1_`, `sk-proj-`). Shared `sk-` prefixes are tried in order (DeepSeek, Moonshot, OpenAI).
2. OASIS lists the models the key can use, drops embedding, speech, image and moderation models, and ranks the rest for agentic coding.
3. It sends a short tool-call test to the best model, then the next, until one passes. A key with no credit for the flagship ends up on the best model it can pay for.
4. The connection is saved on the device and the next-best models are kept as backups.

Links work too: an `ollama.com/library/…` page downloads that model into the local Ollama with progress; a Hugging Face model page runs through the Hugging Face router (or the local Ollama for GGUF); an `openrouter.ai/…` page picks that model. A local address (`localhost:11434`, LM Studio's `:1234`, llama.cpp's `:8080`, or any OpenAI-compatible URL) is probed for its API type. With nothing pasted, the app quietly checks the usual local ports and offers "Use Ollama (this device)". A key pasted into the message box is never sent to the model or shown in the chat, and "my key is sk-or-… now fix the tests" connects first, then runs the task.

**Others.** OpenCode's flow is the closest: `/connect`, choose the provider from a list, paste the key, then pick a model with `/models` ([OpenCode docs](https://opencode.ai/v2/docs/providers), [providers](https://dev.opencode.ai/docs/providers)). Hermes Agent uses an interactive `hermes model` wizard ([Hermes Agent](https://github.com/NousResearch/hermes-agent)). Codewhale uses `/provider` then `/model`, and falls back to Ollama on its own when Ollama is serving and nothing is configured ([Developers Digest](https://www.developersdigest.tech/tools/deepseek-tui)). Qwen Code's free Qwen OAuth tier ended on April 15, 2026; it is now set up through `settings.json` or `OPENAI_API_KEY`/`OPENAI_BASE_URL` ([Tom Rochette's notes](https://tomrochette.com/agents/harnesses/qwen-code/), [Northflank starter pack](https://github.com/northflank-examples/cloud-coding-agent-starter-pack/blob/main/agents/qwen-code.md)). Codex CLI custom providers are TOML entries and must speak the Responses API ([Codex provider guide](https://codex.danielvaughan.com/2026/04/23/codex-cli-custom-model-providers-configuration-guide/)). DeepSeek Harness starts from `npx @deepseek-ai/dsh web` ([DeepSeek Harness](https://www.deepseek.com/harness/en/)).

None of the eight documents recognising the provider from a pasted key, or tool-testing the models before choosing one.

## When a model runs out

**OASIS app.** Failures are sorted into credit, rate limit, rejected key, retired model, context too long, network and server errors. Credit errors try `:free` and local models first. A rejected key skips the rest of that provider. A model that failed is skipped for ten minutes. The agent resends the same conversation to the next model mid-task and says so in the chat ("coder-pro ran out of credit. Switched to coder-mini and carried on."). The model chip lists the chain and has an off switch. The end-to-end test checks this with a provider that starts answering 402.

**Others.** Hermes Agent has the most complete documented fallback: a `fallback_providers` chain in `config.yaml` (or `hermes fallback add`) that moves on 429, 5xx, 401 and 403 and keeps the conversation. Activation is one switch per session, and the chain is set up by hand ([Hermes fallback providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers), [agent loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop)). Codex CLI has no built-in failover between providers; the documented workarounds are an external gateway or a second profile ([Codex outage resilience guide](https://codex.danielvaughan.com/2026/07/27/codex-cli-api-outage-resilience-multi-provider-failover-gateway-routing-defensive-configuration/), [openai/codex#45839](https://github.com/openai/codex/issues/45839)). We found no documented automatic switch in the others.

**OASIS terminal and desktop.** Pasting a key at the first run, into `oasis connect`, or into the app opened from `oasis web` or the desktop app, saves the best model and the next three as `fallbackModel`, the same chain the app builds. The CLI also takes a hand-written chain that crosses providers (`--fallback-model gpt-6.1-mini,openrouter:qwen/qwen3-coder,ollama:qwen3:4b`), switches on credit, rate-limit, overload and model-not-found errors, returns to the main provider after a cooldown, rotates API keys within one provider (`OASIS_API_KEY_POOL`) and routes easy read-only requests to a cheaper model.

## Any device, including slow ones

**OASIS.** The app is a static installable web app. The agent loop, file tools, diffs, JavaScript test runner and GitHub push all run on the device, with no server or account, and it works offline once installed. The same files serve Android, iPhone, iPad, ChromeOS, Windows, macOS and Linux. Lite mode turns on for 2 GB of memory or less, two cores or less, Data Saver or reduced motion: no animation or blur, Markdown re-rendered at most every 220 ms while streaming, and a shorter transcript in the page. On every device, tool output is drawn only when opened and off-screen messages skip layout.

**Others.** Claude Code has no separate mobile app; the Code tab in the Claude app runs cloud sessions or controls your computer remotely ([Claude Code on mobile](https://code.claude.com/docs/en/mobile.md), [changelog](https://code.claude.com/docs/en/changelog)). Hermes Agent reaches phones through about 20 messaging platforms, with the agent running on a computer or server ([Hermes integrations](https://hermes-agent.nousresearch.com/docs/integrations), [releases](https://github.com/NousResearch/hermes-agent/releases)). Qwen Code ships desktop, web shell, IDE and chat-bot front ends ([Qwen Code](https://qwen.ai/qwencode)). DeepSeek Harness is web-UI first with an Electron desktop app and no terminal UI ([DeepSeek Harness](https://www.deepseek.com/harness/en/), [wal.sh survey](https://wal.sh/research/2026-q2-cli-coding-agents/)). Codex runs in its desktop app and CLI ([OpenAI](https://openai.com/index/codex-for-almost-everything/)).

What OASIS does not have: hosted cloud sessions that keep running when the device sleeps, and messaging-app front ends. On a phone, the app cannot run shell commands or Python; it says so and gives the commands to run elsewhere.

## One app or several

**OASIS.** One app serves every surface except the terminal. On a phone or the web it runs the agent itself; opened from `oasis web` or the desktop app it drives the full agent on that computer (real files, shell, git, MCP) with the same chat, approvals, Changes tab, plugins, steering, images and chats. The terminal is the same runtime with a text interface. Pairing a phone with your computer is one QR code (**File → Connect a phone…**). The earlier browser workspace is still at `/classic` while its last panels (terminal pane, run monitor, extensions manager) move into the app.

**Others.** Claude Code spreads across a terminal, IDE extensions, a desktop app, the web and the Code tab in the Claude mobile app, which runs cloud sessions or controls your computer ([Claude Code on mobile](https://code.claude.com/docs/en/mobile.md)). Codex has a CLI, IDE extensions, a desktop app and cloud tasks ([OpenAI](https://openai.com/index/codex-for-almost-everything/)). DeepSeek Harness is a web UI with an Electron wrapper ([DeepSeek Harness](https://www.deepseek.com/harness/en/)). These are capable products; the difference is that OASIS does not ask you to learn a second interface when you change device.

## What we removed

Polish here meant cutting as much as adding. Removed or folded in since the 1.3 work: the live preview pane (an extra panel most tasks did not need; the agent still runs the project's own checks), four plugins that duplicated default behaviour (13 to 9), the multi-step welcome screen, the APK build (the installable app covers Android), the per-turn verification breakdown and session ID line in the terminal (one plain line now), and the separate browser workspace as the default page of `oasis web`.

## Plugins

**OASIS app.** Nine built-in plugins bundle the repository's skills with starter tasks: Debugger, Test writer, Code reviewer, Security audit, Web app studio, API builder, Mobile apps, Docs writer and GitHub. Planning, small changes and explaining a project are default agent behaviour, not plugins. Turning one on for a project loads its skills into every request. As you type, matching plugins appear above the message box, and one tap applies a plugin to that message. The CLI also installs Claude Code-format plugins and has its own catalog (`plugins/catalog.json`).

**Others.** Codex has the largest directory, with 90+ plugins that bundle skills, apps and MCP servers ([OpenAI Help](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex)). Gemini CLI extensions bundle MCP servers, commands, skills and subagents, and install from a GitHub URL ([Gemini CLI extensions](https://geminicli.com/docs/extensions/), [gallery](https://geminicli.com/extensions/)). In DeepSeek Harness everything is a plugin ([DeepSeek Harness](https://www.deepseek.com/harness/en/)). Hermes Agent has a skills hub and plugins ([Hermes Agent](https://github.com/NousResearch/hermes-agent)).

OASIS's catalog is far smaller than Codex's. The difference is discovery: OASIS suggests the plugin from what you are typing, so you do not need to know it exists.

**Installing other ecosystems' add-ons.** Each tool installs only its own format: Claude Code takes Claude Code plugins and MCP servers ([Claude Code plugins](https://code.claude.com/docs/en/plugins)), Codex takes `.codex-plugin` plugins from marketplaces ([Codex plugins](https://developers.openai.com/codex/plugins/build)), Gemini CLI takes `gemini-extension.json` repositories and their release builds ([Gemini CLI releases](https://geminicli.com/docs/extensions/releasing/)), and the skills CLI copies Agent Skills into each agent's folder ([skills.sh](https://www.skills.sh/docs)). OASIS's `oasis add`, `/add` and "install this" take all of them: Claude Code plugins and marketplaces, Codex plugins and marketplaces, Gemini CLI extensions (converted, using the platform release build), Agent Plugins packages, Agent Skills, MCP servers (GitHub repos, the MCP Registry, npm, PyPI, remote URLs) and Markdown agents. They also take the install command exactly as a README prints it (`npx …`, `claude mcp add …`, `/plugin install …`, `gemini extensions install …`, `npx skills add …`). Tested on real repositories: anthropics/skills, anthropics/claude-code, obra/superpowers, wshobson/agents, microsoft/playwright-mcp, modelcontextprotocol/servers, gemini-cli-extensions/security (two MCP servers start with 9 and 3 tools), openai/plugins (62 plugins listed; build-web-apps and linear installed).

**People coming from another agent.** OASIS reads `AGENTS.md`, `CLAUDE.md`, Claude Code's MCP servers and plugins as they are. On first start it names what `/import` would bring over from Codex, Cursor, Gemini CLI, Hermes, OpenCode, Windsurf, Cline or Antigravity (MCP servers, instructions, commands, rules, skills, memories), and imports only after you confirm. Project memory now belongs to the repository, as in Claude Code ([memory](https://code.claude.com/docs/en/memory.md)): every subfolder and git worktree shares it.

## What to do next

1. **Retire `/classic`.** Move its terminal pane, run monitor and extensions manager into the app, then remove the old page.
2. **Run a same-model head-to-head on task success.** Run OASIS against Claude Code, Codex and OpenCode on the eval set with the same model. This is still the main missing evidence (see the [October 31 report](COMPETITIVE_ANALYSIS_2026-10-31.md)).
3. **Grow the plugin catalog** with MCP-backed plugins (databases, issue trackers) in the app, behind the same one-tap flow.
4. **Optional hosted runner** for long tasks on phones, keeping on-device as the default.
