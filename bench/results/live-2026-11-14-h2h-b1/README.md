# Same-model head-to-head, batch 1 — 2026-11-14

All four agents went through the OASIS recording gateway to one free upstream model,
`nvidia/nemotron-3-ultra-550b-a55b:free` on Kilo's keyless gateway
(`https://api.kilo.ai/api/gateway/v1`). No paid inference was used. Every request was
logged in `gateway.jsonl`; the gateway records the model the upstream says served it.

```
node scripts/bench-live.mjs --agents oasis,claude,codex,opencode \
  --model nvidia/nemotron-3-ultra-550b-a55b:free \
  --upstream https://api.kilo.ai/api/gateway/v1 --gateway-interval-ms 18000 \
  --interleave --task taskflow-priority-sort,safe-relative-path,taskflow-search,taskflow-dependencies \
  --timeout-seconds 900 --yes
```

Versions: OASIS 1.3.0, Claude Code 2.1.325, Codex CLI 0.169.0, OpenCode 1.19.5, Node 22.21.1, Linux x64.
One trial per task.

## Result

This is a smoke test, not a ranking. Nothing here supports a claim that any agent is better than another.

| Task | OASIS | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|---|
| `taskflow-priority-sort` | fail (task flaw) | fail (task flaw) | fail (task flaw) | fail (task flaw) |
| `safe-relative-path` | pass (437 s, 17 tool calls) | pass | fail, upstream HTTP 429 | not run (quota) |
| `taskflow-search` | not run (quota) | not run | not run | not run |
| `taskflow-dependencies` | not run (quota) | not run | not run | not run |

- **taskflow-priority-sort:** all four agents fixed the bug. All four then failed the
  verifier's "at least 20 passing tests" check with 19. The task's starting tests already
  failed, so "keep the existing tests and add one" could not reach 20. This was a flaw in
  the task, not in the agents. It was fixed in `9e763b83` after this run started, which
  changes the task fingerprint, so this result cannot be compared with later runs.
- **safe-relative-path:** Codex's trial ended with `exceeded retry limit, last status: 429`.
  That measures the free tier, not Codex.
- **Quota:** Kilo's keyless tier returned HTTP 429 `PROMOTION_MODEL_LIMIT_REACHED` after
  96 calls over 36 minutes (13:13–13:49 UTC), even with an 18-second gap between calls. The
  harness stopped there and recorded nine units as not run.

## Fairness caveats

- **Unpinned OASIS code.** OASIS ran from the working tree while commits landed on `main`.
  `summary.json` records the revision at the start (5743ce4d) and where HEAD ended. Later
  batches use a pinned worktree (`git worktree add /tmp/oasis-pin <sha>`).
- **Different token use.** Token counts differ widely (OASIS about 609k input tokens over
  31 calls; OpenCode 130k over 11). Each product sends its own system prompt and tool set.
  This compares configured products, not harness code under identical prompts.
- **Model ID caveat.** The summary warns that the requested model IDs differ. That is only
  because OpenCode needs a `bench/` provider prefix; the gateway shows that every agent's
  calls were served by the same model ID.
- **Provider not confirmed.** Kilo reported a provider for OASIS and OpenCode but not for
  Claude Code or Codex, so one upstream serving stack is not confirmed.
- **Cost label.** The OASIS rows label cost as "local model". That code predates
  `f7e4d0f0`, which labels free-tier `:free` models correctly. Claude Code reported $0.2056
  from its own price table; no money was charged.

`SUMMARY.md` and `summary.json` were regenerated from the raw files with the harness as
of `7f72d2e9`. Before that commit, tasks that only some agents ran (here
safe-relative-path) were dropped from the summary without notice.
