# Engineering mission log

A short, dated record of changes, tests, benchmark results, blockers and known
weaknesses. Newest first. Detailed user-facing notes go in the CHANGELOG.

## 2026-11-11 (terminal-agent interoperability: Gemini CLI, OpenCode, Goose, Aider, Roo/Kilo)

### Gemini CLI and OpenCode agent files
- Gemini CLI ([subagents doc](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md)) and OpenCode ([agents doc](https://opencode.ai/docs/agents/)) agent Markdown files now load as OASIS agents. `foreignAgentFrontMatter` in src/subagents.mjs translates tool names and deny rules into `tools`/`disallowedTools`. OpenCode's default `primary` mode stays out of the task tool. Tests: test/foreign-agents.test.mjs (2); subagent and import tests 28 pass, 0 fail.

### Gemini CLI TOML commands
- `oasis import gemini` already converted `.gemini/commands/*.toml`, but a migrating user had to run it again after every change. The commands now load in place, following Gemini's [custom commands doc](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md): the prompt is parsed once into text, `@{...}` and `!{...}` parts (braces balanced), so injected file content and command output are never expanded again. `{{args}}` inside `!{...}` is single-quote escaped. Shell runs only for user commands or trusted workspaces and respects deny/ask rules. Test: test/foreign-commands.test.mjs (5 tests); command, import and slash tests 64 pass, 0 fail.

## 2026-11-11 (IDE-agent interoperability: Cursor, Devin Desktop, Antigravity, OpenHands)

### Antigravity plugin skills
- Skills inside installed Antigravity and Antigravity CLI plugins (`~/.gemini/{config,antigravity-cli}/plugins/*/skills`) are now listed like other foreign user skills (40 plugins at most per folder). Test: test/foreign-skills.test.mjs; skill tests 21 pass, 0 fail.

### Worktree setup files
- New worktrees had no `.env` or `node_modules`. Cursor ([worktrees docs](https://cursor.com/docs/configuration/worktrees)) and Windsurf ([Cascade worktrees](https://docs.windsurf.com/windsurf/cascade/workflows)) let a repository say how to prepare one. New src/worktree-setup.mjs follows their lookup order, OS-specific keys and environment variables; `createWorktree` runs it. Unlike those tools, OASIS requires `oasis trust` first, because a cloned repository should not run commands when a subagent starts. OpenHands' `.openhands/setup.sh` ([repository customization](https://docs.openhands.dev/openhands/usage/customization/repository)) is the fallback. OpenHands runs it at every session start inside a sandbox; on a user's own machine OASIS runs it only for a fresh worktree. Test: test/worktree-setup.test.mjs (5 tests, real git worktrees); worktree and session-tools tests 37 pass, 0 fail.

### Antigravity CLI rules
- The [Antigravity rules page](https://antigravity.google/docs/rules-workflows) lists `~/.gemini/antigravity-cli/rules/` and plugin `rules/` folders for the CLI. `~/.gemini/GEMINI.md` and `.agents/rules` were already read; these two are now user rules. Test: test/other-agent-rules.test.mjs (6 tests) with the OpenHands and nested-memory tests, 14 pass, 0 fail.

### Skill folders from other agents
- OASIS read `.agents/skills`, `~/.config/agents/skills` and Claude Code's folders. Added the locations documented by [Cursor](https://cursor.com/docs/context/skills), [Devin Desktop](https://docs.windsurf.com/windsurf/cascade/skills), [Antigravity](https://antigravity.google/docs/skills) and OpenHands, plus Codex's. Home-folder skills use a new `foreign-user` source that remembers its own root, so the existing containment checks for SKILL.md and `references/` still apply. Test: test/foreign-skills.test.mjs (2 tests, including a symlinked skill folder that is skipped); extension, plugin, slash and runtime tests 101 pass, 0 fail.

### OpenHands microagents
- OASIS did not read `.openhands/`. Behaviour reimplemented from the MIT-licensed OpenHands software-agent-sdk (`openhands/sdk/skills/skill.py`, `context/agent_context.py`, `skill_knowledge_info.j2`): files without triggers are repo context, `paths:` beats `triggers:`, `inputs:` adds `/name`, keywords match as whole tokens (`(?<![a-z0-9])kw(?![a-z0-9])` on the lowercased message), and each file is added once per conversation inside `<EXTRA_INFO>`. OASIS detects "already sent" from the `Skill location:` line in earlier user messages, so it survives a resumed session. Attached `@file` contents are not searched for keywords. Test: test/openhands-microagents.test.mjs (3 tests, including a real turn against a local fixture server); memory and agent tests 73 pass, 0 fail.

### Agent ignore files
- Cursor, Devin Desktop, Windsurf, Gemini and Aider let a repository hide files from the agent with gitignore-syntax files ([Cursor](https://cursor.com/docs/context/ignore-files), [Cascade](https://docs.windsurf.com/windsurf/cascade/workflows), [Gemini CLI](https://geminicli.com/docs/cli/gemini-ignore/), [Code Assist](https://developers.google.com/gemini-code-assist/docs/create-aiexclude-file)). OASIS ignored them. New src/agent-ignore.mjs (own gitignore matcher; no new dependency) checks each ignore file from the path's folder up to the git root, plus `~/.codeium/.codeiumignore`. `resolveWorkspacePath` refuses covered paths unless a caller passes `allowIgnored` (web file panel, checkpoints, `/rollback`, export do); `walkFiles`, ripgrep results, ast-grep and `@` mentions filter them. Shell commands are still allowed, as in Cursor. Test: test/agent-ignore.test.mjs (6 tests); related tool tests 127 pass, 0 fail.

### Workflows and commands from other agents
- `oasis import` already copied Cursor commands and Windsurf workflows into `.oasis/commands`, but a repository that had them was not usable until someone ran it. They are now read in place: Cursor `.cursor/commands` (project and home), Devin Desktop `.devin/workflows` and the legacy `.windsurf/workflows` (searched up to the git root, as the [Cascade docs](https://docs.windsurf.com/windsurf/cascade/workflows) describe), Windsurf global workflows, Antigravity `.agents/workflows` and `~/.gemini/config/workflows` (paths from the [workflows-to-skills migration page](https://antigravity.google/docs/migration/workflows-to-skills)) and Cline workflows.
- Windsurf and Antigravity workflows may say "Call /workflow-2". OASIS has no tool for the model to run a slash command, so called workflows are appended to the prompt once each. Their files never run inline shell: that syntax belongs to Claude Code commands, and a repository file should not gain it by being renamed. Test: test/foreign-commands.test.mjs (4 tests, including a symlink that points out of the workspace).

### Devin Desktop rule locations
- Windsurf is now Devin Desktop. Its [rules page](https://docs.windsurf.com/windsurf/cascade/memories) moves rules to `.devin/rules/*.md` and `.devin/global_rules.md` (home-folder copies apply everywhere), keeps the `.windsurf/` files as a fallback (only `.devin/global_rules.md` loads when both global files exist), and reads `AGENTS.md`, `AGENTS.local.md` and `AGENT.md` per folder. OASIS already read `.windsurf/rules` and `.windsurfrules`; it now reads the new locations too, plus the legacy `~/.codeium/windsurf/memories/global_rules.md` that `oasis import windsurf` used to copy. Test: test/other-agent-rules.test.mjs.

## 2026-11-11 (Claude Code parity cycle)

### plansDirectory
- OASIS did not store plans on disk. With `plansDirectory` set, `exit_plan_mode` now writes the plan there before asking for approval. Unlike Claude Code, which defaults to `~/.claude/plans`, nothing is written when the key is unset, and an untrusted repository cannot set it.

### alwaysThinkingEnabled
- Thinking on budget-mode Claude models was already off unless a keyword or saved budget asked for it, so `true` changes nothing. `false` now blocks those budgets, and on adaptive (4.6) models drops the `thinking` field and caps effort at `high`, following the settings reference. Always-thinking models (4.7 and later, Fable) are unchanged. `MAX_THINKING_TOKENS=0` now means "off" instead of "not set".

### Model policy: deniedModels, availableModelsMatch, modelOverrides
- `deniedModels` and `availableModelsMatch` are taken from managed settings only, as in Claude Code. The deny check runs before the allow list at every place a model is picked, and a startup model that is denied falls back to the first allowed `availableModels` entry (or the session refuses to start if none is left).
- `availableModels` id entries now match by prefix by default, so `gpt-5` also allows `gpt-5-mini`; `availableModelsMatch: "exact"` turns that off. Existing alias and family matching is unchanged.
- `modelOverrides` is applied when the request is built, after alias resolution; the session keeps the Claude id for display and policy checks, and only the outgoing request carries the mapped id.

### blockReads/WritesOutsideWorkingDirectories
- OASIS file tools already refuse paths outside the working directories in every mode, so the main effect of these keys was there. What changed: a `true` in any file (an untrusted repository too) turns them on; while on, folders listed only in the repository's `.claude/settings.json` `additionalDirectories` are not working directories; and the write block denies `enter_worktree` and `exit_worktree`, as Claude Code removes its worktree tools.
- Fixed on the way: the session replaced the sandbox's writable list with the working directories, which dropped the cache folders and `sandbox.filesystem.allowWrite`. They are now kept.
- Not done: the sandbox side of the read block (hiding home and other user roots from sandboxed commands, then re-opening git config). `.claude/settings.local.json` is treated as personal, without Claude Code's git-tracked check.
- Test: test/block-outside-working-dirs.test.mjs (3); add-dir, slash, sandbox, settings, worktree and permissions suites pass (89 + 1 skipped).

### Claude Code sandbox settings layout
- OASIS read `sandbox.allowedDomains` and a boolean `sandbox.network`; a Claude Code file with `sandbox.network.allowedDomains`, `sandbox.filesystem.*` or `autoAllowBashIfSandboxed` was ignored. Now read: `network.allowedDomains` / `deniedDomains` (merged across files) and `allowManagedDomainsOnly`; `autoAllowBashIfSandboxed` (same as `autoAllowCommands`); `failIfUnavailable` (managed wins; session start fails instead of only refusing each command, which OASIS already did); `filesystem.allowWrite`, `denyWrite`, `denyRead` with Claude Code's path prefixes (`/`, `//`, `~/`, else project root or `~/.claude` for user files; trailing `/**` dropped, other wildcards skipped as on Linux).
- Enforced in bubblewrap (bind, ro-bind, /dev/null or tmpfs masks), sandbox-exec (deny rules after the allow), containers (bind mounts) and sandbox-runtime (its own lists). Paths that do not exist are not mounted. `/sandbox` toggles now keep these settings instead of dropping them.
- Not done: `excludedCommands`, `filesystem.allowRead`, unix-socket and proxy keys, `credentials`. `allowUnsandboxedCommands` has nothing to switch off: OASIS has no unsandboxed retry.
- Test: test/sandbox-claude-settings.test.mjs (6, one runs real bubblewrap); sandbox, settings and slash suites pass.

### includeGitInstructions and attribution
- `includeGitInstructions: false` (any file) and `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` (wins both ways) now drop the branch, working-tree and recent-commit snapshot from the prompt, and skip those git calls. OASIS has no built-in commit or PR workflow text to remove; its "check git_status before editing" and commit-safety lines stay.
- `attribution.commit` and `attribution.pr` (trusted scopes only, since the text goes into the prompt) tell the model what to end commit messages and PR descriptions with. The user's own instructions take precedence unless the text comes from managed settings, as Claude Code describes. OASIS adds no attribution by default, so `attribution: false`, empty strings and `includeCoAuthoredBy: false` change nothing; `sessionUrl` does not apply (no hosted sessions).
- Test: test/git-instructions-attribution.test.mjs (4, real git repositories); settings, headless, slash, eval and auto-commit suites pass (55 tests).

### claudeMdExcludes
- In a monorepo, a parent folder's CLAUDE.md written for another team was always loaded. `claudeMdExcludes` (globs or absolute paths, matched against the absolute path and the symlink target, merged from every settings file) now skips parent, project, local and user instruction files, `.claude/rules` files (always-on and path-scoped), and nested CLAUDE.md files loaded when the agent works in a folder. Instruction loading now waits for settings, so the session reads them in sequence rather than in parallel.
- OASIS does not follow symlinked rule files at all, so Claude Code's symlink case for rules does not arise.
- Test: test/claude-md-excludes.test.mjs (3); memory, rules and settings suites pass (43 tests).

### MCP server policy and .mcp.json approvals
- OASIS ignored all five keys, so a managed `deniedMcpServers` entry or a `disabledMcpjsonServers` rejection did nothing. Now `deniedMcpServers` and `allowedMcpServers` (by `serverName`, exact `serverCommand` or `serverUrl` with `*`; denial wins; `allowManagedMcpServersOnly` keeps only the managed allowlist) apply to every server source: user, project, plugin, `claude mcp add`, `--mcp-config`, agent files and servers started after an install.
- `.mcp.json` approvals follow the [settings reference](https://code.claude.com/docs/en/settings-reference.md): `disabledMcpjsonServers` rejects from any file; `enableAllProjectMcpServers` and `enabledMcpjsonServers` from user, `--settings` or managed settings start those servers in an untrusted workspace. A trusted workspace still starts every `.mcp.json` server, because OASIS has no per-server approval prompt.
- Not done: Claude Code's exemptions for built-in servers and `managed-mcp.json`, which OASIS does not have.
- Test: test/mcp-policy-settings.test.mjs (8); MCP, settings, plugin and subagent suites pass (58 tests).

### Hook policy settings
- Listed the 248 keys in Claude Code's [settings reference](https://code.claude.com/docs/en/settings-reference.md) and checked each name against `src/`; about 175 never appear. Many are Anthropic-account, desktop or UI keys. The hook policy keys came first because a user who sets them expects hooks to stop, and OASIS ran them anyway.
- `disableAllHooks` (last scope wins; managed is separate and removes everything), `allowManagedHooksOnly` (managed only), `allowedHttpHookUrls` and `httpHookAllowedEnvVars` (merged arrays). Agent front-matter hooks are refused while hooks are restricted. Plugins force-enabled by managed `enabledPlugins` are not exempted, because OASIS has no managed force-enable; their hooks stop too.
- Test: test/hook-policy-settings.test.mjs (7); hooks, settings and subagent suites pass (78 tests).

### Model-switch and DirectoryAdded hooks
- Compared the event list in Claude Code's [hooks reference](https://code.claude.com/docs/en/hooks.md) with the `runHooks` call sites. All 33 event names were accepted in settings, but `PreModelSwitch`, `PostModelSwitch` and `DirectoryAdded` were never fired, so a Claude Code user's hooks for them silently did nothing.
- New src/model-switch.mjs: `/model` (source `command`) and ACP `session/set_config_option` (source `sdk`) run PreModelSwitch with the documented input and decisions, and PostModelSwitch in the background with its output queued for the next request. Canonical names: aliases, `[1m]`, dates, Bedrock and gateway prefixes are stripped; non-Claude models get no canonical name and run every hook, as the docs describe for unknown ids. The cost estimate uses OASIS's price catalog and the last main-conversation response's usage.
- `/add-dir` now fires DirectoryAdded (`slash_command`). While wiring it, found that a folder added mid-session was not added to the sandbox's writable list; fixed.
- Not done: Claude Code's `auto` and `resume` PostModelSwitch sources. OASIS's fallback chain changes the model for one request only (Claude Code skips the hook for that case too), and resume restores the configured model rather than a saved one.
- Tests: test/model-switch-hooks.test.mjs (7) and an ACP case in test/acp.test.mjs; hooks, slash and add-dir suites pass (70 tests).

## 2026-11-11 (frontier-platform cycle: competitor gaps)

### App Server shell commands, remote diff, config read; web archive

Added `thread/shellCommand` (behaviour taken from Codex's `thread_shell_command.rs` tests: own turn when idle, existing turn when active, `userShell` source), `gitDiffToRemote` (nearest remote-contained commit + diff with untracked files; verified by applying the diff to a fresh clone) and `config/read` (Codex `Config` shape, layers with redaction). Web workspace: Archive button in the "Other devices and terminal" list.

### OpenTelemetry GenAI conventions

Aligned model, tool and turn telemetry with the OpenTelemetry GenAI semantic conventions (client inference, execute_tool, invoke_agent, token metrics): standard metrics with recommended buckets, `finish_reasons` as an array, `server.*`, `error.type`, reasoning and cache-write tokens. Standard span names are behind `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` so existing `oasis.*` dashboards keep working. Telemetry is now documented in docs/CONFIGURATION.md. Tests: test/telemetry.test.mjs (9 pass).

### Shared archive state; parallel workstreams
- Owner asked for breadth over Codex-only work. Started three parallel agents in separate clones, each pushing to main: README redesign, Claude Code parity, and Cursor/Windsurf/Antigravity/OpenHands/Devin parity.
- Gap found: App Server `thread/archive` only affected `thread/list`; the web app, `/resume`, `--continue`, the recent-sessions menu and ACP `session/list` still showed archived sessions. All now hide them, with `oasis sessions archive|unarchive|list --archived` and `POST /api/sessions/:id/archive|unarchive`. Tests: test/commands.test.mjs, test/web.test.mjs, test/acp.test.mjs.
- Also added App Server `fuzzyFileSearch` and `thread/turns/list`.

### App Server skills, MCP status and signed tokens
- Added `skills/list` and `mcpServerStatus/list`. OASIS starts MCP servers per thread, not per process as Codex does, so the status list needs a loaded thread's `threadId` (or exactly one loaded thread).
- Added `--ws-auth signed-bearer-token`, following the checks in Codex's `codex-rs/websocket-auth/src/lib.rs`: HS256 only, `exp` required, `nbf` honoured, optional issuer and audience, 30 seconds of default clock skew, and a secret of at least 32 bytes. Verified with Node's `crypto` (HMAC and constant-time compare), so there is no new dependency. The test signs tokens and checks the reasons for refusal, plus a real WebSocket handshake: 401 for expired or wrongly signed tokens, open for a good one.
- Full suite at 59156d95: 2535 tests, 2527 pass, 0 fail, 8 skipped. A rerun covering later commits is in progress.

### App Server thread management
- Compared the client methods in Codex's `common.rs` (187) with OASIS. Most of the 162 missing ones are tied to OpenAI accounts or products: accounts, remote control, realtime voice, ChatGPT projects and plugin sharing. Added the ones that make sense for a local agent: `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/unsubscribe`, `thread/loaded/list` and `thread/compact/start`, plus the `archived`, `searchTerm` and `excludedThreadIds` filters on `thread/list`. Shapes follow `v2/thread.rs`.
- Codex dropped `delivery: "detached"` for reviews (its docs now say to start a thread and review on it), so that checklist item is closed as not needed.
- Bug found while writing the test: `thread/name/set` set `session.name`, but saving reads `session.sessionName`, so App Server renames were lost on restart. Fixed; the archive test reads the name back from disk.

### Asking the user over ACP and the App Server
- OASIS's `ask_user_question` tool only reached the terminal and the web app. Editors on ACP and Codex App Server clients never saw it, because the tool is hidden when nobody can answer.
- ACP: the unstable `elicitation/create` form from the [ACP schema](https://agentclientprotocol.com/protocol/schema), sent only when `clientCapabilities.elicitation.form` is set. The choices go in an `answer` field with `oneOf` (single choice) or `anyOf` items (multi-select), plus an optional free-text `other` field. The form uses the session scope with the tool call ID. Only `accept` counts as an answer.
- App Server: Codex's experimental `item/tool/requestUserInput` (`codex-rs/app-server-protocol/src/protocol/v2/item.rs`), sent only when `capabilities.experimentalApi` is true, as Codex gates experimental methods.
- Tests: an ACP test with an accepted and a declined form, checking what the model receives; two App Server tests (answered, and the tool hidden without experimentalApi).

### Codex App Server Unix socket
- Read `codex-rs/app-server-transport/src/transport/unix_socket.rs`. Codex serves the WebSocket protocol over a Unix socket at `$CODEX_HOME/app-server-control/app-server-control.sock` (folder 0700, socket 0600). It refuses a live socket and removes a stale one.
- OASIS now does the same with `--listen unix://[PATH]`, reusing the WebSocket transport through Node's `http.listen(path)`. The default path is under the OASIS config folder. Codex's daemon pieces (startup lock, rendezvous symlink, `daemon_shutdown`) were not ported: OASIS has no app-server daemon mode.
- Test: a real stale socket (a child process killed with SIGKILL while listening), a live-socket refusal, a non-socket file left in place, the permission modes, and `initialize` over `ws+unix://`. Also checked by hand with the CLI: the socket is removed on SIGTERM.

### Skill catalogue budget
- `loadSkillDescriptions` cut the joined list at 16,000 characters, so a large install could end in half a description, and the model was not told that more skills existed. `fitSkillCatalogue` now keeps whole lines and finishes with "(N more skills not listed; call list_skills to see them all)". Test: test/skill-catalogue-budget.test.mjs.

### ACP session lifecycle and App Server fs/exec
- ACP: `session/list`, `session/resume`, `session/close`, `session/delete`, `logout`, `session/set_config_option` (mode, model), `usage_update` and `session_info_update`, checked against the [ACP v1 schema](https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json). Every method in the ACP schema is now handled. For `$/cancel_request`, the SDK (2.5.0) aborts a per-request signal that OASIS had ignored, so a cancelled `session/prompt` kept running. The prompt now follows that signal and answers `stopReason: "cancelled"`. A test holds the model reply open and sends `$/cancel_request`; without the fix it hangs.
- App Server: `fs/*` and `command/exec*` in `src/codex-app-server-host.mjs` (14 tests), limited to the workspace folders and run through the sandbox.
- Full suite before this cycle's changes: 2515 tests, 2507 pass, 0 fail, 8 skipped.

### Gaps checked and found already closed (no change)
- "The web app polls job status every 350 ms": out of date. `app/main.mjs` long-polls `/api/jobs/:id?after=&wait=20000`.
- Hermes-style self-improving skills: `skill_propose` with `update: true` exists in `src/learning.mjs`.
- DeepSeek Harness in-process code plugins ("everything is a plugin", Cordis): not adopted on purpose. OASIS keeps declarative plugins plus MCP servers in separate processes, so a plugin cannot run code inside the agent process.

### Still blocked
- Comparative benchmarks against other agents need a model API key. The sandbox (2 CPUs, 7 GB RAM) is too slow for fair local-model runs. No results are claimed.

### Codex App Server over WebSocket
- Implemented the transport described in the [Codex App Server docs](https://learn.chatgpt.com/docs/app-server): `--listen ws://IP:PORT`, one message per text frame, `/readyz` and `/healthz`, 403 when an `Origin` header is present, and `--ws-auth capability-token` with `--ws-token-file` or `--ws-token-sha256`, checked during the handshake. One deliberate difference: OASIS will not listen beyond loopback without auth. New dependency: `ws` 8.22.2 (MIT, no dependencies of its own). Node has no built-in WebSocket server. Test: test/codex-app-server-ws.test.mjs spawns the real CLI and runs a turn with a command approval over the socket. It also checks 401 with no token or a wrong token, 403 for a browser Origin, a second connection that starts uninitialized, and a clean SIGTERM exit. Not done: signed bearer tokens and Unix sockets.
- Full suite at 09fb0288: 2497 tests, 2489 pass, 0 fail, 8 skipped.

### RRULE routines (DeepSeek Harness comparison)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) schedules accept a bounded RFC 5545 profile (one DTSTART line and one RRULE line, with a minute floor), backed by the `rrule` npm package. OASIS had cron, plain phrases, intervals and one-offs. Added src/rrule.mjs, a dependency-free evaluator that uses Intl time zones the same way croner does for cron routines, so DST behaviour matches: wall-clock time is kept, skipped times move forward, and repeated times run once. Wired into parseSchedule, nextOccurrence, the catch-up window, and completion when COUNT or UNTIL runs out. Updated the CLI help, routine_manage, the web placeholder and the user guide.
- Verification: test/rrule.test.mjs (9 cases, including DST in New York, Feb 29, Thanksgiving and month ends) and an RRULE routine lifecycle test in test/routines.test.mjs. A differential check against `rrule@2` (installed in /tmp only, not a project dependency) over 4,500 random UTC rules from three seeds found 0 mismatches with sorted BY* lists. With unsorted BYMINUTE lists, `rrule` returns only the last minute; OASIS sorts them.

### Crash-safe task progress (OpenHands comparison)
- [OpenHands' agent architecture](https://docs.openhands.dev/sdk/arch/agent) runs each step atomically from its event history, so a conversation can be paused and resumed between steps. In OASIS only the terminal saved a conversation mid-turn. If `oasis web`, `oasis -p` or `oasis app-server` stopped mid-task, everything since the last finished turn was lost from the conversation, even though files had already changed. The mid-turn saver is now shared (`saveMidTurn` and `settleMidTurnSave` in src/sessions.mjs) and used by all four entry points. While wiring it in, a bug showed up: the callback fires before the tool result joins history, so the old saver missed the last step of a turn. The save now trails the step. Tests: test/web-midturn-save.test.mjs (it reads the session from disk while the second model request is in flight) and test/session-midturn.test.mjs.
- Mid-turn snapshots now carry a `turnInProgress` mark (the request text and the time). A session restored with the mark gets a one-time `<interrupted-turn>` note on its next turn, the same recovery prompt that subagents already received after a restart (`interruptedTurnNote` in src/agent.mjs).
- Full suite before this change: 2489 tests, 2481 pass, 0 fail, 8 skipped.

### Antigravity subagents (docs read)
- From [antigravity.google/docs/subagents](https://antigravity.google/docs/subagents/): agents are Markdown files with YAML front matter in `.agents/agents/` or `~/.gemini/config/agents/`, with Antigravity tool names, `subagent`/`mainAgent` flags, flash/pro tiers, `commandExecutionPolicy`, inherited safety settings, idle subagents woken by messages, and worktree isolation. OASIS already had parallel subagents, `send_message` wake-ups, worktree isolation and inherited permissions. The gap was reading the definition files. Added the folders and field mapping.
- Cursor's search page ([cursor.com/docs/agent/tools/search](https://cursor.com/docs/agent/tools/search)) now describes a local regex index (Instant Grep) and an Explore subagent, and says Cursor does not store embeddings for search. OASIS has ripgrep-backed grep, local semantic search and an explore subagent, so no work was needed here.

### Codex App Server protocol (source read)
- Read the method list at [learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server). Read the v2 types in `codex-rs/app-server-protocol/src/protocol/v2` (Apache-2.0): Thread, Turn, the ThreadItem variants, the approval params and decisions, and the notification payloads.
- `src/app-server.mjs` in OASIS turned out to be a static asset server for the web app, not a protocol server. Added `src/codex-app-server.mjs` and the `oasis app-server` command, built on the same runtime calls ACP uses (createSession, runAgentTurn, saveSession and steerSession).
- An end-to-end test drives the real CLI with a scripted model. It covers a command approval, a file diff, resuming in a fresh process and a declined approval.

### DeepSeek Harness schedule comparison (source read)
- Read `packages/schedule` in [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT). It has: delivery targets for an existing session, one reused new session (`new_once`) or a new session per run (`new`), so OASIS's fresh / `fromSession` / `chain` cover the same ground. It also has RRULE and daily/weekly selectors, optimistic `expectedUpdatedAt` edits, receipt retention (30 days / 200 records) and `deleteInactive()`. Adopted the last three ideas (no code copied). OASIS still lacks RRULE. 5-field cron with a time zone covers the common cases.

### Regression caught by the full suite
- `test/cli-help.test.mjs` ("oasis web leads with the one-click link") hung: after SIGTERM the in-process scheduler loop kept `oasis web` alive. Shutdown now stops the scheduler. `oasis gateway` hosts it only for a real gateway kind and stops it in `finally`, so usage errors still exit. Regression test: `oasis web exits on SIGTERM while hosting the routine scheduler`.

### Conversation routines
- Codex thread automations and Claude Desktop local tasks can continue context. OASIS routines now take `fromSession` + `chain`. `startBackgroundSession({ resumeId, fork: true })` passes `--resume ID --fork-session --session-id NEW` (the CLI already honoured a chosen id for a fork) and records NEW, so in-place resume races with an open terminal can't happen. After an `ok` run of a chained routine, `fromSession` moves to that run's session. Failed runs don't advance the chain.
- Found while testing: `spawnSync` against the in-process scripted model server deadlocks. The test uses async `execFile`.

### Webhook-triggered routines
- Hermes has webhook subscriptions and Claude Code routines can be triggered by API/GitHub events; OASIS routines were clock-only. New schedule type `event` (`webhook`): `receiveWebhook()` checks an HMAC-SHA256 signature over the raw body with timing-safe comparison, queues the payload, and `tick()` launches one run per event. Events wait behind an active run (cron slots are skipped instead, since a missed slot comes back; a missed event does not). Payload goes to a 0600 file plus a fenced `<webhook_payload>` block with closing tags stripped and an untrusted-data notice.
- Endpoint `/hooks/routines/rt-XXXXXXXX` in `src/web.mjs` sits before the access-key check, but the host check and failed-auth lockout still apply.

### Hosted scheduler and browser panel
- `hostScheduler()` runs `runDaemon` in-process for `oasis web` and `oasis gateway` unless another live scheduler owns `<config>/schedules/daemon.pid` or `OASIS_ROUTINES=off`. Ticks are serialized by the existing file lock, so the pid check is a courtesy, not the correctness guarantee.
- `GET/POST /api/routines` (token-authenticated, like `/api/mcp`) and a Settings → Routines section in `app/`. Script routines ask for browser confirmation before saving.
- Tests: `test/routines-hosted.test.mjs` (3).

### routine_manage tool
- Hermes exposes one `cronjob_manage` tool so the agent can schedule from natural language. OASIS now has `routine_manage` (deferred under "Background work"), a thin layer over `src/routines.mjs`. Every action that authorizes future unattended runs (create/edit/resume/run/remove) asks with `always=true`, so `--yes` does not skip it. Subagents get no approver and are refused. Pause/cancel/list/show need no approval. Create defaults the workdir to the session root. Risk medium, write capability, so plan mode denies it.
- Tests: `test/routine-manage-tool.test.mjs` (5).

### Competitor research (source-level)
- Hermes Agent cron ([docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)): durable jobs run by the gateway in fresh sessions, a single `cronjob_manage` tool, pause/resume/run/cancel/remove, catch-up windows (half the period, 2 min to 2 h), `no_agent` script jobs, `[SILENT]`, delivery to chat platforms, pre-dispatch config validation (`blocked_config`, no tokens spent), and no cron management inside cron runs.
- OASIS gap found: `/schedule` and `cron_create` live inside one session ("runs while this session stays open"). Nothing ran unattended.

### Changes
- Routines: `src/routines.mjs` + `src/cli-routines.mjs`, `oasis schedule|cron|routines`. Execution reuses `src/background-sessions.mjs` (no second execution path); delivery reuses the gateway token variables and `chunkText`; output goes through `redactSecrets`. State is file-based under `<config>/schedules` with a cross-process lock, so a daemon restart reconciles earlier runs instead of firing them twice. Interrupted or lost runs pause the routine (never re-run automatically).
- Found while testing: `redactSecrets()` returns `{ text, redacted }`, not a string; the first delivery attempt sent `[object Object]`. Fixed in the caller and covered by a test.

### Tests
- `test/routines.test.mjs` (13 tests): schedule parsing and time zones, catch-up window, lifecycle and name lookup, recursion guard, overlap skipping, one-shot completion, manual runs, interrupted-run pause, `blocked_config` recorded once, a real headless agent run against the scripted model delivering to a fake Telegram API, a `[SILENT]` script run, CLI flag handling, secret redaction.

## 2026-11-10 (completion mandate: baseline, busy-folder recovery, desktop app)

### CI runner shutdowns
- "Tests with a clean environment" ended twice with "The runner has received a shutdown signal" at the same point. Reproduced once locally at higher concurrency: the test runner and its wrapper were killed by a signal to their process group, while a process in another session survived. Running the suite under `setsid --wait` made the job pass, so some test signals the process group above the suite. The exact source is not yet identified (open item). Related hardening: background-session stop now checks the recorded process start time before signalling a stored PID.

### Desktop app
- Restored on the shared runtime (`desktop/`, Electron 45.2.3, electron-builder 26.18.0) without the retired phone-link code. Key storage uses Electron's async `safeStorage` API (the sync one is deprecated); Linux `basic_text` is treated as no key store. Found a real bug on the way: background sessions, syntax checks and plugin installs spawned `process.execPath`, which in Electron opens a second app window; they now get `ELECTRON_RUN_AS_NODE=1`.
- Verified on Linux x64: AppImage (179 MB) and deb (140 MB) build; the packaged app opens the workspace, connects Ollama by pasting its address, runs an approved terminal command; `apt install` then `apt remove` leaves nothing behind. Windows and macOS builds are checked by the new CI matrix only.

### Baseline
- Node 22.21.1, Linux x64, 2 CPU cores. Full `npm test`: 2,384 tests, 2,376 pass, 0 fail, 8 skipped (576 s). oxlint clean, `npm audit` 0 vulnerabilities. Patch/minor dependency refresh: same result (`859163c5`).

### Normal-user runs (local model)
- Clean HOME, `oasis connect http://localhost:11434`: detected Ollama, tested a real tool call and saved `qwen3:4b-instruct-2507-q4_K_M` in about a minute. Clear output.
- `oasis -p "fix slugify" --permission-mode accept-edits`: 14.5 min on CPU. The model's fix passed 1 of 2 tests; OASIS reported that `npm test` was not approved and nothing was verified, and printed how to allow it. Honest; the miss is the 4B model's.
- Web app: a task left running after its tab closed (by design) blocked every new tab with "This workspace already has an active task. Finish or cancel it", with no way to do either from that page.

### Changes
- `busyWorkspaceError()` in `web.mjs`: the 409 names the task holding the folder (or a running terminal command) and carries `activeJob`. The app turns it into **Open the running task** / **Stop it and send this**.

### Tests
- `test/app-runtime-busy-folder.test.mjs` (new), `test/cloud-workspace-lock.test.mjs` and `test/web.test.mjs` assert the named task and `activeJob`. Browser e2e: a second browser's send is turned away with the note, and its Open button attaches to the running task's approval. Checked by hand with the real local model: Open follows the live task; Stop-and-send cancels it and runs the new request with one user message.

### Blockers
- No hosted model key usable from the sandbox (keys pasted in chat are not put into commands; the secure form was declined). Same-model competitor benchmarks stay blocked; real-model runs use a CPU-only 4B model.

## 2026-11-09 (multiple devices on one task)

### Changes
- `RuntimeAgent.answeredHere()` races the local approval/question prompt against a long-poll watcher for that request's `approval_resolved` / `question_answered` event (or the job ending). Answered elsewhere: emits `answered_elsewhere`, posts nothing, and the app closes the card with a toast.
- Bug: `GET /api/sessions/:id` threw (500) for a session not on disk yet, so another browser could not open a task whose first turn was running. Now 404 with a clear message; listed live-only sessions carry `unsaved: true` and the page follows the job without fetching history.

### Tests
- Unit: approval answered on another device is not posted and the turn finishes (`test/app-runtime-resume.test.mjs`, 5/5). Server: missing session is 404 (`test/web-long-poll.test.mjs`).
- Browser e2e with two browser contexts: the second opens the running task from **Other devices and terminal**, sees the request and the approval, allows it; the first browser's card closes and shows "answered on another device". Pass, zero axe WCAG 2 A/AA violations, zero console errors.

## 2026-11-09 (accessibility gate)

- Browser e2e now fails on any axe WCAG 2 A/AA violation, not only colour contrast, and also audits the page with the docked approval open. Result: zero violations on welcome (dark, light, phone), approval open, finished task and sign-in.

## 2026-11-09 (runtime: long-poll job events)

### Changes
- `GET /api/jobs/:id?after=N&wait=ms` (wait capped at 25 s) holds the request until `emit()` adds an event; closing the request or the server releases it. Finished jobs and requests with events ready answer at once. Every terminal status change in `web.mjs` emits an event, so waking on events is sufficient.
- `RuntimeAgent.follow()` sends `wait=20000` and only pauses after a quick empty answer (an older server without `wait`). Replaces the fixed 350 ms poll: event latency drops from up to 350 ms to near zero and an idle task costs one request per 20 s instead of ~3 per second. SSE was considered; long polling keeps the client's event handling and resume logic unchanged and survives proxies that buffer streams.
- Test fakes parsed `after=` with `Number()`, which breaks with a following `&wait=`; they now use `parseInt` like the server.

### Tests
- New `test/web-long-poll.test.mjs` against a real server and scripted model: a long poll returns on the first event, holds ~300 ms with nothing new, is woken by answering an approval, and never holds a finished job.
- Related suites 278 pass, 0 fail; browser e2e pass.

## 2026-11-09 (web app: background tasks, docked approvals, reconnects)

### Changes
- Leaving a running task (New task, another chat, a server session) used to call `stopTurn`, which cancelled the job on the server. `RuntimeAgent.detach()` now aborts only the local follow loop; the job keeps running and the chat is saved with its job id. `follow()` posts no approval/answer and emits `detached` instead of `stopped`/`done`.
- `GET /api/sessions` marks running sessions with `jobId` and the original `prompt`. A brand-new conversation is not on disk until its first turn ends, so live agent jobs whose session is not listed yet are added as entries; before, the sidebar could not see a task another device had just started.
- Sidebar section **Other devices and terminal** lists server sessions not linked to a local chat; opening a running one shows the prompt and follows the job.
- Bug found by e2e: after a reload-resume, the in-memory `turnStart` stayed 0, so leaving the chat again saved `turnStart: 0` and returning dropped the user's request. `restoreChat` now restores `turnStart` when it resumes.
- Approval sheet docks over the chat column on screens ≥1100 px (no backdrop, `aria-modal=false`, positioned from the composer's rect via ResizeObserver, chat gets bottom padding). The modal backdrop blocked the sidebar, so a waiting task trapped the user. Phones keep the bottom sheet.
- Runtime client: reconnect backoff up to 5 s for ~70 tries with `reconnecting`/`reconnected` events; HTTP 401 says the browser is no longer signed in.

### Tests
- `test/app-runtime-resume.test.mjs`: detach posts no approval and no cancel, emits `detached` (4/4).
- Browser e2e: reload reattaches; `/api/sessions` reports one running session with job id and prompt; New task hides the approval; reopening the running task asks the same approval with the request shown once. Pass, axe contrast clean in dark, light, phone and sign-in.
- Related unit suites: 281 pass, 0 fail.

## 2026-11-09 (web app: sidebar, session recovery, remote sign-in, docs)

### Changes
- Web app: task sidebar (Codex / Claude Code-style) on screens 1100 px and wider, with running and "Needs you" dots, search and New task; Ctrl/Cmd+B toggles it (not inside the terminal, where Ctrl+B belongs to tmux). Glass topbar and composer, aurora background, icon suggestion cards, a conic sweep around the composer while a task runs. All motion is off under `prefers-reduced-motion`.
- Session recovery: `RuntimeAgent.send` was split into post + `follow()`. The tab saves the running job id and where the turn began; on reload `restoreChat` trims the half-drawn turn and `resume(jobId)` replays the job from the server. Approvals, questions and elicitations already answered in the event log are not asked again; none are asked for a job that is no longer live. Before, a reload mid-task lost the live view and the open approval until the job timed out.
- Remote sign-in: opt-in **Remember this device** keeps the access key in `localStorage` (default stays per-tab `sessionStorage`). A fresh `#token=` link replaces a remembered rotated key; a stored key the server rejects is deleted and the screen says it no longer works. **Sign out of this browser** in the command palette. The sign-in screen names the host and points to `oasis web key`.
- Fixed: the refactor briefly truncated `app/core/runtime.mjs` (lost `shellWords` and `RuntimeWorkspace`); caught by `test/runtime-engine.test.mjs` before commit.
- Connect hint lists NVIDIA NIM and OmniRoute (both presets were already present and verified in `providers.mjs`, `connect.mjs`, `provider-registry.mjs`).
- Docs: USER-GUIDE, INTERFACES and FIRST-RUN rewritten for the browser-only, remote-first product (no desktop or phone app). README gains "Use it from anywhere", provider key sources, and screenshots from the browser e2e run with honest captions; the earlier real-model screenshots are kept as `real-model-*.png` and linked from the runs table.

### Tests
- New `test/app-runtime-resume.test.mjs` (replay skips answered approval a1, asks open a2 once; finished job asks nothing; only running agent jobs are saved; bad ids ignored) and `test/app-runtime-device-key.test.mjs`.
- Browser e2e now reloads the page at the first approval and asserts the sheet comes back with the request shown once, and signs in from a fresh browser with Remember this device, then opens a second tab that reconnects without the link. Axe contrast clean in dark, light, phone and sign-in views.
- Full `npm test`: 2,335 pass, 0 fail, 8 skipped (before the doc/sign-in edits); after them, the 289 tests in README/docs/CI/app/runtime/web files pass, oxlint clean.

### Blockers and remaining issues
- No real-model run of the new interface yet: no provider key is available to the agent, and the user's personal credentials are deliberately not used. Screenshots come from the scripted-model e2e.
- Chat history still lives in browser IndexedDB per device; the server session store should become the source of truth so a second device sees the same chats.
- The job stream is 350 ms polling; SSE would cut latency and requests.
- Approvals still use the modal sheet rather than inline timeline cards.

## 2026-11-09

### Changes
- Runtime: MCP schemas over 12,000 characters go behind `tool_search` even with 25 or fewer tools. 16 plugins: 46 tools / 36.5k chars → 21 tools / 16.5k chars per request (`test/session-tools.test.mjs`).
- Runtime: after a verification round, the agent is told the user already saw its summary and adds only what the checks showed (`test/gate-names-stale-check.test.mjs`).
- Web app: steps behind an open approval say "Waiting for you" (browser e2e asserts it); the subagent list sits under the step that launched it.
- Web: removed `/api/github/status` and `/api/github/repos` (no caller, no test). The other `/api/*` endpoints without app callers (`extensions*`, `agent-monitor`, `provider/*`) stay: they are tested HTTP API.
- CLI decomposition: `src/cli-doctor.mjs` (doctor, update, uninstall), `src/cli-extensions.mjs` (mcp, extensions), `src/cli-sessions.mjs` (sessions, bg). `src/cli-setup.mjs` (setup, connect, first-run check). `src/cli.mjs` 4,111 → 3,075 lines. Terminal-state helpers (`askLine`, `approve`, `interactive`) are passed in, not imported.
- Docs: README rebuilt around two interfaces (terminal, web app) with real-model screenshots; BENCHMARKS gains a normal-user runs table.
- Plugins (Codex): MCP servers in Codex and Agent Plugins start from the plugin folder. Relative `cwd`, `./` commands and `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` resolve as Codex resolves them; MCP configs keep `cwd` through validation. Before, nexu-io/codex-slides' server looked for `./scripts/start-mcp.mjs` in the workspace.
- Plugins: a server that needs an unset option (n8n's `${user_config.n8n_url}`) says `needs n8n_url: run oasis plugin config …` instead of "Invalid URL". `missingPluginOptions` existed but nothing used it.
- MCP: start failures name the cause (program not on PATH, missing folder, missing Node/Python dependencies, port in use) without echoing stderr.
- Web app: a note lists tool servers that did not start, with the reason (browser e2e asserts it). Web sessions now use the server's `env`; they used to read `process.env`, ignoring `OASIS_CONFIG_DIR` passed to the server.
- CLI: `oasis add --help`/`-h`/bare `oasis add` print usage instead of starting the agent.
- Runtime: a first request rejected as too large without a stated window (DuckDuckGo gateway `ERR_INPUT_LIMIT`) now retries with the compact tool profile and prompt; before, OASIS stopped while Codex's smaller prompt fit (`test/context-overflow.test.mjs`).
- Benchmark harness: Codex 0.130 ignores `OPENAI_BASE_URL` and went to api.openai.com (401). `bench-live` now passes a `model_providers.bench` entry through `-c` (`test/bench-live.test.mjs`).

### Tests
- Full local `npm test` after the overflow and Codex harness fixes: 2,361 pass, 0 fail, 8 skipped. CI on 9733fbd3: quality, installer and desktop builds green.
- Full local `npm test` after the plugin and web changes: 2,358 pass, 0 fail, 8 skipped. Browser e2e passes (8 model requests, 1 approval).
- CI was red from 44b4a727 to a87c068e: one test still checked for the deleted `scripts/check-browser-app.mjs`, and four README tests pinned the old wording. Fixed in 4ce472a6; quality checks green again. Lesson: run the full `npm test` before pushing doc or file removals.
- Full local `npm test` before the fix: 2,362 tests, 2,350 pass, 4 fail (the README tests above), 8 skipped.

### Normal-user runs
- Fresh Linux install as a new user (clean HOME, `install.sh --yes --skip-setup`): 14 s, `oasis doctor` clean, PATH entry added. `oasis setup` opens with a paste-a-key prompt and three clear choices.
- Web app, gpt-oss-20b (Pollinations, free), Ask first: slugify fix + `node:test` test, 409 s, 2 approvals, 1 test passing.
- Codex plugins with `oasis add owner/repo --yes`: BuilderIO/skills, n8n-io/skills, DataDog/pup, NVIDIA/nvidia-kaggle (dual-format) installed, 78 skills. Codex-only: nexu-io/codex-slides started and added 38 tools after `pnpm install` in the plugin (pnpm 10; its workspace file needs it); Storybloq needs the `storybloq` program; n8n's MCP server needs `n8n_url`.

### Blockers
- Free upstreams for a three-agent run: DuckDuckGo's gpt-oss-120b (through OmniRoute) accepts tool calls but drops streams (HTTP 502) and caps input; all three agents failed `clamp-integer` on it, so it is not used for results. Pollinations now needs a key; Cloudflare Playground needs a browser runtime in OmniRoute. OpenRouter free tier: 9 of 50 requests left until the daily reset. OmniRoute's `dva/*` models (Claude Opus 5, GPT-5.6) go through a Devin CLI bridge that needs a signed-in Devin install. NVIDIA build sign-up with the Proton address sent no verification email again (inbox and spam checked).

## 2026-11-08

### Changes
- Frontend consolidation, done: classic page removed (`index.html`, `assets/oasis-interface.css`, `assets/activity-artifacts.css`, `manifest.webmanifest`, `scripts/check-browser-app.mjs`). `/`, `/classic`, `/index.html` redirect to `/app/`; `sw.js` retires itself. `.github/scripts/browser-e2e.mjs` rewritten (972 → ~150 lines) against `/app/`: fix-bug task with approval, file checks, axe contrast dark/light/phone, screenshots. Passed locally (6 model requests). Dropped with classic, still to port: subagent monitor (`/api/agent-monitor`), cloud jobs (`/api/jobs`), GitHub status, local model list; `/api/extensions*` is superseded by Claude Code plugins.
- Frontend consolidation, step 1: MCP server management ported from the classic page (`/classic`) into the new workspace's Settings (`app/core/mcp.mjs`, `test/app-mcp-settings.test.mjs`). Checked live against `oasis web`: add, turn off, remove all update `mcp-servers.json`. Still classic-only: extensions install/update/rollback, subagent monitor, cloud jobs, GitHub status, system-profile recommendation, local model list.

- Benchmark: Claude Code through a gateway received only `ANTHROPIC_AUTH_TOKEN` and exited with "Not logged in" (Claude Code 2.1.319). `scripts/bench-live.mjs` now sets `ANTHROPIC_API_KEY` too. Regression test in `test/bench-live.test.mjs`.

- Config: `OASIS_BASE_URL` set without a model now names `OASIS_MODEL` and suggests `oasis connect <address>`. Test: `test/config-env-missing-model.test.mjs`.

### Tests
- Baseline full `npm test` at b5b6b9a6 on Node 22.20.0, Linux x64: 2,352 tests, 2,344 pass, 0 fail, 8 skipped (722 s).

### Benchmarks
- First valid same-model head-to-head: OASIS vs Claude Code 2.1.319 through OmniRoute, upstream `nvidia/nemotron-3-ultra-550b-a55b:free` (OpenRouter free tier). `clamp-integer`: both pass (OASIS 44 s, Claude Code 121 s). `safe-relative-path`: both fail with the same async/realpath mistake, traced to an underspecified task, now fixed. One trial each, limited by the 50 requests/day free tier. Raw results: `bench/results/live-2026-11-08-omniroute/`.
- Earlier the same day: head-to-head OASIS vs Claude Code 2.1.319 through a local OmniRoute 3.8.53 gateway was wired up and smoke-tested on `clamp-integer`. No comparison result yet: the only connected upstream (keyless LLM7) returned "daily token quota exceeded" for every model, so neither agent reached the verifier. This is recorded as a blocker, not a result.

### Blockers
- Benchmark scale: the OpenRouter free tier allows 50 requests per day, roughly two task pairs. Cerebras requires a payment method before API access; Groq rejects disposable addresses; NVIDIA build sign-up is waiting on an email code.
- A usable upstream model for the benchmark. Google sign-in for an AI Studio (Gemini) key stops at a security-code challenge that needs the account owner.
- OmniRoute's Antigravity and Gemini-CLI OAuth providers are marked by OmniRoute as terms-of-service risks; not used, to avoid putting the Google account at risk.

### Known weaknesses (from audit)
- `src/agent.mjs` (about 5,000 lines; context-window discovery moved to `src/context-window.mjs`) and `src/cli.mjs` (3,075 lines on 2026-11-09, from 4,111) are still large; decomposition is ongoing.
- One browser front end (`app/`); the classic page was removed on 2026-11-08.
- No same-model, multi-trial published comparison against Claude Code yet.
