# Engineering mission log

A short, dated record of changes, tests, benchmark results, blockers and known
weaknesses. Newest first. Detailed user-facing notes go in the CHANGELOG.

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
