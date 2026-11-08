# OASIS vs Claude Code through OmniRoute — 2026-11-08

Same model, same gateway, same tasks, one trial each. This is a smoke-level
comparison, not a ranking: two tasks and one trial cannot separate the agents.

- Gateway: OmniRoute 3.8.53 on `127.0.0.1:20128`. OASIS used its
  OpenAI-compatible `/v1/chat/completions`; Claude Code 2.1.319 used the
  Anthropic-compatible `/v1/messages`.
- Upstream model: `nvidia/nemotron-3-ultra-550b-a55b:free` on OpenRouter
  (free tier, 50 requests per day — the reason for the small sample).
- Harness: `scripts/bench-live.mjs --agents oasis,claude --trials 1`,
  600 s timeout. Claude Code ran with `--permission-mode dontAsk` and the
  harness allowlist.

| Run | Task | Difficulty | OASIS | Claude Code |
|---|---|---|---|---|
| 1 | `clamp-integer` | small | pass, 44.3 s, 55.4k tokens | pass, 121.3 s, 52.2k tokens |
| 2 | `safe-relative-path` | medium | fail, 28.4 s, 121.0k tokens | fail, 59.0 s, 49.7k tokens |

Run 2: both agents wrote an `async` `resolveRelative` built on
`fs.realpath`; the verifier calls it synchronously against a root that does
not exist. The task text did not say either, so the task was tightened after
this run (it now asks for a synchronous, string-only helper). The task
fingerprint changed, so later runs of this task are not comparable to run 2.

Cost: the `$0.27` Claude Code figures are Claude Code's own estimate at
Anthropic list prices for a model it does not recognise. The upstream was a
free-tier model; nothing was billed. OASIS reports `$0` for the same reason.

Raw files: `run1-*.json`, `run2-*.json`; the generated summaries are
`run1-SUMMARY.md` and `run2-SUMMARY.md`.
