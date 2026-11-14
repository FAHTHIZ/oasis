# Agent evaluation run — 2026-11-14

OASIS 1.3.0 · 3 verified matched tasks × 1 requested trial(s) · shared endpoint `oai.endpoints.kepler.ai.cloud.ovh.net (recorded)`.

Headline pass rate is a macro-average of per-task pass rates. A task contributes only when every completed agent has exactly the requested number of distinct trials, complete matching SHA-256 task fingerprints, and matching category/difficulty metadata.

| Agent | Requested model | CLI-reported model | Pass rate | Passed trials | Median trial time | Tokens | Total reported cost |
|---|---|---|---:|---:|---:|---:|---:|
| Codex CLI | gpt-oss-20b | — | not run | — | — | — | — |
| Aider aider 0.86.2 (openai/gpt-oss-20b) | openai/gpt-oss-20b | openai/gpt-oss-20b | 33.3% | 1/3 | 108.1 s | 21290 | n/a |

## Gateway record

Same model verified: every scored agent's calls were served by `gpt-oss-20b`, as reported by the upstream.

| Agent | Calls | Failed calls | Served model(s) | Provider(s) | Input tokens | Output tokens |
|---|---:|---:|---|---|---:|---:|
| codex | 18 | 18 | none reported | none reported | 0 | 0 |
| aider | 6 | 0 | gpt-oss-20b ×6 | none reported | 14506 | 13098 |

## Interpretation limits

- Agent adapters do not use identical tool surfaces, approval modes, or sandbox policies. This is a configured-product comparison, not an isolated measurement of harness code.
- Token and cost fields are adapter-reported usage. Cost may be absent or calculated differently by providers; it is not a normalized billing audit.
- Fewer than two agents completed a run; this is not a head-to-head comparison.
- Only 3 task(s) have complete, identical SHA-256 fingerprints and the requested number of trials across all completed agents; the guide targets at least 50 representative tasks.
- Only 1 trial(s) per task were requested. One trial is a smoke test; three trials are a minimum diagnostic repeat, not a confidence interval or significance test.
- No verified matched task is labeled large; this run does not test larger repository-level work.
- Every scored agent was served model gpt-oss-20b, but the gateway could not confirm one upstream provider for all of them (missing or different provider fields); serving stacks can differ in quantization and limits.
- The selected agents do not all have one identical, explicitly requested model ID.

## Agents not run

- Codex CLI: the endpoint refused every request (HTTP 422 on /responses: Failed to deserialize the JSON body into the target type: include[0]: unknown variant `reasoning.encrypted_content`, exp), so the agent never reached the model; this is an endpoint mismatch, not a result

## Run provenance

| Agent | CLI version | Source revision | Runtime |
|---|---|---|---|
| Aider | aider 0.86.2 | 0b86899f1a2637b33b65b5598704a175b197dd8f | v22.21.1 / linux / x64 |

## Task coverage

Shared task IDs: safe-relative-path, taskflow-priority-sort, taskflow-search.
Verified matched tasks: safe-relative-path, taskflow-priority-sort, taskflow-search.

<details><summary>Per-task results</summary>

| Task | Category | Difficulty | Aider |
|---|---:|---:|---:|
| `safe-relative-path` | security-boundaries | medium | 100% |
| `taskflow-priority-sort` | data-structures | small | 0% |
| `taskflow-search` | data-structures | medium | 0% |

</details>

Raw per-trial JSON files contain verifier output, changed files, and adapter-reported usage. Keep those files with this summary; the summary alone is not a complete audit record.
