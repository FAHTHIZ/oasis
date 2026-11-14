# Benchmark methodology

OASIS contains several kinds of evaluation. They answer different questions and should not be combined into one headline score.

## Product demonstrations are not benchmark results

The README includes an unscripted `gpt-oss-20b` CLI recording, with a GIF, MP4 and raw terminal cast. It demonstrates the user-facing flow and makes mistakes, approvals and verification visible. It is a single qualitative example, not a fixed verifier-backed task set. Do not quote its duration, tool count or token usage as comparative success, speed, cost or safety evidence.

For quantitative comparisons, use the controlled live-evaluation protocol below: pin the model, provider, task set, verifier, configuration and environment; record attempts, verified outcomes, interventions, failures, tokens, elapsed time and cost; and report repetitions and variance.

## Runtime performance

`npm run bench:perf -- --runs 7 --json FILE` measures the runtime without a model. Recorded 14 November 2026 on Linux x64, 2 CPUs, 8 GB RAM, Node 22.21, light load ([raw JSON](../bench/results/perf-2026-11-14.json)):

| Measurement | Median | Notes |
| --- | --- | --- |
| `oasis --version` | 26 ms | peak RSS 46.3 MB |
| `oasis --help` | 27 ms | peak RSS 46.8 MB (325 ms / 113 MB before the help fast path) |
| Import agent runtime | 217 ms | 176 source modules, 149 dependency modules |
| Create session (default tools) | 170 ms | 21 tools, RSS 158.8 MB |
| First request size | ~5,228 tokens | system prompt 2,165, tool schemas 3,063 |
| Web workspace server | 158.2 MB idle | 159.5 MB after serving the app (175 KB) |
| Task routing decision | 29 µs | per `selectTaskModel` call |
| stdio MCP server connect | 24 ms | p90 136 ms, 20 tools listed |

Most remaining memory comes from Oasis's own source modules, which load at import. Splitting them further is open work. Importing `src/agent.mjs` loads 345 modules (+59 MB RSS). The third-party packages among them (`yaml`, `jsonc-parser`, `unbash`, `cockatiel`, `image-size` and five small ones) add about 17 MB together. Loading any one of them lazily would save at most 3.5 MB (`yaml`), so they still load at import (measured 14 November 2026).

About 45 MB of the session's RSS appears on the first token count, which loads the tokenizer's BPE table. Measured 14 November 2026 in a fresh Node 22 process (RSS after loading and encoding one string): `gpt-tokenizer` o200k (what OASIS uses) +68 MB / 284 ms, `gpt-tokenizer` cl100k +46 MB, `js-tiktoken` o200k +153 MB, `tiktoken` (WASM) o200k +65 MB. `gpt-tokenizer` is within 3 MB of the WASM build and needs no binary, and `js-tiktoken` uses more than twice as much, so no change was made. The table loads on the first token count, not at startup (`--version` and `--help` stay at 46 MB).

### CLI launch against other agent CLIs

`npm run bench:perf -- --compare` (Linux only) runs `--version` and `--help` for each agent CLI on PATH. Every CLI is measured the same way: the same machine, a scratch HOME, no provider keys, and no model calls. It samples peak RSS (`VmHWM`) for every process in the CLI's process tree every 2 ms. Recorded 14 November 2026, 5 runs each ([raw JSON](../bench/results/perf-compare-2026-11-14.json)):

| CLI (version) | `--version` | `--help` | Peak RSS, largest process / tree sum |
| --- | --- | --- | --- |
| OASIS 1.3.0 | 28 ms | 29 ms | 46.8 / 46.8 MB |
| Claude Code 2.1.325 (native binary) | 9 ms | 137 ms | 22.5 MB (`--version`), 101.1 MB (`--help`) |
| Codex CLI 0.169.0 | 39 ms | 37 ms | 47.2 MB, Node wrapper only (see below) |
| OpenCode 1.19.5 | 544 ms | 564 ms | 126.2 / 138.6 MB |
| Aider 0.86.2 | 883 ms | 853 ms | 73.5 / 122.7 MB (21 processes) |
| Gemini CLI 0.68.0 | 1,772 ms | 1,739 ms | 201.1 / 370.5 MB (2 processes) |

These numbers measure launch cost only. They say nothing about how well an agent does on a task, and launch time hardly matters once a model call takes seconds. Sampling can miss very short-lived subprocesses, so the memory figures are lower bounds. Codex's Rust binary answers `--version` faster than the sampling interval, so only its Node wrapper was recorded.

## Router comparison

`npm run bench:routers -- --route name=baseUrl,model[,KEY_ENV] ...` sends the same requests to one model reached directly and through local gateways, and checks what an agent depends on: tool calls arriving with valid arguments, complete streams, usage reporting, a clear error for an unknown model, and the model appearing in `/models`. Keys are read from the named environment variables and never written out.

Run on 14 November 2026 with OVH's anonymous `gpt-oss-20b`, direct, through FreeLLMAPI and through OmniRoute, over 3 rounds ([details and raw rows](../bench/results/routers-2026-11-14/README.md)). Both routers passed every tool-call, streaming, usage and unknown-model check. OmniRoute's streams were slower in all three rounds (median first token 6.4 s against 0.5 s direct and 2.0 s through FreeLLMAPI), and OmniRoute does not list `ovh/…` models in `/models`. Three rounds are an indication, not a measured router overhead.

Oasis was then run end to end on two eval tasks over each route ([write-up and raw records](../bench/results/routers-2026-11-14/e2e/README.md)). Direct: 2/2. FreeLLMAPI: 1/1 scored (one task excluded after OVH 429s). OmniRoute: 0/2 at first. Two OmniRoute stream quirks caused this: the tail of a tool call's arguments arrived as a separate nameless call, and keepalive chunks were mistaken for the served model. After Oasis handled both (commit `98b411d0`), OmniRoute scored 1/2, and the remaining failure was the model ignoring a required error wording. One trial per task: this shows the routes work for agent traffic. It does not rank them.

## Model-free harness benchmark

Run:

```sh
npm run bench:harness
```

The harness benchmark imports real OASIS runtime functions and evaluates them against fixed, labelled cases. Its tracks cover areas such as tool-call recovery, edit application, command-safety decisions, secret detection and other runtime guards. Where a meaningful baseline exists, the report shows it alongside OASIS.

Useful options:

```sh
node bench/harness/run.mjs --verbose
node bench/harness/run.mjs --json ./harness-results.json
node bench/harness/run.mjs --check
```

The CI check mode is deterministic and omits the wall-clock latency track. A regular report may include startup or latency measurements; those depend on the machine and should be compared only under controlled conditions.

The held-out case sets are intended to test generalization beyond the cases used during routine development. Keep their labels and expected outcomes intact. If a held-out case is changed, document the reason and preserve the previous result so the comparison remains interpretable.

## Token-efficiency benchmark

Run:

```sh
npm run bench:tokens
```

This benchmark uses a scripted provider and fixed evaluation tasks. It records the request bodies generated by the real agent loop, counts tokens with the o200k_base BPE vocabulary (gpt-tokenizer, the same counter OASIS uses for context budgeting in `src/tokens.mjs`), and checks that scripted edits still satisfy each task's verifier.

Useful options:

```sh
node bench/tokens/run.mjs --verbose
node bench/tokens/run.mjs --json ./token-results.json
node bench/tokens/run.mjs --check
```

Counts use one vocabulary for every model, so they track but do not equal each provider's own tokenizer (Anthropic, Gemini and Qwen tokenize differently). `--check` refuses a baseline counted with a different counter instead of comparing incompatible numbers. Host facts in the prompt (kernel release, Node version, date, temp path) and per-run ids and test timings are replaced with fixed stand-ins before counting ([bench/tokens/normalize.mjs](../bench/tokens/normalize.mjs)), so a laptop and CI measure the same code identically; `--check` also refuses a baseline measured under different counting rules. The benchmark can compare prompt growth, tool-schema overhead and reusable request prefixes under its fixture assumptions; it does not establish real-world billing or model quality.

## Memory retrieval benchmark

`npm run bench:memory` scores memory search (`rankMemories`: MiniSearch BM25+ with Porter2 stemming) on 30 realistic project memories in [evals/memory-retrieval](../evals/memory-retrieval). It uses 15 dev questions, which may be used while tuning, and 25 held-out paraphrased questions, which are the number to report. Each question has exactly one right memory.

| Split | Questions | Recall@1 | Recall@3 | MRR |
|---|---:|---:|---:|---:|
| Dev | 15 | 100% | 100% | 1.000 |
| Held-out | 25 | 92% | 100% | 0.960 |

Measured 2026-11-09. The two held-out misses are vocabulary gaps: "update the README images" (the note says "screenshots") and "run the python tests" (the note says "pytest"). Both still rank second. `test/memory-retrieval-bench.test.mjs` fails if held-out recall@1 drops below 88%, recall@3 below 96% or MRR below 0.93. The set is small and was written by the maintainers, so it guards against regressions; it does not measure retrieval at scale.

Optional embedding rerankers were measured on the same questions on 2026-11-12 with [transformers.js](https://github.com/huggingface/transformers.js) 4.3.2. Reciprocal-rank fusion of BM25 with all-MiniLM-L6-v2 or bge-small-en-v1.5 (q8) gave held-out recall@1 96% (MRR 0.980) with dev unchanged. Reranking BM25's list by MiniLM similarity alone gave held-out 100% but dropped dev recall@1 to 93%. The gain is one question in 40, and the cost is a 745 MB install with native binaries plus a model download on first use, so OASIS does not ship a reranker. See row 31 of the [replacement matrix](REPLACEMENT-ROADMAP.md#decision-matrix-for-remaining-home-grown-parts).

## Live model evaluations

Live evaluations involve an actual provider and model. Their outcomes depend on the model snapshot, provider implementation, prompt, task set, context limits, tool protocol, sampling settings, network conditions and available budget.

When recording a live result, include at least:

- Exact model identifier and provider.
- Date and evaluation commit.
- Task set and task-verifier version.
- OASIS configuration, permission mode and enabled integrations.
- Machine and operating-system details where relevant.
- Number of tasks attempted, completed and verified.
- Token usage, elapsed time and cost where the provider reports them.
- Failures, skipped tasks and any manual intervention.

Compare systems using the same model, task set, provider settings and environment wherever possible. Report repetitions and variance when the benchmark is nondeterministic.

## Latest results (12 November 2026)

Measured on commit `c1396e7b`, Node 22, a 2-core Linux machine. Raw files are in [bench/results](../bench/results).

### Harness (model-free)

`npm run bench:harness`, file [harness-2026-11-12.json](../bench/results/harness-2026-11-12.json). Baseline is the same input without the OASIS guard.

| Track | Development set | Held-out v1 | Held-out v3 |
| --- | --- | --- | --- |
| Malformed tool-call recovery | 26/26 (baseline 3/26) | 11/11 (baseline 1/11) | 13/13 (baseline 0/13) |
| Edit application | 14/14 (baseline 4/14), 5/5 bad edits refused | 7/7 (baseline 1/7), 3/3 refused | 5/5 (baseline 0/5), 3/3 refused |
| Risky commands stopped under auto-approve | 49/49, everyday commands usable 32/32 | 15/15, 10/10 usable | 54/54, 22/22 usable |
| Placeholder (elided code) guard | 12/12, 0/8 false alarms | 4/4, 0/2 | 6/6, 0/4 |
| Weakened-test detection | 8/8, 0/4 false alarms | 3/3, 0/1 | 7/7, 0/3 |
| Secret scanning before commit | 10/10, 0/8 false alarms | 5/5, 0/3 | 8/8, 0/5 |

Held-out v2 still misses one secret pattern (4/5); it is kept as measured. First request with the default tool set: 17 tools, about 5,282 tokens (system 2,508, schemas 2,774); the 16K small-context profile sends 11 tools and about 3,228 tokens.

### Tokens (scripted provider)

`npm run bench:tokens`, file [tokens-2026-11-12.json](../bench/results/tokens-2026-11-12.json). Both fixed tasks pass their verifiers; usage accounting matches.

| Task | Requests | Input tokens | Uncached | First / last request |
| --- | ---: | ---: | ---: | --- |
| `taskflow-search` (gpt-oss-20b profile) | 18 | ~162,628 | ~13,561 | ~5,173 / ~13,541 |
| `normalize-token-usage` (gpt-4o profile) | 18 | ~257,444 | ~20,323 | ~5,645 / ~20,306 |

### Live, local model on CPU

`npm run bench:live -- --agents oasis --model qwen2.5-coder:3b-oasis --router http://localhost:11434/v1 --task clamp-integer --timeout-seconds 1800`, files in [live-2026-11-12-ollama](../bench/results/live-2026-11-12-ollama/SUMMARY.md). Ollama on 2 CPU cores, no GPU.

| Task | Model | Result |
| --- | --- | --- |
| `clamp-integer` (small) | qwen2.5-coder 3B, 32K window | Timed out at 1,800 s after 17,210 tokens, before verification |

This shows the hardware, not the harness: a 3B model on two CPU cores generates a few tokens per second, so one small task does not fit in 30 minutes. The earlier same-gateway run against Claude Code is in [live-2026-11-08-omniroute](../bench/results/live-2026-11-08-omniroute/README.md). SWE-bench and Terminal-Bench scores (the adapter is in `bench/harbor`) need a capable hosted model and a paid budget, so none are published yet.

### Recorded same-model gateway (14 November 2026)

`npm run bench:live -- --upstream URL --model ID` starts a local gateway, routes every agent through its own tagged path (`/a/<agent>/v1`), relays chat completions, Anthropic Messages and OpenAI Responses calls, forces the one model on all of them, and writes `gateway.jsonl` with the model and provider the upstream reports for each call. The summary calls a run "same model verified" only when every scored agent was served one identical model; otherwise it says so in the interpretation limits.

First run, files in [live-2026-11-14-openrouter-gateway](../bench/results/live-2026-11-14-openrouter-gateway/README.md): OASIS passed `clamp-integer` in 190.9 s (22 calls, all served by `nvidia/nemotron-3-ultra-550b-a55b:free` via Nvidia). Codex CLI ran 20 calls on the same served model before OpenRouter's free-tier daily limit (50 requests) stopped it; Claude Code sent nothing because it routed loopback calls through `HTTPS_PROXY` (fixed). A scored head-to-head needs a key with credits: OpenRouter raises the free-model limit to 1,000 requests a day once 10 credits are added.

Second run, five agents on Kilo Gateway's keyless route, files in [live-2026-11-14-kilo-h2h-partial](../bench/results/live-2026-11-14-kilo-h2h-partial/README.md). It planned 12 tasks. It stopped after the first because Kilo's anonymous quota ran out (HTTP 429 `PROMOTION_MODEL_LIMIT_REACHED`, not retryable) after 70 requests. On `clamp-integer` all five agents passed: OASIS, Claude Code 2.1.325, Codex CLI 0.169.0, OpenCode 1.19.5 and Aider. All were served `nvidia/nemotron-3-ultra-550b-a55b:free`. By the gateway's count, OASIS sent the most prompt tokens: 242,932 in 15 requests, against Codex's 157,994 in 14, OpenCode's 111,139 in 11 and Aider's 739 in 1. Claude Code's 35,492 is likely uncached input only. This is one task and one trial, so it is a smoke test, not a ranking. Agent-reported token counts disagree with the gateway (OpenCode reported 37,253), so compare gateway counts. Since this run the relay stops on a non-retryable quota 429, drops tasks failed under rate limiting from the scores, saves `progress.json` after each unit, and records message sizes (not contents).

Third run (batch 1), four agents on the same Kilo route, files in [live-2026-11-14-h2h-b1](../bench/results/live-2026-11-14-h2h-b1/README.md). It planned four tasks and ran out of Kilo's quota after 96 calls in 36 minutes. On `taskflow-priority-sort` all four agents fixed the bug, then all failed the verifier's "at least 20 passing tests" check with 19. The task's starting tests already failed, so the check could not be met; the task was fixed in `9e763b83`, and this result is not comparable with later runs. On `safe-relative-path` OASIS (437 s, 17 tool calls) and Claude Code passed, Codex failed after the upstream returned 429, and OpenCode was not reached. OASIS ran from an unpinned working tree that changed during the run (the summary records both revisions). Later runs use a pinned worktree.

## Normal-user runs

Separate from scored benchmarks, OASIS is used the way a person would: type a request, approve steps, read the answer. These runs use real providers and no scripted model, so they show speed, wording and rough edges a harness does not.

| Date | Request | Interface | Model | Outcome |
| --- | --- | --- | --- | --- |
| 8 Nov 2026 | Fix `slugify()` (only the first space was replaced), add a `node:test` test, run the tests | Web app, Ask first | gpt-oss-20b (Pollinations, free) | Pass. Global-regex fix, new test file, 1 test passing. 409 s, 2 approvals. |
| 8 Nov 2026 | Same task, earlier build | Web app | gpt-oss-20b | Pass in 411 s. Found: stale reply cursor, empty steps, "Working" shown behind the approval sheet. All fixed. |
| 7 Nov 2026 | "math.mjs add() is wrong. Fix it, add a test, run it." | `oasis -p` | gpt-oss-20b | Pass, exit 0, about 10 minutes. Found: no output until the end. Fixed with per-step progress on stderr. |
| 7 Nov 2026 | Build a to-do web app in `index.html` | Web app | gpt-oss-20b | Working app in about 6 minutes. |
| 7 Nov 2026 | Install and use 16 plugins from `anthropics/claude-plugins-official` | Web app and terminal | gpt-oss-20b | All installed; hooks, skills and MCP servers ran. Found: 46 tools and 36.5k characters of schemas per request. Large MCP servers now load on demand (21 tools, 16.5k characters). |

Times are dominated by the free endpoint (35–140 s per request, one request at a time). Each problem found became a fix with a regression test; see the [Changelog](../CHANGELOG.md).

## Interpreting results

- A harness benchmark measures selected runtime behaviours, not general coding ability.
- A token benchmark measures scripted request construction and approximate input size, not model intelligence.
- A live task score measures a particular model/runtime/configuration combination on a particular task set.
- Passing tests and benchmark cases do not prove that OASIS is defect-free, secure in every environment or superior to another product.

Do not describe a result as a universal ranking or a guarantee. Publish the raw report, methodology and commit alongside any headline number.
