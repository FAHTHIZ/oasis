# Changelog

User-facing change history grouped by package version. A version heading does not imply that a GitHub Release or downloadable assets have been published; check the [Releases page](https://github.com/FAHTHIZ/oasis/releases) for current availability.

## Unreleased

### Runtime

- `oasis mcp login NAME` and `/mcp login NAME` find HTTP servers that come from plugins. context7's plugin server now requires sign-in, and OASIS told users to run `oasis mcp login context7`, which then said there was no such server.

- Plugin MCP servers that need an option nobody set (the n8n plugin's `${user_config.n8n_url}`) are skipped with "needs n8n_url: run oasis plugin config … n8n_url=VALUE" instead of failing as "Invalid URL". An unset value only in `env` stays empty, as before.
- Local MCP servers that fail to start say why: a missing program ("not installed or not on your PATH"), a missing folder, missing Node.js or Python dependencies (with the folder to run `npm install` in), or a port in use. Stderr itself is still not shown, because it can contain tokens.

- Codex and Agent Plugins MCP servers now start where Codex starts them. A relative `cwd` (such as `"."`), a `./` command and `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` resolve against the installed plugin, and stdio servers without a `cwd` start in the plugin root. Before this, every MCP server started in the workspace, so bundled scripts such as nexu-io/codex-slides' `./scripts/start-mcp.mjs` were not found. MCP server configs keep their `cwd` through validation.
- When the verification step sends the agent back after it already showed a summary, it now adds one or two sentences on what the checks showed instead of a second full summary. Found in the normal-user web run.
- MCP tools now also go behind `tool_search` when their schemas are large (over 12,000 characters, about 3,000 tokens), not only when there are more than 25 of them. With 16 plugins on, the 25 plugin MCP tools (mostly browser automation) were sent on every request; now the model sees 21 tools and 16.5k characters of schemas instead of 46 tools and 36.5k, about 5,000 fewer input tokens per request. `OASIS_TOOL_SEARCH_CHARS` changes the limit; `OASIS_TOOL_SEARCH=off` keeps everything loaded.

### Terminal

- `oasis add --help`, `oasis add -h` and a bare `oasis add` print the usage line. Before, they were sent to the agent, which asked for a model provider.
- `oasis -p` is no longer silent while it works. In text mode it prints one dim line per step on stderr ("· Edited math.mjs", "· Ran the tests: npm test") when stderr is a terminal. The answer on stdout is unchanged, so pipes and scripts see the same output. `OASIS_PROGRESS=1` forces the lines on, `OASIS_PROGRESS=0` turns them off. Found in the normal-user test, where a 10-minute run printed nothing.
- Fixed: the activity label for `list_files` read "Used list files".
- `oasis setup --help` prints usage instead of starting the interactive wizard.
- Terminal progress (OSC 9;4): Windows Terminal, ConEmu, Ghostty 1.2+ and iTerm2 3.6.6+ show a busy indicator in the tab while a turn runs, paused while approval is pending, and error after a failed turn. `OASIS_TERMINAL_PROGRESS=off` disables it.
- `/export FILE.html` writes the conversation as one standalone page you can open or share. Each tool step is collapsible and shows its input and result. A Content-Security-Policy blocks scripts and remote loads, and credentials are redacted. `/export FILE.md` still writes Markdown.
- Inline image previews: screenshots and images from tools, and `@image.png` mentions, are drawn in the terminal on Kitty, Ghostty, iTerm2, WezTerm, Warp and VS Code. They are off in tmux, screen, Zellij, CI and pipes. `OASIS_INLINE_IMAGES=0` turns them off; `=kitty` or `=iterm` forces a protocol.
- `oasis models [filter] [--json] [--refresh]` lists the models the configured provider serves, with context window, price and image support from the models.dev catalog. The current model is marked, and `availableModels` policy is respected.
- Fixed: `/agents` printed a literal `\n` instead of one agent per line.
- Edit previews highlight the changed words inside a changed line (theme tokens `diffAddedWord` / `diffRemovedWord`), as in Claude Code and Cursor. Unrelated replacements stay whole-line.

### Browser workspace

- The web app says when a tool server did not start, and why ("A tool server did not start. n8n-mcp: needs n8n_url: run oasis plugin config …"). Before, plugin and MCP tools that failed to start were simply missing from the chat.
- Web sessions use the server's environment (`OASIS_CONFIG_DIR` and the rest) rather than the process environment, so a server started with its own config dir now loads that dir's MCP servers.
- The subagent list sits right under the step that started it, instead of after every later step in the turn.
- A step waiting on an approval now says "Waiting for you" instead of "Working". Found in the normal-user run, where `npm test` showed "Working" behind the Allow sheet. The browser e2e checks it.
- Fixed: a streamed reply that was followed by a tool call kept its blinking cursor for the rest of the chat, and steps that ended with nothing to show left empty gaps. Both seen in a real gpt-oss-20b run in the web app.
- Subagents show up in the web app. A turn that starts subagents gets a small list with each one's task, live status (working, done, failed, stopped) and its latest note. It is saved with the chat. This replaces the classic page's run monitor for the common case; background agents that outlive the turn are still only in the terminal's `/tasks`.
- The approval sheet's "Always allow" button reads in plain words: "Always allow npm test commands" instead of "Always allow run_command(npm test:*)". The exact rule is in the button's tooltip. Activity cards no longer repeat the runtime's label as a grey hint.
- Activity cards name every tool. Tools without a written label (plugin and MCP tools, `git_commit`, `browser` and others) used to all say "Completed a project step"; they now say what ran, for example "Used context7: resolve library id" or "Made a commit". Same change in the terminal labels. Hints that only repeat the label are hidden.
- Steps that only ran tools sit together as one compact list, and the written answer gets clear space above it. Whitespace-only streamed text (common with gpt-oss) no longer leaves empty bubbles with their own timestamp row.
- One web interface. The classic single-file page (`index.html`, served at `/classic`) is retired; `/`, `/classic` and `/index.html` now open the app at `/app/`. OASIS has two first-class interfaces: the terminal and the web app (the desktop app and `oasis app` package the same web app). A worker left by the old page clears its caches and unregisters itself. Not carried over yet: the subagent run monitor, cloud jobs list, GitHub status and local model list.
- The browser end-to-end check now drives the app: a scripted model fixes a bug, the user approves the edit in the approval sheet, the test passes, and axe finds no color-contrast problems in dark, light and phone views. Screenshots are saved as CI artifacts.
- Accessibility: the message box is announced as a combobox for its `/` and `@` suggestions, and the files-panel resize handle reports its width.
- Chats lists **Earlier on this computer**: sessions from the terminal (`oasis`, `oasis -p`) or other tabs. Opening one continues it in the browser with its full history. The file list also refreshes when you come back to the tab, so files changed in the terminal show up.
- The Plugins sheet manages Claude Code plugins on the computer running `oasis web`: see installed plugins, turn them on or off, remove them, search a marketplace (popular plugins such as frontend-design, superpowers and code-review first) and install with one click. With no marketplace yet, it offers Anthropic's official one (about 300 plugins). New `GET/POST /api/plugins` endpoint, same code paths as `oasis plugin`.
- Fixed: when OASIS checked its own edits after a streamed reply, the next reply was drawn in the same bubble with no break ("Provide confirmation.✅ Created…"). The `verification_gate` event now ends the bubble. Found while using the app as a normal user with gpt-oss-20b.
- The post-edit check note now tells the model it is internal. In a live terminal run, the final answer ended with "The gate is satisfied", which meant nothing to the user.
- Fixed: connecting a keyless remote endpoint (for example `https://text.pollinations.ai/openai`) said "Locked in" but the app kept asking for a key. Connections proven to work without a key are saved with `keyless: true` and count as configured for that endpoint only.
- Settings has a **Tools (MCP servers)** section when the workspace is connected to `oasis web`: list, add, turn on or off and remove servers in `mcp-servers.json`. Commands are split with quote support and checked before saving; environment access takes variable names only. Before, this was only in the classic page at `/classic`.
- With no model connected, the `oasis web` welcome screen shows what fits this computer (hosted model, a local server already running, or an Ollama model to install), from `/api/system/profile`.
- Found in a hands-on pass. The terminal pane showed a blinking cursor that ignored typing until you found Start terminal. It now shows a hint, and Enter starts the shell (approval still applies). After the shell exits, Enter starts a new one.
- `?` opens the keyboard shortcuts when you are not typing, as in GitHub and Gmail.
- On touch screens, the composer buttons are 40px tall instead of 28px.
- New Terminal tab, connected to OASIS on a computer: an interactive shell beside the chat, rendered with xterm.js and opened with Ctrl+`. It asks before starting and only launches the server's own shell (the request cannot name another program). It is invisible to the agent, does not lock the workspace, strips common secret environment variables, and reattaches after a page reload.
- The Files panel can be resized: drag its left edge or use the arrow keys on it, and double-click to reset. The width is remembered.
- The file viewer has a Download button, so single files can be saved from a local project too (Export zip only covers browser projects).
- Messages show a compact timestamp in their hover bar (the full date is in the tooltip). Saved chats keep the times.
- Command palette → **Download this chat** saves the conversation as the standalone HTML page from `/export FILE.html` (served by `GET /api/sessions/:id/export`, which requires the session token).
- After Undo, the reverted turn stays in the transcript, dimmed, with a note that files and conversation went back.
- The usage chip next to Send shows the estimated spend for the chat (subagents included) beside the context meter, with a `+` when some requests used a model with no known price.
- Copy buttons under every reply and on your own messages, plus Edit to put a sent message back in the composer. Copies keep the original Markdown.
- Fixed: the Copy button on code blocks did nothing.
- The diff viewer sizes itself to the change: a two-line fix opens as a short dialog instead of a full-height sheet, and long diffs still scroll.
- Fixed: diffs and code blocks drew `=>`, `!=` and similar as ligatures (`⇒`, `≠`), so code could read differently from what is in the file.
- Activity steps name the subagent that ran ("Ran the explore agent", with its task description), and coordination, question, plan, memory and MCP steps get their own labels instead of "Completed a project step". The server sends the same labels to the browser when OASIS runs on a computer.
- The composer shows how full the context window is as a ring and percentage (amber past 70%, red past 90%), with token counts on hover.
- Inline autocomplete in the composer: `/` suggests commands, custom commands and skills, and `@` suggests project files. Arrow keys move, Tab or Enter accepts, Escape closes. Connected to OASIS on a computer, `/` no longer opens the command palette (Ctrl+K still does).
- After a turn that changed files, the last reply offers Undo, which runs `/undo` to restore the files and rewind the conversation by one turn.
- While the tab is in the background, the page title shows a badge when a task finishes or needs approval. Optional desktop notifications are under Settings.
- Plan mode in the browser app's mode menu (when connected to OASIS on a computer), and Shift+Tab in the composer cycles modes as in the terminal.
- The header shows the current git branch. `/api/status` now reports `branch`.

### Agents and subagents

- The line under each subagent shows only what matters: "own worktree" and "read-only" when they apply, then the model. It used to read "shared workspace · write-capable access · model … · 27 tools available".
- Fixed: model names under subagents lost every "r", "n" and "0" ("e2e-coder" showed as "e2e-code") because of a doubly escaped character class.
- Custom agents accept the full Claude Code front matter: `disallowedTools`, `maxTurns` (reports are marked `partial` at the limit), `permissionMode: plan`, `skills` (preloaded), `memory` (user, project or local `MEMORY.md`), `background` and `color`. Project, user, plugin and `--agents` definitions share one parser.
- `/tasks` lists finished and restart-interrupted subagents under **Earlier in this session**, and `/tasks send ID MESSAGE` steers a running one or resumes a finished one with its saved conversation (Claude Code 2.1.319 parity). Background MCP tasks appear in `/tasks` too.
- Agent files also accept `hooks` (scoped to the agent; `Stop` runs as `SubagentStop`; project files need a trusted workspace) and `omitClaudeMd`, plus `mcpServers`: inline servers connect only for that agent's turns and close afterwards; and `autoCompactWindow`. With `--agent`, `initialPrompt` starts the session and `disallowedTools` applies to the main agent too.
- `task` accepts `output_schema`; the report is validated and the agent gets one correction turn, then the result carries `structured` or `schema_errors`.
- Background agents that go silent are stopped as `stalled` after 450 seconds (1200 seconds inside a running tool) and keep their last text as a partial report. Set `OASIS_SUBAGENT_STALL_SECONDS` or `subagentStallSeconds`; `0` disables it.
- Nested delegation, as in Claude Code: subagents can launch their own up to three layers deep. Set `subagentMaxDepth`, `OASIS_SUBAGENT_MAX_DEPTH` or `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (`1` disables it). Read-only agents never delegate, and `Agent` in a `tools` list maps to `task`.
- `neuron_network` loads on demand with the other background-agent tools, saving about 200 tokens per request.
- New [Subagents guide](docs/SUBAGENTS.md).
- Found in a real delegation run with gpt-oss-20b. Optional tool fields sent as `null` (`"model": null`) are now dropped when the call is valid without them, instead of costing a correction turn.
- Subagent requests now stream even with no display, so a silent provider trips the idle watchdog (`OASIS_STREAM_IDLE_SECONDS`, 120 s) instead of the 600 s header timeout. In the live run, one hang held the parent for 300 s. To turn this off, set `OASIS_SUBAGENT_STREAM=0`.

- `oasis plugin --help` and `oasis --help` now list the Claude Code plugin marketplace commands (`plugin marketplace add`, `plugin install`). Before, they showed only `plugin eval`.

### Benchmarks
- `bench:live --router` now gives Claude Code `ANTHROPIC_API_KEY` as well as `ANTHROPIC_AUTH_TOKEN`. Claude Code 2.1.319 stopped at "Not logged in" with only the token set, so every Claude Code trial through a gateway failed before sending a request.

### Providers
- `OASIS_BASE_URL` without `OASIS_MODEL` now says which variable is missing and offers `oasis connect <that address>`, instead of only "Run oasis setup".
- [OmniRoute](https://github.com/cheaper-inference/omniroute) is a built-in gateway provider (`omniroute`, `OMNIROUTE_API_KEY`, `localhost:20128`). See [Configuration](docs/CONFIGURATION.md#omniroute-gateway).
- Pasting a server address with a key no longer fails with "needs an API key" when the server also guards an Ollama-style `/api/tags` route, and a wrong key is now reported as a wrong key.
- Model setup on a gateway rules out an unconnected upstream after one failed probe, and keeps its models out of the backups.
- Gateway 5xx errors such as "not configured" are no longer retried for minutes. They fail over at once, with advice to connect the provider.
- Model ranking ignores digits in a provider prefix (`llm7/…`), so they no longer count as a model version.
- Prompt-mode tool calling for endpoints that ignore `tools` or drop system messages: set `toolCalling: "prompt"` / `OASIS_TOOL_CALLING=prompt`, and optionally `systemMessages: "user"` / `OASIS_SYSTEM_MESSAGES=user`. Verified with gpt-oss-20b, which fixed a failing test with no native tools sent. See [Configuration](docs/CONFIGURATION.md#endpoints-without-native-tool-calling).
- Tool names with trained-in namespaces (`repo_browser_read_file`, `repo_browser.read_file`, `default_api:grep`) now map to the real tool. In a live gpt-oss run they cost two wasted turns.
- When a gateway such as OmniRoute reports a 502 whose upstream cause is "Prompt too long", the error now shows that cause and suggests `/compact` or a larger model. Before, it was retried as a server fault.

### Security and reliability
- Local gateways that need a key (LiteLLM, OmniRoute with authentication) now work from the environment: `OASIS_API_KEY` is sent to a `localhost` server when `OASIS_BASE_URL` names it, and `OASIS_LOCAL_API_KEY` is documented. Ambient cloud keys are still never sent to local servers. Before this change, `oasis eval` and `bench:live` through a keyed local gateway failed on every request.
- DuckDuckGo-style `ERR_INPUT_LIMIT` answers (sent as HTTP 429) count as prompt-too-large: history is compacted instead of waiting out a rate limit, and the message no longer says "rate-limiting".
- `npm test` gives each run a private temporary folder and removes it afterwards. Before, a full run left about 4,000 folders and 1 GB (heap snapshots from the `/heapdump` test) in the system temp folder. It also no longer depends on shell globbing, which Windows `cmd` lacks.
- Found by running Anthropic's `commit-commands` plugin on a real free model. In `oasis -p "/command"`, the command's `allowed-tools` were dropped, and its read-only context lines (`git diff HEAD`, `git log`) were skipped. Both now behave as in Claude Code. A compound shell line is allowed when allow rules cover every piece. A commit that fails because Git has no author identity says so instead of blaming hooks.
- `git_commit` tells the model when the work is already committed: the success result says to report the hash, and a repeat call names the earlier commit. A real gpt-oss-20b run made six more commit attempts after the first succeeded.
- In `oasis web`, adding files from the Files panel failed with "workspace.write is not a function". Files now go into the real project folder, including PDFs and other binary documents up to 10 MB, so the agent can read them. Writes stay inside the project, refuse protected paths (`.env`, `.git`, keys) and links, ask before replacing a file, and wait while an agent is running. Verified in the browser: an uploaded report.pdf was read correctly by gpt-oss-20b.
- When a text-only model rejects an attached image ("This model does not support image input"), OASIS remembers that for the session. It resends without the image data, replacing each image with a note, so the model tells you it can't see it. Later messages keep working. Before this, the user saw a raw HTTP 400, and every later message in that chat failed the same way. Found in the browser workspace with gpt-oss-20b. The stored image is kept, so a vision model picked later still gets it.
- An `error` event inside a chat-completions stream now restarts the reply (within the usual restart limit) unless it is permanent (auth, quota, context length, policy, other 4xx). Pollinations sends one when its upstream glitches, and it used to end the whole run.
- Auto mode approves the project's own test, lint and build commands (`npm test`, `node --test`, `node x.test.js`, `pytest`, `cargo test`, `go test`, `make test`) without a classifier call, while the default "Test and build" rule is in force. Seen live: on a free model that takes 45 s per reply, every test run had been denied when the 30 s classifier call timed out.
- The auto-mode classifier's time limit stretches to 1.5x the main model's typical reply time (up to 180 s) when it runs on the same model; `autoMode.timeoutSeconds` sets it.
- A classifier timeout is reported as a timeout, with a hint to set `autoMode.model`, instead of "cancelled by the user".
- A 429 that means "one request at a time" (Pollinations' keyless API) now waits and retries instead of failing in under a second.
- A declined command now tells the model not to retry or ask again, but to finish what it can and name the command for the user.
- Shutting down the browser workspace now waits briefly for cancelled tasks to record their final status, then closes task history, so no write lands after shutdown. This fixes an intermittent cleanup failure on Node 26.
- New `dontAsk` permission mode and `permissions.denyInsteadOfPrompting` setting (Claude Code parity): calls that would wait on an approval prompt are denied with a readable reason and the turn continues, so CI and unattended runs never hang. See [Permission modes](docs/CONFIGURATION.md#permission-modes).
- The SSRF address policy is built on `ipaddr.js` with declarative CIDR tables.
- Plugin downloads, MCP OAuth discovery and public web fetches share one DNS-pinned, size-bounded HTTP client (`src/safe-http.mjs`) instead of three copies.
- The test suite is green on `main` again after the tool-registry and Pages removals.

### MCP
- In `auto` mode, read-only and closed-world MCP tools from your own MCP config run without a classifier call. The server's annotations decide this. Project servers, secret-like tool names and changed tools are excluded. Found in a live run: a free one-request-at-a-time model timed out on the classifier and the tool was wrongly denied. The same run now answers in 49 s.
- Long-running MCP tools run as MCP Tasks through the official [`@modelcontextprotocol/ext-tasks`](https://github.com/modelcontextprotocol/ext-tasks) requester. When a server declares `tasks.requests.tools.call` and a tool sets `execution.taskSupport` to `required` or `optional`, OASIS creates a task, polls at the server's interval, reads the result and sends `tasks/cancel` when you interrupt. Task calls are not bound by the per-request timeout (2-hour ceiling).
- A task still running after 5 seconds moves to the background in the interactive terminal and in streaming headless sessions, as in Claude Code. The turn continues, and the result arrives as a notification that wakes an idle session. It passes through the prompt-injection guard. Interrupting the turn after the move does not cancel the task. Set `OASIS_MCP_TASK_BACKGROUND_MS` to change the grace period. `OASIS_MCP_TASK_BACKGROUND=0` (or `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND=1`) always waits. One-shot `-p` runs and the browser always wait.

### Maintenance
- Removed duplicated chat chunking (Telegram gateway) and generated-media file handling (images and speech).
- README: quick start, agent system overview and Claude Code compatibility summary.
- README rebuilt: a one-line installer for macOS and Linux, browser workspace screenshots in light and dark, a feature tour, an architecture diagram and a comparison summary. The comparison page now covers Codex, Gemini CLI, OpenCode, Goose and Pi as well as Claude Code and Hermes.
- The npm package no longer includes the README demo recording and screenshots (about 1.8 MB).

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
