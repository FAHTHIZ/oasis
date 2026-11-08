# Engineering mission log

A short, dated record of changes, tests, benchmark results, blockers and known
weaknesses. Newest first. Detailed user-facing notes go in the CHANGELOG.

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

### Tests
- Full local `npm test` after the plugin and web changes: 2,358 pass, 0 fail, 8 skipped. Browser e2e passes (8 model requests, 1 approval).
- CI was red from 44b4a727 to a87c068e: one test still checked for the deleted `scripts/check-browser-app.mjs`, and four README tests pinned the old wording. Fixed in 4ce472a6; quality checks green again. Lesson: run the full `npm test` before pushing doc or file removals.
- Full local `npm test` before the fix: 2,362 tests, 2,350 pass, 4 fail (the README tests above), 8 skipped.

### Normal-user runs
- Web app, gpt-oss-20b (Pollinations, free), Ask first: slugify fix + `node:test` test, 409 s, 2 approvals, 1 test passing.
- Codex plugins with `oasis add owner/repo --yes`: BuilderIO/skills, n8n-io/skills, DataDog/pup, NVIDIA/nvidia-kaggle (dual-format) installed, 78 skills. Codex-only: nexu-io/codex-slides started and added 38 tools after `pnpm install` in the plugin (pnpm 10; its workspace file needs it); Storybloq needs the `storybloq` program; n8n's MCP server needs `n8n_url`.

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
