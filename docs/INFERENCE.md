# Inference: providers, budgets and zero-budget mode

This page covers how Oasis chooses where a model request goes, what it may
cost, and how to cap it. The design notes behind it are in
[INFERENCE-GATEWAY-PLAN.md](INFERENCE-GATEWAY-PLAN.md).

## Zero-budget mode

```
oasis --zero-budget
OASIS_ZERO_BUDGET=1 oasis -p "fix the failing test"
```

or in settings: `{ "zeroBudget": true }`. The environment variable wins over
settings (`OASIS_ZERO_BUDGET=0` turns it off for one run).

Before every request, including fallback models, subagents and side requests
such as compaction summaries and `/btw`, Oasis checks that the route has
positive evidence it cannot bill. A route that fails the check is never
contacted: the request is refused before anything is sent, and the fallback
chain moves to its next entry.

| Route | Treated as |
|---|---|
| Ollama, or a loopback server on a model-server port (11434, 1234, 8080, 8000, 5001, 1337) | free |
| An endpoint saved as keyless and called without a key or auth header | free |
| An OpenRouter model ending in `:free`, or `openrouter/free` | free |
| A model you list in `OASIS_FREE_MODELS` (comma-separated, `*` allowed) or settings `freeModels` | free |
| A model you priced at $0 (`OASIS_PRICE_INPUT=0 OASIS_PRICE_OUTPUT=0` or settings `pricing`) | free |
| A model with a catalog price above $0 | paid, refused |
| A model listed at $0 in the catalog, or with no known price | unknown, refused |
| A loopback service on any other port (it may be LiteLLM or OmniRoute forwarding to a paid model) | unknown, refused |

Unknown is refused on purpose: a free tier can bill once it is used up, and an
advertised free allowance is not a guarantee. If you know a route cannot bill
you (for example a Gemini key on a project with no billing account), declare it:

```
OASIS_FREE_MODELS='gemini-2.5-flash,groq:llama-3.3-*' oasis --zero-budget
```

Zero-budget mode covers chat requests. Image generation, speech and web search
providers have their own settings and are not gated by it yet.

## Request and token budgets

```
oasis -p --max-requests 40 --max-total-tokens 400000 "add input validation"
```

or settings `maxRequests` and `maxTotalTokens`, or `OASIS_MAX_REQUESTS` and
`OASIS_MAX_TOTAL_TOKENS`.

- Every HTTP attempt counts, retries included, so a flaky provider cannot
  multiply the spend.
- The parent and its in-process subagents share one count. Child processes
  (`oasis attempts`, background `oasis -p` runs) inherit the limits through the
  environment and each get their own count.
- The run stops before the attempt that would pass a limit. For tokens, the
  check uses the size of the prompt about to be sent (about four characters a
  token) plus what has been used, so one reply's output can overshoot the token
  limit.
- The conversation up to the stop is kept, and `oasis --resume` continues it.
  Headless JSON output reports `error_max_requests`, `error_max_total_tokens` or
  `error_zero_budget`.

`--max-budget-usd` still caps estimated dollars. It is checked after each reply,
because the price is only known from the reply's usage.

## Usage and quota tracking

Oasis records every model request in `<config dir>/quota-ledger.json`
(file mode 0600), one record per provider, API key and model:

```
$ oasis quota
qwen/qwen3-coder:free  on openrouter.ai  key 3f9a1c07de
  today: 41 requests, 512000 input + 9100 output tokens, 1 failed (1 quota)
  reported by the provider 3 min ago: requests 0 of 50 left, resets 2026-11-15T00:00:00.000Z (a snapshot of that moment, not a guarantee)
  cooling down until 2026-11-15T00:00:00.000Z (reset time stated by the provider)
```

- Keys are never written; a key appears as the first 10 hex characters of its
  SHA-256, so two keys for one provider stay apart.
- "Remaining" comes only from the provider's own rate-limit headers
  (`x-ratelimit-*`, `anthropic-ratelimit-*`) and is shown with its age. A
  provider that sends none is shown as "remaining quota: unknown", never as
  available. Advertised free-tier sizes are not used.
- Daily counts reset at midnight UTC.
- After a quota failure (429 or 402 that is not a short per-minute wait):
  - if the provider stated when it resets (Retry-After, rate-limit reset
    headers, or OpenRouter's `X-RateLimit-Reset` in the error body), the route
    is skipped without a request until then, in this and later sessions, and
    the fallback chain moves on;
  - if it did not, Oasis guesses 2 minutes, then 10, then an hour. A guess
    only skips the route when a fallback model exists, so your only model is
    never refused on a guess;
  - a successful request clears the cooldown;
  - local servers (loopback) never cool down; a 429 there means busy.
- `oasis quota --json` prints the raw records, `oasis quota --reset [TEXT]`
  clears all records or the matching ones, and `OASIS_QUOTA_LEDGER=off` turns
  recording off.
- Several Oasis processes can update the file at once. Each write re-reads it
  and changes only its own record, so a lost count is possible but rare.
