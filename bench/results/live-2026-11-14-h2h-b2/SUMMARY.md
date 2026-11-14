# Cross-agent task benchmark — 2026-11-14

OASIS 1.3.0 · 3 verified matched tasks × 1 requested trial(s) · shared endpoint `oai.endpoints.kepler.ai.cloud.ovh.net (recorded)`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| OASIS 1.3.0 (gpt-oss-20b) | gpt-oss-20b | gpt-oss-20b | 100% | 3/3 | 1005.0 s | 689732 | $0.0225 |
| Claude Code | gpt-oss-20b | — | not run | — | — | — | — |
| Codex CLI | gpt-oss-20b | — | not run | — | — | — | — |
| OpenCode 1.19.5 (bench/gpt-oss-20b) | bench/gpt-oss-20b | bench/gpt-oss-20b | 33.3% | 1/3 | 368.2 s | 198751 | $0.0000 |
| Aider aider 0.86.2 (openai/gpt-oss-20b) | openai/gpt-oss-20b | openai/gpt-oss-20b | 33.3% | 1/3 | 35.1 s | 3320 | n/a |

## Gateway record

Same model verified: every scored agent's calls were served by `gpt-oss-20b`, as reported by the upstream.

| Agent | Calls | Failed calls | Served model(s) | Provider(s) | Input tokens | Output tokens |
|---|---:|---:|---|---|---:|---:|
| oasis | 67 | 0 | gpt-oss-20b ×67 | none reported | 671968 | 17764 |
| claude | 6 | 6 | none reported | none reported | 0 | 0 |
| codex | 18 | 18 | none reported | none reported | 0 | 0 |
| opencode | 29 | 0 | gpt-oss-20b ×29 | none reported | 214257 | 4042 |
| aider | 3 | 0 | gpt-oss-20b ×3 | none reported | 2345 | 975 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Only 3 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- OpenCode: 2 scored trial(s) ended in an agent or provider error before verification and count as failures (first: OpenCode exited with code 1: Expected 'id' to be a string.).
- Every scored agent was served model gpt-oss-20b, but the gateway could not confirm one upstream provider for all of them (missing or different provider fields); serving stacks can differ in quantization and limits.
- The selected agents do not all have one identical, explicitly requested model ID.

## Agents not run

- Claude Code: every trial ended in an agent error before verification (first: Claude Code exited with code 1: {"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"13769c12-05b5-4531-b0ca-12e3fd540790","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_to)
- Codex CLI: every trial ended in an agent error before verification (first: Codex CLI exited with code 1: unexpected status 422 Unprocessable Entity: Failed to deserialize the JSON body into the target type: tools[4].type: unknown variant `namespace`, expected one of `functio)

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| OASIS | 1.3.0 | ce21f0131672870c67f5fab7d2469f1be84b3b12 | v22.21.1 / linux / x64 |
| OpenCode | 1.19.5 | ce21f0131672870c67f5fab7d2469f1be84b3b12 | v22.21.1 / linux / x64 |
| Aider | aider 0.86.2 | ce21f0131672870c67f5fab7d2469f1be84b3b12 | v22.21.1 / linux / x64 |

## Task coverage

Shared task IDs: safe-relative-path, taskflow-priority-sort, taskflow-search.
Verified matched tasks: safe-relative-path, taskflow-priority-sort, taskflow-search.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | OASIS | OpenCode | Aider |
|---|---:|---:|---:|---:|---:|
| `safe-relative-path` | security-boundaries | medium | 100% | 100% | 100% |
| `taskflow-priority-sort` | data-structures | small | 100% | 0% | 0% |
| `taskflow-search` | data-structures | medium | 100% | 0% | 0% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
