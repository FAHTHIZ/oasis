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
| Baseline: lint, audit, full test suite on Node 22 | done | oxlint 0 warnings; `npm audit` 0 vulnerabilities; 2,384 tests, 0 failures |
| Use the CLI as a new user (clean HOME) | done | `--help`, `doctor`, `connect` (Ollama) and a `-p` task with a local model |
| Use the web workspace as a new user | done | Connected a local model, ran tasks in two tabs; found the busy-folder dead end (fixed) |
| Current competitor scan (Claude Code, Codex, OpenCode, OpenHands) | doing | Claude Code 2.1.322, OpenCode 2.2.6, OpenHands 1.38.0 as of 2026-11-10 |

## 2. Fix and consolidate

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Reproducible bugs found while using the product | doing | Busy folder 409 dead end: fixed. Tests touching the real home folder (stale catalog, 155 leaked backups): fixed |
| Dependency refresh (patch/minor) | done | `859163c5`; undici 8 (major) deferred |
| Continue `src/agent.mjs` (5,105 lines) and `src/cli.mjs` (3,213) decomposition | open | Only with characterization tests first |

## 2b. Frontier-platform gaps (2026-11-11 cycle)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Durable scheduled routines (Hermes cron parity) | done | `oasis schedule`, `test/routines.test.mjs` (13 tests, real headless run + Telegram delivery) |
| Agent tool to manage routines (`routine_manage`, approval-gated) | done | `test/routine-manage-tool.test.mjs` |
| Routines in the web app and hosted by `oasis web` / `oasis gateway` | done | `test/routines-hosted.test.mjs` |
| Event-triggered routines (webhook fires a routine) | done | `test/routines-hosted.test.mjs` (webhook test) |
| Crash-safe mid-turn saves in web, headless and App Server turns | done | `test/web-midturn-save.test.mjs`, `test/session-midturn.test.mjs` |
| RFC 5545 RRULE routine schedules (DeepSeek Harness parity) | done | `test/rrule.test.mjs`, `test/routines.test.mjs` (RRULE lifecycle), differential check vs `rrule@2`: 0/4,500 mismatches |
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

## 2c. IDE-agent interoperability (Cursor, Devin Desktop/Windsurf, Antigravity, OpenHands)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Devin Desktop rule folders (`.devin/rules`, `.devin/global_rules.md`, `~/.devin/rules`), Windsurf global rules, `AGENT.md`, `AGENTS.local.md` | done | `test/other-agent-rules.test.mjs` (Devin Desktop test) |
| Cursor commands, Devin Desktop / Windsurf / Antigravity / Cline workflows as native slash commands | done | `test/foreign-commands.test.mjs`. Not done: Devin Desktop's scan of workflow folders in sub-folders, enterprise system workflow folders, Cursor team commands (server-side) |
| Agent ignore files (`.cursorignore`, `.devinignore`, `.codeiumignore` + global, `.geminiignore`, `.aiexclude`, `.aiderignore`) | done | `test/agent-ignore.test.mjs`. Not done: blocking shell commands (Cursor does not either), Cursor's default ignore list, Cursor's `.cursorindexingignore` (indexing only; OASIS has no remote index) |
| OpenHands microagents / skill files (always-on, `paths:`, keyword `triggers:`, task `/name`) | done | `test/openhands-microagents.test.mjs`. Not done: prompting for task-microagent `inputs`, OpenHands' public skills registry and installed-skills folder (`~/.openhands/skills/installed`, its own manifest) |
| Skill folders of Cursor, Codex, Devin Desktop/Windsurf, Antigravity, OpenHands | done | `test/foreign-skills.test.mjs` (also Antigravity plugin skills, `~/.gemini/{config,antigravity-cli}/plugins/*/skills`). Not done: Antigravity's parent-folder `.agents/skills` scan, keyword `triggers:` on OpenHands SKILL.md files (only on plain .md microagents) |
| Antigravity CLI global and plugin rules | done | `test/other-agent-rules.test.mjs` (Antigravity CLI test). Not done: Antigravity's 12,000-character per-rule cap (OASIS keeps its own limits) |
| Worktree setup: Cursor `.cursor/worktrees.json`, Windsurf `post_setup_worktree` | done | `test/worktree-setup.test.mjs`. Not done: Devin Desktop's newer `.devin/hooks.v1.json` (Claude-style hooks, owned by the hooks work), Cursor `.cursor/environment.json` (Cloud Agents run on Cursor's hosted VMs; blocked: hosted service), `.openhands/pre-commit.sh` (OpenHands writes it into `.git/hooks`; OASIS does not change the user's git hooks, and OpenHands now points to Stop hooks instead). `.openhands/setup.sh` is done (same test) |

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
| `permissions.blockReadsOutsideWorkingDirectories` / `blockWritesOutsideWorkingDirectories` (file tools, repository folders, worktree tools) | done | `test/block-outside-working-dirs.test.mjs` (3 tests); the sandbox read block is open |
| Model policy: managed `deniedModels` and `availableModelsMatch`; `modelOverrides` | done | `test/model-policy-settings.test.mjs` (5 tests); `enforceAvailableModels` needs nothing: OASIS always falls back to an allowed startup model |
| `alwaysThinkingEnabled` and `MAX_THINKING_TOKENS=0` | done | `test/always-thinking-setting.test.mjs` (3 tests); `true` is a no-op, as in Claude Code |
| `plansDirectory` (plan files from `exit_plan_mode`) | done | `test/plans-directory.test.mjs` (3 tests); trusted files only, and no plan file is written when unset |
| `worktree.symlinkDirectories`, `worktree.sparsePaths`, `worktree.baseRef` | done | `test/worktree-claude-settings.test.mjs` (4 tests, real git); OASIS keeps `head` as the default base |
| `skillOverrides`, `disableBundledSkills` / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`, `disableSkillShellExecution` | done | `test/skill-overrides-settings.test.mjs` (3 tests); OASIS skills have no inline shell, so the shell switch covers command files; ```` ```! ```` blocks are not supported |
| `sandbox.excludedCommands`, `filesystem.allowRead`, `credentials`, unix-socket/proxy keys | open | `allowUnsandboxedCommands` needs nothing: OASIS has no unsandboxed retry |

## 2e. Terminal-agent interoperability (Gemini CLI, OpenCode, Goose, Aider, Roo/Kilo/Cline)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Gemini CLI `.gemini/commands/**/*.toml` as native slash commands (`{{args}}`, `!{...}` with escaping, `@{...}` files and folders, namespaces) | done | `test/foreign-commands.test.mjs` (Gemini test). Not done: an interactive confirmation for each `!{...}` (OASIS uses workspace trust and permission rules instead), multimodal `@{image}`, `.gitignore` filtering inside `@{folder}` (agent-ignore files and sensitive paths are filtered), extension commands outside installed extensions |
| Gemini CLI `.gemini/agents` and OpenCode `.opencode/agents` agent files as native agents | done | `test/foreign-agents.test.mjs` (2 tests). Not done: OpenCode agents defined inline in `opencode.json` (`agent`/`agents` keys; `oasis import opencode` still covers `.opencode` files), per-pattern permission rules, nested OpenCode agent IDs (`team/reviewer`), `temperature`, model ids, Gemini remote A2A agents |
| Roo Code / Kilo Code custom modes, mode rules, Kilo agent folders, Roo global rules, `.roorules`, `.kilocode/rules`, `.roo/commands` | done | `test/roo-kilo.test.mjs` (2 tests). Not done: enforcing `fileRegex` edit limits, the `mcp`/`browser` groups, global `custom_modes.yaml` in VS Code storage, a command's `mode:` switch, Kilo `kilo.jsonc` `agent` / `instructions` keys. Cline memory bank is a prompt convention (files in `memory-bank/` read by custom instructions), so it needs no loader |

## 3. Competitive evaluation

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Same-model, multi-trial benchmark vs Claude Code / Codex / OpenCode | blocked | Needs a model key usable from the sandbox; only a local CPU model is available. No results will be claimed without runs. |

## 4. Desktop distribution (after core validation)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| Restore a desktop shell on the shared runtime | done | `desktop/` imports `src/web.mjs` directly; Electron and electron-builder live only in `desktop/package.json`. Child processes get `ELECTRON_RUN_AS_NODE` (`src/node-process.mjs`) |
| Windows, macOS (arm64, x64), Linux (AppImage, deb) installers in CI | doing | `release.yml` `desktop` matrix builds and launch-tests each one. Linux AppImage and deb built, launched and used locally (Ollama task, terminal); Windows and macOS verified only by CI |
| Secure credential storage, auto-update, clean uninstall | done (Linux verified) | OS key store via async `safeStorage`, 0600 fallback without a keyring; SHA256SUMS-verified updates per install kind; `apt install`/`apt remove` clean locally |
| Code signing (Apple Developer ID, Windows certificate) | blocked | Needs the owner's certificates; builds are ad hoc signed (macOS) or unsigned (Windows), documented in docs/DESKTOP.md |

## 5. README and documentation (last)

| Item | Status | Evidence / notes |
| --- | --- | --- |
| README revamp with real screenshots only | open | Do after the product and interfaces stabilise |

## Blockers

- **Model access for benchmarks.** Keys pasted in chat are not used from the
  shell; the secure credential form was declined twice. Real-user runs use a
  local Ollama model, which limits task difficulty and speed.
