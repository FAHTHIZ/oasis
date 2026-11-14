# Recorded same-model smoke run — 14 November 2026

First run of `bench:live --upstream`: OASIS, Claude Code and Codex CLI on
`clamp-integer` (small), one trial, every call relayed through the local
recording gateway to OpenRouter with the model forced to
`nvidia/nemotron-3-ultra-550b-a55b:free`.

```
npm run bench:live -- --agents oasis,claude,codex \
  --model nvidia/nemotron-3-ultra-550b-a55b:free \
  --upstream https://openrouter.ai/api/v1 --gateway-interval-ms 3000 \
  --task clamp-integer --timeout-seconds 270 --yes
```

| Agent | Outcome | Gateway calls | Served model (per upstream) |
| --- | --- | ---: | --- |
| OASIS 1.3.0 | Pass, 190.9 s, 22 calls, 267,867 input / 3,913 output tokens | 22 | nemotron-3-ultra ×22 (provider Nvidia) |
| Codex CLI 0.130.0 | Not scored: the free tier's 50-requests-per-day limit was reached on its 20th call (HTTP 429) | 20 | nemotron-3-ultra ×19 |
| Claude Code 2.1.286 | Not scored: no call reached the gateway | 0 | — |

What this run shows: the pipeline works end to end, and `gateway.jsonl`
proves which model and provider served every call, per agent. It is not a
head-to-head result: one task, one trial, one scored agent.

Problems it found, both fixed in the same change set:

- Claude Code honours `HTTPS_PROXY` even for a loopback base URL, so behind
  a proxy its calls never reached the gateway. `bench:live` now adds
  loopback to `NO_PROXY` for gateway runs.
- The same-model check counted agents that were skipped (Codex after the
  rate limit); it now considers only agents with scored trials.

`gateway.jsonl` has the OpenRouter account id removed from the one 429 body.
