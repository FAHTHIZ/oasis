# Oasis end to end through each router, 14 November 2026

Oasis ran two eval tasks (`clamp-integer`, `safe-relative-path`) with OVH AI Endpoints' anonymous `gpt-oss-20b`, reached directly, through FreeLLMAPI, and through OmniRoute. The routes were the same as in the [protocol check](../README.md). Each run went through `scripts/bench-live.mjs` with its recording gateway, `--gateway-interval-ms 31000` (OVH allows 2 requests per minute per IP and model), and one trial per task. No paid inference was used.

| Route | Oasis revision | Passed | Tokens (gateway) | Served model (gateway) | Notes |
|---|---|---:|---:|---|---|
| direct | `b135fbc3` | 2/2 | 257,876 | `gpt-oss-20b` ×28 | |
| FreeLLMAPI | `b135fbc3` | 1/1 scored | 65,093 | `gpt-oss-20b` ×10 | `clamp-integer` was excluded: OVH answered 429 on 3 calls while another benchmark shared the IP |
| OmniRoute, first run | `b135fbc3` | 0/2 | 99,116 | `gpt-oss-20b` ×21, `keepalive` ×3 | Both failures came from OmniRoute stream issues (below) |
| OmniRoute, after fixes | `98b411d0` | 1/2 | 271,233 | `gpt-oss-20b` ×26 | `safe-relative-path` failed because of the model (below) |

## What went wrong through OmniRoute, and what changed

1. **Split tool call.** In the finish chunk, OmniRoute sent the last piece of a call's arguments (`}` or `200}`) as a separate call: `index: 1`, a new `call_…` id, and no name. Oasis received a `read_file` call with truncated JSON plus a nameless call, which failed as `unknown_tool`. Direct OVH streams never did this in the captured traffic. Oasis now merges a nameless call into the previous call when its arguments complete that call's unfinished JSON (commit `98b411d0`). The regression test in `test/stream-duplicate-call-ids.test.mjs` replays the captured chunk pattern.
2. **Keepalive chunks.** While it waits for the upstream, OmniRoute sends `{"model":"keepalive","choices":[]}`. The recording gateway took `keepalive` as the served model, so the summary said "Same model NOT verified". The gateway now ignores these chunks (same commit), and the re-run reports `gpt-oss-20b` on every call.
3. **"Provider returned empty content".** In the first run, OmniRoute's log shows this error five times (09:40 to 09:44 UTC), and one of them ended a trial as a stream interruption. The re-run did not hit it. The cause is inside OmniRoute and was not identified.
4. **Gate fragment.** In a manual `oasis -p` run through OmniRoute, the model answered the post-edit verification reminder with only "Check util diff.", and that fragment was printed as the answer. Oasis now sends one more reminder in that case (commit `b995ea0e`).

## Remaining failure on the re-run

`safe-relative-path`: the task says that both an absolute path and a `../` escape must throw an Error whose message contains "escapes". The model wrote "Absolute paths are forbidden: /etc/passwd" for the absolute case, and the verifier rejected it. This is a model-reasoning failure, not a routing one. The direct run of the same model passed this task.

## Limits

- One trial per task and two tasks per route. This shows whether a route works for agent traffic. It does not measure quality differences between routes.
- The runs were sequential, not interleaved, and OVH's anonymous tier is shared and rate-limited, so wall times are not comparable across routes.
- FreeLLMAPI scored only one task because of the 429s.
