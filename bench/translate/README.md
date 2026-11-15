# Protocol translation for the keyless head-to-head

OVHcloud AI Endpoints' anonymous tier serves only OpenAI chat completions, and
rejects any `Authorization` header. Claude Code speaks Anthropic Messages,
Codex CLI speaks OpenAI Responses and Gemini CLI speaks the Gemini API, so
without a translation layer they cannot reach the same model as OASIS,
OpenCode and Aider (earlier runs recorded HTTP 404 and 422 for them).

The chain used from 15 November 2026:

```
agent -> scripts/bench-gateway.mjs (records every call, paces 31 s)
      -> LiteLLM 1.109.1, litellm.yaml (port 4002, translates protocols)
      -> ovh-hop.mjs (port 4003: strips auth, drops OpenAI-only fields, logs served model)
      -> https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
```

```
python3 -m venv /tmp/llvenv && /tmp/llvenv/bin/pip install 'litellm[proxy]==1.109.1'
node bench/translate/ovh-hop.mjs &
/tmp/llvenv/bin/litellm --config bench/translate/litellm.yaml --port 4002 &
OASIS_GATEWAY_UPSTREAM_KEY=sk-bench-local-0123456789abcdef \
  node scripts/bench-live.mjs --upstream http://127.0.0.1:4002/v1 --model gpt-oss-120b \
  --gateway-interval-ms 31000 --interleave --task ... --yes
```

Caveats that belong next to any result produced this way:

- Claude Code, Codex CLI and Gemini CLI go through LiteLLM's translation;
  OASIS, OpenCode and Aider speak chat completions, so LiteLLM forwards them
  almost unchanged. A translation bug would count against the translated agents.
- None of the three is using its vendor's own model, which is what it is tuned
  for. These runs compare the agent harnesses on one shared open model, not
  the products as their vendors ship them.
- `use_chat_completions_api: true` is required for Codex: without it LiteLLM
  passes `/v1/responses` through to OVH's own Responses endpoint, which rejects
  Codex's `include: ["reasoning.encrypted_content"]`, its reasoning summaries
  and its input items. The `include` filter in `ovh-hop.mjs` predates that
  setting and no longer fires (requests reach OVH as chat completions).
- LiteLLM's Gemini responses carry no `modelVersion`; `ovh-hop.mjs` logs the
  model OVH reports serving (`STRIP_LOG`, default `/tmp/ll/ovh.jsonl`).
- Codex CLI sends two leading `developer` messages, which become two system
  messages. Qwen3.5's chat template rejects that ("System message must be at
  the beginning."). On a streamed Responses call, LiteLLM turned the error into
  an empty 200 reply, so before this fix Codex ended every Qwen3.5 task after
  one request, with 0 tokens (about 31 s). `ovh-hop.mjs` now merges a leading
  run of system messages into one, keeping the text and its order. gpt-oss
  accepts several system messages, so its runs were not affected.
