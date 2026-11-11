# Engineering mission log

A short, dated record of changes, tests, benchmark results, blockers and known
weaknesses. Newest first. Detailed user-facing notes go in the CHANGELOG.

## 2026-11-11 (frontier-platform cycle: competitor gaps)

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
