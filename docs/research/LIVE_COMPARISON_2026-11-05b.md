# Live head-to-head, 2026-11-05 (second set)

Real runs, no mocks, on the repository's hidden-verifier eval tasks (`evals/tasks`), through local logging gateways that force one model for every agent. Raw summaries are in [`bench/results/live-2026-11-05b/`](../../bench/results/live-2026-11-05b/). Runs before `729816f` recorded the HEAD at the end of the run, not the code they loaded; where the start time pins the loaded revision, the table says so. This follows the [first set](LIVE_COMPARISON_2026-11-05.md), which ran on Gemini Flash-Lite until that key's daily quota ran out.

Read the caveats before quoting any number: one trial per task, at most three tasks, free endpoints with rate limits and long stalls. This is a smoke test, not a ranking.

## Setup

| | |
|---|---|
| Models | `gpt-oss-20b` through Pollinations' keyless endpoint (the gateway waits 47 s between requests to stay inside its limit); `nvidia/nemotron-3-ultra-550b-a55b:free` through OpenRouter's free tier (about 50 requests a day) |
| Gateway | A local proxy that rewrites every request to the one model above and logs each request, response and token count, so all agents get the same model whatever they ask for |
| Agents | OASIS 1.1.0 (main), Aider 0.86.2 (`openai/` prefix), OpenCode 1.19.5 (`@ai-sdk/openai-compatible`, config written by `bench:live --router`) |
| Not run | Claude Code and Codex CLI: neither can use these models through their normal setup, and no Anthropic or OpenAI account was available. Gemini CLI: its key's daily quota was still used up. |

## Results

### gpt-oss-20b (Pollinations)

| Agent | clamp-integer | safe-relative-path | taskflow-search | Passed |
|---|---|---|---|---:|
| OASIS, morning (HEAD `d8eaed8` at the end of the run) | fail | pass (70,660 tokens) | fail: HTTP 400 | 1/3 |
| Aider, morning | pass (1,652 tokens) | pass (2,084 tokens) | fail: added no tests | 2/3 |
| OpenCode, evening (harness at `bb25890`, loaded at start) | pass (35,287 tokens, 242 s) | fail: "Expected 'id' to be a string" | fail: same error | 1/3 |
| OASIS, evening (`bb25890`, loaded at start) | pass (90,093 tokens, 476 s) | pass (221,834 tokens, 1,095 s) | fail: HTTP 400 | 2/3 |
| OASIS, taskflow-search rerun (`729816f`) | — | — | FAIL: HTTP 400 "Unknown role: assistant<\|channel\|>commentary" from the upstream after 258,409 tokens, 1,090 s. The harmony tool-name cleaning worked live and the run continued until this upstream error; `e814649` now retries it | — |
| OASIS, second taskflow-search rerun (`66d4812`, loaded at start) | — | — | pass (188,606 tokens, 857 s, 16 tool calls, 18 requests). No upstream 400 happened this time, so the `e814649` retry was not exercised; the gateway's own log matches the reported tokens. [Summary](../../bench/results/live-2026-11-05b/taskflow-rerun2-SUMMARY.md) | — |

What happened in the failures:

- **OASIS, HTTP 400 (both runs).** gpt-oss sometimes leaks its harmony channel tokens into a tool name (`read_file<|channel|>commentary`). OASIS sent the name back with the tool result, and the endpoint rejected the whole request ("Names must match `^[a-zA-Z0-9_-]{1,64}$`"), which ended the run. The fix (`cc58a59`) landed six minutes after the evening run had loaded its code, so that run still hit it. The benchmark summary credited the run to the HEAD at the end, which was wrong; `729816f` now records the revision loaded at start and flags runs where HEAD moved.
- **OASIS, morning clamp-integer.** The model's regex rejected negative numbers, and it never read the repository's existing `clampInteger` in `src/config.mjs`.
- **OpenCode, "Expected 'id' to be a string".** The endpoint's stream sometimes sends a final tool-call fragment at a new index with no id or name (in one captured stream, the closing `}` of call 0 arrived as index 1). OpenCode's client stops on it. OASIS now joins such a fragment to the previous call (`2171d91`); before that, it would have built a broken, nameless call.
- **Aider, taskflow-search.** The task says "add tests"; Aider changed the code and added none.
- **Taken together on taskflow-search:** every agent failed it in the matched runs above. One later OASIS-only run passed it, so it is not counted in any agent's score: one pass in one trial says the task is reachable on this model, not that OASIS would pass it reliably.

### Nemotron 3 Ultra (OpenRouter free), safe-relative-path only

| Agent | Result | Tokens | Time |
|---|---|---:|---:|
| OASIS (HEAD `d3c6ad7` at the end) | pass | 349,162 | 389 s (19 requests, including one 232 s upstream stall) |
| Aider | pass | 4,943 | 237 s |
| OpenCode (HEAD `ce18cbf` at the end) | not valid | 71,819 | 281 s |

The OpenCode trial is not valid: it ran before the `PWD` fix (`bb25890`), so OpenCode worked in the folder the benchmark started from, not the task workspace, and left the workspace unchanged. The daily request limit did not allow a rerun.

## What the runs found in OASIS, and the fixes (all on main)

| Finding | Fix |
|---|---|
| Harmony tokens in a tool name made the endpoint reject the request with HTTP 400 | Names are cleaned before dispatch and before they are sent back (`cc58a59`) |
| A stray tool-call fragment at a new index would have become a nameless call | Joined to the previous call, in the CLI and the app (`2171d91`) |
| `glob_files` ignored a `path` folder, so `{path: "src", pattern: "*.mjs"}` searched the root, found nothing, and the model decided the project had no modules | `path` is supported (relative, or absolute inside the project), and a root-only pattern with no matches lists matching files in subfolders (`4ce9fdb`, `f8cca69`) |
| `search_file` instead of `search_files` cost a turn | Singular/plural slips map to the one matching tool (`5b931fb`) |
| `run_command` with `args` as one string failed | Accepted (`0cd306b`) |
| After tests passed, the gate asked for a separate diff review, and the model wrote a second, contradictory final answer | A passing check covers targeted edits; files rewritten wholesale still need a diff review (`a2d9ee1`) |
| Each request carried the README up to 9k characters, long skill lines and long tool schemas | README clipped to 2.5k characters, skill lines to 160, five schemas shortened (`ce18cbf`, `0315f8c`, `857c1ab`) |
| The eval summary credited a run to commits made while it ran | Revision recorded at load, with a flag when HEAD moves (`729816f`) |

The harness had two bugs that affected other agents: OpenCode ignored `OPENAI_BASE_URL` (fixed by writing an OpenCode provider config, `0d8c1ca`), and it took its project folder from `PWD` (`bb25890`).

## What this does and does not show

- On gpt-oss-20b, OASIS went from 1/3 to 2/3 during the day. Its remaining failure was a crash on a leaked tool name, which is now fixed (see the rerun row).
- **OASIS uses far more tokens than Aider.** On the same passed task it used 34 to 71 times as many: 70,660 vs 2,084 on gpt-oss and 349,162 vs 4,943 on Nemotron. Aider makes one edit per task without a tool loop. OASIS explores, edits, runs checks and answers the verification gate, and every step resends the conversation. The fixes above cut the fixed part of each request, but the loop itself is the cost. On free endpoints with request limits, that is a real disadvantage.
- Nothing here compares OASIS with Claude Code or Codex. Those agents could not run on these models.
- One trial per task cannot separate these agents. Next: 3 trials on 10 or more tasks when a provider with enough quota is available.
