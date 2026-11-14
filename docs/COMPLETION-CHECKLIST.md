# Completion checklist

The working list for the full-product completion mandate. Every item is either
done with evidence, in progress, open, or blocked with a reason. Update it in
the same commit as the work it describes. Detailed notes stay in
[MISSION-LOG.md](MISSION-LOG.md); user-facing notes go in the CHANGELOG.

Status: **done** (tested and pushed) · **doing** · **open** · **blocked**

## 1. Investigation

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Codex TypeScript SDK drop-in (`oasis exec --json`, `codexPathOverride`) | done | `test/codex-exec-json.test.mjs` (5 tests: spawns OASIS with the SDK's exact argv, prompt on stdin, resume by thread id, output schema, setup error). Also checked by hand with the published `@openai/codex-sdk` 0.167.1 (`codexPathOverride` → a shell wrapper for `oasis`): `run`, `runStreamed` with `outputSchema`, and `resumeThread` all worked against a scripted model. |
| Clone and inventory the repository | done | 2,865 commits, ~69k lines in `src/`, ~8k in `app/`, 458 test files (2026-11-10) |
| Read history, mission log, scorecard, architecture docs | done | Desktop (Electron) app retired in `3114f599` on 2026-11-09; browser-only since |
| Baseline: lint, audit, full test suite on Node 22 | done | oxlint 0 warnings; `npm audit` 0 vulnerabilities; 2,384 tests, 0 failures at the start. Re-run 2026-11-14 on Node 22.21.1: 3,292 tests, 3,284 pass, 8 skipped, 0 fail |
| Use the CLI as a new user (clean HOME) | done | `--help`, `doctor`, `connect` (Ollama) and a `-p` task with a local model |
| Use the web workspace as a new user | done | Connected a local model, ran tasks in two tabs; found the busy-folder dead end (fixed) |
| Current competitor scan (Claude Code, Codex, Gemini CLI, OpenCode, Aider) | done | Benchmarked versions are the latest published on 2026-11-14: Claude Code 2.1.325, Codex CLI 0.169.0, Gemini CLI 0.68.0, OpenCode 1.19.5 (npm `latest`), Aider 0.86.2 (PyPI). Feature comparison in [COMPARISON.md](COMPARISON.md) |

## 2. Fix and consolidate

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Reproducible bugs found while using the product | doing | Busy folder 409 dead end: fixed. `oasis doctor` ignoring the backup models saved by `oasis connect`: fixed, with a regression test. Terminal reply bullet stranded above replies that open with a newline: fixed, with a regression test. Terminal-panel approval capturing keystrokes in the deny box: fixed, covered in the browser end-to-end test. `-p` printing only "Check util diff." after the verification gate: fixed, with a regression test. OmniRoute splitting a tool call's closing `}` into a nameless call: fixed, with a regression test built from the captured stream. `/model` picker offering embedding, speech and image models: fixed, with a regression test. Silent headless model fallback, `[hook]`-tagged fallback notices, and FreeLLMAPI's body-only "Soonest reset ~Ns" ignored: fixed, with regression tests. Tests touching the real home folder (stale catalog, 155 leaked backups): fixed One-shot prompts with no provider exiting 0, and `oasis models` making an unauthenticated request when nothing was configured: fixed (`2c8f49b0`). `-C` with a missing folder showing a raw ENOENT: fixed (`64c7b527`). Setup rejecting qwen3:0.6b on Ollama because it intermittently wrote the probe tool call as reply text (measured 1 in 3), which the agent loop already handles; the same model then finished a real task: fixed (`c77d1eac`). The Ollama-with-no-models hint now names a model that fits the machine (`e0340709`, `0a8837c9`). Repeated empty searches now escalate the hint (`093ea945`). All have regression tests except the `0a8837c9` wording fix, which was checked in a PTY run. 14 November 2026: CI workflows calling a deleted script and an uncaught EPIPE in child stdin (`5743ce4d`); `git_diff`/`git_status` outside a repository returning 16 KB of git usage text (`e3e92872`); no follow-up when a requested test was missing (`04bf616c`); benchmark records calling a free cloud model "local" (`f7e4d0f0`); `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` ignored, sending the key to the vendor (`5922de48`); `--model` not satisfying the missing-model check (`f43ab04a`); API keys echoed back in provider error bodies printed in full (`2bcec33e`). All with regression tests that fail without the fix. |
| Dependency refresh (patch/minor) | done | `859163c5`; undici 8 (major) deferred |
| Dead-code removal (knip across src/, app/, ide/, desktop/, scripts/; each removal checked with `rg` for dynamic imports and string references) | done | Unused exports and re-exports removed, and 231 module-internal helpers un-exported: `test/dead-exports.test.mjs`. Stale doc references to removed files: `test/docs-file-references.test.mjs`. The five "unused" dependencies knip lists are loaded dynamically (`@highlightjs/cdn-assets`, `lowlight`, `@vscode/ripgrep`, `@xterm/*` via `scripts/vendor-terminal.mjs`) and stay |
| FreeLLMAPI as a built-in gateway; gateway key variables; windows from loopback gateways; `cost_known`; one local-port list; missing key masks | done | `2c729bed`: `test/pricing-gateway.test.mjs`, `test/api-key-helper.test.mjs`, `test/local-context.test.mjs`, `test/app-connect.test.mjs`, `test/flags.test.mjs`, `test/eval.test.mjs`, `test/secret-shield.test.mjs` |
| Continue `src/agent.mjs` and `src/cli.mjs` decomposition | done (stopped deliberately) | The model-request pipeline (timeouts, stream restarts, fallback, tracing, raw request, connection test) moved to `src/agent-request.mjs` and the help text to `src/cli-help.mjs`, unchanged: identical export list, byte-identical `--help`, a scope check with no unresolved names, and the full suite (3,226 tests). `agent.mjs` 5,589 → 4,700 lines, `cli.mjs` 3,634 → 3,404. Subagents, specialist reviews, workflows and task dispatch moved to `src/agent-subagents.mjs` (977 lines; `agent.mjs` → 3,751) with the same checks. The 311-line flag loop in `cli.mjs` `main` is now `parseMainFlags(rawArgs, flags)` (`main` 764 → 457 lines; references to `main`'s locals rewritten by scope analysis). `runAgentTurnRaw`'s 202-line per-call result loop is `applyToolResults(session, options, turn)` (the function 903 → 704 lines); a check confirmed no closure outside it reads the five values it reassigns while it runs. Stopped there on purpose: the model-request step of `runAgentTurnRaw` reads and writes about ten loop locals (streamed text, token totals, timing, step counters) through callbacks, so extracting it would mean passing a mutable state object around, with regression risk and no behavior gain. The remaining long functions (`createSession`, `interactive`, `runPrompt`) are mostly factory closures of the same kind |

## 2b. Frontier-platform gaps (2026-11-11 cycle)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Durable scheduled routines (Hermes cron parity) | done | `oasis schedule`, `test/routines.test.mjs` (13 tests, real headless run + Telegram delivery) |
| Agent tool to manage routines (`routine_manage`, approval-gated) | done | `test/routine-manage-tool.test.mjs` |
| Routines in the web app and hosted by `oasis web` / `oasis gateway` | done | `test/routines-hosted.test.mjs` |
| Event-triggered routines (webhook fires a routine) | done | `test/routines-hosted.test.mjs` (webhook test) |
| Crash-safe mid-turn saves in web, headless and App Server turns | done | `test/web-midturn-save.test.mjs`, `test/session-midturn.test.mjs` |
| RFC 5545 RRULE routine schedules (DeepSeek Harness parity) | done | `test/rrule.test.mjs`, `test/routines.test.mjs` (RRULE lifecycle); expansion by `rrule-temporal` 2.2.8 (adds BYSETPOS, BYWEEKNO, BYYEARDAY) |
| Webhook event filters (GitHub `event.action`, ping) | done | `test/routines-hosted.test.mjs` |
| Routine results review in the browser (Codex Triage parity) | done | `test/routines-hosted.test.mjs` (runs endpoint) |
| Routine history retention, stale-edit conflicts, prune finished | done | `test/routines.test.mjs` (bounded history) |
| Antigravity custom agent folders and front matter | done | `test/subagent-definitions.test.mjs` (Antigravity) |
| Codex App Server protocol (core: threads, turns, items, approvals over stdio) | done | `test/codex-app-server.test.mjs` |
| Codex App Server thread/fork (with lastTurnId) | done | `test/codex-app-server.test.mjs` (fork) |
| Codex App Server review/start (inline) | done | `test/codex-app-server.test.mjs` (review) |
| Codex App Server WebSocket transport (`--listen ws://`, /readyz, /healthz, Origin 403, capability-token auth) | done | `test/codex-app-server-ws.test.mjs` |
| Codex App Server `fs/*` and `command/exec` (+ write, resize, terminate, outputDelta) | done | `test/codex-app-server-host.test.mjs` (14 tests: root confinement, symlink escape, read-only, watch, streaming, cap, PTY, sandbox launcher) |
| Codex App Server: Unix-socket transport (`--listen unix://[PATH]`) | done | test/codex-app-server-ws.test.mjs |
| Codex App Server: thread archive/unarchive/delete/unsubscribe/loaded list/compact | done | `test/codex-app-server.test.mjs` (lifecycle test) |
| Codex App Server: `skills/list`, `mcpServerStatus/list` | done | `test/codex-app-server.test.mjs` |
| Codex App Server: detached review | not needed | Codex removed `delivery: "detached"`; its docs say to start a thread and review on it, which OASIS supports |
| Codex App Server: signed bearer tokens | done | `test/codex-app-server-ws.test.mjs` (HS256 JWT checks and a 401/open handshake) |
| ACP stable session lifecycle (list, resume, close, delete, config options, usage and title updates) | done | `test/acp.test.mjs` (lifecycle test against a real `oasis acp` process) |
| ACP elicitation (`ask_user_question` as an `elicitation/create` form) | done | `test/acp.test.mjs` (accepted and declined forms) |
| Codex App Server `item/tool/requestUserInput` for `ask_user_question` (experimentalApi clients) | done | `test/codex-app-server.test.mjs` |
| Plain daily/weekly schedule phrases (DSH `daily`/`weekly` selectors) | done | `test/routines.test.mjs` (plain calendar phrases) |
| Routines that continue an existing conversation (Codex thread automations) | done | `test/routines.test.mjs` (chained fork e2e). Runs fork with `--resume ID --fork-session --session-id NEW`, so the original session file is never written. |
| OpenTelemetry GenAI semantic conventions (spans, metrics, opt-in span names) | done | `test/telemetry.test.mjs` (collector checks names, buckets, attributes) |
| Codex App Server `fuzzyFileSearch`, `thread/turns/list` | done | `test/codex-app-server.test.mjs` |
| Codex App Server `thread/shellCommand`, `gitDiffToRemote`, `config/read`, `hooks/list`, `account/read` | done | `test/codex-app-server.test.mjs` (shell turn, failure, timeout, next-turn context, plan refusal; config shape and redaction), `test/codex-app-server-host.test.mjs` (diff applies cleanly to a clone) |
| Archived sessions hidden from every resume surface (CLI, web, ACP, App Server) | done | `test/commands.test.mjs`, `test/web.test.mjs`, `test/acp.test.mjs` |
| Browser-only web chats copied into the server session store on connect (`POST /api/sessions/import`, one copy per chat, text turns only) | done | `test/web-import-browser-chats.test.mjs` (3 tests). Not done: copying the browser's tool steps |

## 2c. IDE-agent interoperability (Cursor, Devin Desktop/Windsurf, Antigravity, OpenHands)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Devin Desktop rule folders (`.devin/rules`, `.devin/global_rules.md`, `~/.devin/rules`), Windsurf global rules, `AGENT.md`, `AGENTS.local.md` | done | `test/other-agent-rules.test.mjs` (Devin Desktop test) |
| Cursor commands, Devin Desktop / Windsurf / Antigravity / Cline workflows as native slash commands, including Devin Desktop workflow folders in sub-folders (4 levels, dependency folders skipped) | done | `test/foreign-commands.test.mjs`. Not done: enterprise system workflow folders, Cursor team commands (server-side) |
| Agent ignore files (`.cursorignore`, `.devinignore`, `.codeiumignore` + global, `.geminiignore`, `.aiexclude`, `.aiderignore`) | done | `test/agent-ignore.test.mjs` (patterns matched by node-ignore, checked against `git check-ignore`). Not done: blocking shell commands (Cursor does not either), Cursor's default ignore list, Cursor's `.cursorindexingignore` (indexing only; OASIS has no remote index) |
| OpenHands microagents / skill files (always-on, `paths:`, keyword `triggers:`, task `/name` with its `inputs` and `${VAR}` placeholders listed and asked for) | done | `test/openhands-microagents.test.mjs`. Not done: OpenHands' public skills registry and installed-skills folder (`~/.openhands/skills/installed`, its own manifest) |
| Skill folders of Cursor, Codex, Devin Desktop/Windsurf, Antigravity, OpenHands | done | `test/foreign-skills.test.mjs` (3 tests; also Antigravity plugin skills, `~/.gemini/{config,antigravity-cli}/plugins/*/skills`). `.agents/skills` in folders above the workspace up to the git root load too (nearer wins, the workspace's own folder wins). SKILL.md files with OpenHands `triggers:` are also added to the message on a keyword match (`test/openhands-microagents.test.mjs`) |
| Antigravity CLI global and plugin rules | done | `test/other-agent-rules.test.mjs` (Antigravity CLI test). Not done: Antigravity's 12,000-character per-rule cap (OASIS keeps its own limits) |
| Worktree setup: Cursor `.cursor/worktrees.json`, Windsurf `post_setup_worktree` | done | `test/worktree-setup.test.mjs`. Not done: Devin Desktop's newer `.devin/hooks.v1.json` (Claude-style hooks, owned by the hooks work), Cursor `.cursor/environment.json` (Cloud Agents run on Cursor's hosted VMs; blocked: hosted service), `.openhands/pre-commit.sh` (OpenHands writes it into `.git/hooks`; OASIS does not change the user's git hooks, and OpenHands now points to Stop hooks instead). `.openhands/setup.sh` is done (same test) |
| Cursor Cloud Agents API (REST v1 and v0) on `oasis web` | done | `test/cursor-agents-api.test.mjs` (real HTTP against the server with the scripted model): Bearer and Basic auth, wrong key 401, DNS-rebinding 421, lockout 429; create → FINISHED with `result`, `durationMs` and usage; pagination; `agent_id_conflict`; follow-up, `agent_busy`, steer (`steered` with the prompt reaching the turn, and `queued`), cancel and `run_not_cancellable`; archive, unarchive, delete; SSE stream with `tool_call`, `result` and `done`, `Last-Event-ID` resume and `invalid_last_event_id`; 4xx for other repositories, wrong `startingRef`, PR, branch, `envVars`, MCP, subagent, cloud env, image URL and model params; v0 launch, status with summary, conversation, follow-up, stop and a `statusChange` webhook with its HMAC signature checked by a local receiver, including one retry; records survive a restart. Not done: pull requests, branch creation, cloning other repositories, Cursor environments, `envVars`, inline MCP servers and subagents, artifacts, environment, secret and sub-token endpoints, `interaction_update` and `thinking` stream events; not tested against Cursor's own SDK or a Cursor-built client |

## 2d. Claude Code parity (2026-11-11 cycle)

Gaps found by checking the [hooks reference](https://code.claude.com/docs/en/hooks.md), settings, SDK and changelog against `src/`.

| Item | Status | Evidence / notes |
| --- | --- | --- |
| `PreModelSwitch` / `PostModelSwitch` hooks fired on `/model` and ACP model changes (cost fields, canonical-name matcher, ask/deny, timeout blocks) | done | `test/model-switch-hooks.test.mjs`, `test/acp.test.mjs` (sdk source) |
| `DirectoryAdded` hook on `/add-dir`; sandbox writable folders updated | done | `test/model-switch-hooks.test.mjs` |
| Hook policy settings: `disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`, `httpHookAllowedEnvVars` | done | `test/hook-policy-settings.test.mjs` (7 tests, includes a real HTTP server) |
| MCP policy settings: `allowedMcpServers`, `deniedMcpServers`, `allowManagedMcpServersOnly`; `.mcp.json` approvals `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` | done | `test/mcp-policy-settings.test.mjs` (8 tests, real stdio servers) |
| `claudeMdExcludes` for instruction files, rules and nested CLAUDE.md | done | `test/claude-md-excludes.test.mjs` (3 tests) |
| `includeGitInstructions` / `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`; `attribution.commit` / `attribution.pr` | done | `test/git-instructions-attribution.test.mjs` (4 tests); `sessionUrl` not applicable |
| Claude Code sandbox keys: `network.allowedDomains`/`deniedDomains`/`allowManagedDomainsOnly`, `autoAllowBashIfSandboxed`, `failIfUnavailable`, `filesystem.allowWrite`/`denyWrite`/`denyRead` | done | `test/sandbox-claude-settings.test.mjs` (6 tests, real bubblewrap) |
| `permissions.blockReadsOutsideWorkingDirectories` / `blockWritesOutsideWorkingDirectories` (file tools, repository folders, worktree tools) | done | `test/block-outside-working-dirs.test.mjs` (3 tests); sandbox read block: `test/sandbox-read-block.test.mjs` (4 tests, real bubblewrap and a linked git worktree). The OS sandbox hides home and the user-file roots, then re-opens the working folders, PATH toolchains, `~/.agents/skills`, global git config files and a linked worktree's common `.git`. Not done: following git `[include]` files; OASIS keeps `~/.claude` and its config folder masked, so their skills are not re-opened |
| Model policy: managed `deniedModels` and `availableModelsMatch`; `modelOverrides` | done | `test/model-policy-settings.test.mjs` (5 tests); `enforceAvailableModels` needs nothing: OASIS always falls back to an allowed startup model |
| `alwaysThinkingEnabled` and `MAX_THINKING_TOKENS=0` | done | `test/always-thinking-setting.test.mjs` (3 tests); `true` is a no-op, as in Claude Code |
| `plansDirectory` (plan files from `exit_plan_mode`) | done | `test/plans-directory.test.mjs` (3 tests); trusted files only, and no plan file is written when unset |
| `worktree.symlinkDirectories`, `worktree.sparsePaths`, `worktree.baseRef` | done | `test/worktree-claude-settings.test.mjs` (4 tests, real git); OASIS keeps `head` as the default base |
| `skillOverrides`, `disableBundledSkills` / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`, `disableSkillShellExecution` | done | `test/skill-overrides-settings.test.mjs` (3 tests); OASIS skills have no inline shell, so the shell switch covers command files; ```` ```! ```` blocks are not supported |
| `sandbox.excludedCommands`, `sandbox.filesystem.allowRead` | done | `test/sandbox-excluded-allowread.test.mjs` (5 tests, real bubblewrap); OS backend only, not containers or SSH |
| Agent SDK `Query` controls (`interrupt`, `setModel`, `setPermissionMode`, `setMaxThinkingTokens`, `supportedModels`, `mcpServerStatus`, `close`) | done | `test/sdk-controls.test.mjs` (5 tests); no streaming-input mode, `rewindFiles`, `applyFlagSettings` or plugin/skill reload controls |
| PostModelSwitch `source: "auto"` for fallbacks | done | `test/fallback-chain.test.mjs` (1 new test); `source: "resume"` does not apply because resuming keeps the current model instead of restoring the saved one |
| ```` ```! ```` fenced shell blocks in commands/skills | done | `test/command-fenced-shell.test.mjs` (3 tests); the `shell: powershell` frontmatter key is not honoured |
| `spinnerVerbs` | done | `test/spinner-verbs-setting.test.mjs` (4 tests); terminal only, the web app has no spinner verb |
| `fileSuggestion` | done | `test/file-suggestion-setting.test.mjs` (4 tests): terminal `@` completion, and the web composer's `@` through `GET /api/file-suggestions` (real server, token checked) |
| `subagentStatusLine` | done | `test/subagent-status-line.test.mjs` (2 tests): payload with `columns` and `tasks` (id, type, agentType, status, description, label, startTime, model, effort, contextWindowSize, tokenCount, tokenSamples, cwd), `{"id","content"}` rows replace or hide `/tasks` rows and the running-subagent rows above the terminal prompt; trust and `disableAllHooks` gates. Not done: the web app's agent list does not run it |
| `sandbox.credentials` (`files`, `envVars`), `sandbox.filesystem.allowManagedReadPathsOnly` | done | `test/sandbox-credentials.test.mjs` (4 tests, real bubblewrap). `mask` entries are applied as `deny` (OASIS has no substituting egress proxy, so tools that need the secret stop working in the sandbox); `mask` from repository settings is ignored, as in Claude Code |
| Unix-socket/proxy keys (`allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup`, `httpProxyPort`, `socksProxyPort`) and the Unix-socket block they open | done | `test/sandbox-unix-sockets.test.mjs` (7 tests; live: a bubblewrap command reached a host socket before the fix and is refused after). macOS rules are unit-tested only (no Mac available) |
| Duplicated sandbox checks in `oasis doctor` (`src/cli-doctor.mjs`) and `/doctor` (`src/doctor.mjs`) | done | One `sandboxDoctor()` built on `resolveSandbox`. Fixed with it: `oasis doctor` reported bubblewrap for a `docker`/`podman`/`ssh` backend and ignored `allowManagedDomainsOnly` and proxy ports. The two reports keep different scopes (installation vs. live session) |
| Admin-required repository locks (managed `allowManagedDomainsOnly`, or `allowUnsandboxedCommands: false` from policy or `--settings`) and the deny-read lock | done | `test/sandbox-unix-sockets.test.mjs` (10 tests). Under the lock a repository's `excludedCommands`, `allowedDomains`, `allowWrite` and `additionalDirectories` (for commands) are ignored, and it cannot switch off a sandbox you enabled. `allowUnsandboxedCommands` only locks: OASIS has no unsandboxed retry |

## 2e. Terminal-agent interoperability (Gemini CLI, OpenCode, Goose, Aider, Roo/Kilo/Cline)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Gemini CLI `.gemini/commands/**/*.toml` as native slash commands (`{{args}}`, `!{...}` with escaping, `@{...}` files and folders, namespaces) | done | `test/foreign-commands.test.mjs` (Gemini test). Not done: an interactive confirmation for each `!{...}` (OASIS uses workspace trust and permission rules instead), multimodal `@{image}`, `.gitignore` filtering inside `@{folder}` (agent-ignore files and sensitive paths are filtered), extension commands outside installed extensions |
| Gemini CLI `.gemini/agents` and OpenCode `.opencode/agents` agent files, plus OpenCode / Kilo Code agents defined inline in `opencode.json(c)` / `kilo.json(c)` (`agent`/`agents` keys, `prompt`/`system`, `{file:...}` prompts), as native agents | done | `test/foreign-agents.test.mjs` (3 tests). Not done: per-pattern permission rules, nested OpenCode agent IDs (`team/reviewer`), `temperature`, model ids, Gemini remote A2A agents |
| Roo Code / Kilo Code custom modes, mode rules, Kilo agent folders, Roo global rules, `.roorules`, `.kilocode/rules`, `.roo/commands` | done | `test/roo-kilo.test.mjs` (2 tests). Not done: enforcing `fileRegex` edit limits, the `mcp`/`browser` groups, global `custom_modes.yaml` in VS Code storage, a command's `mode:` switch (Kilo `kilo.jsonc` `agent` keys load as agents and `instructions` as rules). Cline memory bank is a prompt convention (files in `memory-bank/` read by custom instructions), so it needs no loader |
| Goose `.goosehints` (global, git-root-down, nested) and recipes via `/recipe` | done | `test/goose.test.mjs` (3 tests). `user_prompt` and missing required parameters are asked for one at a time in the terminal and web app (non-interactive runs report them). Not done: `CONTEXT_FILE_NAMES`, full Jinja (only `{{ key }}` and `indent`), recipe extensions/sub-recipes/retry, `GOOSE_RECIPE_GITHUB_REPO` |
| OpenCode commands (Markdown and `opencode.json`) as native slash commands; OpenCode/Kilo `instructions` as rules | done | `test/foreign-commands.test.mjs` (OpenCode test), `test/config-instructions.test.mjs`. Not done: remote instruction URLs (no network fetch from config), OpenCode `agent`/`model` on commands, `/team/review` slash spelling (OASIS uses `/team:review`) |
| Aider `read:` files; Gemini `context.fileName` and just-in-time subfolder context files | done | `test/config-instructions.test.mjs` (Aider/Gemini test). Not done: Gemini ancestor search past the workspace for custom names, dropping `GEMINI.md` when `context.fileName` omits it, other `.aider.conf.yml` options (Aider's lint/test/auto-commit already have OASIS equivalents: auto-test, auto-commit, repo map) |

## 3. Competitive evaluation

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Same-model, multi-trial benchmark vs Claude Code / Codex / OpenCode | partial | Two 2026-11-14 runs on Kilo's keyless route, one trial per task, both cut short by its anonymous quota (429 `PROMOTION_MODEL_LIMIT_REACHED`, about 70–96 calls per window). Run 1: all five agents passed `clamp-integer` (`bench/results/live-2026-11-14-kilo-h2h-partial/`). Batch 1 (`929de0c4`, `bench/results/live-2026-11-14-h2h-b1/`): all four agents failed `taskflow-priority-sort` on a task flaw since fixed (`9e763b83`); `safe-relative-path`: OASIS and Claude Code passed, Codex was cut by a 429, OpenCode not reached. Smoke scale only: no ranking can be drawn |
| OASIS prompt-token use is the highest of five agents on `clamp-integer` (242,932 vs Codex 157,994, OpenCode 111,139; gateway counts) | explained | Not a harness defect. Base request is comparable (OASIS ~7.0k, Codex ~6.9k, OpenCode ~7.8k tokens). The jump is the model reading `test/runtime.test.mjs` (24,064 chars) whole at its 2nd call (OVH run trace), which every later request carries; Claude Code's Read would also return it whole (under 2,000 lines). The rest is request count: each extra round trip re-sends the context. The relay now names the tool behind the largest message (`adc35b81`) |
| Benchmark harness: quota stop, rate-limited trials excluded, progress saved per unit, message sizes recorded, partly-run tasks listed | done | `test/bench-live.test.mjs` (21 tests, with a fake upstream that returns Kilo's quota 429). `7f72d2e9`: a task only some agents ran was dropped from SUMMARY.md silently; it is now listed with each agent's outcome, still unscored |
| Gemini CLI in the same benchmark | doing | `bench:live --router` runs it through FreeLLMAPI's native `/v1beta` surface (`5ee05996`); smoke: passed clamp-integer in 17 s. Route for the full run: Gemini CLI → FreeLLMAPI → the recording gateway → Kilo, so the gateway logs Gemini's calls like the others'. FreeLLMAPI must have every other model disabled and its Gemini model map pointed at the benchmark model, or `auto` and Gemini CLI's helper calls can be served by a different free model. Extra translation layer is a fairness caveat |
| Live check of both routers with OASIS | done | FreeLLMAPI (source, 2026-11-14) and OmniRoute 3.8.53: `oasis -p` fixed a bug through each on the same free Nemotron model, 4 requests each; `docs/CONFIGURATION.md` |
| OASIS through OmniRoute vs FreeLLMAPI vs direct | done (smoke scale) | Two tasks, OVH gpt-oss-20b, one trial each: direct 2/2, FreeLLMAPI 1/1 scored, OmniRoute 0/2, then 1/2 after fixing its split tool-call tail and keepalive handling (`bench/results/routers-2026-11-14/e2e/`). Too small to rank the routes |

## 4. Desktop distribution (after core validation)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Restore a desktop shell on the shared runtime | done | `desktop/` imports `src/web.mjs` directly; Electron and electron-builder live only in `desktop/package.json`. Child processes get `ELECTRON_RUN_AS_NODE` (`src/node-process.mjs`) |
| Windows, macOS (arm64, x64), Linux (AppImage, deb) installers in CI | doing | `release.yml` `desktop` matrix builds and launch-tests each one. Linux AppImage and deb built, launched and used locally (Ollama task, terminal); Windows and macOS verified only by CI (all six desktop builds and launch tests passed on `1df1d9d9`, run 43597144664). No hands-on Windows or macOS test |
| Secure credential storage, auto-update, clean uninstall | done (Linux verified) | OS key store via async `safeStorage`, 0600 fallback without a keyring; SHA256SUMS-verified updates per install kind; `apt install`/`apt remove` clean locally |
| Code signing (Apple Developer ID, Windows certificate) | blocked | Needs the owner's certificates; builds are ad hoc signed (macOS) or unsigned (Windows), documented in docs/DESKTOP.md |

## 5. README and documentation (last)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| README revamp with real screenshots only | partial | `af1d2c8a`: hero labelled as an illustration (the demos are real recordings), test count, free-tier routers, a verified-vs-not status table. 2026-11-14: the same-model summary is in "Tested like a real user", and the README no longer lists Gemini CLI as head-to-head tested (smoke run only). Still partial: the benchmark sample is too small for a results table |

## Blockers

- **Model access for benchmarks.** Kilo's anonymous routes (also used through
  FreeLLMAPI and OmniRoute) ran out on 2026-11-14 after about 70 requests
  (`PROMOTION_MODEL_LIMIT_REACHED`, "sign up or come back later"). A free account
  key (Kilo, OpenRouter, Groq, Google AI Studio, Cerebras) from the owner would
  lift this; signing up is the owner's decision, not the agent's. Frontier paid models are still
  not used: no paid inference without the owner's permission.
