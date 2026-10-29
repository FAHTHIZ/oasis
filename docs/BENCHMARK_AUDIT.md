# Benchmark audit and next steps

**Audit date:** October 29, 2026  
**Scope:** the 31 checked-in evaluation fixtures, evaluator/verification design, report metadata, and readiness for a fair Claude Code comparison.  
**Status:** static audit completed; no authenticated live head-to-head run has been performed in this audit.

## Finding

OASIS has a useful evaluator foundation, but the current suite is better described as a deterministic smoke/regression suite than a competitive coding benchmark. The task validator has meaningful integrity checks: each task has a non-empty prompt, a reference patch and an external verifier; the no-op baseline must fail; the reference patch must apply and pass; task fingerprints include the prompt, shared snapshot, reference patch and verifier. The evaluator also uses disposable task workspaces, rejects symlinks and sensitive patch paths, and compares task-balanced outcomes only when task IDs overlap.

The main limitation is task representativeness, not simply task count. The 31-task suite clusters around isolated helper functions, parsing and boundary behavior. There is useful security and configuration coverage, but relatively little evidence of sustained work in an existing codebase: multi-file features, debugging after failing tests, architecture-aware changes, regression recovery, cancellation/resume, or broad changes spanning several modules. One task explicitly requires a source change plus a new regression-test file. The existing suite should not be marketed as proof of parity with Claude Code.

## Current coverage inventory

The task IDs fall into these approximate areas:

| Area | Tasks | What the current coverage can tell us |
|---|---:|---|
| Small helpers and data-shape utilities | 13 | Useful signal on precise implementation of bounded, deterministic functions; low evidence for broader repository understanding. |
| Input, network, path and credential boundaries | 12 | Useful regression signal for secure parsing, URL/path boundaries, and redaction; does not prove end-to-end security or sandbox strength. |
| Context, token/cost estimation, retry and cache behavior | 4 | Checks selected agent-adjacent utilities, not long-context planning quality or real provider recovery. |
| Configuration integration | 2 | Adds persistence/configuration behavior; still too small to represent normal multi-file engineering work. |
| **Total** | **31** | Good smoke/regression foundations; insufficient by itself for competitive capability claims. |

Treat this categorization as a planning aid, not a benchmark result. Task counts do not imply equal difficulty, importance, or statistical weight.

## Reproducibility and fairness gaps

1. **Source revision was missing from run reports.** The OASIS and Claude Code runners recorded runtime/provider/task fields but not the exact OASIS source commit. The evaluator now records `sourceRevision` when a full 40-character commit SHA is available and includes it in comparison metadata. Historical reports without the field remain unpinned and should not be retroactively treated as revision-verified.
2. **A fixture verifier is not the same as a real task benchmark.** Baseline/reference validation proves that a task is discriminative and its reference solution works. It does not prove that the task resembles real user work or that a model can solve it.
3. **Harness and product comparison must be kept separate.** Compare the same pinned model on both harnesses where possible to study harness effects. When each product uses its own recommended model/configuration, label it a product comparison and report those differences rather than attributing the full result to the agent loop.
4. **Permission and environment differences must be recorded.** The Claude Code runner uses restricted CLI mode and a small approved command set; OASIS evaluation uses its own approval and tool policy. This is not an OS sandbox. Either align policies where practical, or explicitly call the result a configured-product comparison.
5. **Cost must remain unknown when it is unreported.** For estimated OASIS token costs, preserve the configured rates and label the result as an estimate. Missing vendor per-run cost data is not zero cost.

## Next benchmark build-out

### P0 — Preserve provenance

- [x] Record exact OASIS source revision in new run reports when the checkout or execution environment supplies one.
- [x] Surface source revisions in comparison JSON and terminal output; leave missing/legacy revisions explicitly unpinned.
- [x] Reject malformed `--trials` values rather than allowing `parseInt` to silently turn values such as `2.5` and `2abc` into two trials.

### P1 — Expand task representativeness

Add and validate at least 25 additional tasks before promoting the suite as a serious coding benchmark. Prioritize:

- Existing-code bug fixes with regression tests across 2–5 files.
- Feature work that follows existing architecture and preserves API compatibility.
- Failed-test diagnosis and a second edit/test recovery cycle.
- Read/search/navigation tasks requiring a correct code-path explanation or change.
- Tool permission denial, cancellation, and safe resume behavior.
- Long-context tasks that exercise context compaction and task continuity.
- Cross-module configuration/provider changes and reliable integration tests.

Keep the verifier outside the agent-editable workspace. Use independent acceptance checks, record reference patch size and touched modules, and review for trivial shortcuts that satisfy the verifier without actually meeting the task intent. Prefer separate, task-specific repository snapshots over one overly simplified fixture repo for all categories.

### P2 — Make the score hard to game

- Define task category and difficulty before the run; show both overall and category-balanced results.
- Pin task definitions and source snapshots by SHA-256 fingerprints and keep historical reports immutable.
- Run at least three trials per task for stochastic model behavior, publish every failed/timeout trial, and separate primary acceptance pass rate from quality review.
- Add a blinded human diff review rubric for correctness, unintended changes, maintainability and test quality; report it separately from automated pass rate.
- Normalize timeout, permission, model, context and budget policy before starting a run. Document unavoidable differences.
- Run the full suite in an environment isolated from personal credentials; the fixture runner itself is not an OS-level sandbox.

### P3 — Run and publish the comparison

1. Validate the task suite with `npm run check` and `node src/cli.mjs eval --validate`.
2. Run a one-task pilot with both agents and inspect raw tool traces and verifier behavior.
3. Pin versions, commit SHAs, model IDs, environment, permissions, trial count, timeout, budget and pricing methodology.
4. Run three or more trials and preserve full machine-readable reports, task-level pass/fail, timings, and all failures.
5. Publish conclusions only at the level supported by the data. Do not claim general parity from the smoke suite or a handful of tasks.

## Current result status

No authenticated Claude Code head-to-head outcome is reported here. The changes in this audit improve provenance; they do not themselves demonstrate that one coding agent is better than another.
