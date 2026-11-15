# OASIS general-purpose architecture (proposal)

**Status:** proposal for review. Nothing here is implemented unless it names
an existing file. Integration work starts only after review (see
[ROADMAP.md](ROADMAP.md)).

## Goal

OASIS today is a coding-agent runtime. The goal is a system that also does
research, reasoning, analysis and automation with the same guarantees that
make its coding work trustworthy: real tools, permission checks, and a final
answer that only claims what the run can show.

The proposal does not add a second runtime. It generalises three things
OASIS already has:

1. **Tools** already go through one kernel (`src/tool-kernel-core.mjs`) with
   policy, timeouts, cancellation and audit.
2. **Verification** already checks coding claims against evidence
   (`src/claim-check.mjs`, `src/completion-gates.mjs`,
   `src/verification-summary.mjs`).
3. **Orchestration** already exists as subagents, teams, workflows and a
   shared task board (`src/agent-subagents.mjs`, `src/shared-tasks.mjs`,
   `src/workflows.mjs`, `src/neuron-network.mjs`).

What is missing is a domain-neutral form of item 2, and a single scheduler
for item 3. Those are the two core changes. Everything else is delivered as
domain packs on the existing extension points.

## Layers

```text
Interfaces       terminal | web | desktop | ACP / IDE | SDK | gateways | routines
                 (unchanged; all call the same session API)
-------------------------------------------------------------------------------
Intake           task classification (src/task-classifier.mjs) -> task domain,
                 required capabilities, risk, budget envelope
-------------------------------------------------------------------------------
Coordination     Oasis Neuron Network: coordinator, scheduler, ledger
                 (OASIS-NEURON-NETWORK.md); work graph = src/shared-tasks.mjs
-------------------------------------------------------------------------------
Execution        neuron = one agent turn loop (src/agent.mjs) with a scoped
                 tool set, model route, workspace and budget
-------------------------------------------------------------------------------
Capabilities     Tool Kernel: files, shell, browser (src/browser-tool.mjs),
                 web search (src/web-search.mjs), execute_code (src/code-mode.mjs),
                 MCP, connectors, workflows; all under src/permissions.mjs and
                 the sandbox (src/sandbox.mjs)
-------------------------------------------------------------------------------
Knowledge        instructions (src/memory.mjs), auto memory (src/auto-memory.mjs),
                 session recall (src/session-search.mjs), skills, learning
                 proposals (src/learning.mjs), repo map and LSP for code
-------------------------------------------------------------------------------
Evidence         evidence ledger + domain verification contracts (new; generalises
                 claim-check and the verification summary)
-------------------------------------------------------------------------------
Models           provider transport, routing (src/model-routing.mjs), escalation
                 (src/escalation.mjs), cost policy, quota ledger, fallback chain
-------------------------------------------------------------------------------
Durability       sessions, checkpoints, routines, report hand-off files, ledger
```

## Task domains

A task domain is a named bundle, not a code path. It declares what the
agent may use and what counts as done.

| Domain | Typical tools | Evidence that counts | Final-answer rule |
| --- | --- | --- | --- |
| `code` (existing) | files, shell, LSP, tests | Test, build, lint and type-check runs after the last edit; diff review; LSP diagnostics | "Tests pass" only after a passing run against the current files |
| `research` | web search, fetch, browser, PDF, session recall | Each cited claim links to a source fetched in this run; the fetched text contains the claim (or a quoted span) | Uncited factual sentences are flagged; refuted or unverifiable claims are listed, not hidden |
| `analysis` | `execute_code`, files, notebooks, PDF and table readers | Every reported number is produced by an executed cell or command whose output is in the ledger | Numbers with no producing execution are flagged |
| `automation` | connectors, MCP, shell, routines, browser | Each side effect is an approved tool call with a recorded result; dry run first where the tool supports it | "Done" lists the effects that happened, with IDs; failures are reported per item |
| `writing` | files, research tools | Facts follow the `research` rule; requested format and length checked | Same as research |

The classifier proposes a domain and the user can override it (`/domain`,
planned). A task may move between domains as it goes: the coordinator can
open a `research` child inside a `code` task.

## Evidence ledger

One append-only record per session (and per neuron) of evidence events:

```text
{ id, neuron, kind, tool_call_id, at, subject, digest, status, detail }
kind: test_run | build_run | lint_run | lsp | diff_review |
      source_fetch | source_quote | code_exec_output |
      side_effect | approval | artifact
```

- Produced by the Tool Kernel after each call, from the tool's own result,
  never from the model's text.
- `digest` binds the event to the state it was produced against (the file
  set's hash for code, the fetched body's hash for sources, the cell's output
  hash for analysis). A later edit makes older code evidence stale, which is
  what `src/claim-check.mjs` already enforces for tests.
- The final answer is checked against the ledger by the domain's contract.
  This replaces the coding-specific checks with one mechanism, and the
  coding checks become the `code` contract with their current tests as the
  characterisation suite.

This is the main generalisation. It is also what lets a network of agents
be trusted: a child's report is accepted with the child's ledger entries,
not on its word.

## Domain packs

A domain pack is an OASIS plugin (the format in `docs/EXTENDING.md`) with:

- skills (procedures and checklists for the domain);
- agent definitions (roles such as `researcher`, `fact-checker`,
  `analyst`), each with a tool allowlist and a model hint;
- workflows (for example the existing `src/workflows/deep-research.js`);
- a verification contract: a small declarative file naming which evidence
  kinds the domain's claims need;
- optional MCP servers (the existing `plugins/oasis-research` is the first
  pack in all but name).

Packs cannot add permissions or change the Tool Kernel. A pack that needs a
new tool ships it as an MCP server, which goes through the same policy.

## Reasoning

"Reasoning" is not a separate engine. It is:

- the model's own reasoning (reasoning effort is already passed per
  provider);
- explicit decomposition by the coordinator into a work graph with
  dependencies, so a long problem is several checkable steps;
- independent cross-checks where they pay for themselves: the deep-research
  workflow already re-verifies each claim with a separate agent;
- an optional critic step adapted from OpenHands (retry while a critic score
  is below a threshold, bounded iterations), used only when a benchmark shows
  it helps a domain.

## What stays the same

- The turn loop, provider transport, permission engine, sandbox, sessions,
  checkpoints and interfaces.
- Local-first storage in the OASIS config folder and the project's `.oasis/`.
- The rule that skill and memory text is data and never grants capability.

## Risks

| Risk | Mitigation |
| --- | --- |
| Research verification that checks the source contains the claim is fooled by paraphrase | Quote spans are required for high-stakes claims; paraphrase falls back to a separate checker agent, and the answer says which method was used |
| Evidence ledger grows large | Store digests and short excerpts, keep full bodies in the session scratch folder, same as report hand-off files |
| Domains become a second plugin system | Domains are plugins; no new loader |
| More agents means more cost | Budget envelopes are deducted from the parent; the network ledger reports cost per neuron |
