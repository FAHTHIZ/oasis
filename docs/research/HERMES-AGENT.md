# Hermes Agent: technical research report

**Subject:** [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), MIT License  
**Revision studied:** `fd8a6c41` (main, 2026-11-15); latest release v0.23.1 (2026-11-10)  
**Method:** read the source, the `AGENTS.md` files and the developer guide in
`hermes-agent/website/docs/developer-guide/`. Numbers below were read from the
code at that revision (mainly `hermes-agent/hermes_cli/config_defaults.py`),
not from marketing pages. Paths are written `hermes-agent/...` to keep them
apart from OASIS paths.

Nothing from Hermes is copied into OASIS. Where OASIS follows a Hermes design,
the OASIS module says so in its header comment (for example `src/routines.mjs`
and `src/profiles.mjs`).

## Summary

Hermes is a Python 3.11 to 3.14 agent runtime (about 1.1 million lines of
non-test Python, about 8,500 test files) built around one `AIAgent` class
that serves the CLI, a messaging gateway for 25+ chat platforms, an ACP
editor adapter, an API server, a batch runner and a Python library. Its
distinctive strengths are not the loop itself but the operating discipline
around it: a byte-stable system prompt to keep provider prompt caches warm,
a strict "narrow waist" rule for what may enter the core, bounded file-based
memory with background review, cron with at-most-once semantics, and a large
plugin and skills catalogue.

Its weaknesses for OASIS's purposes are size (a single runtime of that scale
is expensive to audit), Python-only extension points, and many process-local
features (background delegations, kanban dispatcher) that do not survive a
restart without extra machinery.

## Architecture

```text
Entry points: cli.py, gateway/run.py, acp_adapter/, batch_runner.py, API server, library
        |
        v
AIAgent facade (run_agent.py) + sibling modules in agent/
  prompt builder | provider resolution (3 API modes) | tool dispatch
  context compression and caching | memory manager | auxiliary client
        |
        v
Session store (SQLite + FTS5, hermes_state*.py)    Tool backends (terminal, browser, web, MCP, files, vision)
```

- **Facade plus siblings.** `hermes-agent/run_agent.py` holds the `AIAgent`
  facade. The loop lives in `hermes-agent/agent/conversation_loop.py` and
  `agent/turn_*.py` phase modules. The project enforces size ratchets in CI:
  cyclomatic complexity, function length and file length budgets, so modules
  are split rather than grown.
- **Three provider API modes:** Chat Completions, OpenAI Responses (Codex)
  and Anthropic Messages, selected per provider at runtime. OASIS has the
  same three (`docs/architecture/provider-transport.md`).
- **Turn limit:** `agent.max_turns` defaults to unlimited
  (`max_iterations=sys.maxsize` in `run_agent.py`); the comment says caps
  "caused silent mid-task truncation". A wall-clock budget and a one-time
  budget warning are optional.
- **Platform-agnostic core:** platform differences live in the entry point,
  not in `AIAgent`. Profiles (`hermes -p NAME`) isolate home, config,
  memory, sessions and gateway PID per profile.

## Invariants that shape the design

1. **Prompt caching is sacred.** The system prompt is built once per
   conversation and must stay byte-stable. Only compression or an explicit
   user action (`/model`) may change it. Mid-conversation information is
   injected as a user message or tool result, never by editing the system
   prompt. A prompt-surface snapshot test in CI catches accidental changes.
2. **The core is a narrow waist.** New capability goes, in order of
   preference: extend an existing tool, a CLI command plus a skill, a
   service-gated tool, a plugin, an MCP server, and only last a new core
   tool. This keeps the always-on tool list and prompt small.

OASIS already follows the first in spirit (idle compaction, superseded
result stubs and the read cache all aim at cache reuse) but has no snapshot
test of its prompt surface. That is a cheap, high-value adoption; see the
[roadmap](ROADMAP.md).

## Tools and toolsets

- `hermes-agent/tools/registry.py` has no dependencies; every
  `tools/*.py` file calls `registry.register()` at import time, so discovery
  needs no manual list. Each tool may carry a `check_fn` (TTL-cached) that
  hides it when its service is unavailable.
- `hermes-agent/toolsets.py` groups 70+ tools into about 28 toolsets that
  profiles and subagents select from.
- Handlers return JSON strings. A few tools (todo, memory) run inline in the
  loop instead of through the generic executor.
- **Tool Search** (`tools/tool_search.py`): progressive disclosure with
  `tool_search`, `tool_describe` and `tool_call`, so a large catalogue does
  not have to sit in the prompt. OASIS has its own `tool_search` over
  deferred MCP tools (`src/mcp.mjs`) plus lazy MCP servers
  (`src/mcp-lazy.mjs`), which address the same cost.
- **Programmatic tool calling** (`tools/code_execution_*.py`): the model
  writes code that calls tools over an RPC kernel. OASIS's equivalent is
  `execute_code` in `src/code-mode.mjs`, run in QuickJS.
- Terminal backends: local, Docker, SSH, Modal, Daytona and Vercel Sandbox.

## Delegation (subagents)

`hermes-agent/tools/delegate_tool*.py`, defaults from `config_defaults.py`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `max_concurrent_children` | 10 | Parallel children per batch and concurrent background units |
| `max_spawn_depth` | 1 | Flat by default; 2 allows orchestrator to leaf |
| `orchestrator_enabled` | true | Kill switch for the orchestrator role |
| `oneshot_max_children` | 2 | Cap for one-shot runs, because children "re-pay a cold system prompt" |
| `subagent_auto_approve` | false | Children resolve approvals non-interactively; default is deny |
| `resumable_ttl_hours` | 48 | Resumable delegations, `auto_resume` off by default |

Children are either leaves or orchestrators. Results can be structured with
an output schema. Delegation providers are plugins, so a child can run on
another backend.

Compared with OASIS: OASIS nests deeper by default (`subagentMaxDepth` 3,
maximum 5) and caps background agents at 8 per tree with a shared dollar
ledger (`src/subagent-support.mjs`). Hermes's explicit leaf/orchestrator
role split and its one-shot child cap are worth adopting as policy, because
they encode a measured observation (children re-explore and re-pay the
prompt) rather than a guess.

## Memory and learning

- **Built-in memory** (`tools/memory_tool.py`): two files, `MEMORY.md`
  (2,200 characters, about 800 tokens) and `USER.md` (1,375 characters),
  inserted into the system prompt as a frozen snapshot at session start.
  Edits during a session are written to disk but do not change the running
  prompt, which preserves the cache.
- **Memory provider plugins** (`plugins/memory/`, `agent/memory_provider.py`):
  one provider at a time (single select). Third-party backends moved out of
  core into the plugin catalogue.
- **Background review** (`agent/background_review.py`): after turns, a forked
  agent reviews the conversation and saves memory or skills. Memory is
  nudged every 10 turns (`memory.nudge_interval`).
- **Curator** (`agent/curator.py`): archives stale agent-created skills,
  with a backup first.

OASIS's auto memory (`src/auto-memory.mjs`) is file-based with a one-line
index in the prompt, and procedural learning (`src/learning.mjs`) keeps skill
proposals inert until approved. The difference that matters: Hermes learns
automatically in the background, OASIS requires approval. OASIS should keep
approval as the default (a learned skill is an instruction to a future agent
with tools) and borrow the review trigger, not the auto-promotion.

## Skills

Strict authoring rules (short descriptions, at most 60 characters, so the
index stays small), a bundled set, an optional set, and a hub that installs
from several registries (`tools/skills_hub_*.py`) with guards that scan
skills for credentials and dangerous patterns (`tools/skills_guard*.py`,
`tools/skills_ast_audit.py`). OASIS reads Agent Skills from its own and other
agents' folders, has `oasis skills add/install/remove` and a skill doctor
(`src/skill-doctor.mjs`). Its installer (`src/skill-install.mjs`) runs
nothing from the source and skips symlinks, but it does not statically audit
the scripts a skill ships for credential access or exfiltration patterns.
That is a gap worth closing.

## Scheduling

`hermes-agent/cron/`: jobs in `jobs.json`, `croniter` expressions,
at-most-once execution, a tick lock, an inactivity watchdog (600 s), script
jobs that do not need the model (`no_agent`), and `context_from` chaining of
one job's output into the next. OASIS routines (`src/routines.mjs`) were
designed after this and cover the same ground, including chaining.

## Multi-agent coordination

- **Kanban** (`tools/kanban_tools.py`, `plugins/kanban/`): a SQLite board with
  a dispatcher, claims and a failure limit (2) per card.
- **Goals:** `/goal` repeats turns until an auxiliary judge model says the
  goal is met, up to `goals.max_turns` (20). Judge failures fail open; the
  budget is the backstop.
- **Mixture of agents:** a virtual provider that sends a prompt to reference
  models and aggregates their answers (`hermes_cli/moa_cmd.py`).

OASIS has a shared task board with leases and dependency checks
(`src/shared-tasks.mjs`), `/goal` with a strict judge and the same 20-turn
cap, teams, and best-of-N attempts in worktrees (`src/best-of-n.mjs`). The
OASIS judge is stricter by design ("unverified claims do not count").

## Context management

`agent/context_compressor*.py`: compress at 50% of the window by default,
prune old tool results before summarising, summarise with an auxiliary
model, keep a protected tail. Per-model thresholds can be configured.
`agent/auxiliary_client*.py` routes side tasks (titles, summaries, judging,
vision) to a cheaper model with its own fallback and rate-limit handling.

## Training data and research use

Hermes exports trajectories (ShareGPT JSONL) and runs batches
(`batch_runner.py`, `trajectory_compressor.py`). Its RL environments were
built on [Atropos](https://github.com/NousResearch/atropos), which is now
archived (July 2026). OASIS already exports ShareGPT and OpenAI formats and
runs batches (`src/trajectories.mjs`).

## Strengths

- Clear invariants, written down and enforced by tests (prompt surface,
  size ratchets).
- Cache-aware memory (frozen snapshot) and context design.
- Breadth: 25+ chat platforms, many terminal and browser backends.
- Conservative delegation defaults based on observed cost.
- Large, active community and plugin catalogue.

## Limitations

- Very large surface for a single runtime; auditing a change end to end is
  hard, and many features overlap.
- Python-only plugins; no language-neutral extension contract beyond MCP.
- Several coordination features are process-local; background delegations
  and the kanban dispatcher depend on the process staying up, with resume
  added later as a separate mechanism.
- Background learning writes memory and skills without a person in the loop
  by default.
- Its RL training path depends on an archived project.

## What OASIS should take

| Hermes design | Decision for OASIS | Why |
| --- | --- | --- |
| Prompt-surface snapshot test | Adopt (build) | Cheap guard for cache stability and prompt bloat |
| Narrow-waist footprint ladder | Adopt as contribution policy | Matches OASIS's dependency rule in [RESEARCH.md](../RESEARCH.md) |
| Frozen memory snapshot per session | Verify and adopt if missing | Keeps the cache warm while memory changes |
| Leaf vs orchestrator roles, one-shot child cap | Adopt as delegation policy | Encodes measured cost of children |
| Background review trigger | Adapt: propose, never auto-promote | Learning stays reviewable |
| Skill install static audit | Build | Closes a supply-chain gap |
| Tool search | Already equivalent (`tool_search`, lazy MCP) | No change |
| Mixture of agents | Do not adopt now | Multiplies cost; OASIS's evidence-based escalation is cheaper |
| Python runtime, plugin loader | Do not adopt | OASIS core stays Node, model-agnostic |
