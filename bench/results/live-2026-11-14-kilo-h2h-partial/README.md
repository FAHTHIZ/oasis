# Live head-to-head, 2026-11-14 (partial: stopped by the provider's quota)

Five agents on one model through OASIS's recording relay (`npm run bench:live -- --upstream`), task-major order (`--interleave`), one trial, 900 s timeout, 18 s minimum gap between upstream requests.

- Upstream: Kilo Gateway, keyless (`https://api.kilo.ai/api/gateway/v1`). No account, no key, no charge.
- Model requested and served for every call: `nvidia/nemotron-3-ultra-550b-a55b:free` (provider field `Nvidia` on every 200 response; see `gateway.jsonl`).
- OASIS at `95586de7` (pinned worktree). Competitors: Claude Code 2.1.325, Codex CLI 0.169.0, OpenCode 1.19.5, Aider (pip, current on 2026-11-14).
- Planned: 12 tasks × 5 agents. Ran: task 1 for all five agents and task 2 for OASIS. At 08:13 UTC Kilo began answering every request with HTTP 429 `PROMOTION_MODEL_LIMIT_REACHED` and `x-should-retry: false`, for every keyless free model, after 70 requests in 25 minutes. The run was stopped by hand; nothing after that point measures an agent.

## Result: clamp-integer (all five passed)

The harness verifier ran independently after each agent finished.

| Agent | Result | Successful requests | Prompt tokens (gateway) | Completion tokens (gateway) | Tools sent per request | Tokens the agent reported |
| --- | --- | --- | --- | --- | --- | --- |
| OASIS | pass | 15 | 242,932 | 2,570 | 17 | 245,502 |
| Claude Code | pass | 8 (+4 rejected with 400) | 35,492* | 1,089 | 6–7 | 36,581 |
| Codex CLI | pass | 14 | 157,994 | 2,610 | 9 | 161,349 |
| OpenCode | pass | 11 | 111,139 | 1,520 | 10 | 37,253 |
| Aider | pass | 1 | 739 | 1,689 | 0 (whole-file edit format) | 2,439 |

\* Claude Code calls the Anthropic Messages endpoint. The prompt-token counts Kilo returns there drop sharply between turns (5,025 → 1,353), which suggests they exclude cached input. Treat Claude Code's prompt total as a lower bound, not a like-for-like figure.

Wall time is not reported as a result: the relay holds each request at least 18 s after the previous one (Kilo allows about 200 requests an hour), so time tracks request count, not agent speed.

## What this shows, and what it does not

- One task, one trial: a smoke test, not a ranking. All five agents solved it.
- OASIS used the most prompt tokens of the five on this task: about 1.5× Codex and 2.2× OpenCode by the gateway count. Its first request is about the same size as Codex's (7,044 vs 6,876 tokens), but its prompt doubled at request 4 (7,610 → 16,114) and stayed above 16k. Something it read or ran early added about 8.5k tokens that it then carried for 11 more turns. That gap is real and is tracked in the checklist (`docs/COMPLETION-CHECKLIST.md`). The relay did not record message contents, so the cause is not identified from this run.
- Adapter-reported tokens are not comparable across agents: OpenCode reported 37,253 tokens while the gateway counted 111,139 prompt tokens for its calls. Use the gateway columns.
- OASIS's taskflow-emoji-truncate result (fail, 107,176 tokens) is not a result: its last three requests got the quota 429, so it could not finish. The harness now excludes such trials from scores (see below).

## Harness changes made because of this run

- The relay marks a 429 the provider calls non-retryable (`x-should-retry: false`, or a named quota or limit) as `quotaExhausted`. The run then stops and lists the units that did not run instead of recording a string of failures.
- Each result row records `upstreamRateLimited`. A task where any agent failed a trial while being rate-limited is excluded from the scores, with a caveat naming it.
- `progress.json` is written after every unit, so an interrupted run keeps its results. This run's per-trial JSON was lost because results were written only at the end; the numbers above come from `run.log` and `gateway.jsonl`.

## Files

- `gateway.jsonl`: one line per upstream request (agent, status, served model, provider, message count, tools count, prompt and completion tokens). No keys and no message contents.
- `run.log`: the harness console output.
