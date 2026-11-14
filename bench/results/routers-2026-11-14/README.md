# Router comparison, 14 November 2026

`npm run bench:routers` against one model, OVH AI Endpoints' `gpt-oss-20b` on its anonymous tier (2 requests per minute per IP and model, no charge), reached three ways:

| Route | Base URL | Model ID | Router version |
|---|---|---|---|
| direct | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | `gpt-oss-20b` | none |
| freellmapi | `http://127.0.0.1:3001/v1` | `gpt-oss-20b` | FreeLLMAPI at commit `7129751`, OVH key `anonymous`, Kilo disabled so nothing else could serve the call |
| omniroute | `http://127.0.0.1:20128/v1` | `ovh/gpt-oss-20b` | OmniRoute 3.8.53 from npm, `ovhcloud` connection with an empty key |

Three rounds, routes interleaved within each round, model requests spaced 31 s apart. Machine: Linux x64, 2 CPUs; a separate benchmark was using `gpt-oss-120b` on the same OVH account at the same time (a different model, so a separate rate-limit bucket). Raw rows: [`routers.json`](routers.json).

| Route | Tool calls intact | Usage reported | Streams complete | Median tool-call request | Median time to first streamed token | Median full stream | Unknown model | `/models` lists the model |
|---|---:|---:|---:|---:|---:|---:|---|---|
| direct | 3/3 | 6/6 | 3/3 | 1.9 s | 0.5 s | 2.3 s | 404 with message | yes |
| freellmapi | 3/3 | 6/6 | 3/3 | 1.3 s | 2.0 s | 2.4 s | 404 with message | yes |
| omniroute | 3/3 | 6/6 | 3/3 | 1.9 s | 6.4 s | 12.8 s | 400 with message | no |

What this shows, and what it does not:

- Both routers passed tool calls through intact (valid JSON arguments, `finish_reason` and usage present), finished every stream with `[DONE]`, and failed an unknown model fast with a readable 4xx instead of answering from another model. FreeLLMAPI marks the serving provider in `X-Routed-Via` (`ovh/gpt-oss-20b` on every call).
- OmniRoute's streams were slower in all three rounds (first token 18.3 s, 1.5 s and 6.4 s; full stream 30.8 s, 7.2 s and 12.8 s, against 0.5–0.6 s and 1.5–3.4 s direct). The cause was not identified; OmniRoute's log shows no upstream error or retry for these calls.
- One FreeLLMAPI tool call took 31.5 s (the other two 1.2–1.3 s), again with no error in its log. Three rounds are too few to separate router overhead from OVH's own variance; read the medians as indications, not measured overhead.
- OmniRoute routes `ovh/…` models but does not list them in `GET /v1/models`, so an agent that discovers models from that list (Oasis does, for context windows) will not find them.
- OmniRoute's `ovhcloud` provider must be added with no key. A placeholder key such as `anonymous` makes OVH answer 403, and OmniRoute then marks the connection banned.
