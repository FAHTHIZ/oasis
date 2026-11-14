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

Zero-budget mode also covers the other services that can bill:

- Image generation, text to speech and voice transcription use the same rule
  before anything is uploaded. Declare one free with a prefix:
  `OASIS_FREE_MODELS=image:flux,tts:*,voice:whisper-large-v3-turbo`.
- Web search uses only keyless backends (DuckDuckGo, your SearXNG). Keyed
  backends (Tavily, Brave, Exa, Firecrawl) run on credit-based plans, so they
  are hidden unless declared, for example `OASIS_FREE_MODELS=search:tavily`.

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

## Measuring it

`npm run bench:gateway` (`node bench/gateway/run.mjs`, about 5 seconds, no
network) runs the real agent loop for several sessions against simulated
providers and counts every HTTP request Oasis sends, with the feature under
test off (baseline) and on. Between sessions the in-memory circuit breaker is
reset, as in a new process, so only state Oasis saves carries over. "Paid"
means the catalog lists a price above $0 for the model; the dollar figures use
1,200 input and 150 output tokens per reply.

Results on 2026-11-14 (`bench/results/gateway-2026-11-14.json`):

| Scenario | Variant | Requests | Failed | Paid | Est. $ | Sessions done |
|---|---|---|---|---|---|---|
| Main model's daily quota used up (429, Retry-After 2 h), backup works, 5 sessions | ledger off | 10 | 5 | 0 | 0 | 5/5 |
| | ledger on | 6 | 1 | 0 | 0 | 5/5 |
| Paid main model, declared-free backup, 5 sessions | normal | 5 | 0 | 5 | 0.0293 | 5/5 |
| | zero-budget | 5 | 0 | 0 | 0 | 5/5 |
| Only a paid model, 3 sessions | normal | 3 | 0 | 3 | 0.0175 | 3/3 |
| | zero-budget | 0 | 0 | 0 | 0 | 0/3 (stopped, nothing sent) |
| Model loops on tool calls and never finishes, 1 session | step limit 40 | 41 | 0 | 0 | 0 | 0/1 |
| | --max-requests 8 | 8 | 0 | 0 | 0 | 0/1 (stopped) |
| Only model: quota 429 with no reset time, then recovers, 3 sessions | ledger off | 4 | 1 | 0 | 0 | 3/3 |
| | ledger on | 4 | 1 | 0 | 0 | 3/3 (a guess never refuses your only model) |

These are simulations: they show what Oasis sends under each provider
behaviour, not how fast or reliable a real provider is. Live runs need quota
that was not available for this stage (the test key allows 50 free-model
requests a day), so no live gateway numbers are claimed here. `npm run
check:quick` runs the benchmark with `--check`, which fails if a scenario stops
meeting its expectation.

## Troubleshooting

- "Zero-budget mode refused <model>": the route is paid or its price is
  unknown. Use a local server (Ollama 11434, LM Studio 1234, llama.cpp 8080,
  vLLM 8000), an OpenRouter `:free` model, or declare one you know is free:
  `OASIS_FREE_MODELS=provider/model`.
- "Skipped <model> ... without sending a request": the quota ledger has the
  route in cooldown. `oasis quota` shows why and until when; `oasis quota
  --reset <model>` clears it if you added credit or the provider reset early.
- "HTTP 429: Rate limit exceeded: free-models-per-day" from OpenRouter: the
  50-requests-per-day free allowance is used up. It resets at the time in
  `x-ratelimit-reset` (Oasis waits for it). OpenRouter raises the allowance
  for accounts that bought credit; Oasis never buys it for you.
- "HTTP 404: This model is unavailable for free": OpenRouter withdrew that
  `:free` model. It suggests a paid slug; Oasis does not follow it. Pick a
  current free model (`oasis models`) or configure a fallback.
- Some gateways answer failures with HTTP 200 and an error body. Oasis treats
  the status in the body as the real one, so fallback and quota tracking work
  the same as for a normal HTTP error.
- "HTTP 402: The API key used for this request has reached its budget ...
  (The gateway sent this as an HTTP 200 reply)": Pollinations' free tier sends
  its budget notice as if it were the model's answer. Oasis recognises that
  exact notice (its opening sentence plus the gateway's link or response id),
  counts it as a quota failure and moves to the fallback model instead of
  showing it as a reply. Other gateways' notices are not known yet; report
  one with `/bug` if you see it.
- "Request budget exceeded" / "token budget exceeded": the run hit
  `--max-requests` or `--max-total-tokens`. The conversation is kept;
  `oasis --resume` continues it with a higher limit.

## Limitations

- Zero-budget mode trusts its evidence: a loopback port, OpenRouter's `:free`
  naming, and your declarations. It cannot see a provider's billing settings.
- MCP servers and hooks that call paid APIs themselves are outside Oasis's view and are not gated.
- Remaining quota is known only for providers that send rate-limit headers,
  and only as of the last response.
- The ledger is per machine and per config directory (profiles are separate).
- Child processes inherit request and token limits but count separately.
