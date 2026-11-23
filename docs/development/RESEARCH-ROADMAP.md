# Research and invention log

This file records the technology research done for OASIS: what each new mechanism solves, what existing systems do, what is actually new, how it was measured, and where it landed. Each entry names its commit on `main` and the tests that cover it. Ideas that were examined and rejected are listed too, with the reason.

The rule for an entry: it must close a gap OASIS had, not rename something it already did, and it must have a measurable acceptance criterion that was checked.

## Shipped

### Effect contracts and the intent journal

- Commit: `f00fbd77`. Docs: [Effects](../EFFECTS.md), [Durable execution](../DURABLE-EXECUTION.md).
- Problem: shell commands were a blind spot. `/rewind` undid tool edits but not what `sed -i`, a formatter or a generator changed, and after a crash nobody knew whether the action that was running had happened.
- Prior art: Claude Code and Codex checkpoints restore tool edits and the conversation, not shell effects ([Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing), [Codex discussion](https://github.com/openai/codex/discussions/9618)). Workflow engines record activity results and require idempotent activities ([Temporal](https://docs.temporal.io/activities), [Restate](https://docs.restate.dev/concepts/durable_execution)); write-ahead logging comes from databases ([ARIES](https://dl.acm.org/doi/10.1145/128765.128770)).
- New: every non-read-only command is bracketed by Git tree snapshots written through a private index and object store, so the observed effects are exact and rewindable without touching the user's repository; a write-ahead intent journal records probes per action, and after a crash each in-doubt action is resolved by observing its targets ("observe and decide") instead of retry-and-hope.
- Acceptance: shell changes are undone by `/rewind`; the user's index, refs and object store are byte-identical before and after; after a simulated crash, applied, partial and not-applied actions are classified correctly. All covered by `test/effect-contracts.test.mjs` and `test/intent-journal.test.mjs`.

### Supply chain: SBOM, provenance attestations and reproducible packs

- Commit: `1b4a5e30`. Docs: [Downloads and releases](../RELEASES.md).
- Problem: release artifacts had checksums but no statement of what they contain or how they were built.
- Prior art: [SLSA provenance](https://slsa.dev/spec/v1.0/provenance), [in-toto attestations](https://github.com/in-toto/attestation), [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).
- New for OASIS: a deterministic CycloneDX 1.6 SBOM generated from the lockfile, signed build provenance for the tarball and SBOM via [actions/attest](https://github.com/actions/attest) pinned by commit, and a check that two packs of the same commit are byte-identical.
- Acceptance: the SBOM is identical across runs; the pack is reproducible; the release workflow attests both files.

### Verified updates

- Commit: `0a8b77f2`. Docs: [What `oasis update` checks](../RELEASES.md#what-oasis-update-checks).
- Problem: `oasis update` installed whatever the network returned.
- New: the update downloads the release's own npm tarball, checks its SHA-256 against `SHA256SUMS`, reads `package.json` from inside the tarball to refuse downgrades or substitutions, and verifies the SLSA provenance with `gh attestation verify` pinned to the release workflow, tag and commit. A failed check installs nothing.
- Acceptance: `test/update-verify.test.mjs` (8 tests, including the real v1.8.0 tarball). Live check against v1.8.0: checksum matched; provenance reported `unavailable` in a sandbox where `gh` could not reach Sigstore, which is the documented outcome.

### Verifier diversity

- Commit: `d20c38d2`. Docs: [Task model, verifier diversity](../TASK-MODEL.md).
- Problem: a "second look" by the same model family counted as independent review.
- Prior art: correlated errors among LLM judges and self-preference bias ([ACM 2025](https://dl.acm.org/doi/10.5555/3780338.3781516), [arXiv 2605.29800](https://arxiv.org/html/2605.29800), [arXiv 2604.07650](https://arxiv.org/html/2604.07650)).
- New: reviewers are scored on independence from the author (provider, family, prompt, evidence channel); a same-family review is labelled as such and does not satisfy an "independent review" gate.
- Acceptance: covered by `test/verifier-diversity.test.mjs`.

### One trace across processes

- Commit: `cbdda045`. Docs: [Trace context across processes](../CONFIGURATION.md#trace-context-across-processes).
- Problem: a task's spans stopped at process boundaries: a command, an MCP server and the model request each started a new trace.
- Prior art: [W3C Trace Context](https://www.w3.org/TR/trace-context/), [OpenTelemetry environment carriers](https://opentelemetry.io/docs/specs/otel/context/env-carriers/), [MCP SEP-414 request `_meta`](https://modelcontextprotocol.io/seps/414-request-meta), [GenAI span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md).
- New: `TRACEPARENT` is passed to every spawned command, `_meta.traceparent` to MCP `tools/call`, the `traceparent` header to model requests, and `oasis mcp serve` continues the caller's trace. `OASIS_OTEL_ENV_CONTEXT=parent|link|off` chooses parent or link semantics ([discussion](https://github.com/open-telemetry/opentelemetry-specification/issues/5398)).
- Acceptance: `test/trace-context.test.mjs` (5 tests, including a real cross-process MCP call whose server span has the client span as parent).

### Fault injection and the reliability laboratory

- Commit: `ed8c1f7d`. Docs: [Reliability laboratory](../RELIABILITY-LAB.md).
- Problem: recovery code was tested one path at a time; nobody measured whether a task survives realistic failures without duplicating side effects.
- Prior art: [Principles of chaos engineering](https://principlesofchaos.org/), [Netflix chaos engineering](https://netflixtechblog.com/tagged/chaos-engineering).
- New: `OASIS_FAULTS` injects model and tool faults into the real agent on seeded schedules; the lab runs 15 scenarios against a reactive stand-in model in throwaway work trees and scores completion, duplicated effects and wasted requests.
- Findings and fixes: the first run scored 10/15. Cut, garbage and empty HTTP 200 bodies ended the task, and a lost reply after an append caused a duplicate write. Bad bodies are now retried like interrupted streams (at most twice), and failed journaled calls are checked against their probes and observed effects at once (`afterFailure`).
- Acceptance: 15/15 with 0 duplicated effects after the fixes; ablation with `OASIS_AFTER_FAILURE_CHECK=0` gives 13/15 with 2 duplicates; the idempotent-write scenario uses 3 model requests instead of 5. `test/fault-injection.test.mjs` (7 tests).

### Command rehearsal

- Commit: `937d9d97`. Docs: [Command rehearsal](../REHEARSAL.md).
- Problem: an approval prompt showed the command line only; for programs, builds and package scripts the static effect prediction can only say "broad".
- Prior art: [binpash/try](https://github.com/binpash/try) runs a shell command over overlayfs and commits the upper layer, without network isolation and without a conflict check; tool-specific dry runs (`make -n`, `terraform plan`) cover only their tool.
- New: before approval, the command runs once in a bubblewrap overlay with no network, no host sockets and a read-only system; the prompt lists the exact files it would create, modify and delete; after approval the real run is compared with the rehearsal and any file it changed beyond what was shown is named. `oasis rehearse --apply` lands exactly the rehearsed changes after re-checking every touched path.
- Acceptance: `scripts/rehearsal-bench.mjs` on 16 commands: exact file list for 15 (static prediction: 4), median overhead about 50 ms; the miss (a time-named output file) is caught by the divergence check. The workspace is byte-identical after a rehearsal; network, `/run` sockets and writes outside the workspace are refused (`test/rehearsal.test.mjs`, 10 tests). The benchmark also exposed that `find -delete`, `xargs sed -i` and package scripts were predicted to change nothing; fixed in the same commit.

## Examined and not built

| Direction | Finding | Decision |
| --- | --- | --- |
| Neuron mesh | `src/neuron-network.mjs`, `neuron-ledger.mjs`, `neuron-scheduler.mjs` already project the agent registry as a lineage graph with a scheduler and approvals. | Not duplicated. |
| Truth graph | `claim-ledger.mjs`, `evidence-ledger.mjs`, `claim-check.mjs`, `knowledge-board.mjs` and `calibration.mjs` already record claims, their footing and settled confidence. | Not duplicated. A cross-session claim store is listed below as experimental. |
| Universal work certificates | `receipts.mjs` already signs verifiable receipts (Ed25519, evidence chain, replay). | Not duplicated; the provenance work above extends the same idea to releases. |
| Capability passports | `capability-router.mjs` routes task classes to models from measured eval reports; `calibration.mjs` measures trust in stated confidence. | Not duplicated. |
| WASI plugin runtime | `node:wasi` is documented as not a security sandbox ([Node.js WASI](https://nodejs.org/docs/latest/api/wasi.html)); OASIS already isolates workflow code in `workflow-sandbox.mjs` and commands in bubblewrap/Seatbelt. | Rejected as specified: a WASI runtime on `node:wasi` would add a boundary that is not one. |
| Context compiler | `context-window.mjs`, `local-context.mjs`, compaction and the repo map cover budgeted context today. | Deferred until a measurable gap is shown (see below). |

## Roadmap

### Immediate improvements

- Rehearsal on by default where the OS sandbox is already enabled with `sandbox.autoAllowCommands`, since that setting already accepts running isolated commands without a prompt.
- Feed `rehearsal_divergence` and `afterFailure` events into `oasis insights`, so repeated divergence for one command becomes visible.
- Add rehearsal and fault scenarios to the reliability lab (a command whose rehearsal and real run differ).

### Ready for implementation

- Approval answer "apply the rehearsal" in the terminal and app prompts, so a person can accept exactly what was shown instead of a second run (the apply path and its conflict check exist).
- Rehearsal on macOS: no overlay mount there, but an APFS clone (`clonefile`) of the workspace plus Seatbelt would give the same change list for small workspaces; acceptance would be the same 16-command benchmark.

### Experimental

- Cross-session claim store: let claims settled in one session (with evidence) answer questions in the next, invalidated by file hashes. Acceptance: fewer repeated checks in multi-session evals with no stale answers.
- Effect-aware scheduling: run tool calls in parallel when their rehearsed or predicted effect sets are disjoint. Acceptance: wall-clock reduction on parallel-tool evals with zero conflicting writes.

### Long term

- Network effect rehearsal through a recording proxy, so a rehearsal can show which hosts a command would contact and what it would send.
- Signed per-action effect records inside work receipts, so a reviewer can verify not only checks but each file change against a rehearsal.
