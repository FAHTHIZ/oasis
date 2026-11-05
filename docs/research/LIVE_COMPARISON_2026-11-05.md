# Live head-to-head, 2026-11-05

Real runs, no mocks. Every agent used the same model ID (`gemini-flash-lite-latest`, a free-tier Google AI Studio key) through one local logging gateway, on the repository's own hidden-verifier eval tasks (`evals/tasks`). Raw summaries are in [`bench/results/live-2026-11-05/`](../../bench/results/live-2026-11-05/).

Read the caveats before quoting any number: 3 tasks and 1 trial per task is a smoke test, not a benchmark result, and the free tier was saturated (frequent 503 "high demand" and 429s).

## Agents

| Agent | Version | How it reached the model |
|---|---|---|
| OASIS | 1.1.0 (main, commits listed below) | OpenAI-compatible endpoint |
| Aider | 0.86.2 | `openai/` prefix, same endpoint |
| OpenCode | 1.19.5 | run 1: `@ai-sdk/openai-compatible`; run 2: its native `google` provider |
| Gemini CLI | 0.67.0 | native Gemini API (`GOOGLE_GEMINI_BASE_URL`) |
| Claude Code 2.1.286, Codex CLI 0.130.0 | installed | not run: neither can use a Gemini model, and no Anthropic or OpenAI account was available. Same-model numbers for them are not possible here. |

## Results

### Final run (after today's fixes)

| Agent | Passed | Median time | Notes |
|---|---:|---:|---|
| OASIS | 3/3 | 102 s | 72 successful model requests out of 90 (6 × 429, 12 × 503 retried). ~1.35 M input tokens (self-reported, cumulative across steps); about $0.14 at Gemini Flash-Lite list price (the free-tier key was not billed). |
| Aider | 2/3 | 6 s | 3 requests in total (one edit per task, no tool loop). Failed `taskflow-search`: kept 19 tests and added none, although the task says "add tests". |
| OpenCode (native Google provider) | 0/3 | — | Two tasks ended in HTTP 400 "Requests ending with a model turn are not supported" after an empty step; the third ended on a 503 without retrying. |
| Gemini CLI | not valid | — | The key's daily free-tier quota (500 requests/day) was used up when its turn came; every trial failed in about 2 s with HTTP 429. Its earlier result is below. |

### Morning run (OASIS before today's fixes)

| Agent | Passed | What happened |
|---|---:|---|
| OASIS | 0/3 | Two tasks gave up after 6 tries on 503s; on the third, Gemini returned `finish_reason: "function_call_filter: MALFORMED_FUNCTION_CALL"` with an empty message, and OASIS took that as the final answer. |
| Gemini CLI | 1/3 | Passed `taskflow-search` in 256 s; `clamp-integer` ran 396 s and exited without a JSON result; `safe-relative-path` failed the error-wording check. |
| Aider | 1/3 | Passed `clamp-integer`. |
| OpenCode (OpenAI-compatible provider) | 0/3 | HTTP 400 "Function call is missing a thought_signature": that path drops Gemini's thought signatures. OASIS keeps them. |

## What the runs found in OASIS, and the fixes (all on main)

| Finding | Fix |
|---|---|
| Gave up on 503 "high demand" after 6 tries | 8 patient retries with backoff (2/5/10/20/30/30 s), a visible retry line, `OASIS_PROVIDER_RETRIES` (584f74b) |
| Gemini parallel tool calls without `index` were merged into one broken call | Kept separate (65deb3a) |
| `MALFORMED_FUNCTION_CALL` with no content ended the task | Treated as a failed step (1113f06, app: e4505c8) |
| Gemini repeated the same malformed call on the identical request, 3 times in a row | Retry with a corrective note instead of resending the same request (be3477c). The `clamp-integer` rerun then passed 2/2 |
| An empty reply to a "make this change" request ended the turn | Continue nudge (1113f06) |
| "Add tests" requests could finish with no test file touched (every agent made this miss once) | Verification gate: the turn is not finished until a test file changes (2ecc051) |
| A cloud model behind a localhost gateway was reported as a free local model | Priced at list price (43a2b16, a8abc00) |
| A used-up daily quota error ended with "check the endpoint, model name, and tool-calling support" | Advice that fits the error (65b8c87) |

The eval set also had a defect: `safe-relative-path` checked for the word "escapes" in the error without saying so. All three agents that got that far failed only on that check, so the task now states the wording.

## Other measured comparisons (same machine)

| Measure | OASIS | OpenCode | Aider | Codex CLI | Claude Code |
|---|---:|---:|---:|---:|---:|
| `--version` start time | 117 ms | 483 ms | 838 ms | 44 ms | 10 ms |
| Install size | 88 MB | 409 MB | 580 MB | 215 MB | 231 MB |

- With Gemma 4 31B, OpenCode and Aider printed the model's raw `<thought>` text; OASIS hides it.
- Gemini CLI printed a raw stack trace to the user on each 503 retry; OASIS prints one retry line.
- Gemini CLI also sent requests to `gemini-3.8-flash` (its routing/classifier calls) during a run requested with `gemini-flash-lite-latest`, so it was not strictly single-model.

## What this does and does not show

- It shows OASIS working end to end with a weak, overloaded free model where it failed this morning, and that its verification loop catches misses ("add tests") that one-shot editing does not.
- It does not show OASIS beating Claude Code or Codex. Those agents could not run on the same model here. Public leaderboards use each vendor's own frontier model: for example, Claude Code with Opus 5.5 at 64.8% on [Terminal-Bench 4](https://hub.harborframework.com/datasets/terminal-bench/terminal-bench/4?tab=leaderboard&leaderboard=4-0-0), and Codex with GPT-6 Astra at 58.2% on the [September 2026 Terminal-Bench 4 run](https://www.smfclearinghouse.com/tests/terminal-bench-4-september-2026/).
- The cost of the verification loop is real: OASIS made 24× as many successful model requests as Aider (72 vs 3) for one more pass. With a paid frontier model, that trade-off needs measuring on more tasks.
- Next: 3 trials on 20 or more tasks once quota allows, and Claude Code and Codex on their own models next to OASIS on the same models.
