# Changelog

User-facing change history grouped by package version. A version heading does not imply that a GitHub Release or downloadable assets have been published; check the [Releases page](https://github.com/FAHTHIZ/oasis/releases) for current availability.

## Unreleased

### OpenTelemetry GenAI conventions

- Model-call spans now carry `server.address`/`server.port`, `gen_ai.request.stream`, reasoning level, reasoning and cache-write token counts, and `gen_ai.response.finish_reasons` as a string array (it was a single string). Failures set `error.type` (HTTP status, `cancelled`, Node error code or class).
- New standard metrics: `gen_ai.client.inference.duration`, `gen_ai.client.inference.operation.input_tokens` and `output_tokens` with the recommended buckets, and `gen_ai.execute_tool.duration`.
- `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` switches span names to `invoke_agent oasis`, `chat MODEL` and `execute_tool TOOL`; the `oasis.*` names stay the default. Telemetry is documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md#telemetry-opentelemetry).

### Rules and workflows from IDE agents

- Devin Desktop (the new name of Windsurf) rule locations are read as they are: `.devin/rules/*.md` with their `trigger:` front matter (`always_on`, `glob`, `model_decision`, `manual`), the always-on `.devin/global_rules.md` (or the legacy `.windsurf/global_rules.md` when there is no `.devin` one, as Devin Desktop does), personal `~/.devin/rules/*.md` and `~/.devin/global_rules.md`, and the legacy Windsurf global rules at `~/.codeium/windsurf/memories/global_rules.md`. `AGENT.md` and `AGENTS.local.md` load like `AGENTS.md`, in the project and per folder. `OASIS_OTHER_AGENT_RULES=0` turns them off with the other agents' files.
- Other agents' command and workflow files are slash commands without importing: Cursor `.cursor/commands/*.md` and `~/.cursor/commands`, Devin Desktop and Windsurf `.devin/workflows` and `.windsurf/workflows` (in the workspace and in parent folders up to the git root, `.devin` winning) and `~/.codeium/windsurf/global_workflows`, Antigravity `.agents/workflows`, `.agent/workflows` and `~/.gemini/config/workflows`, and Cline `.clinerules/workflows`. OASIS's own and Claude Code commands win on a name clash. A workflow that says "Call /other-workflow" gets that workflow appended (up to six, two levels deep). These files are plain prompts: inline `!` shell and `allowed-tools` are ignored, and Antigravity's `// turbo` markers do not skip approvals.

### Claude Code hook parity

- `PreModelSwitch` and `PostModelSwitch` hooks now run. They were accepted in settings but never fired. `/model NAME` (terminal and web) and an ACP editor's model picker run `PreModelSwitch` first, with Claude Code's input: `from_model`, `to_model`, `requested_model`, `source` (`command` or `sdk`), and the cost of re-sending the conversation (`context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing`). Exit 2, `decision: "block"`, `permissionDecision: "deny"` or a timeout (30 seconds by default) keeps the current model. `"ask"` asks in the terminal and counts as a refusal elsewhere; `deny` beats `ask` beats `allow`. Matchers compare the target's canonical name, so `claude-opus-4-6` also covers dated, Bedrock and gateway ids; models without a Claude name run every hook. `PostModelSwitch` runs in the background after the switch, and its output (plain stdout or `additionalContext`) reaches the model once, with the next request; only the newest switch's output is kept.
- `DirectoryAdded` now runs after `/add-dir` adds a folder (matcher `slash_command`, input `directory` and `source`), in the background as in Claude Code. It does not run for folders that were already in the workspace.
- Fixed: a folder added with `/add-dir` was not writable by sandboxed commands until restart. It is now added to the sandbox's writable folders at once, as `--add-dir` does at start-up.

### Crash-safe task progress

- Browser tasks (`oasis web`), headless runs (`oasis -p`) and App Server turns now save the conversation while a turn is still running, as the terminal already did. If the server stops or crashes mid-task, the finished steps are kept, and the interrupted task's session can be continued. The save trails each tool step by a moment so it includes that step's result, and it runs at most every 3 seconds.
- A session restored after such a stop is marked as having an unfinished turn. `oasis -c` says so, and the next turn tells the model that its last step may not have finished and that it should check the files before continuing. The warning is given once, and a normal end-of-turn save clears the mark.

### Antigravity agent definitions

- Custom agents are also read from Google Antigravity's folders: `.agents/agents/<name>.md` or `<name>/agent.md` in the project, and `~/.gemini/config/agents/`. Antigravity tool names, `subagent: false`, `commandExecutionPolicy: off`, model tiers and skill paths are mapped (see docs/SUBAGENTS.md).

### Archived sessions everywhere
- Archiving now means the same thing in every interface. A session archived from a Codex App Server client (`thread/archive`), `oasis sessions archive ID` or the web API (`POST /api/sessions/ID/archive`, `/unarchive`) leaves the web app's session list, `/resume`, the terminal's recent-sessions menu, `oasis --continue`, `oasis sessions list` and ACP `session/list`. `oasis sessions list --archived` and `GET /api/sessions?archived=1` show archived ones, and an archived session still resumes by ID.

### Agent Client Protocol (editors)

- `oasis acp` now implements the rest of the stable ACP session lifecycle: `session/list`, `session/resume` (reopen without replaying), `session/close`, `session/delete` and `logout`, advertised through `sessionCapabilities`. Editors get a Mode and a Model picker through `session/set_config_option` (only models allowed by `availableModels`), a context meter through `usage_update`, and a session title through `session_info_update`.
- When an editor advertises `elicitation.form`, the agent's `ask_user_question` tool reaches the user as an ACP `elicitation/create` form (still unstable in ACP v1): the choices as a single- or multi-select field linked to the tool call, plus an optional free-text "Other" field. Declining, cancelling or stopping the prompt counts as no answer, and the model picks a reasonable option and says which. Editors without the capability see no change.
- `$/cancel_request` for a running `session/prompt` now stops the turn (reply `stopReason: "cancelled"`), the same as `session/cancel`. Before, the request was marked cancelled while the agent kept working.

### Codex App Server protocol

- File system and command methods: `fs/readFile`, `fs/writeFile`, `fs/createDirectory`, `fs/getMetadata`, `fs/readDirectory`, `fs/remove`, `fs/copy`, `fs/watch` / `fs/unwatch` (with `fs/changed` notifications), and `command/exec` with `command/exec/write`, `command/exec/resize`, `command/exec/terminate` and streamed `command/exec/outputDelta`, including PTY mode through node-pty. Unlike Codex, paths must sit inside the server's folder, a thread's folder or `OASIS_APP_SERVER_FS_ROOTS` (symlinks resolved first), commands run through the sandbox from OASIS settings, and a server started in plan mode refuses writes and commands.
- `--listen unix://` (default `~/.oasis/app-server-control/app-server-control.sock`, or `OASIS_CONFIG_DIR`) and `--listen unix://PATH` serve the WebSocket protocol over a Unix domain socket, like Codex. The folder is kept at mode 700 and the socket at 600, so only your user can connect, and no token is needed. A socket left behind by a crashed server is removed on start; a running server or a non-socket file at that path stops the new server with an error. The socket is removed on shutdown. Not available on Windows.
- Clients that set `capabilities.experimentalApi` in `initialize` get the agent's `ask_user_question` as Codex's experimental `item/tool/requestUserInput` request (one question with its options, `isOther: true`), tied to the tool's item. Other clients never see the request, and the tool stays hidden from the model when nobody can answer.
- Thread management: `thread/archive` and `thread/unarchive` (archived threads leave `thread/list` unless you pass `archived: true`), `thread/delete`, `thread/unsubscribe`, `thread/loaded/list` and `thread/compact/start` (a turn with one `contextCompaction` item). `thread/list` also takes `searchTerm` and `excludedThreadIds`. Matching notifications: `thread/archived`, `thread/unarchived`, `thread/deleted`, `thread/closed`, `thread/compacted`.
- `skills/list` returns the skills OASIS can load for each requested folder, in Codex's shape: `system` for built-in skills, `repo` for skills in the project and `user` for personal skills and plugin skills, each with its SKILL.md path.
- `mcpServerStatus/list` reports a loaded thread's MCP servers: connected ones with server info, capabilities, tools and resources, and failed ones with the error. `serverName` and `detail: "toolsAndAuthOnly"` are supported. OASIS starts MCP servers per thread, so the method needs a `threadId` unless exactly one thread is loaded.
- `--ws-auth signed-bearer-token --ws-shared-secret-file PATH` accepts HS256 JWTs signed with a shared secret of at least 32 bytes, matching Codex's checks: `exp` required, `nbf` honoured, optional `--ws-issuer` and `--ws-audience`, and `--ws-max-clock-skew-seconds` (default 30). Verification uses Node's crypto module, so no JWT library is added.
- `fuzzyFileSearch` ranks files and folders under the given roots for @-file pickers, returning Codex's result shape (`root`, `path`, `match_type`, `file_name`, `score`, `indices`). Roots must be inside the server's allowed folders, secrets and ignored files are skipped, and `cancellationToken` cancels an older search.
- `thread/turns/list` pages a thread's turns (newest first by default, `sortDirection: "asc"` for oldest first) with `summary`, `full` or `notLoaded` item views, a `nextCursor`, and a `backwardsCursor` that re-includes the anchor turn when the direction is reversed.
- Fixed: `thread/name/set` changed the name only for the current connection. The name is now saved with the session, so it survives a restart and shows in `thread/list`, `oasis sessions` and the web app.

- `oasis app-server --listen ws://127.0.0.1:4500` serves the protocol over WebSocket, one JSON-RPC message per text frame, with `/readyz` and `/healthz` probes and 403 for any request with an `Origin` header. `--ws-auth capability-token --ws-token-file PATH` (or `--ws-token-sha256 HEX`) requires a bearer token in the handshake. Listening beyond loopback without auth is refused. Adds the `ws` package (MIT).
- `oasis app-server` serves the core of the Codex App Server v2 protocol over stdio JSONL, so clients written for `codex app-server` can drive OASIS. It supports threads (start, resume, fork with `lastTurnId`, read, list, rename), turns (start, steer, interrupt), inline `review/start` (current changes, base branch, commit or custom), `model/list`, and `userMessage`, `agentMessage`, `commandExecution`, `fileChange` (with unified diffs), `mcpToolCall` and `dynamicToolCall` items. Approvals arrive as Codex approval requests with the accept, acceptForSession, decline and cancel decisions. Field names follow the Apache-2.0 protocol definitions in `openai/codex`; no Codex code is included.

### Connect cards
- Say "connect GitHub", type `/connect linear`, or let the agent ask: a Connect card appears inline in the conversation (brand mark, what it is for, **Connect** / **Not now**), the way hosted assistants show one. Connect opens the sign-in in a popup (the system browser in the desktop app), the card follows it, and it settles as Connected with the number of tools ready. The task waits on the card and continues in the same turn.
- New `connect_service` tool (in the Setup tool group) so the agent can ask for an app it needs. It returns at once when the app is already connected, quietly reattaches one that was signed in before, and never runs in subagents or headless runs (those are told to run `oasis mcp connect NAME`).
- A built-in catalog of remote MCP servers with verified OAuth: GitHub, Linear, Notion, Sentry, Atlassian, Stripe, Vercel, Supabase, Neon, Cloudflare (and its docs), Hugging Face, monday.com, Intercom and PayPal. Other names resolve through the official MCP Registry (remote servers only); a pasted `https://` URL works too.
- GitHub: an existing `gh` sign-in connects instantly; otherwise `gh auth login --web` runs and the one-time code is shown on the card with a "Copy code and open GitHub" button; without `gh`, a token box. The token is checked against the GitHub API and stored like other MCP sign-ins.
- OAuth from another device: the card can take the `http://127.0.0.1/...` address the browser landed on, so signing in from a phone finishes the computer's sign-in.
- Terminal: the same card is drawn as a box with Connect / Not now; `/connect` lists apps with their status; `oasis mcp connect [NAME]` works from a shell. API: `GET/POST /api/connectors`, `GET/POST /api/connectors/:id` (`connect`, `skip`, `token`, `callback`).
- More apps: Airtable, Square, Webflow and Granola (OAuth), DeepWiki and Exa (no sign-in). Settings → Apps lists them all with Connect and Disconnect. A tool server that fails because it needs sign-in now shows a Connect card in the chat.
- "Connect GitHub and Linear" (or `/connect github linear` in the terminal) shows one card per app, and pasting an MCP server address on its own (https://mcp.…, …/mcp, …/sse) offers its Connect card.
- Scope step-up: when an app answers 403 insufficient_scope, the Connect card explains which access it needs, signs in again asking for that scope, and retries the call.
- Settings → Apps has a search box, lists connected apps first, and connects any other app from a pasted MCP server URL.
- 14 more apps, each tested to accept a loopback redirect at registration: GitLab, Miro, Buildkite, Honeycomb, Axiom, Sanity, Postman, Klaviyo, Fireflies, Dropbox, Make, Cal.com, Grafana Cloud and Mux (48 in all).
- 13 more apps, each checked for OAuth dynamic client registration: PostHog, Netlify, Prisma, Semgrep, Jam, Wix, Supermemory, Apify, Tavily, Close, Attio and Todoist, plus Context7 (no sign-in).
- `/disconnect NAME` in the terminal signs out of an app and removes the server OASIS added (Tab completes app names).
- The agent is told which project apps are not connected (one system-prompt line; OASIS_NO_APP_HINTS=1 turns it off), so it offers a Connect card when a task needs one.
- The new-chat screen shows "This project uses" with one-click Connect chips for project apps that are not connected.
- The terminal start-up tip names project apps that are not connected yet, with the /connect line to run.
- Apps the project already uses (vercel.json, a stripe or @sentry dependency, a GitHub remote, ...) are listed next in Settings → Apps and `/connect`, marked "Used in this project".
- Settings → Apps and `/connect` flag a sign-in that expired with no refresh token, with a one-click Reconnect.
- A connected card has "Show tools" listing what the app added.
- Lazy sign-in, as in Claude's connectors: when a connected app's tool is refused because the sign-in expired or was revoked, the Connect card appears and the same call runs again once you connect. No model round trip, no lost context.
- Brand marks come from Simple Icons (CC0) and are bundled, so the strict app CSP stays unchanged.

### Routines (durable scheduling)
- Routines accept RFC 5545 recurrence rules: `DTSTART;TZID=Asia/Dhaka:20261127T170000 RRULE:FREQ=MONTHLY;BYDAY=-1FR`. Supported: FREQ=DAILY, WEEKLY, MONTHLY and YEARLY, with INTERVAL, COUNT, UNTIL, BYDAY (with ordinals), BYMONTHDAY, BYMONTH, BYHOUR, BYMINUTE and WKST. A rule that runs out marks the routine completed. Unsupported parts (sub-daily FREQ, BYSETPOS and others) are refused with a reason.
- `oasis schedule` (aliases `oasis cron`, `oasis routines`) adds routines: prompts or shell commands that run on a schedule whether or not a terminal is open. In-session `/schedule` jobs still end with their session. Schedules are 5-field cron with an optional per-routine time zone (`--tz Asia/Dhaka`), `every 2h`, `in 30m`, or an ISO date. `oasis schedule daemon` runs them; `oasis schedule tick` does one pass for a system crontab.
- Each fire runs in a fresh background session (the same tools, permission rules and logs as `oasis --bg`), in the routine's `--workdir`, with its own `--model`, `--permission-mode` and `--skill` list. `--script` runs a command with no model at all.
- Lifecycle follows Hermes Agent's cron: `pause`/`resume` (a slot that came due while paused gets one catch-up run), `run` (an extra fire that leaves the schedule alone), `cancel` (stops only the current run), `remove` (also stops a live run), `--paused` to create a canary, and lookup by name with ambiguous names refused.
- A missed cron slot runs late only inside a catch-up window (half the period, 2 minutes to 2 hours, or `--grace MINUTES`). A slot that comes due while the previous run is still going is skipped, not stacked. A run interrupted by a reboot or crash pauses the routine for review instead of running again.
- Results are saved under `<config>/schedules/output/` and can be delivered to `telegram:CHAT_ID`, `slack:CHANNEL`, `discord:CHANNEL_ID` or an HTTPS `webhook:` with secrets redacted. Output that starts with `[SILENT]` is saved but not sent.
- Before an agent run, missing model credentials, a missing workdir or a missing gateway token mark the routine `blocked_config` once and no model call is made. Scheduled runs cannot create or change routines.
- `oasis web` and `oasis gateway` now run the scheduler themselves (as Hermes' gateway does), so a separate daemon is optional. Only one scheduler runs per config folder; set `OASIS_ROUTINES=off` to stop a server from hosting it. Settings in the browser workspace has a Routines section to add, run, pause, resume, stop and remove routines, and it shows whether a scheduler is running.
- Webhook routines: `oasis schedule add webhook "triage the new issue"` creates a routine that fires when `oasis web` receives `POST /hooks/routines/ID` signed with its secret (`X-Hub-Signature-256: sha256=…`, the GitHub format, or `X-OASIS-Signature`). Unknown ids and bad signatures get the same 401 and count toward the existing lockout. Payloads up to 256 KB are queued (20 at most), wait behind a run in progress instead of being dropped, are saved to a file the run can read (`OASIS_EVENT_FILE`), and reach the agent marked as untrusted data.
- Webhook routines can filter events like Claude Code's GitHub triggers: `--event pull_request.opened --event release` matches `X-GitHub-Event` (or `X-OASIS-Event`) plus the payload's `action`. GitHub's `ping` is acknowledged and never runs. Non-matching events get `200 {accepted:false}` and are not queued.
- Fixed: `oasis schedule edit` could not clear a field (`--tz ''`, `--model ''`, `--workdir ''`).
- Settings → Routines → Recent results shows the last 10 runs of a routine with status, delivery and saved output (`GET /api/routines?runs=ID`).
- Conversation routines (like Codex thread automations): `--from-session ID` starts every run from a copy of a saved conversation, and `--chain` makes each run continue from the previous successful run. The original conversation is never written to, since each run forks it under a new id that the routine records. In a session, the agent's `routine_manage` takes `continue_this_conversation: true`.
- `/schedule durable DESCRIPTION` asks the agent to set up a routine from plain language (like Claude Code's `/schedule`), and `/schedule routines` (or `/routines routines`) lists them. Plain `/schedule CRON PROMPT` still makes a session-only job and now says how to make a durable one.
- Plain calendar schedules: `daily at 09:00`, `weekdays at 9am`, `weekends at 10am`, `every monday at 14:00`, `weekly on mon, wed and fri at 9:15pm`. They compile to cron in the routine's time zone. A bare `9` is rejected as ambiguous.
- Bounded history: each routine keeps its newest 200 run records and 30 days of output and webhook payload files (`OASIS_ROUTINE_HISTORY`, `OASIS_ROUTINE_HISTORY_DAYS`). `oasis schedule prune` deletes finished one-time routines. Browser edits carry the routine's `updatedAt`, and an edit based on a stale copy gets a 409 instead of overwriting someone else's change.
- The agent can manage routines itself with the `routine_manage` tool (list, show, create, edit, pause, resume, run, cancel, remove). Creating, editing, resuming, triggering and removing ask you every time, even with `--yes`, and the prompt shows the schedule, command, folder, permission mode and delivery target. Subagents and runs with nobody to answer are refused and told to use `oasis schedule`. Pausing and cancelling never need approval.

### Desktop app
- The desktop app is back, built on the same runtime as `oasis` and `oasis web` (it imports the web server rather than shipping a copy). Releases carry a Windows installer (x64, ARM64), macOS disk images (Apple Silicon, Intel) and Linux AppImage and `.deb` packages (x64, ARM64), all covered by `SHA256SUMS`. See [docs/DESKTOP.md](docs/DESKTOP.md).
- The model key is encrypted with the operating system's key store (Keychain, DPAPI, libsecret/KWallet). On Linux without a keyring it is kept like the CLI keeps it, in an owner-only `config.json`. A key the CLI already saved moves into the key store on first launch.
- **Help → Check for updates…** and the update bar download the new installer, check it against `SHA256SUMS`, and install it the right way for how OASIS was installed (silent Windows installer, AppImage swap, or open the `.deb`/`.dmg`).
- Builds are not yet signed with an Apple Developer ID or Windows certificate; docs/DESKTOP.md gives the one-time macOS quarantine step and the SmartScreen note.
- Fixed: background sessions, syntax checks and Claude plugin installs started `process.execPath`, which inside the desktop app would open another window instead of running Node.

### Web app
- Starting a task while another one is still running in the same folder no longer ends in a dead-end "Finish or cancel it" message. The note names the running task and offers **Open the running task** (attaches to it, including its open approval) and **Stop it and send this** (cancels it and sends your new request, without a duplicate message). The server's 409 now carries `activeJob` (`id`, `type`, `title`, `sessionId`, `status`) for any client. Found while using the app: a task left running after its tab closed blocked every new tab with no way out.

### Runtime
- The skill list sent to the model stays within its 16,000-character budget by dropping whole lines. Before, a long list was cut mid-description and the model was not told that more skills existed. Now the last line says how many skills were left out and points to `list_skills`.
- `oasis -p` no longer throws away a run that is stopped part-way. A timeout, SIGTERM from a CI runner or supervisor, or a provider failure used to leave no saved session, so the work could not be continued. Once the model has answered at least once the session is saved, and text output ends with `The work so far is saved. Continue it with: oasis --resume ID`. Found while running a 15-minute local-model task under `timeout`.
- `oasis bg stop`, attach and respawn no longer trust a stored PID on its own. On Linux each background run records when its process started; if that PID now belongs to a different program (the run ended and the number was reused), the run shows as interrupted and nothing is signalled. Before, stopping a stale entry could send SIGTERM and SIGKILL to an unrelated program's whole process group.
- `npm test` gives the suite a private home folder (`HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `APPDATA`, `LOCALAPPDATA`) with a scratch `.gitconfig`, so tests no longer read a model catalog cached in your real `~/.config/oasis` (which changed expected context windows) or leave backup folders there. Set `OASIS_TEST_REAL_HOME=1` to opt out. `oasis web` now refreshes the model catalog with the environment it was started with.
- `/goal` has the full lifecycle: `/goal pause`, `/goal resume`, `/goal edit CONDITION` and `/goal clear`. Ctrl+C or the turn limit pauses the goal instead of discarding it. Resuming keeps the turn count and the last check, and tells the model not to repeat finished work. Goals are saved with the session; one that was running when OASIS stopped comes back paused. Goals are capped at 4,000 characters.
- Learned skills can improve themselves, like Hermes' `skill_manage`, but still with your approval. When a learned skill turns out wrong or outdated, the agent can call `skill_propose` with `update: true` to propose the corrected version. `/learning show ID` marks it as an update, and `/learning approve ID` replaces the skill and keeps the old version as `SKILL.md.bak`. Updates only touch skills in the learned-skill folders (`.agents/skills`, `~/.config/agents/skills`).
- Memory is bounded the way Hermes does it, without losing notes. A full store (500 notes per scope, or `OASIS_MEMORY_LIMIT`) no longer refuses new ones. It moves the least valuable note to `.archive/`: outdated first, then stale and never recalled. The note stays readable there. Notes marked outdated leave the prompt index but stay searchable, and the index lists the most useful notes first (recalled, verified, recent), so a tight budget drops the least useful.
- `/swarm` (the Kimi Code name) is an alias of `/batch`, which splits a large change into independent units and runs them in parallel worktree subagents.
- `npm run bench:memory` measures memory search on a fixed held-out set: 92% of questions get the right note first and 100% within the top 3 (MRR 0.960). A regression test keeps it above those floors.
- Resuming a long conversation that has been idle for over an hour (30k+ tokens, at least about $0.05 on a paid model) warns that the provider cache has likely expired, says what the next message will cost, and suggests `/compact` or `/clear`. Claude Code added the same warning in 2.1.304. Local and free models never warn.
- OASIS asks before a web, MCP or network shell call sends your own email address (from `git config user.email`, `GIT_AUTHOR_EMAIL` or `OASIS_USER_EMAIL`) over the network, once per address and tool, in every mode except bypass. GitHub noreply addresses are skipped. Claude Code added the same check in 2.1.317.
- A new JavaScript module must be loaded once before the work counts as verified. In a live eval the model created `src/lib.mjs` with a CommonJS `require.main` check inside an ES module; `npm test` passed because nothing imported the file, yet it threw on first use. The verification gate now names any new exporting module that no passing check loaded, and assisted verification runs `node <file>` for it (servers, CLIs and browser code are skipped).
- Read deduplication no longer traps a model that keeps asking for the same file. The first repeat of an unchanged read still returns a short pointer; a second repeat returns the content, since the model has lost track of the earlier result (Claude Code 2.1.317 removed its stub for the same reason).
- A self-paced `/loop` now ends when a run finishes without calling `schedule_wakeup`, instead of waking again after a guessed 10 minutes (matching Claude Code 2.1.319). `OASIS_LOOP_KEEPALIVE=1` keeps the old behavior.
- Deny rules now see commands run through `busybox` or `toybox` applets (`busybox rm x` used to escape `Bash(rm:*)`). Found by a new adversarial policy corpus: 54 inputs that must never match a strict allow rule, 41 spellings that must hit a deny rule, and a wider unbash/tree-sitter parity set.
- `search_files` no longer returns a bare empty list. A query that looks like a regex (`a|b`, `foo.*bar`) is retried as one, and an empty result explains that the search is one literal string and suggests grep, glob_files, list_files, or creating the code if it does not exist yet. In a live eval a small model made five empty searches in a row before writing anything.
- `write_file` and `edit_file` warn when a change mixes module systems: CommonJS `require`, `require.main`, `module.exports` or `__dirname` in an ES module (`.mjs`, or `.js` under `"type": "module"`), or `import`/`export` in a `.cjs` file. The warning gives the ESM replacement, so the mistake is fixed before any test runs.
- Resuming a session whose goal was paused prints `[goal] Paused goal: … /goal resume continues it; /goal clear drops it.`
- Goals work in print mode: `oasis -p --goal "npm test passes"` (or `oasis -p "/goal npm test passes"`) keeps working until a strict check says the condition is met, up to `--goal-turns N` turns (default 10). Stream JSON emits a `goal_check` event after each turn; the result carries `goal: { condition, met, turns, reason }`, and a goal that is never met ends as `error_goal_not_met` with exit code 1, so CI can tell.
- The goal check now reads verdicts wrapped in markdown (`**MET**`, `Verdict: MET`) and never reads "NOT MET" as met.
- Test files that import helpers from `src/cli.mjs` no longer start an interactive session as a side effect; `main()` only runs when cli.mjs is the entry point.
- Running `oasis` with piped or redirected input no longer prints "Oasis session closed." and exits without saying why. It explains that interactive mode needs a terminal, shows the `oasis -p` equivalents, and exits with code 2.
### Runtime
- No more invented test results. In a real run with `npm test` not approved, the model wrote a fake "PASS … All tests passed (3)" log and OASIS printed it. Now, when code was edited and no check ran, a "tests pass" claim is sent back to the model. If it still can't be verified, the answer ends with "Not verified: `npm test` was not approved, so no check ran. Run `npm test` to confirm." That line is left off when the answer already says the check didn't run. The verification nudge now tells the model the command was not approved and that it must never write output it did not see.
- `oasis -p` lists what was not approved (nobody can approve in print mode) and how to allow it next time: `--allowedTools "run_command(npm test:*)"` or `--permission-mode auto`. JSON output now includes each denial's `tool_input`.
- `oasis connect URL` works with keyless gateways that also list paid models (such as LLM7). Paid models and models without tool calling are tried last. A 401 from one model no longer ends setup; OASIS moves on to the next one, and only when every model needs a key does it say the server lists models without a key but needs one to use them. Paid models are not offered as backups.
- The "keep the key out of shell history" tip only shows when a key was actually pasted.

### Web app
- Switching to another task or starting a new one no longer cancels the running task. It keeps going in the background, its sidebar entry shows Working or Needs you, and opening it again reattaches. Tasks started from another browser or from the `oasis` terminal are listed under **Other devices and terminal**; opening a running one follows it live.
- On wide screens the approval card docks above the message box instead of covering the page, so the sidebar stays usable while a task waits. Toasts move out of its way and repeated toasts show once.
- Answering an approval or question in one browser (or the terminal) closes it in every other browser following the task, with a note saying it was answered elsewhere. Before, the other card stayed open, and clicking it did nothing.
- Opening a task from **Other devices and terminal** works while its first turn is still running. `GET /api/sessions/:id` for a session that is not saved yet now returns 404 instead of a server error.
- Following a task no longer polls every 350 ms. The page long-polls `GET /api/jobs/:id?after=N&wait=ms`, and the server answers the moment the next event arrives (or after up to 25 s), so steps, approvals and replies show up immediately with far fewer requests over remote connections.
- A dropped connection shows "Reconnecting…" and retries with backoff for about a minute. A rejected access key now says you are no longer signed in instead of failing silently.
- A task sidebar on wide screens lists this project's tasks, marks the ones running or waiting for you, and hides with Ctrl+B (Cmd+B).
- Reloading the page, closing the tab or losing the connection no longer loses a running task. The web app reattaches, replays the timeline from the server and asks an open approval again; approvals you already answered are not asked twice.
- **Remember this device** on the sign-in screen keeps the access key on a phone or laptop you own. **Sign out of this browser** (Ctrl+K) forgets it. A saved key that stopped working is removed, with a message saying so.
- A refreshed look: glass top bar and message box, a soft aurora background, icon cards for suggested tasks and a sweep around the message box while OASIS works. Reduced-motion settings turn the animation off.

### Runtime
- A first request that a gateway rejects as too large, without saying how large the window is, now retries with the smaller tool set and prompt instead of stopping.

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
- `bench:live --router` now sends Codex CLI through the gateway; Codex ignores `OPENAI_BASE_URL`, so it gets a provider entry instead.
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
