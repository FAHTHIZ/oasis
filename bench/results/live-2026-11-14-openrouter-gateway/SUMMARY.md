# Agent evaluation run — 2026-11-14

OASIS 1.3.0 · 1 verified matched tasks × 1 requested trial(s) · shared endpoint `openrouter.ai (recorded)`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OASIS 1.3.0 (nvidia/nemotron-3-ultra-550b-a55b:free) | nvidia/nemotron-3-ultra-550b-a55b:free | nvidia/nemotron-3-ultra-550b-a55b:free | 100% | 1/1 | 190.9 s | 271780 | $0.0000 |
| Claude Code | nvidia/nemotron-3-ultra-550b-a55b:free | — | not run | — | — | — | — |
| Codex CLI | nvidia/nemotron-3-ultra-550b-a55b:free | — | not run | — | — | — | — |

## Gateway record

Same model NOT verified from the gateway record.

| Agent | Calls | Failed calls | Served model(s) | Provider(s) | Input tokens | Output tokens |
|---|---:|---:|---|---|---:|---:|
| oasis | 22 | 0 | nvidia/nemotron-3-ultra-550b-a55b:free ×22 | Nvidia ×22 | 267867 | 3913 |
| codex | 20 | 1 | nvidia/nemotron-3-ultra-550b-a55b:free ×19 | none reported | 309556 | 1855 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Fewer than two agents completed a run; this is not a head-to-head comparison.
- Only 1 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- The recording gateway did not see every completed agent served by one identical model ID (see the gateway table); this is not a verified same-model comparison.

## Agents not run

- Claude Code: every trial ended in an agent error before verification (first: Claude Code exited with code 1: {"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"8c61059d-eba6-418e-b813-5a0de5d27aa0","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_to)
- Codex CLI: every trial ended in an agent error before verification (first: Codex CLI exited with code 1: exceeded retry limit, last status: 429 Too Many Requests)

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OASIS | 1.3.0 | c483a962f6cbb5618bd3e75ae9e089ebcd80126a (HEAD moved to c862a91657641717bd041995d29adeeba9343532 during the run; the loaded code is the first revision) | v22.20.0 / linux / x64 |

## Task coverage

Shared task IDs: clamp-integer.
Verified matched tasks: clamp-integer.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OASIS |
|---|---:|---:|---:|
| `clamp-integer` | utility-logic | small | 100% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
