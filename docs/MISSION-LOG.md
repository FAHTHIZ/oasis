# Engineering mission log

A short, dated record of changes, tests, benchmark results, blockers and known
weaknesses. Newest first. Detailed user-facing notes go in the CHANGELOG.

## 2026-11-08

### Changes
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
- `src/agent.mjs` (about 5,000 lines; context-window discovery moved to `src/context-window.mjs`) and `src/cli.mjs` (4,111 lines) are monoliths; decomposition is ongoing.
- Two browser front ends exist: `index.html` (classic, 319 KB single file) and `app/` (newer workspace). Consolidation is pending.
- No same-model, multi-trial published comparison against Claude Code yet.
