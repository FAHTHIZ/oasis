# OASIS coding-agent benchmarks

**Status: model-free harness benchmark published (below); 50-task agent suite (including 17 repository-level tasks) and runners ready. No same-model head-to-head against Claude Code has been published yet.**

The first task taxonomy is an explicit, reviewable estimate in `evals/tasks/metadata.json`; the difficulty labels are not calibrated benchmarks, and the current suite still lacks large repository-level tasks.

This page records how to produce a reproducible, auditable comparison. It deliberately does not claim OASIS is faster, cheaper, or more accurate than Claude Code without completed runs on the same tasks.

## Model-free harness benchmark (2026-11-01)

A coding agent is a model plus a harness. This benchmark measures the harness alone: it feeds OASIS the outputs that real models actually produce (malformed tool calls, drifting edits, dangerous commands, placeholder rewrites, weakened tests, leaked credentials) and checks what the runtime does with them. No model, network or API key is needed, so anyone can reproduce it in a few seconds:

```bash
node bench/harness/run.mjs            # all sets, human-readable
node bench/harness/run.mjs --verbose  # list every failing case
node bench/harness/run.mjs --json out.json
```

Each track compares OASIS with a simple baseline that has no repair or guard layer (strict `JSON.parse` on native calls only, exact unique `old_string` match, no command policy, no guards). This is an honest floor, not a model of any particular competing product.

### Three case sets

- **Development set:** cases the runtime was improved against. Scores here are expected to be high and say little about generalization.
- **Held-out v1:** written before any fix and scored once untuned (`bench/results/harness-heldout-v1.json`); its misses were fixed afterwards, so it is now a tuned set too.
- **Held-out v2:** written after the v1 fixes and scored once untuned (`bench/results/harness-heldout-v2.json`); its real misses were then fixed.

The untuned held-out scores are the generalization numbers. Report those, not the post-fix 100%.

| Track | Baseline (dev) | OASIS before fixes (dev) | Held-out v1, untuned | Held-out v2, untuned | All sets now |
| --- | --- | --- | --- | --- | --- |
| Tool-call recovery (malformed or text-only calls) | 3/26 | 25/26 | 9/11 (baseline 1/11) | 9/9 (baseline 0/9) | 100%, 0 false runs |
| Edit application under drift | 4/14 | 13/14, 1 wrong write | 7/7 (baseline 1/7) | 4/5 (baseline 1/5) | 100%, 0 wrong writes |
| Destructive commands stopped with approvals off | 0/49 | 31/49 | 9/15 | 13/16 (14/16 with the scorer fix below) | 100%, every everyday command still runs |
| Placeholder (elision) rewrites caught | 0/12 | 12/12 | 2/4 | 2/3 | 100%, 0 false alarms |
| Weakened tests caught | 0/8 | 8/8 | 2/3 | 2/3 | 100%, 0 false alarms |
| Secrets caught before commit | 0/10 | 8/10 | 4/5 | 4/5 | 19/20 (one deliberate miss, below), 0 false alarms |

Notes:

- Negative cases are scored too: plain prose and code samples that must not run as tool calls, edits that must be refused (ambiguous or absent `old_string`), everyday commands that must still run, ordinary comments, honest test renames, env references, placeholders and UUIDs that must not trip a guard.
- The command scorer originally decided which commands a Git safety snapshot can undo with a hard-coded ID list, so `git reset --hard HEAD~3` in v2 was scored as unprotected. Cases now carry a `recoverable` flag. The untuned v2 number above is the one recorded before that fix.
- `v2-slack` is still a miss on purpose. The test token contains the sequential digits `1234567890`, which the secret scanner treats as a placeholder to avoid false alarms on documentation. Real Slack tokens do not look like that, so the filter stays.
- "Commands stopped" means blocked, or held for approval even in bypass mode (`run_shell` high-risk commands such as `curl | sh`, `terraform destroy` or `git clean -x` always ask), or made undoable by an automatic Git safety snapshot.

### Context overhead and startup

| Profile | Tools sent | System prompt | Tool schemas | First request | Time to first model request | End to end |
| --- | --- | --- | --- | --- | --- | --- |
| Default | 64 | ~4,232 tok | ~11,198 tok | ~15,430 tok | ~246 ms | ~323 ms |
| Small-context (windows of 16K or less) | 13 | ~1,576 tok | ~2,161 tok | ~3,737 tok | ~252 ms | ~339 ms |

Tokens are estimated as characters / 4. Times are medians of 5 cold `oasis -p` runs against a local fixture server on a 2-CPU machine. Rarely used tools in the small-context profile stay reachable through `tool_search`.

### What this benchmark does not show

It does not measure task success with a real model, and it does not compare OASIS with Claude Code, Codex CLI or any other product. It shows that, for the same model output, the OASIS runtime recovers more calls, applies more edits correctly and stops more damage than a harness without these layers. Task success needs the agent suite below, run with the same model in each harness.

## What the current 50-task suite proves

The repository has 50 deterministic evaluation fixtures under **evals/tasks/**. Seventeen of them (`taskflow-*`) are repository-level tasks on a small multi-module CLI project (`evals/snapshots/taskflow`: store, query, dates, format, CLI and event modules with its own 19-test suite): eight are bug reports in which the agent must find a defect from a user-style symptom description and add a regression test, and nine are multi-file features (search, weekday due dates, unsubscribe, an urgent priority, stats, export with secret redaction, undo, recurring tasks, atomic bulk completion). Their verifiers run the project's whole test suite, require new tests to be added, and then check behaviour with hidden assertions that the agent never sees. Eight recently added fixtures broaden coverage into network boundary validation, retry policy, credential hygiene, bounded data handling, and cache behavior. The `config-strict-integer-bounds` task is the first multi-file project regression: it fixes permissive configuration parsing and requires a dedicated regression-test file. Each fixture has a task prompt, a disposable repository snapshot, a reference patch, and an external verifier. The suite validator checks both that the untouched baseline fails and that the reference patch passes.

### Added fixture catalogue

| Fixture | Independent acceptance focus |
|---|---|
| `http-body-limit` | UTF-8 byte counting, bounded JSON bodies, oversized and malformed payloads |
| `same-origin-redirect` | Relative redirect resolution, HTTP(S)-only destinations, origin and credential checks |
| `transient-provider-retry` | Transient status allowlist and strict maximum-attempt behavior |
| `secret-log-redaction` | Bearer credentials and sensitive key/value assignments without losing safe text |
| `bounded-pagination` | Strict integer parsing, safe offsets, and bounded page sizes |
| `ttl-cache` | Injected-clock expiry and oldest-insertion eviction at capacity |
| `safe-archive-entry` | POSIX/Windows absolute paths, UNC paths, NULs, and traversal rejection |
| `normalize-request-headers` | Case-insensitive lookup, whitespace trimming, and ambiguous record-key rejection |
| `session-history-truncation` | Keep system context and the newest 119 messages when persisting long sessions |

This is useful for checking evaluator integrity and a broader range of coding behaviors. Two fixtures now require coordinated production-code and regression-test changes (`config-strict-integer-bounds` and `session-history-truncation`), but the suite is still **not** a representative real-world software-engineering benchmark: most tasks remain small and utility-level, and their reference solutions exist in the repository. Do not market the suite's pass rate as parity with Claude Code. New runs record a top-level `sourceRevision` when a full Git commit SHA is available from `OASIS_SOURCE_REVISION`, `GITHUB_SHA`, or the checked-out repository's `git rev-parse HEAD`; packaged installs without repository metadata may report `null`. Comparison output surfaces revisions and labels missing revisions as unavailable.

## Reusable repository snapshots

A task can include its own complete `repo/` directory, or a small `repo/BASE_SNAPSHOT` pointer containing a reusable snapshot ID. The pointer resolves to `evals/snapshots/<snapshot-id>/`; IDs are restricted to safe lowercase slugs, and the referenced directory must exist and must not itself be a symlink. Named snapshots let multiple task fixtures share the same repository revision without duplicating the full source tree.

The evaluator fingerprints the snapshot contents alongside the task prompt, reference patch, verifier, and classification metadata. Changing snapshot contents changes the task fingerprint, so results from different repository states must not be blended as if they used the same task. Keep each snapshot immutable for a comparison and record its upstream repository URL and exact commit in adjacent benchmark documentation.

### Task statements name the exact signature (2026-11-02)

The 20 "Create `src/lib.mjs` exporting `name(...)`" tasks used to hide the parameter list, so a multi-argument helper such as `clampInteger` could be correct and still fail because the model chose a different argument order. Each statement now gives the signature from its reference patch, for example `clampInteger(value, fallback, min, max)`. Verifiers, reference patches and snapshots are unchanged and `oasis eval --validate` still passes all 50 tasks, but the task fingerprints changed, so the comparator will not pair results recorded before and after this change. The field runs below that predate it are marked.

Each trial row in a result file also has `changes`: the files the agent added, modified or deleted relative to the snapshot, with contents capped at 6,000 characters per file and 24,000 per trial, so a failure can be traced to the code that caused it.

## Run the suite validator first

From a clean checkout with Node.js 22 or newer:

```sh
npm install
npm run check
node src/cli.mjs eval --validate
```

The validator does not call a model. A successful validation means the fixtures and verifiers are internally consistent, not that either agent has solved the tasks.

## Run Claude Code on the same fixtures

Install and authenticate the current Claude Code CLI first. The benchmark requires v2.1.248 or newer because it uses the CLI's restricted mode. Check the [official CLI reference](https://code.claude.com/docs/en/cli-reference) and [headless execution guide](https://code.claude.com/docs/en/headless) for current flag behavior.

Start with one task before running the full set:

```sh
node src/cli.mjs eval --claude-code --task clamp-integer --trials 1 --yes
```

Then run three trials per task:

```sh
node src/cli.mjs eval --claude-code --trials 3 --yes
```

Options include **--model sonnet** or an exact model name, **--max-turns 30**, **--timeout-seconds 600**, and **--budget-usd 1.00**. The dollar cap is supported by Claude Code print mode but is a client-side estimate; check the vendor's billing records for actual charges. See the [official pricing page](https://platform.claude.com/docs/en/about-claude/pricing). The runner uses restricted mode, disables session persistence, exposes file tools plus Bash, and auto-approves only **npm test**, **npm run check**, and read-only **git diff/status** patterns. Other tool requests are denied by the non-interactive permission policy. It does not use the unrestricted permission-bypass mode.

This remains an agent running code. The verifier is kept outside the disposable workspace, but the runner is not an OS-level sandbox. Run benchmarks in a controlled environment, do not point it at personal workspaces, and use a dedicated account/configuration with no unrelated secrets. A timed-out or rejected tool request counts as a failed trial.

## Run OASIS and compare reports

In a separate run, configure OASIS to use the model/provider configuration you want to compare:

```sh
node src/cli.mjs eval --trials 3 --timeout-seconds 600 --yes
```

Both OASIS and Claude Code modes accept **--timeout-seconds** (30–3600 seconds; default 600). The OASIS runner aborts the model turn and closes session-owned processes when the deadline fires; this is cooperative cancellation, not an OS-level sandbox guarantee for arbitrary third-party tools. The Claude Code runner applies the same budget to the CLI process. Setup and the independent verifier are outside the agent deadline, although the reported wall time includes workspace setup and verification.

The runner writes JSON reports in the OASIS config directory under **eval-results/** by default. You can select a different destination using **OASIS_EVAL_RESULTS_DIR**.

### Optional model-routing trials

OASIS evals can opt into a second model for the easy tier:

```sh
node src/cli.mjs eval --task clamp-integer --trials 3 \
  --route-easy-model LOW_COST_MODEL_ID \
  --route-strong-model STRONG_MODEL_ID --yes
```

These flags apply only to OASIS eval runs and cannot be combined with `--claude-code`. The evaluator passes each pinned fixture's difficulty label as an explicit routing hint. A fixture marked `small` can therefore test the easy model even if it includes a code edit. This is a controlled benchmark override; normal interactive prompts use the conservative read-only classifier and do not inherit fixture labels.

Routed reports record requested and selected models, route tier/reason, per-model cost estimates, and the estimated difference versus the strong model. Estimates use the routed task's observed token counts and configured model pricing; a strong-model answer could use a different number of tokens. Missing price data is reported as unknown. Compare routed and unrouted runs as distinct configurations with the same task snapshot, verifier, trial count, timeout, and provider constraints.

Compare the two reports using the generated paths:

```sh
node src/cli.mjs eval --compare /path/to/oasis-run.json /path/to/claude-code-run.json

# Save a reusable JSON comparison and an offline HTML report:
node src/cli.mjs eval --compare /path/to/oasis-run.json /path/to/claude-code-run.json \
  --out ./eval-results/arena-comparison.json \
  --html ./eval-results/arena-comparison.html
```

The optional **--out** and **--html** flags create durable artifacts from the same comparison. The JSON file preserves the complete comparison structure for follow-up analysis. The standalone HTML report is responsive, keyboard-readable, works offline, escapes report-supplied labels, and includes headline metrics, task-by-task outcomes, run revisions, paired task wins/ties/losses, and interpretation guardrails. Output paths must differ from each other and from the input run reports. Existing output files must be regular files rather than symlinks. Reports are written to a unique owner-only temporary file in the destination directory and atomically renamed into place, so readers do not see partial reports and the final path cannot redirect report bytes through a symlink. Exported artifacts use owner-only permissions where the operating system supports POSIX file modes.

The comparison includes **paired task outcomes**: for each matched task, it compares the two observed pass rates across that task's recorded trials and counts an A win, B win, or tie. This is descriptive only, not a statistical significance test. It also includes structured **caveats** when the matched sample has fewer than 50 tasks, any task has fewer than three trials, run revisions/fingerprints are missing, classifications are incomplete, or no large tasks are represented. Caveats are part of the JSON artifact and are visible in the HTML/terminal output so a small or unpinned run is not easily mistaken for a parity claim.

The comparator now fingerprints each task's prompt, shared repository snapshot, reference patch, and external verifier. A same-named task with a different fingerprint is excluded from headline results; legacy reports without fingerprints are marked unverified. The comparator reports task-balanced pass rate, category-balanced pass rate, difficulty-balanced pass rate, per-task median time, cost when known, and per-task results. Category/difficulty metadata is read from `evals/tasks/metadata.json`, included in task fingerprints, and must match across reports; incompatible metadata is excluded instead of silently blended. Legacy reports without category metadata remain comparable by task ID/fingerprint but cannot produce a category- or difficulty-balanced headline score. Never compare different or modified task definitions in headline metrics.

## Fair-comparison rules

1. Use identical task IDs, task prompts, snapshots, verifier scripts, trial counts, timeout budgets and run ordering.
2. Record the exact OASIS commit, OASIS model/provider/version, Claude Code CLI version, Claude model, OS, Node.js version, max-turn limit, timeout, permission policy, and run date. Do not combine results across model versions without a separate row.
3. To compare the **agent harnesses**, run the same model through OASIS and Claude Code where both providers permit it. To compare the **products as configured**, publish those as separate runs and label the different models/configurations.
4. Treat deterministic verifier outcomes as the success signal. Do not use a model to judge itself and do not count a task as passed just because the agent says done.
5. Run three trials at minimum and publish every failure and timeout. Report task-balanced, category-balanced, and difficulty-balanced pass rates plus total trial counts.
6. Report cost only when supported by per-run usage metadata or documented token rates. Subscription usage with no per-run dollar amount is **unknown**, not zero. OASIS's token-price setting produces an estimate and does not account for every cache/billing modifier; label it as an estimate.
7. Do not claim "90%" or "at the same level as Claude Code" from this 50-task suite alone. A credible public claim needs a larger set of repository-level bug-fix/refactor tasks, independent hidden tests, leakage checks, and multiple trials.

## Coverage audit and result limits

The checked-in evaluator currently has **50 deterministic task fixtures**: 19 labelled small, 28 medium and 3 large. The original 33 mostly exercise bounded helper logic, parsing, validation, storage and security/configuration cases; the 17 `taskflow-*` tasks add repository-level bug diagnosis and multi-file features with hidden verifier assertions. All 50 pass the validator (baseline fails, reference patch passes). This is stronger regression coverage, but one small project is still not a representative SWE-bench-scale benchmark.

The static audit identified these priorities:

1. Done (November 1, 2026): 17 repository-level tasks added to reach 50. Still open: more pinned repositories, covering multi-file features, real bug fixes, failing-test diagnosis/recovery, context continuity, permission denial, cancellation and unrelated-change preservation.
2. Pin source revision, task and snapshot fingerprints, model/provider, prompt, permission policy, budget, timeout and environment for every run.
3. Run stochastic tasks at least three times and retain raw results, including all failures and timeouts.
4. Keep independent deterministic acceptance separate from blinded human diff review for correctness, regressions and maintainability.
5. Keep quarantine and negative controls active so benchmark prompts do not leak and the scorer demonstrates that it can detect a bad result.

No authenticated live Claude Code head-to-head result is published. Do not claim parity, superiority, speed or accuracy from fixture count or a single run.

## Result status

No live Claude Code results are included yet. The CLI integration is testable with a fake runner, but this task-authoring session did not run an authenticated Claude Code CLI benchmark. Before publishing head-to-head numbers, run both agents against identical task fingerprints, use the same model when comparing harnesses, publish every trial and failure, and retain the complete machine-readable reports.

## Small local model field runs (2026-11-01)

These are diagnostic runs, not a benchmark result. They were run on a 2-CPU, 7 GB machine with llama.cpp `llama-server` b12024 (`--jinja -c 16384`) and Qwen2.5-Coder-1.5B and -3B Instruct (Q4_K_M), using `oasis -p` and `oasis eval --task clamp-integer --trials 1`.

Rows without a note used the earlier task wording, where `clampInteger(...)` did not state its argument order (see [task statements](#task-statements-name-the-exact-signature-2026-11-02)). Both earlier Qwen3-4B `clamp-integer` failures returned `0` for `clampInteger('8', 7, 1, 10)`, which fits a different argument order rather than broken clamping logic. That is a guess from the output; the runs did not log the code.

| Model | Run | Outcome | Main failure modes seen |
| --- | --- | --- | --- |
| Qwen2.5-Coder-1.5B | about 12 `oasis -p` runs | File created in later runs; logic still wrong | Described steps instead of acting; text and XML-attribute tool calls; announced a step then stopped; canned refusals; claimed changes it never made; echoed `<tool_response>`; tutorial pseudo-code in place of the file |
| Qwen2.5-Coder-3B | 2 `oasis -p` runs | File created, harness ran diff and `node --check`, syntax error caught | Used `tool_search` as a code search; several JSON calls in one fence; pasted the corrected file as a code block instead of editing |
| Qwen2.5-Coder-3B | 2 `oasis eval` trials on `clamp-integer` | 0/2 passed | Trial 1 stopped without creating the file. Trial 2 wrote the file and the harness ran the checks, but the code returned `'8'` instead of `8` and had the wrong signature; it also called made-up tools (`git_init`, `git_add`) |
| Qwen3-4B (Q4_K_M, llama.cpp b12032, `-t 2`) | 1 `oasis eval` trial on `clamp-integer`, after the 900 s first-byte fix | 0/1 passed | The run no longer times out: 6 tool calls, finished on its own, 53,658 tokens, 36.6 min wall time (prompt reads at about 11 tokens/s on 2 CPUs). The hidden verifier failed on logic (`0 !== 8`): the model's clamp returned the wrong value. Harness side worked as designed; code correctness is the model's limit |
| Qwen3-4B (same setup) | 1 `oasis eval` trial on `parse-boolean-flag`, before commit 2d6dbb8 | 0/1 passed | Hit the 45-minute task timeout with no completed tool call recorded, after 43,154 tokens. The llama-server log later showed the cause was in OASIS, not the model: Node's built-in `fetch` (undici) has a hidden 300 s response-header timeout, so every long prompt was cancelled exactly 301 s after it started and retried. Fixed in 2d6dbb8 (loopback providers now use `node:http`) |
| Qwen3-4B (same setup) | 1 `oasis eval` trial on `parse-boolean-flag`, after 2d6dbb8 | 1/1 passed | Passed the hidden verifier: 4 tool calls, 35,204 tokens (34,257 in, 947 out), 24.9 min wall time. The first request read about 7.7k prompt tokens for roughly 8 minutes without being cancelled. One trial, so this is a single data point, not a pass rate |
| Qwen3-4B (same setup) | 1 `oasis eval` trial on `clamp-integer`, rerun after 2d6dbb8 | 0/1 passed | Fewer tool calls and tokens than the first run (4 tool calls, 34,121 tokens: 33,351 in, 770 out) in 23.0 min, but the same wrong answer: the hidden verifier got `0` where it expected `8`. Other work (the test suite and browser checks) shared the 2 CPUs during this run, so the wall time is pessimistic. This is a model-correctness failure, not a harness timeout. |
| Qwen3-4B (same setup) | 1 `oasis eval` trial on `dedupe-names`, at commit 31e609e | 1/1 passed | Passed the hidden verifier: 5 tool calls, 46,744 tokens (45,602 in, 1,142 out), 35.8 min wall time. The server ran on port 8081, which OASIS does not probe, so the first request was rejected as too long (17,146 tokens against 16,384) and retried with the small tool set, as described in the CHANGELOG. The test suite also ran on the same 2 CPUs during part of this run. This run predates the compact-prompt swap in 1371dfb. |
| Qwen3-4B (same setup) | 1 `oasis eval` trial on `clamp-integer` with the stated signature, at commit 0216802 (compact-prompt swap included) | 0/1 passed | Finished in 12.5 min with 4 tool calls and 20,497 tokens (19,882 in, 615 out), against 23 to 37 min before. After the expected overflow on port 8081, the first real request was 4,230 prompt tokens, against about 7.9k in the `dedupe-names` run, which saved about 3.5 min of prompt reading on 2 CPUs. With the argument order fixed, the answer moved from `0` to `7` (the fallback) for `clampInteger('8', 7, 1, 10)`: the helper apparently rejected the numeric string `'8'` instead of parsing it. That is still a model-correctness failure. This run started before per-trial change logging (601e11d), so its code was not kept. |
| Qwen3-4B (same setup) | 1 `oasis eval` trial on `safe-task-id`, at commit 8f92a04 (first run with per-trial change logging) | 0/1 passed | Finished on its own in 16.4 min with 8 tool calls and 41,172 tokens (40,213 in, 959 out). The saved changes show why it failed: the task asks for `src/lib.mjs`, but the model created `src/utils.mjs`, so the verifier could not import the helper. Its logic was also off by one (it allowed 63 characters in total, not a first character plus up to 63). Both are model mistakes the harness recorded but did not cause. The wrong file name is now caught: OASIS tells the model once to use the named file (see the CHANGELOG). The off-by-one is still up to the model. The full test suite shared the 2 CPUs for part of this run. |
| Qwen3-4B (same setup) | 1 `oasis eval` trial on `safe-task-id`, at commit d55989b (with the wrong-file check) | 1/1 passed | Passed the hidden verifier: 5 tool calls, 25,892 tokens (24,984 in, 908 out), 17.3 min wall time. The model wrote `src/lib.mjs` on its own this time, so the wrong-file check never fired; the pass is run-to-run variation, not that check. The saved code still has flaws the hidden tests do not catch: a case-insensitive `/i` flag that accepts uppercase, and a 63-character limit where 64 is allowed. The full test suite shared the 2 CPUs for part of this run. Across both tries: 1/2. After this run the `safe-task-id` verifier was made stricter (it now checks a 64-character ID, a mixed-case ID such as `aBc`, `a.b`, `a_b`, a leading hyphen, a backslash, a tab and a number). The code from this run fails the stricter verifier, so under the current task fingerprint the score for this run would be 0/1. |

Each failure mode above has a matching harness change and a regression test (see the 1.0.0 entries in [CHANGELOG.md](../CHANGELOG.md)). The remaining 3B failures are about code correctness, which the harness can surface (verifier and syntax errors go back to the model) but cannot fix. To reproduce, start `llama-server` with `--jinja`, set `OASIS_BASE_URL=http://127.0.0.1:8080/v1`, and run `oasis eval --task clamp-integer --trials 3 --yes` with `OASIS_DEBUG=raw` to log every model reply before cleanup.

## Cost-aware model routing experiment

OASIS can route clearly small, read-only tasks to a cheaper model while keeping implementation, security-sensitive, ambiguous, and larger tasks on a strong model. Routing is deliberately conservative; it is not a guarantee that every easy request can be recognized.

Configure the interactive agent with:

```text
/routing easy MODEL_ID
/routing strong MODEL_ID
/routing on
/routing status
```

The strong model defaults to the provider model for the session if no separate strong model is configured. Routing settings are saved in user settings. Untrusted project settings cannot switch the user's model routing policy.

Run the full task suite with three trials per task and explicit model IDs:

```sh
node src/cli.mjs eval \
  --route-easy-model CHEAPER_MODEL_ID \
  --route-strong-model STRONG_MODEL_ID \
  --trials 3 \
  --timeout-seconds 600 \
  --yes
```

Run a separate baseline without the routing flags. Keep both runs on the same source revision, task fingerprints, provider configuration, and trial count. Do not compare runs with different revisions or task fingerprints as though they were paired.

Routed OASIS trial records include the selected model, requested/default model, route tier and reason, strong-model baseline, token totals, estimated cost, estimated savings, and a costSource field. When a model has no configured price, routed cost and savings remain unknown rather than being inferred from the other model's rate. Configure model prices in settings when a provider/model is not covered by the built-in pricing table.

**Interpretation boundary:** the strong-model comparison estimates what the same observed token counts would cost at the strong model's configured rate. It is a counterfactual price estimate, not a second run and not evidence that the stronger model would use the same number of tokens or produce the same result. Run the unrouted baseline separately to compare pass rate, time, and actual token consumption. Do not present the estimated per-task saving as a measured quality or performance improvement.

The default classifier sends only short, clearly read-only prompts to the easy model. The evaluator also passes the task's small / medium / large metadata as a routing hint: small tasks can use the easy model; medium and large tasks use the strong model. Security-sensitive language always overrides a small hint and stays on the strong model. Those labels are fixture metadata, not a calibrated model of task complexity.

---

## Five-track measurement contract

The five-track work measures narrow failure modes—context durability, token efficiency, task-list fidelity, ambiguity safety and long-horizon completion. It is separate from the existing 50-task regression evaluator and is not a training system; it does not train, tune or modify a model. A track is publishable only after frozen tasks, hash validation, a deterministic scorer, a negative control, at least three seeds, CI and a raw result artifact all exist.

**Status: benchmark infrastructure is being built in gated stages. No five-track result has been published.**

> This suite measures the specific failure modes documented in Claude Code's public issue tracker. A passing score is not a claim of general superiority. It is a claim that OASIS does not reproduce these specific failures.

## Purpose and scope

This suite measures five narrow, falsifiable behaviors: context durability, token efficiency, task-list fidelity, ambiguity safety, and long-horizon completion. It is not a training system and it does not train, tune, or modify a model.

The existing `evals/tasks/` suite remains a separate utility-focused regression suite. Its 50 fixtures, disposable snapshots, reference patches, external verifiers, snapshot fingerprints, validator, Claude Code runner, and JSON/HTML comparison reports are reused rather than rebuilt. The fixtures must not be presented as a representative coding-quality score.

## Measurement rules

Every track must satisfy all of these rules before its result is publishable:

1. **Frozen tasks:** store the evaluation set as UTF-8 JSON Lines in `bench/tasks/`. Store its SHA-256 digest in `bench/hashes/{track}.sha256`. A runner must refuse to start if the task file's digest differs.
2. **Deterministic scoring:** use exact-match checks, external test results, token counts, or binary state checks. Do not use a language model to judge another model's output.
3. **Controlled comparisons:** pin the model while comparing harnesses; pin the harness while comparing models. Record the exact model and harness revisions.
4. **Repeated runs:** use at least three seeds. Publish each seed, the mean, and a confidence interval. A single run is not a benchmark result.
5. **Quarantine:** task prompts and exact question strings must not enter training data, teacher dialogues, or reusable snapshots. CI must reject unknown files and symlinks in protected data locations and detect exact prompt matches.
6. **Negative control:** every track has one control that must perform strictly worse than the positive run. The track is blocked until that assertion passes in CI.
7. **Complete reporting:** publish failures, timeouts, and losses as well as successes. Never remove inconvenient results from the report.

A track is not complete because its runner starts or its scorer emits a number. It is complete only after its frozen tasks, hash check, deterministic scorer, negative control, three-seed run, CI result, and result artifact are all present.

## Tracks and targets

The values in this table are the planning baselines and targets from the benchmark build contract. They are not OASIS measurements. Primary-source references for each external baseline must be recorded alongside the relevant task design before making a public claim that the target beats that baseline.

| Track | Failure measured | Contract baseline | Initial target |
|---|---|---:|---:|
| **FRR — Context Durability** | Facts from earlier session history are lost after compaction | Compact-Bench: at most 16.0% recurring-detail retention for LLM summaries (different metric) | Overall Fact Retention Rate above 40%; task continuation preserved in every seed |
| **TPST — Token Efficiency** | Unnecessary context and cache token consumption | One Claude Code issue: 12,195,203 tokens across 32 model calls in a single reported session (incident, not a benchmark baseline) | At most 50% of Claude Code tokens per successful task on the same model and task set |
| **Staleness Window — Task-List Fidelity** | Completed work remains marked incomplete | One Claude Code issue: task list remained stale for about 25 tool calls (single incident) | Mean no more than 3 calls; maximum no more than 5 |
| **BVR — Ambiguity Safety** | Agent acts on an ambiguous target without clarification | UnderSpecBench: 55.8–67.8% boundary violations across five agent/model configurations | Below 20% across 20 tasks and 3 seeds |
| **UCR — Long-Horizon Completion** | Agent fails to finish multi-file work after a mid-task dependency arrives | GitTaskBench: best reported task pass rate 48.15% (not unattended completion) | At least 70% unattended verified completion |

## External source audit and comparability

These references explain why the tracks matter. They are **not interchangeable baselines**: the tasks, models, harnesses, metrics, and sampling differ. The initial targets above remain hypotheses until OASIS and a comparison harness are measured on the same frozen tasks with the same model and run conditions.

- **Context compaction — [Compact-Bench, arXiv:2610.31710](https://arxiv.org/abs/2610.31710):** across its separate recurring-detail dataset, LLM summaries retained at most 16.0% of recurring details; production summaries retained 15.7% at the first compaction boundary. This is recurring-detail retention, not the FRR score defined here. Its task-preservation experiment separately found stable damage in 5–64% of 22 full-history successes, depending on the summarizer.
- **Token use and task-list staleness — [Claude Code issue #106138](https://github.com/anthropics/claude-code/issues/106138):** one user-reported session recorded 32 model calls and 12,195,203 total tokens (12,121,965 cache-read, 49,369 cache-write, 64 uncached input, and 23,805 output tokens). The roughly 380,000 cache-read tokens are an average per model call, not total tokens per successful task. The same issue describes a seven-step task list remaining on step 1 through about 25 tool calls while steps 1–4 were completed. Both are single incident reports, not population estimates.
- **Ambiguity safety — [UnderSpecBench, arXiv:2607.02294](https://arxiv.org/abs/2607.02294):** its 69 task families and 2,208 prompt variants produced 55.8–67.8% action-boundary violations across five agent/model configurations. Its deterministic oracles separate wrong-target and over-scope behavior from clarification, refusal, and deferral. The OASIS BVR task set is smaller and must not be presented as a direct replication.
- **Repository task completion — [GitTaskBench, AAAI 2026](https://ojs.aaai.org/index.php/AAAI/article/view/40533):** the paper reports 54 realistic repository tasks; the best reported system, OpenHands with Claude 3.7, solved 48.15%. That is task success, not the two-hour unattended-completion metric defined by UCR.

The Claude Code issue figures are anecdotal examples. They are useful for constructing falsifiable tests, but cannot establish a general Claude Code average. No OASIS-versus-Claude-Code performance claim is justified until the same-model, same-task comparison in the build gates is complete.

### Track definitions

**FRR — Fact Retention Rate**

One 50-turn refactor task uses a pinned multi-file snapshot. Ten known facts are queried at turns 10, 25, and 40. Score the exact facts recovered at each checkpoint and overall. Its negative control replaces the compaction summary with a random subset of earlier turns; FRR must fall.

**TPST — Tokens per Successful Task**

Ten multi-file refactor tasks are selected from the existing fixture suite. Count input, output, cache-read, and cache-write tokens. A task is successful only when its external verifier passes. Its negative control reduces the available context to 10% before each task; measured tokens per successful task must rise.

**Staleness Window**

A seven-step task delays an external input needed by step 2. Measure the tool calls between actual completion and the corresponding task-list update. Its negative control freezes the task list; the measured window must increase to the full task length.

**BVR — Boundary Violation Rate**

Twenty deliberately ambiguous tasks are scored into exactly one category: Safe Clarification, Safe Deferral, Wrong Target, or OverScope. BVR is (Wrong Target + OverScope) divided by total runs. Its negative control uses fully specified versions of the same tasks; BVR must fall to near zero.

**UCR — Unattended Completion Rate**

A two-hour multi-file refactor runs on a pinned snapshot. A mock external dependency arrives during the task and requires re-planning. A run passes only when tests are green and language-server diagnostics are clean without human intervention after the initial prompt. Its negative control removes the mid-task dependency; completion rate must improve.

## Required file layout

Each track is added only when the preceding gate is satisfied:

```text
bench/
  README.md
  tasks/
    frr/turn_50_refactor.jsonl
    tpst/refactor_10.jsonl
    staleness/delayed_step_7.jsonl
    bvr/ambiguous_20.jsonl
    ucr/refactor_2h_midtask.jsonl
  hashes/
    frr.sha256
    tpst.sha256
    staleness.sha256
    bvr.sha256
    ucr.sha256
  runners/
    frr.py
    tpst.py
    staleness.py
    bvr.py
    ucr.py
  scorers/
    frr.py
    tpst.py
    staleness.py
    bvr.py
    ucr.py
  controls/
    frr_negative.py
    tpst_negative.py
    staleness_negative.py
    bvr_negative.py
    ucr_negative.py
  results/
    .gitkeep
```

## Build order and gates

1. **Infrastructure reuse audit:** validate the existing 50 fixtures on current HEAD, inspect quarantine CI, verify the Claude Code runner's minimum version and restricted mode, and keep this document linked from the root README.
2. **Existing-suite negative control:** add `--negative-control` to the existing eval runner. It must substitute no-op or random predictions and assert a pass rate strictly below the configured threshold.
3. **FRR:** do not begin the next track until the FRR negative control passes and checkpoint scores are reported.
4. **Staleness:** proceed only after its frozen-list control proves the metric moves in the expected direction.
5. **BVR:** review the four-category deterministic scorer line by line; run the fully specified control.
6. **TPST:** audit token accounting for cache-read/cache-write double counting; run the truncated-context control.
7. **UCR:** use a pinned snapshot and a mock mid-task dependency; run the dependency-removed control.
8. **Claude Code comparison:** pin the same model and run configuration on both harnesses. Publish the JSON and HTML comparison, including losses.

Do not skip a gate or begin a later track early. If a negative control does not produce a strictly worse score, stop: the metric has not demonstrated that it can detect the failure it claims to measure.

## Result publication

Each completed track publishes `bench/results/{track}.json` with the frozen task digest, source revision, model and harness identifiers, run timestamps, per-seed raw outcomes, mean, confidence interval, negative-control result, and verifier details.

The final comparison is published as:

- `bench/results/comparison.json`
- `bench/results/comparison.html`

The README summary must distinguish wins, ties, and losses. Missing runs and unavailable measurements must be labeled as unavailable, never silently replaced with zero.

## Five-track implementation status

As of October 31, 2026, the five-track protocol and required layout are documented, but no five-track result or OASIS-vs-Claude Code score has been published. External issue reports and paper figures in the design are hypotheses for constructing falsifiable tasks, not population baselines. The current 50-task evaluator and its report comparator remain distinct from these future track-specific runners and scorers.
