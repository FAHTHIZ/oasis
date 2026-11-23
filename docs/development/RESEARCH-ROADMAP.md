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

### World drift on resume

- Commit: `c2c376d9`. Docs: [World drift on resume](../CONTINUITY.md).
- Problem: a resumed session assumes the workspace is as it left it; commits, branch switches and external edits made in between are invisible to the model.
- Prior art: Claude Code and Codex resume restore the conversation only; OASIS's `file-state.mjs` reminder is in-memory and lost when the process exits.
- New: each save records HEAD, branch and content hashes of the files the conversation touched; resume reports new commits, branch change, rewritten history and changed known files to the user and, once, to the model.
- Acceptance: `test/world-drift.test.mjs` (7 tests); capture on 300 files of this repository about 127 ms, comparison about 91 ms.

### Effects in insights

- Commit: see `git log -- src/insights.mjs` ("Report effect signals in insights").
- `/insights` now counts failed calls that had taken effect, rehearsal misses per command and drifted resumes, read from the saved tool results (truncated results still count by marker). Acceptance: `test/insights.test.mjs` effects test.

### Rehearsal by default under the bubblewrap sandbox

- Commit: see `git log -- src/rehearsal.mjs` ("Rehearse by default under the bubblewrap sandbox").
- The roadmap item said "with `sandbox.autoAllowCommands`"; under that setting ordinary commands never prompt, so the useful default is the sandbox itself: the commands that still prompt there are the high-risk ones. Building it exposed that the shipped rehearsal read credential paths and the unscrubbed environment before approval (fixed concurrently in `aeb229fd`; this change adds the sandbox's own `denyRead` masks) and that `"rehearse"` in settings was dropped by the loader (fixed here). `test/settings-keys.test.mjs` shows a repository cannot turn it on.

### Apply the rehearsal

- Commit: see `git log -- src/rehearsal.mjs` ("Offer to apply a rehearsal instead of running again").
- Problem: after a rehearsal, approval ran the command a second time; for time- or randomness-dependent commands the real run differs from what was shown (the divergence check could only report it afterwards).
- New: a third terminal answer lands the rehearsed upper layer, conflict-checked, with no second run; offered only for clean, non-high-risk rehearsals.
- Acceptance: `test/rehearsal.test.mjs`: a counting script lands one line, not two; a file edited during the prompt blocks the apply and nothing runs; failing, no-op and high-risk commands are not offered it; the agent path for `run_command` and `run_shell` returns `appliedRehearsal: true`; no rehearsal directory is left behind.

### Rehearsal in the reliability lab, and approval-time snapshots

- Commit: see `git log -- src/reliability-lab.mjs` ("Grade rehearsal in the reliability lab").
- Three scenarios with a stand-in person (yes, apply, edit-then-apply). The third failed on first run: the effect snapshot was taken before the approval prompt, so an edit made during the prompt was credited to the command and the refused apply was reported as "probably ran". Fixed by re-taking the snapshot on approval; `test/rehearsal.test.mjs` fails without the fix. Lab: 18 of 18.

### Safety snapshots taken at approval

- Commit: see `git log -- test/git-safety.test.mjs` ("Take the git safety snapshot after approval").
- Found by auditing every snapshot taken before an approval prompt, after the lab's effect-snapshot finding. The git safety snapshot (the only copy of what a discarding git command destroys) missed edits made while the prompt was open; `test/git-safety.test.mjs` shows the prompt-time edit missing from the snapshot without the fix and present with it. `run_shell` already took it after approval.

### World drift for chats and subagents

- Commit: see `git log -- docs/CONTINUITY.md` ("Tell resumed chats and subagents what moved").
- Gateway `/resume` replies append the drift summary; subagent transcripts store a per-agent world fingerprint (captured in the agent's own root) and the first message after a resume starts with `<workspace-drift>`. `test/agent-transcript-resume.test.mjs` fails without the resume change (the note is missing) and passes with it; `test/gateway-resume.test.mjs` covers the chat core and Telegram.

### Apply the rehearsal from the app, and the rehearsal shown at all

- Commit: see `git log -- app/index.html` ("Show the rehearsal in approvals and offer it in the app").
- Building the app button exposed that `formatApprovalMessage` (shared by the terminal and the web server) rewrote command prompts down to the command line, so no person had ever seen a rehearsal's file list or a high-risk reason. Fixed and tested in `test/approval-language.test.mjs`; the end-to-end web test in `test/rehearsal.test.mjs` checks the card text, the `rehearsal` flag, the answer and that the command landed once.

### Command effects in receipts

- Commit: see `git log -- docs/RECEIPTS.md` ("Attest files that commands changed in receipts").
- Receipts attested only paths from edit tools, so a file produced by a formatter or generator was outside the signature. Command and check evidence events now carry the observed `changed` paths (from effect contracts, skipped when unattributable), saved with the session, signed in the chain and digested in `files`. `test/receipts.test.mjs` runs a real generating command through the agent, verifies the receipt, alters the file and sees `files` fail; without the change the generated file is not in the receipt.

### Rehearsal outcomes in receipts

- Commit: see `git log -- src/receipts.mjs` ("Record rehearsal outcomes in receipts").
- Each rehearsed command's evidence event carries `rehearsal` (applied, matched, diverged plus `unrehearsed`, incomplete); it is saved with the session and signed in the chain, and verification adds a `rehearsals` line. Tests: `test/receipts.test.mjs` (outcomes, verification line, a forged outcome detected as tampering) and `test/rehearsal.test.mjs` (a real applied-then-matched pair through the agent).

### Servers a rehearsal tried to reach

- Commit: see `git log -- src/rehearsal-lister.mjs` ("Show which servers a rehearsed command tried to reach").
- A refusing HTTP proxy on the rehearsal's loopback records CONNECT and absolute-URI targets; proxy variables, `PIP_PROXY`, `NODE_USE_ENV_PROXY` and git's `http.proxy` point at it. 6 of 6 common clients reported correctly in this sandbox, local servers unaffected, about 6 ms overhead. Building it showed that git settings in the environment carried a proxy password into rehearsals; those are now removed. Tests in `test/rehearsal.test.mjs`.

## Examined and not built

| Direction | Finding | Decision |
| --- | --- | --- |
| Neuron mesh | `src/neuron-network.mjs`, `neuron-ledger.mjs`, `neuron-scheduler.mjs` already project the agent registry as a lineage graph with a scheduler and approvals. | Not duplicated. |
| Truth graph | `claim-ledger.mjs`, `evidence-ledger.mjs`, `claim-check.mjs`, `knowledge-board.mjs` and `calibration.mjs` already record claims, their footing and settled confidence. | Not duplicated. A cross-session claim store is listed below as experimental. |
| Universal work certificates | `receipts.mjs` already signs verifiable receipts (Ed25519, evidence chain, replay). | Not duplicated; the provenance work above extends the same idea to releases. |
| Capability passports | `capability-router.mjs` routes task classes to models from measured eval reports; `calibration.mjs` measures trust in stated confidence. | Not duplicated. |
| WASI plugin runtime | `node:wasi` is documented as not a security sandbox ([Node.js WASI](https://nodejs.org/docs/latest/api/wasi.html)); OASIS already isolates workflow code in `workflow-sandbox.mjs` and commands in bubblewrap/Seatbelt. | Rejected as specified: a WASI runtime on `node:wasi` would add a boundary that is not one. |
| Effect-aware scheduling | Running independent edit calls of one reply in parallel saves about 14 ms per 10 edits (20.6 ms sequential, 6.1 ms parallel, `edit_file` on 10 files), against model turns measured in seconds; parallel commands would break per-command effect attribution, rehearsal divergence and the safety snapshot. | Rejected: no measurable advantage for the risk. |
| Context compiler | `context-window.mjs`, `local-context.mjs`, compaction and the repo map cover budgeted context today. | Deferred until a measurable gap is shown (see below). |

## Roadmap

### Immediate improvements

- None open; see Ready for implementation.

### Ready for implementation

- Rehearsal on macOS: no overlay mount there, but an APFS clone (`clonefile`) of the workspace plus Seatbelt would give the same change list for small workspaces; acceptance would be the same 16-command benchmark.

### Experimental

- Cross-session claim store: let claims settled in one session (with evidence) answer questions in the next, invalidated by file hashes. Acceptance: fewer repeated checks in multi-session evals with no stale answers.

### Long term

- Record direct socket and DNS attempts in rehearsals (seccomp user notification or a fake resolver), for clients that ignore proxy variables.
