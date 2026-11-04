# Learning from experience

OASIS can turn a successful, repeatable workflow into a proposed Agent Skill. This is **procedural learning**, separate from auto memory:

- Auto memory stores facts, preferences, decisions, and lessons.
- Procedural learning captures a reusable method: the inputs, ordered steps, required capabilities, permission boundaries, and success criteria.

The purpose is to preserve useful experience without letting an agent silently rewrite its own operating instructions.

## Lifecycle

1. **Complete the task.** The agent must finish the requested work and inspect relevant verification results after its final edit.
2. **Recognize a reusable method.** A non-trivial task may expose a procedure worth repeating. One-off fixes and generic summaries are not useful skill candidates.
3. **Propose.** The agent can call `skill_propose` only when OASIS's live verification gate is clear. After code changes, the runtime requires a reviewed final diff and a relevant check that passed after the latest edit. Test-integrity issues and blocking language-server findings also prevent proposals. OASIS then validates the identifier, description, required headings, size limits, and obvious secret patterns, and stores an inert proposal.
4. **Review.** Use `/learning list` and `/learning show ID` to inspect the exact content and the agent-reported evidence.
5. **Promote or reject.** `/learning approve ID` writes a normal portable Agent Skill. `/learning reject ID [reason]` keeps a local rejection record. Neither action is performed automatically.

A proposal is not proof that the task succeeded. The evidence field is supplied by the agent and must be checked against the actual tool output, changed files, and test results before approval.

## Commands

```text
/learning
/learning list
/learning show 0123456789abcdef
/learning approve 0123456789abcdef
/learning reject 0123456789abcdef Not generalizable
```

`/learning` and `/learning list` show proposals in the current project and user scope. Approval is a separate, explicit user command. OASIS refuses to overwrite an existing skill or shadow another skill with the same name. Project skills are promoted to `.agents/skills/NAME/SKILL.md`. User-scope skills are promoted to `$XDG_CONFIG_HOME/agents/skills/NAME/SKILL.md` (or `~/.config/agents/skills/NAME/SKILL.md` when `XDG_CONFIG_HOME` is unset).

Use project scope for a method tied to one repository. Use user scope only for a genuinely reusable personal workflow or preference. Project proposals are keyed by an opaque hash of the resolved workspace path; the path itself is not written into the proposal record.

## Storage and controls

Pending proposals are stored locally beneath the OASIS config directory:

```text
learning/
  user/proposals/
  projects/PROJECT-HASH/proposals/
```

Each proposal is a bounded JSON record containing a short id, skill name, description, scope, status, timestamp, session reference, evidence note, and Markdown body. The storage directory is created with restrictive permissions where supported, files are written with private file modes, malformed or oversized files are ignored, and symbolic-link proposal directories are not followed.

The learning tool is available by default alongside the agent runtime. Disable it with `OASIS_AUTO_LEARNING=0`, `false`, or `off`, or set `autoLearning: false` in OASIS settings. This setting is independent of `autoMemory`.

The proposal validator:
- requires the portable skill headings: `Purpose`, `Inputs`, `Workflow`, `Required provider capabilities`, `Permissions`, and `Success criteria`;
- bounds names, descriptions, evidence, body size, and proposal count;
- rejects content that the existing secret redactor recognizes rather than silently preserving or redacting a potentially compromised skill;
- writes only declarative Markdown and never executes candidate content;
- refuses promotion if a skill with the same name is already available, and refuses symlinked project skill directories.

Secret screening is defense in depth, not a complete data-loss-prevention system. Review every proposal for secrets, personal information, unsafe assumptions, stale steps, and prompt-injection text.

## Trust and safety model

A promoted skill is still an instruction file, not a permission grant. Project files, user skills, imported skills, and generated skill text are untrusted context. Runtime permission checks, approvals, path validation, command-risk controls, sandbox policy, and verification gates remain authoritative. A skill cannot authorize shell commands, grant network access, suppress approvals, or override the system policy.

Promotion does not train model weights, change model parameters, or guarantee improved reasoning. It adds a reusable procedure to the existing Agent Skills loader. OASIS does not distribute private memories or proposals to other users.

The `/learning` flow also does not claim that an application is “bulletproof” or perform unrestricted autonomous penetration testing. Use the existing security-review workflows and controlled test environments for defensive checks; review findings and validate fixes independently.

## Open-source design references

These projects informed the design at the level of public architecture and documented behavior. OASIS does not vendor their code or add a dependency on them as part of this feature.

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — experience-to-skill workflows, persistent user context, and reusable procedures.
- [OpenViking](https://github.com/volcengine/OpenViking) — inspectable filesystem-oriented memory and tiered summaries. It is AGPL-3.0; no code is copied into OASIS.
- [Mem0](https://github.com/mem0ai/mem0) — multi-level memory and evaluation-oriented retrieval design. Its hosted-service benchmark claims are not treated as OASIS results.
- [LangGraph](https://github.com/langchain-ai/langgraph) — durable execution, checkpointing, and explicit state management.
- [OpenSSF Scorecard](https://github.com/ossf/scorecard) — repository supply-chain and security-posture checks; useful as a separate project-maintenance direction.

## Current limitations and next evaluation steps

The first version creates and reviews skill proposals; it does not automatically measure whether a promoted skill improves future task success. Future learning work should add reproducible skill-use telemetry, offline regression tasks, stale-skill detection, and before/after evaluation while preserving user approval and privacy. A skill should be kept only when measured outcomes improve without increasing regressions, security findings, cost, or context overhead.
