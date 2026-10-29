# OASIS coding-agent benchmarks

**Status: harness and smoke-suite only. No Claude Code head-to-head result has been published yet.**

The first task taxonomy is an explicit, reviewable estimate in `evals/tasks/metadata.json`; the difficulty labels are not calibrated benchmarks, and the current suite still lacks large repository-level tasks.

This page records how to produce a reproducible, auditable comparison. It deliberately does not claim OASIS is faster, cheaper, or more accurate than Claude Code without completed runs on the same tasks.

## What the current 32-task suite proves

The repository has 32 deterministic evaluation fixtures under **evals/tasks/**. Eight recently added fixtures broaden coverage into network boundary validation, retry policy, credential hygiene, bounded data handling, and cache behavior. The `config-strict-integer-bounds` task is the first multi-file project regression: it fixes permissive configuration parsing and requires a dedicated regression-test file. Each fixture has a task prompt, a disposable repository snapshot, a reference patch, and an external verifier. The suite validator checks both that the untouched baseline fails and that the reference patch passes.

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

Compare the two reports using the generated paths:

```sh
node src/cli.mjs eval --compare /path/to/oasis-run.json /path/to/claude-code-run.json
```

The comparator now fingerprints each task's prompt, shared repository snapshot, reference patch, and external verifier. A same-named task with a different fingerprint is excluded from headline results; legacy reports without fingerprints are marked unverified. The comparator reports task-balanced pass rate, category-balanced pass rate, difficulty-balanced pass rate, per-task median time, cost when known, and per-task results. Category/difficulty metadata is read from `evals/tasks/metadata.json`, included in task fingerprints, and must match across reports; incompatible metadata is excluded instead of silently blended. Legacy reports without category metadata remain comparable by task ID/fingerprint but cannot produce a category- or difficulty-balanced headline score. Never compare different or modified task definitions in headline metrics.

## Fair-comparison rules

1. Use identical task IDs, task prompts, snapshots, verifier scripts, trial counts, timeout budgets and run ordering.
2. Record the exact OASIS commit, OASIS model/provider/version, Claude Code CLI version, Claude model, OS, Node.js version, max-turn limit, timeout, permission policy, and run date. Do not combine results across model versions without a separate row.
3. To compare the **agent harnesses**, run the same model through OASIS and Claude Code where both providers permit it. To compare the **products as configured**, publish those as separate runs and label the different models/configurations.
4. Treat deterministic verifier outcomes as the success signal. Do not use a model to judge itself and do not count a task as passed just because the agent says done.
5. Run three trials at minimum and publish every failure and timeout. Report task-balanced, category-balanced, and difficulty-balanced pass rates plus total trial counts.
6. Report cost only when supported by per-run usage metadata or documented token rates. Subscription usage with no per-run dollar amount is **unknown**, not zero. OASIS's token-price setting produces an estimate and does not account for every cache/billing modifier; label it as an estimate.
7. Do not claim "90%" or "at the same level as Claude Code" from this 32-task smoke suite. A credible public claim needs a larger set of repository-level bug-fix/refactor tasks, independent hidden tests, leakage checks, and multiple trials.

## Result status

No live Claude Code results are included yet. The CLI integration is testable with a fake runner, but this task-authoring session did not run an authenticated Claude Code CLI benchmark. Before publishing head-to-head numbers, run both agents against identical task fingerprints, use the same model when comparing harnesses, publish every trial and failure, and retain the complete machine-readable reports.
