# Same-model head-to-head, batch 2 — 2026-11-14

Five agents went through the OASIS recording gateway to one free upstream model,
`gpt-oss-20b` on OVHcloud AI Endpoints (`https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`,
keyless, about 2 requests per minute). No paid inference was used. Every request is in
`gateway.jsonl`, with the model the upstream says served it.

```
node scripts/bench-live.mjs --agents oasis,claude,codex,opencode,aider --model gpt-oss-20b \
  --upstream https://oai.endpoints.kepler.ai.cloud.ovh.net/v1 --gateway-interval-ms 31000 \
  --interleave --task taskflow-priority-sort,safe-relative-path,taskflow-search \
  --timeout-seconds 1800 --yes
```

The harness ran from a pinned worktree at `ce21f013` (14:09–15:30 UTC). Versions: OASIS
1.3.0, Claude Code 2.1.325, Codex CLI 0.169.0, OpenCode 1.19.5, Aider 0.86.2, Node 22.21.1,
Linux x64. One trial per task.

## Result

One trial per task on three tasks is a smoke test, not a ranking. The table is what
happened; the notes under it say which failures measure the agent and which do not.

| Task | OASIS | Claude Code | Codex CLI | OpenCode | Aider |
|---|---|---|---|---|---|
| `taskflow-priority-sort` | pass (492 s, 10 tool calls) | not measured (endpoint) | not measured (endpoint) | fail (crash) | fail (harness flaw) |
| `safe-relative-path` | pass (1,005 s, 21 tool calls) | not measured (endpoint) | not measured (endpoint) | pass (664 s) | pass (50 s) |
| `taskflow-search` | pass (1,390 s, 28 tool calls) | not measured (endpoint) | not measured (endpoint) | fail (crash) | fail (harness flaw) |

- **Claude Code: endpoint mismatch, not a result.** OVH serves only
  `/v1/chat/completions`. All 6 of Claude Code's calls went to `/v1/messages` and got
  HTTP 404 (`gateway.jsonl`). It never reached the model.
- **Codex CLI: endpoint mismatch, not a result.** All 18 calls got HTTP 422 on
  `/v1/responses`: `tools[4].type: unknown variant namespace`. Codex 0.169 sends its
  sub-agent tools as an OpenAI-only tool type. `d5ee49fd` (after this run's pin) turns
  those tools and hosted web search off for custom endpoints, and marks an agent whose
  every call was refused as "endpoint mismatch" instead of scoring it.
  `SUMMARY.md` was produced by the pinned harness, which lists both agents as
  "not run"; their failure lines are in `claude-codex-failures.log`.
- **OpenCode: a real robustness failure.** Two trials ended with OpenCode exiting on
  `Expected 'id' to be a string` after 9 and 4 tool calls, while parsing OVH's stream.
  That is OpenCode's handling of this provider, so it counts against OpenCode here, but it
  says nothing about OpenCode with other providers.
- **Aider: a benchmark-harness flaw, not Aider's result.** The task workspace was a
  bare folder. Aider finds files through git, so it created its own empty repository
  ("Git repo: .git with 0 files"), could not see the code, and printed a tool call as text
  or asked for a file listing. `6e9f13b6` now starts every agent, OASIS included, in a
  repository with the task files in one baseline commit. Aider's two failures should be
  re-run before they are read as anything.

## Fairness caveats

- **Different token use.** OASIS used about 672k input tokens over 67 calls, OpenCode 214k
  over 29, Aider 2.3k over 3. Each product sends its own system prompt and tool set; this
  compares configured products, not identical prompts. OASIS was also the slowest on
  every task it shared with a passing competitor.
- **Model ID caveat.** The summary warns that requested model IDs differ. That is only the
  provider prefix OpenCode (`bench/`) and Aider (`openai/`) need; the gateway shows every
  scored call was served by `gpt-oss-20b`. OVH reports no provider field, so one serving
  stack is likely but not confirmed.
- **Cost.** Costs shown are list-price estimates from each tool's own price table. The
  endpoint is free and nothing was charged.
- **Not fixed by this batch.** Claude Code, Codex CLI and Gemini CLI still need a
  same-model run through an endpoint that speaks their protocol.
