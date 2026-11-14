# Follow-up run, batch 3: Aider re-run and Codex CLI on OVH — 2026-11-14

Same endpoint and tasks as [batch 2](../live-2026-11-14-h2h-b2/README.md): `gpt-oss-20b` on
OVHcloud AI Endpoints (keyless, free), recorded by the OASIS gateway. Harness pinned at
`0b86899f`, which includes the git-baseline workspace (`6e9f13b6`) and the Codex
compatibility flags (`d5ee49fd`). 15:34–15:54 UTC, one trial per task.

```
node scripts/bench-live.mjs --agents codex,aider --model gpt-oss-20b \
  --upstream https://oai.endpoints.kepler.ai.cloud.ovh.net/v1 --gateway-interval-ms 31000 \
  --interleave --task taskflow-priority-sort,safe-relative-path,taskflow-search \
  --timeout-seconds 1800 --yes
```

| Task | Aider 0.86.2 | Codex CLI 0.169.0 |
|---|---|---|
| `taskflow-priority-sort` | fail (asked the user to add a file) | not measured (endpoint) |
| `safe-relative-path` | pass (108 s) | not measured (endpoint) |
| `taskflow-search` | fail (test outside the suite) | not measured (endpoint) |

- **Aider now sees the project.** Every trial records `gitBaseline: true`, and Aider built
  its repository map. These failures are Aider's own, not the harness's:
  - `taskflow-priority-sort`: Aider reasoned that it "must not edit any existing code
    without asking to add files" and asked the user to add the sorting file to the chat.
    Aider expects the user to name the files to edit; in one-shot `--message` mode the run
    ends there. Aider given the file names would probably do better, but no agent in this
    benchmark is given them.
  - `taskflow-search`: Aider changed `src/query.mjs` and `src/cli.mjs` and added
    `src/__tests__/query.test.mjs`. The project's `npm test` runs only `test/*.test.mjs`,
    so the new test is not part of the suite and the "at least 20 passing tests" check
    found 19. The verifier stops there, so whether the search code itself was right was
    not checked.
- **Codex CLI: still an endpoint mismatch.** With the sub-agent and web-search tools off,
  OVH's `/v1/responses` rejected the next OpenAI-only field: `include[0]: unknown variant
  reasoning.encrypted_content` (all 18 calls, HTTP 422, `codex-failure.log`). Codex 0.169
  sent it in every configuration tried against a capture stub (reasoning effort `none`,
  reasoning summary `none`, `model_supports_reasoning_summaries=false`); a custom model
  catalog entry might drop it, but copying one from a built-in model would also replace
  the system prompt, so it was not used. The harness
  reported Codex as skipped ("the endpoint refused every request") instead of scoring it.
  Codex therefore needs an endpoint whose Responses API accepts its requests; the next
  run sends it through FreeLLMAPI's Responses-to-chat translation.
