# Capability and architecture gap analysis

Internal working document, November 2026. Every finding below was checked
against the code on `main` (file and line references are to that revision),
not against earlier reports. The competitor facts it relies on are in
[COMPARISON.md](../COMPARISON.md) and [RESEARCH.md](../RESEARCH.md).

## What the code already has

Oasis is not missing the common agent features. Verified in source:

| Area | Where | State |
| --- | --- | --- |
| Agent loop with verification gates | `src/agent.mjs` turn loop, `src/completion-gates.mjs`, `src/claims.mjs` | Strong. Unverified "tests pass" claims are sent back; diff review is required before finishing. |
| Loop and struggle detection | `src/agent.mjs` (identical-outcome breaker, no-progress cycle, failure thrash across edits, repeated failed command) | Strong signals, but today they only add a reminder or stop the turn. |
| Repo understanding | `src/repo-map.mjs` (tree-sitter tags + PageRank, Aider's method), `src/code-ast.mjs`, `src/ast-grep.mjs`, `src/lsp.mjs`, related-test discovery | Comparable to Aider's repo map; LSP diagnostics feed verification. |
| Extensions | MCP client/server/OAuth/registry/trust, Claude Code plugins and marketplaces, Codex plugins, hooks, skills, `tool_search` deferral | Broadest plugin compatibility in the comparison set. |
| Orchestration | `src/subagents.mjs`, `src/agent-tasks.mjs`, workflows, worktrees, best-of-N, teams | Real; `src/neuron-network.mjs` is a read-only lineage graph over these, not a scheduler. |
| Inference | fallback chain, circuit breaker, key pool, quota ledger, zero-budget gating, cost policy, provider-200-error handling, OTel | Strong after the November inference work. |
| Context efficiency | read de-duplication, superseded results, output condensing, observation masking, microcompaction, compaction | Strong; measured by `bench/tokens`. |
| Security | bubblewrap / Seatbelt / Docker / srt sandboxes, command-safety classifier, secret shield (Gitleaks rules), loopback-only servers by default | Strong; external MCP servers and hooks run outside the sandbox (documented). |

## Gaps that matter, in priority order

### 1. Routing has no evidence-based escalation (§5)

`src/model-routing.mjs` picks one model per task before any work happens:
only read-only, tool-free requests go to the cheaper model; anything that
edits or runs commands goes to the strong model. That is the opposite of
"use the cheapest model that can reliably finish and escalate on evidence":
most coding work never touches the cheaper model, and a cheaper model that
is struggling is never replaced; the turn just stops with "I'm stuck".

The struggle evidence already exists in the turn loop. The gap is wiring it
to a model switch. Plan: an opt-in `cascade` routing mode where coding tasks
start on the cheaper model and, the first time an objective signal fires
(loop breaker, failure thrash, repeated failed command, no-progress cycle),
the rest of the turn moves to the strong model with a hand-over note,
recorded in the run's routing record. Safety-sensitive and image tasks still
start on the strong model; zero-budget mode never escalates to a paid model.

Status: implemented in `39a6534e` (`modelRouting.mode = "cascade"`,
`src/escalation.mjs`, tests in `test/model-escalation.test.mjs`). Escalation
happens at most once per task; the cascade's cost benefit has not been
measured against live providers yet (see gap 5).

### 2. Gateway budget notices accepted as answers (§5)

Some free gateways answer HTTP 200 with assistant text such as "The API key
used for this request has reached its budget". Oasis treats HTTP 200 error
*bodies* as failures (`bdaabcd4`) but not this *content*, so the notice
would be shown as the model's reply and no fallback would run.

Status: implemented in `3c9d6cdd` (`gatewayBudgetNotice` in
`src/api-error.mjs`; the notice counts as a 402 quota failure and triggers
fallback). Only the exact Pollinations wording is matched.

### 3. No single per-task run report (§5 observability)

The data exists in pieces (`/usage`, `/cost`, quota ledger, OTel spans,
`modelRouting` on results) but no one view answers: which model ran, why,
whether it escalated, how many requests and tokens, estimated vs.
provider-reported cost, which fallbacks fired, what caching avoided, and
whether the task finished verified.

Status: implemented in `b424594f` (`src/run-report.mjs`, `/report`,
`result.runReport`). Cache-read tokens are shown; tokens saved by in-process
de-duplication and masking are measured by `bench/tokens`, not per task. The
fix also restored `onFallback` delivery from the turn loop, which had been
silently dropped.

### 4. Documentation sprawl (§11)

25 files under `docs/`; several are plans or scorecards from earlier missions
(REPLACEMENT-ROADMAP, ENGINEERING-SCORECARD, COMPLETION-CHECKLIST,
NEW-MODULES, ARCHITECTURE-ALTERNATIVES, AGENT-RUNTIME-ALTERNATIVES,
PROJECT-QUALITY-BENCHMARK, INFERENCE-GATEWAY-PLAN, MISSION-LOG). They should
be archived or merged into the target structure, and the README rewritten
around what a new user needs.

### 5. Competitive evidence is thin (§12)

`docs/REAL-WORLD-RUNS.md` and `bench/` measure Oasis against itself and
scripted baselines. There is no same-model, same-task comparison against
another open-source harness with repeated trials. Claude Code and Codex need
paid access that this work does not have; that must be stated, not papered
over.

## Orchestration audit (§4)

Checked in `runSubagent` and `runSpecialistReview` (`src/agent.mjs`):

- Subagents and specialist reviews share the parent's budget ledger, so
  `--max-budget-usd`, `--max-requests` and `--max-total-tokens` count their
  requests; zero-budget mode and `freeModels` are inherited.
- A requested or configured subagent model must pass `availableModels`.
- Nesting is bounded by `subagentMaxDepth` (default 1); read-only agents
  never get the `task` tool; background agents are capped.
- Subagents run only when the model calls the `task` tool or a workflow asks
  for one. Nothing spawns agents by default.

Found and fixed: `/reload-plugins` rebuilt the session with a fresh ledger,
so spend and request limits restarted from zero after a reload. The ledger,
spend and last run report now carry over (`test/rebuild-session-budget.test.mjs`).

## Not gaps (checked and left alone)

- A Python router such as RouteLLM: trained on chat preference data, adds a
  Python/ML runtime, and does not use the agent-loop evidence Oasis already
  has. Rejected (see RESEARCH.md).
- A LiteLLM proxy in front of every request: Oasis already has fallback,
  quota and cost policy in-process; a proxy adds a service to run and a
  second place where budgets can be bypassed. Supported as an optional
  OpenAI-compatible endpoint only.
- Rewriting `agent.mjs` from scratch: the loop is large but well covered by
  tests; splitting continues module by module.

## CI status at the start of this work

Quality checks were failing on `main`: the token benchmark measured the same
code differently on CI and locally (kernel release, Node version, date, temp
paths and random ids in the prompt). Fixed in `bb27a8d9`; the measured growth
since the previous baseline was traced to two deliberate changes before the
baseline was refreshed.
