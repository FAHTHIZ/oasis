# Changelog

User-facing change history grouped by package version. A version heading does not imply that a GitHub Release or downloadable assets have been published; check the [Releases page](https://github.com/FAHTHIZ/oasis/releases) for current availability.

## Unreleased

### Agents and subagents
- Custom agents accept the full Claude Code front matter: `disallowedTools`, `maxTurns` (reports are marked `partial` at the limit), `permissionMode: plan`, `skills` (preloaded), `memory` (user, project or local `MEMORY.md`), `background` and `color`. Project, user, plugin and `--agents` definitions share one parser.
- Agent files also accept `hooks` (scoped to the agent; `Stop` runs as `SubagentStop`; project files need a trusted workspace) and `omitClaudeMd`, plus `mcpServers`: inline servers connect only for that agent's turns and close afterwards; and `autoCompactWindow`. With `--agent`, `initialPrompt` starts the session and `disallowedTools` applies to the main agent too.
- `task` accepts `output_schema`; the report is validated and the agent gets one correction turn, then the result carries `structured` or `schema_errors`.
- Background agents that go silent are stopped as `stalled` after 450 seconds (1200 seconds inside a running tool) and keep their last text as a partial report. Set `OASIS_SUBAGENT_STALL_SECONDS` or `subagentStallSeconds`; `0` disables it.
- Nested delegation, as in Claude Code: subagents can launch their own up to three layers deep. Set `subagentMaxDepth`, `OASIS_SUBAGENT_MAX_DEPTH` or `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (`1` disables it). Read-only agents never delegate, and `Agent` in a `tools` list maps to `task`.
- `neuron_network` loads on demand with the other background-agent tools, saving about 200 tokens per request.
- New [Subagents guide](docs/SUBAGENTS.md).

### Security and reliability
- New `dontAsk` permission mode and `permissions.denyInsteadOfPrompting` setting (Claude Code parity): calls that would wait on an approval prompt are denied with a readable reason and the turn continues, so CI and unattended runs never hang. See [Permission modes](docs/CONFIGURATION.md#permission-modes).
- The SSRF address policy is built on `ipaddr.js` with declarative CIDR tables.
- Plugin downloads, MCP OAuth discovery and public web fetches share one DNS-pinned, size-bounded HTTP client (`src/safe-http.mjs`) instead of three copies.
- The test suite is green on `main` again after the tool-registry and Pages removals.

### MCP
- Long-running MCP tools run as MCP Tasks through the official [`@modelcontextprotocol/ext-tasks`](https://github.com/modelcontextprotocol/ext-tasks) requester. When a server declares `tasks.requests.tools.call` and a tool sets `execution.taskSupport` to `required` or `optional`, OASIS creates a task, polls at the server's interval, reads the result and sends `tasks/cancel` when you interrupt. Task calls are not bound by the per-request timeout (2-hour ceiling).
- A task still running after 5 seconds moves to the background in the interactive terminal and in streaming headless sessions, as in Claude Code. The turn continues, and the result arrives as a notification that wakes an idle session. It passes through the prompt-injection guard. Interrupting the turn after the move does not cancel the task. Set `OASIS_MCP_TASK_BACKGROUND_MS` to change the grace period. `OASIS_MCP_TASK_BACKGROUND=0` (or `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND=1`) always waits. One-shot `-p` runs and the browser always wait.

### Terminal

- Terminal progress (OSC 9;4): Windows Terminal, ConEmu, Ghostty 1.2+ and iTerm2 3.6.6+ show a busy indicator in the tab while a turn runs, paused while approval is pending, and error after a failed turn. `OASIS_TERMINAL_PROGRESS=off` disables it.
- `/export FILE.html` writes the conversation as one standalone page you can open or share. Each tool step is collapsible and shows its input and result. A Content-Security-Policy blocks scripts and remote loads, and credentials are redacted. `/export FILE.md` still writes Markdown.
- Inline image previews: screenshots and images from tools, and `@image.png` mentions, are drawn in the terminal on Kitty, Ghostty, iTerm2, WezTerm, Warp and VS Code. They are off in tmux, screen, Zellij, CI and pipes. `OASIS_INLINE_IMAGES=0` turns them off; `=kitty` or `=iterm` forces a protocol.
- `oasis models [filter] [--json] [--refresh]` lists the models the configured provider serves, with context window, price and image support from the models.dev catalog. The current model is marked, and `availableModels` policy is respected.
- Fixed: `/agents` printed a literal `\n` instead of one agent per line.
- Edit previews highlight the changed words inside a changed line (theme tokens `diffAddedWord` / `diffRemovedWord`), as in Claude Code and Cursor. Unrelated replacements stay whole-line.

### Browser workspace

- The Files panel can be resized: drag its left edge or use the arrow keys on it, and double-click to reset. The width is remembered.
- The file viewer has a Download button, so single files can be saved from a local project too (Export zip only covers browser projects).
- Messages show a compact timestamp in their hover bar (the full date is in the tooltip). Saved chats keep the times.
- Command palette → **Download this chat** saves the conversation as the standalone HTML page from `/export FILE.html` (served by `GET /api/sessions/:id/export`, which requires the session token).
- After Undo, the reverted turn stays in the transcript, dimmed, with a note that files and conversation went back.
- The usage chip next to Send shows the estimated spend for the chat (subagents included) beside the context meter, with a `+` when some requests used a model with no known price.
- Copy buttons under every reply and on your own messages, plus Edit to put a sent message back in the composer. Copies keep the original Markdown.
- Fixed: the Copy button on code blocks did nothing.
- The composer shows how full the context window is as a ring and percentage (amber past 70%, red past 90%), with token counts on hover.
- Inline autocomplete in the composer: `/` suggests commands, custom commands and skills, and `@` suggests project files. Arrow keys move, Tab or Enter accepts, Escape closes. Connected to OASIS on a computer, `/` no longer opens the command palette (Ctrl+K still does).
- After a turn that changed files, the last reply offers Undo, which runs `/undo` to restore the files and rewind the conversation by one turn.
- While the tab is in the background, the page title shows a badge when a task finishes or needs approval. Optional desktop notifications are under Settings.
- Plan mode in the browser app's mode menu (when connected to OASIS on a computer), and Shift+Tab in the composer cycles modes as in the terminal.
- The header shows the current git branch. `/api/status` now reports `branch`.

### Maintenance
- Removed duplicated chat chunking (Telegram gateway) and generated-media file handling (images and speech).
- README: quick start, agent system overview and Claude Code compatibility summary.

## [1.1.1] - 2026-11-07

- Rebuilt the README around platform downloads and clearly separated terminal, browser-workspace and desktop entry points.
- Added a complete user guide and release guide covering Windows, macOS, Linux, Homebrew and checksum verification.
- Removed the public marketing website and Pages deployment; retained the host-connected browser application.
- Removed website-only build and QA steps from the main quality and release paths.
- Made desktop release gates depend on same-commit quality and installer checks rather than a marketing-site deployment.
- Renamed the browser application integrity checker so it is no longer confused with the retired marketing site.

- Retired the Pages-based marketing website and its site-specific CI/build pipeline while keeping the local browser workspace and PWA application intact.
- Fixed Server-Sent Events without an explicit event field to use the protocol default event name, message.
- Added an engineering scorecard, first-run guide and focused pull-request template.

- Corrected release documentation to distinguish Git tags, CI artifacts and published GitHub Release assets.
- Updated the repository inventory and architecture notes after the first provider-stream extraction.
- Added a reproducible, caveated comparison of repository presentation and engineering practices against a 100-project AI-agent reference set.
- Added an unscripted `gpt-oss-20b` CLI demonstration to the README, with GIF/MP4 playback and the raw terminal recording; it is a qualitative product example, not a scored benchmark.

- `glob_files` and `search_files` find files anywhere in large repositories; they previously stopped after the first 1,800–5,000 files. `search_files` now uses ripgrep.
- `grep` accepts ripgrep-style arguments (`-i`, `-A`, `-B`, `-C`, `head_limit`) and adds `type`, `before`, `after` and `offset`.
- One provider registry drives setup, `configure_provider`, fallback models and local-server discovery; user settings can add or re-point providers ([configuration reference](docs/CONFIGURATION.md)). `configure_provider` now accepts every known provider instead of five.
- Output token limits come from the models.dev catalog, so models such as the default `gpt-6.1-sol`, gpt-oss, GLM-5 and MiniMax-M2 get 32,000 tokens per response instead of 8,192.
- `read_file`, `edit_file`, `multi_edit` and `write_file` read and preserve UTF-16 files with a byte order mark instead of rejecting them as binary.
- `run_command` and `run_shell` leave out passing-test timing blocks, repeated test headers, npm update banners and progress redraws; failures keep every line and the raw output stays in `.oasis/command-logs/`. A passing 20-test `npm test` result shrinks from 1,140 to 508 tokens ([command output](docs/CONFIGURATION.md#command-output)).
- Command logs in `.oasis/command-logs/` no longer show up in `git status`, `git_diff` or `git add -A`; the directory now gets a `.gitignore`.
- `grep` shows matches that sit deep inside long lines (minified bundles, generated JSON) as a window around the match; before, it showed the first 400 columns, which often did not include the match.
- Reasoning replay follows the models.dev `interleaved` field, so GLM, MiMo and other interleaved-thinking models get their `reasoning_content` back between tool calls (previously only names containing deepseek, moonshot or kimi). A `replayReasoning` config value overrides it. The bundled catalog snapshot was refreshed.
- The token benchmark (`bench/tokens`) counts tokens with the same o200k BPE counter the runtime uses instead of characters / 4; the baseline was regenerated (taskflow-search ~162.7k, normalize-token-usage ~256.2k input tokens).

## [1.1.0]

- Added desktop update notifications and checksum verification before installing release assets.
- Improved first-run setup with hardware-aware model and provider recommendations.
- Added LAN links and QR-based access for phone and tablet workflows, plus installable browser-app support.
- Expanded optional desktop builds for macOS Intel, Linux ARM64 and Windows ARM64 when the corresponding CI jobs succeed.
- Improved usage and local-model cost reporting, context management and harness evaluation workflows.

## [1.0.0]

- First stable public release of the OASIS coding-agent runtime and desktop application.
