# Oasis implementation plan: reliability and capability gaps

**Audit date:** 2026-10-29  
**Integration policy:** incremental commits directly to main; no capability is complete until its acceptance criteria and tests pass on the changed revision.

## Architecture summary

Oasis is a Node.js ESM application. src/cli.mjs starts terminal/headless workflows; src/agent.mjs owns the model/tool loop and authorization; src/tools.mjs implements workspace operations; src/slash.mjs implements commands; src/sessions.mjs persists session state; src/lsp.mjs and src/diagnostics.mjs provide semantic code intelligence and checker execution; src/permissions.mjs, src/settings.mjs and src/hooks.mjs enforce controls; src/subagents.mjs, src/agent-tasks.mjs, src/workflows.mjs and src/workflow-sandbox.mjs coordinate workers; src/plugins.mjs and src/claude-plugins.mjs handle distinct extension formats; src/web.mjs hosts the local authenticated workspace; src/cloud-task-store.mjs and the OpenHands adapter provide narrower task/remote foundations. Tests use Node's built-in test runner; npm run check also validates the public site and evaluation fixtures.

## Capability matrix

| Capability | Status | Existing Oasis equivalent | Main gap |
|---|---|---|---|
| LSP diagnostics/navigation | Partial | src/lsp.mjs, src/diagnostics.mjs, /diagnostics, /fix | Automatic post-edit diagnostics, baseline comparisons, unavailable state, deterministic /fix gate |
| Dynamic multi-agent workflows | Partial | src/workflows.mjs, src/workflow-sandbox.mjs, src/agent-tasks.mjs, /workflows, /review, /batch | First-class /audit, normalized findings, dedupe, verification labels and strict limits |
| Cross-session messaging | Missing | Child/team messaging and session-local task board | Active-session registry, structured inbox/queue and safe turn-boundary delivery |
| Context inspection/compaction | Partial | src/context.mjs, /context, /compact, hooks | /context all attribution, preservation rules, preview and cancel |
| Permission modes/policy | Partial | src/permissions.mjs, src/settings.mjs, src/hooks.mjs, /mode, /permissions | Stable mode semantics, policy precedence, protected path/MCP/agent limits and deny-before-execution proof |
| Session fork/resume/steering | Partial | src/sessions.mjs, /fork, /resume, background-agent controls | Fork isolation, checkpoint continuity and guaranteed steering insertion |
| Plugin packaging/marketplace | Partial | src/plugins.mjs, src/claude-plugins.mjs, plugins/catalog.json | Native manifest, command namespace, explicit grants and permission-diff updates |
| Artifacts/live investigation pages | Missing | Local web workspace and run monitor | /artifact, private timeline, redaction, access control and cleanup |
| Output styles/scoped rules | Partial | src/output-styles.mjs, src/memory.mjs, imported rule formats | Requested built-ins and deterministic path-frontmatter rule loader |
| Self-hosted/remote execution | Partial | Browser job runtime, src/cloud-task-store.mjs, OpenHands delegation | Oasis-owned runner protocol, workspace allowlist, authenticated stream, approval/cancel/revoke/retention |

## Prioritized roadmap

1. **P0 — LSP-verified edit loop.** Make verification truthful without duplicating the existing language-server client.
2. **P0 — deterministic policy enforcement.** Enforce safety at the tool boundary rather than relying on model compliance.
3. **P1 — /audit workflow.** Reuse current workflow primitives with fixed roles, schema, deduplication and cancellation bounds.
4. **P1 — context accounting and preview.** Make categories inspectable and critical state explicitly preserved.
5. **P1 — session lifecycle and messaging.** Validate session identity; messages are data, never executable commands.
6. **P2 — native plugin packaging.** Strict schema, staged install, namespacing and permission-diff review.
7. **P2 — output styles and path-scoped rules.** Deterministic matching and visible conflicts.
8. **P2 — local investigation artifacts.** Localhost-bound event timeline with redaction.
9. **P2 — self-hosted runner.** Design trust boundaries first; managed execution stays optional and later.
10. **Release/platform verification.** Verify relevant workflows on one revision before claiming compatibility.

## Implementation records

### 1. LSP-verified development loop

- **Progress (2026-10-29):** the first increment is on main in src/lsp.mjs, src/agent.mjs, and the focused LSP tests. It requests diagnostics after successful edits to LSP-mapped files, compares against a pre-edit diagnostic set when an already-approved server is active, represents missing-server/timeouts as unavailable, and suppresses successful completion when new/unclassified LSP errors remain after one repair opportunity. A fake TypeScript language-server test covers TS2322 reporting. The full current-head check remains pending; broader real-server/platform coverage remains open.

- **Existing equivalent:** src/lsp.mjs has an on-demand LSP client with definitions, references, symbols and diagnostics; src/diagnostics.mjs runs configured type checkers and linters. test/lsp.test.mjs includes a fake server.
- **Affected files:** src/lsp.mjs, src/tools.mjs, src/agent.mjs, src/slash.mjs, src/diagnostics.mjs, test/lsp.test.mjs, test/diagnostics.test.mjs, focused agent/slash tests, docs/USER_GUIDE.md, docs/ARCHITECTURE.md.
- **Minimum viable implementation:** after successful edit/write/multi-edit/notebook edit, identify eligible source paths and request diagnostics from the existing LSP client where available. Return a structured state: verified, findings or unavailable. Keep a per-session/file/version baseline so new findings can be distinguished when feasible. /diagnostics should show error/warning/info groups. /fix must require verification and cannot report success while newly introduced errors remain.
- **Risks:** starting an LSP runs a local executable and must retain approvals, deadlines and path checks. An empty result differs from no response. Avoid running expensive whole-project checks after every small edit.
- **Tests:** fake-server diagnostics after edit; introduced TypeScript error surfaces with file/line/code; old-vs-new comparison; server startup failure/timeout; /fix gate; navigation preferred for known symbols; retain supported language mappings.
- **Definition of done:** TS errors surface after edits; /fix cannot succeed with a new error; unavailable verification is explicit; focused tests and npm run check pass.

### 2. Dynamic workflows and /audit

- **Progress (2026-10-29):** added `src/workflows/audit.js` and `/audit`. Four isolated read-only reviewers return a fixed finding schema; findings dedupe by normalized file/line/title; up to four high/critical findings are independently checked; the result separates verified and unverified findings and reports failed reviewers without discarding other results. Focused orchestration tests have been added; current-head CI is pending. Worker timeout/cancellation/resource-limit acceptance remains open.

- **Existing equivalent:** src/workflows.mjs and src/workflow-sandbox.mjs support schema-checked agent, parallel, pipeline and phase primitives. src/agent-tasks.mjs supports bounded background workers. A built-in accepted /audit workflow is not established.
- **Affected files:** src/workflows.mjs, src/workflow-sandbox.mjs, src/slash.mjs, src/subagents.mjs, workflow tests, docs/SLASH_COMMANDS_AND_SKILLS.md, docs/USER_GUIDE.md.
- **Minimum viable implementation:** security, performance, test-coverage and dependency reviewers each return JSON validated against title, severity, file, line, evidence, recommended fix and confidence. Cap concurrency, total workers, worker duration, report length and finding count. Merge overlapping findings while retaining provenance; optionally verify high/critical findings; label findings verified or unverified.
- **Risks:** false positives, context leakage, resource exhaustion, false confidence from the verifier and accidental writes. Reviewers and verifier default to read-only.
- **Tests:** concurrency/time caps, schema rejection, partial failure, cancellation, duplicate merge, severity/confidence order, bounded parent output and read-only tools.
- **Definition of done:** /audit returns one bounded prioritized report from isolated reviewers; one worker failure does not lose other results.

### 3. Cross-session messaging

- **Existing equivalent:** src/agent-tasks.mjs and src/session-tools.mjs handle child/team communication and a session-local task board; no verified global inbox exists between independent active sessions.
- **Affected files:** new src/session-messaging.mjs, src/sessions.mjs, src/session-tools.mjs, src/slash.mjs, turn-boundary handling in src/cli.mjs or src/agent.mjs, messaging/session tests, architecture/user-guide docs.
- **Minimum viable implementation:** a local permission-restricted registry with active-session heartbeat/expiry. Messages include source/target IDs, timestamp, bounded text, optional files/action and info/warning/blocking priority. /notify only queues data for a known active target; /inbox supports read/dismiss. Deliver before the next model/tool action, never by invoking tools. Bound message size, rate and forwarding depth; dedupe IDs.
- **Risks:** stale/forged IDs, cross-workspace leaks, queue growth, prompt injection, loops and unsafe filesystem permissions.
- **Tests:** delivery, busy-target queue, stale-target error, workspace isolation, read/dismiss, loop/rate limits, command text is not executed, corrupt-store recovery and close cleanup.
- **Definition of done:** two active sessions exchange structured messages; target sees messages before its next action; messages cannot execute commands or reveal another transcript.

### 4. Context and compaction

- **Existing equivalent:** src/context.mjs estimates tokens and compacts history; src/slash.mjs has /context and /compact [focus]; PreCompact/PostCompact hooks exist.
- **Affected files:** src/context.mjs, src/slash.mjs, src/agent.mjs, src/sessions.mjs, context/compaction tests, user-guide and architecture docs.
- **Minimum viable implementation:** a pure breakdown for system prompt, memory, skills, local/MCP tool schemas, history and outputs, plus largest-message entries and /context all. Label figures estimates. Store must-preserve goal, constraints, plan, paths, latest errors and verification results. Preview proposed retained/summarized content and support cancel without changing history.
- **Risks:** double counting, provider tokenization differences, preview secret leakage, storage growth and summary hallucination.
- **Tests:** category attribution, largest output ranking, detailed mode, preservation, cancel leaves history unchanged, custom focus and hook cancellation.
- **Definition of done:** users can inspect context drivers; preview/cancel is non-destructive; key state remains; estimates are not called exact provider billing.

### 5. Permissions and deterministic policy

- **Existing equivalent:** src/permissions.mjs evaluates rules and command risks; src/settings.mjs merges settings; src/hooks.mjs supports blocking PreToolUse; /mode and /permissions exist.
- **Affected files:** src/permissions.mjs, src/settings.mjs, src/hooks.mjs, src/tools.mjs, src/agent.mjs, src/slash.mjs, permission/hook tests and security docs.
- **Minimum viable implementation:** stable aliases/semantics for plan, manual, accept-edits and auto. Precedence is managed/organization > project > user > mode defaults; deny/protected-path rules always win. Validate policy before tool execution. Destructive recursive delete, force push, remote script piped to shell, secret edits, destructive DB operations and deployment default to deny or approval.
- **Risks:** shell grammar ambiguity, wrapper bypass, imported-settings compatibility and overrestrictive defaults.
- **Tests:** mode matrix, wrapped/chained shell parsing, deny-over-allow, policy precedence, protected paths, MCP allowlist, malformed policy fails closed, denied hooks have no side effect.
- **Definition of done:** denied action never reaches executor; rejection names the rule; sources are explainable; required platform tests pass.

### 6. Fork/resume/steering

- **Existing equivalent:** src/sessions.mjs, /fork, /resume, background-agent message/stop tools.
- **Affected files:** src/sessions.mjs, src/slash.mjs, src/cli.mjs, src/agent.mjs, src/web.mjs, src/agent-tasks.mjs and session/agent/browser tests.
- **Minimum viable implementation:** deep-serialize fork state with fresh ID and independent checkpoint references; don't mutate stored original. Resume restores only persisted state and reports missing resources. Insert bounded queued steering after a tool completes and before the next model decision; immediate interrupt uses AbortSignal/process-tree termination.
- **Risks:** mutable references, stale snapshots, steering races and incomplete rollback of completed side effects.
- **Tests:** original unchanged; separate checkpoints/edits; resume continuity; queue order; process interrupt; idempotent cancellation.
- **Definition of done:** isolated forks, truthful resume, steering before next decision and no surviving cancelled process.

### 7. Plugin package and marketplace

- **Existing equivalent:** src/plugins.mjs manages reviewed skill bundles; src/claude-plugins.mjs supports portions of the ecosystem plugin/marketplace format; plugins/catalog.json is a reviewed catalog.
- **Affected files:** src/plugins.mjs, src/claude-plugins.mjs, new src/plugin-manifest.mjs, src/settings.mjs, src/slash.mjs, registry/catalog and plugin tests/author docs.
- **Minimum viable implementation:** versioned plugin.json declares name/version/description/author/license/minimum Oasis version, skills/hooks/subagents/MCP servers/commands and requested permissions. Validate paths and identifiers; namespace commands as /plugin-name:command; reject collisions. Stage local/Git installs and validate before activation. Show grants; hooks/MCP stay disabled until approved; show permission diffs before updates.
- **Risks:** install-time code, traversal/symlinks, malicious metadata, namespace spoofing, update tampering and external incompatibilities.
- **Tests:** manifest, traversal/symlink rejection, local/Git install, namespace collision, grants, update diff, disable/remove rollback and no execution during inspection.
- **Definition of done:** safe local install and namespaced commands; explicit grants and visible update differences. Listing does not certify safety.

### 8. Live investigation artifacts

- **Existing equivalent:** src/web.mjs and the run monitor provide a local authenticated workspace and task summaries; no verified /artifact timeline exists.
- **Affected files:** new src/artifacts.mjs, src/web.mjs, src/slash.mjs, event publication in src/agent.mjs, artifact tests and user guide.
- **Minimum viable implementation:** /artifact NAME creates a session-owned local route backed by an allowlisted event schema: goal, actions, redacted command summaries, changed files, tests, errors/hypotheses, status and checkpoint references. Bind to loopback by default; use web-token auth; bound storage; escape HTML; require explicit export/share; close resources on shutdown.
- **Risks:** secrets in output, LAN exposure, XSS, unbounded logs and orphaned servers.
- **Tests:** live updates, redaction before persistence/render, localhost binding, token protection, explicit export, escaping/caps and shutdown cleanup.
- **Definition of done:** live useful timeline, local by default and no sharing without explicit action.

### 9. Output styles and scoped rules

- **Existing equivalent:** src/output-styles.mjs includes default, explanatory and learning; src/memory.mjs loads user/project instruction layers.
- **Affected files:** src/output-styles.mjs, src/memory.mjs, new src/scoped-rules.mjs, src/agent.mjs, src/slash.mjs, tests and user guide.
- **Minimum viable implementation:** add concise, architect and reviewer styles and /style alias. Parse bounded Markdown path-frontmatter rules from a documented project rules directory, loading only patterns matching active task paths. Base project memory remains active. Surface conflicting rules and both sources; never silently discard a safety conflict.
- **Risks:** glob/path edge cases, traversal in rules, context growth and mixing presentation with policy.
- **Tests:** matching/nonmatching paths, multiple paths, malformed frontmatter, conflict reporting, memory always loaded and style does not override policy.
- **Definition of done:** requested built-ins exist; one style affects presentation only; nonmatching rules excluded and conflicts surfaced.

### 10. Self-hosted remote execution

- **Existing equivalent:** src/web.mjs local jobs, src/cloud-task-store.mjs task metadata and the OpenHands bridge. These are not the requested Oasis-owned runner.
- **Affected files:** first docs/REMOTE_RUNNER_DESIGN.md; later src/runner-protocol.mjs and src/runner-server.mjs, CLI/permission integration, runner tests and security docs.
- **Minimum viable implementation:** a self-hosted runner accepts bounded task envelopes and workspace roots from explicit allowlists. Stream typed status/tool/output/approval/complete/error events; pause at approval; cancel process trees. Keep secrets as opaque handles, never model-context values. Persist bounded redacted logs; support revoke/delete. Local execution is default; managed execution is later and optional.
- **Risks:** remote code execution, workspace escape, secrets in prompts/logs, network/replay attacks, orphaned workers and retention surprises. Never bind publicly by default.
- **Tests:** start/stream/complete, approval pause, cancellation, path/symlink escape, secret redaction, revocation, retention/deletion and unauthorized access denial.
- **Definition of done:** user can inspect, approve, cancel and revoke a self-hosted task; workspace boundaries are enforced by code; design covers local/self-hosted/managed modes.

## Per-increment protocol

1. Read target modules and tests and record current main SHA.
2. Write a short, dependency-bounded plan.
3. Implement the smallest complete behavior plus regression tests.
4. Update this plan, STATUS.md, relevant docs and CHANGELOG.md.
5. Run focused tests and npm run check; record actual results.
6. Commit directly to main after the increment is coherent. Pending/failed CI must remain visible.
7. Report implemented, partial and not-yet-implemented separately. Do not delete branches or force-update main to avoid conflicts.

This is a plan, not a claim that future behavior exists.
