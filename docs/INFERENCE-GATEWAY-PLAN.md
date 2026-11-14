# Inference gateway: audit and plan

Written 2026-11-14 from the code on `main`, before any gateway change. The
"Status" column is updated as stages land; see docs/MISSION-LOG.md for the
commits.

## How a model request travels today

Every chat request, including side requests (compaction summaries, titles,
classifiers, `/btw`, plan checks), goes through one chain in `src/agent.mjs`:

```
requestCompletion            fallback chain (fallback-chain.mjs) + circuit breaker (circuit-breaker.mjs)
 └ requestCompletionWithStreamRestarts   restarts a dropped stream (bounded)
   └ requestCompletionTraced / TracedAuth  context anchor, apiKeyHelper refresh on 401
     └ requestCompletionTracedInner        OpenTelemetry gen_ai spans and metrics
       └ requestCompletionRaw              builds the body, key pool (key-pool.mjs),
                                           retry loop (provider-retry.mjs), one fetch per attempt
```

After a reply, the turn loop (and `chargeAuxiliaryUsage` for side requests)
prices the usage with `pricing.mjs` and the models.dev catalog
(`model-catalog.mjs`), then records it in `session.budgetLedger`. That ledger is
shared by the parent and its in-process subagents, so `--max-budget-usd` caps
the whole task.

Image generation (`image-gen.mjs`), speech (`tts.mjs`, `voice.mjs`) and web
search (`web-search.mjs`) use their own fetches and their own configuration.

## What is already strong (kept)

| Concern | Module | Notes |
|---|---|---|
| Fallback across models and providers | fallback-chain.mjs | Typed reasons: credits, rate, model, server, auth. Skips providers whose breaker is open. |
| Circuit breaker | circuit-breaker.mjs | Per provider, escalating cooldown, in memory. |
| Key rotation | key-pool.mjs | Rotates on 401, 402, 403 and 429 with the provider's reset time. |
| Retries | provider-retry.mjs | Bounded attempts, Retry-After, short per-minute waits, no retry on hard quota, billing, oversized prompts or unconfigured routes. |
| Pricing | pricing.mjs + models.dev | Local, keyless and gateway-port rules. Unknown prices are counted as "unknown", not as $0 spent. |
| Local models | local-context.mjs, ollama-discovery.mjs, hardware.mjs | Context-window probing and a small-context profile. |
| Prompt caching | provider-request.mjs | Anthropic breakpoints; cached tokens are tracked. |
| Context efficiency | context.mjs, read-dedup.mjs, superseded-results.mjs, output-condense.mjs, report-handoff.mjs | Repeated reads, superseded tool output, long reports moved to files. |
| Stored keys | secure-store.mjs, safe-storage.mjs | OS keychain or encrypted file. |

## Gaps found

1. No zero-budget guarantee. `--max-budget-usd` is checked after a reply has
   been billed, and a model with an unknown price counts as $0. Nothing stops
   a fallback entry, a subagent or a side request from reaching a paid model.
2. No request or token budget. A run can only be capped by dollars and turns.
3. Quota state is lost between runs. The breaker and key pool live in memory, so
   each new session re-discovers an exhausted daily free quota (for example
   OpenRouter's 50 free requests a day) and cannot report what is left.
4. Usage is not tracked per provider, key and model across sessions.
5. Rate-limit headers that state remaining capacity are only used for waiting,
   never recorded.

## The two reference gateways

Both are MIT-licensed TypeScript servers (cloned and read 2026-11-14).

FreeLLMAPI (Azhan787/FreeLLMAPI, about 137k lines with tests):

- Sliding-window counters per platform, model and key for requests and tokens
  per minute and per day, persisted in SQLite (`services/ratelimit.ts`).
- Cooldowns record their provenance: "authoritative" when the provider stated
  the reset, "heuristic" when it is the gateway's own guess. An escalating
  ladder (2 min, 10 min, 1 h, 1 day) applies only to real quota signals, not to
  timeouts or 5xx. Local endpoints get a 5 s cooldown and never the ladder.
- In-flight leases close the check-then-act race under parallel load.

OmniRoute (cheaper-inference/omniroute, about 15k source files):

- `STRICT_ZERO_COST` (`open-sse/services/autoCombo/strictZeroCostFilter.ts`)
  admits a candidate only on positive evidence that it cannot bill, with a
  three-state allowance (SAFE, EXHAUSTED, UNKNOWN). UNKNOWN is never treated as
  safe.
- Compression and prefix-freeze experiments, and a semantic cache.
- It also ships web-session executors, client fingerprinting, header
  obfuscation and a Turnstile solver (`services/claudeTurnstileSolver.ts`,
  `services/claudeCodeObfuscation.ts`, `executors/*-web.ts`). These exist to use
  consumer accounts through unofficial channels. Oasis does not adopt them;
  they conflict with provider terms and with this project's rules.

### Decision

Oasis does not embed either gateway or depend on one being up. Both stay
usable as an OpenAI-compatible endpoint (`OASIS_BASE_URL`), as before; their
port rule in pricing.mjs already marks OmniRoute as never free. The ideas worth
having are re-implemented in small, dependency-free modules on top of the
existing chain (no SQLite, no server):

| Idea | Source | Oasis home |
|---|---|---|
| Admit only routes proven free; unknown is not free | OmniRoute STRICT_ZERO_COST | `src/cost-policy.mjs` |
| Request and token budgets checked before sending | new | `src/cost-policy.mjs` + `budgetLedger` |
| Per provider, key and model usage, persisted | FreeLLMAPI ratelimit.ts | `src/quota-ledger.mjs` |
| Provider-stated vs guessed cooldowns; ladder only on quota signals; local endpoints exempt | FreeLLMAPI | `src/quota-ledger.mjs` |
| Remaining capacity from headers, marked as reported, not guaranteed | both | `src/quota-ledger.mjs`, `oasis quota` |

## Stages

| Stage | Content | Status |
|---|---|---|
| 1 | Zero-budget mode and request and token budgets, enforced before every request, including fallbacks, subagents and side requests | done |
| 2 | Persistent quota ledger, pre-send skip of routes the provider said are exhausted, `oasis quota` report | done |
| 3 | Gateway behaviour benchmark (bench/gateway/run.mjs): requests, failures, paid requests and estimated cost with each feature off and on | done |
| 4 | Documentation: gateway setup, local inference, zero-budget mode, troubleshooting, limitations | planned |
