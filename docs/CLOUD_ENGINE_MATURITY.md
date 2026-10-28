# Oasis Cloud Engine: Maturity Gap Analysis and Implementation Roadmap

**Research date:** 2026-10-28  
**Scope:** the complete coding-agent execution platform and cloud workspace, not the number of plugins installed.

## Executive assessment

Oasis already has a substantial coding-agent core: multi-provider tool loops, browser chat, session persistence, approvals, permission rules, hooks, skills, MCP, subagents, checkpoints, worktrees, GitHub workspace cloning, and a local web runtime. The primary maturity gap is not missing individual tools. It is the execution platform around them.

Today, oasis web runs as a Node process on the computer hosting Oasis. Browser tasks execute against that host process's active workspace; job objects and their event streams are held in memory, capped at 20 retained jobs and 120 events per job. Agent sessions persist separately, but job status and event history do not survive a process restart. The browser runtime therefore acts as a useful remote control for a host agent, not yet as a managed cloud task service.

The security policy correctly describes command execution as defense in depth rather than a complete sandbox. The CLI can use bubblewrap on Linux or sandbox-exec on macOS when available and enabled; unsupported hosts fall back to approvals. A mature hosted worker must not inherit the host user's unrestricted permissions.

## What the leading systems teach us

Use vendor documentation as a capability reference, not as an instruction to copy proprietary internals.

- **Codex Cloud:** reusable project environments; a separate isolated workspace per task; setup of dependencies and access settings; task continuation across web, desktop, and mobile; reviewable results and test output. Cloud environment documentation: https://help.openai.com/en/articles/20001545-using-codex-cloud and https://learn.chatgpt.com/docs/environments/cloud-environments
- **Cursor Cloud Agents:** dedicated isolated VMs; repository/dependency setup; long-running asynchronous tasks; controlled secrets and network policy; test evidence and artifacts attached to results; remote access to the running environment; scheduled or event-triggered entry points. Documentation: https://prod.cursor.com/help/ai-features/background-agents
- **GitHub Copilot on GitHub:** repository exploration and planning, code changes on a branch, test execution in a cloud development environment, pull-request review, and scheduled/event-driven repository automations. Documentation: https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github
- **Claude Code:** strong built-in tools, planning, subagents, hooks, skills, permission rules, sandboxing, checkpoint/rewind, and remote/mobile workflows. Plugins organize additional customizations; they are not a prerequisite for the core agent loop. Documentation: https://support.claude.com/en/articles/14554000-claude-code-power-user-tips and https://code.claude.com/docs/en/sub-agents

Common pattern: each task has an explicit lifecycle, its own environment and durable history, bounded execution access, visible verification, and a reviewable artifact. Mobile access is a client to that runtime; it does not require every phone to host the full coding engine locally.

## Existing Oasis strengths worth preserving

- Provider-neutral model integration, including native and compatible APIs.
- The existing agent/tool loop and the CLI/browser surfaces.
- Per-action approval, permission rules, command analysis, URL restrictions, and optional OS sandboxing.
- Skills, hooks, custom agents, MCP, Git worktrees and checkpoints.
- Persisted agent conversations and browser-based job polling.
- GitHub CLI integration that keeps the host's GitHub credential out of the browser.

Do not rewrite these from scratch just to resemble another product. Harden and compose them behind clear service boundaries.

## Gap analysis (ordered by risk and leverage)

### P0 — durable task control plane

**Current gap:** browser job IDs, status and short event streams are process-memory state. A server restart makes a task disappear from the job API even when the agent session was saved. There is no task-history endpoint.

**Required behavior:** durable task records; safe, bounded event history; status recovery after restart; task list/detail APIs; idempotent event cursors; clear distinction between a completed task and a task interrupted by server shutdown. Persist under the user's private Oasis config directory with restrictive file permissions, not inside a project checkout. Do not persist pending approvals as if they were still valid.

**Initial implementation:** the cloud-task-store.mjs layer, browser runtime integration, authenticated /api/jobs history endpoint, browser Cloud runs panel, and restart/redaction/API tests establish the first control-plane foundation. It is durable local persistence, not hosted compute.

The browser chat now also offers an opt-in **isolated Git worktree** for a new coding task. It requires a clean, committed Git checkout; creates a dedicated `oasis/...` branch; runs the agent inside that separate checkout; and leaves the main checkout untouched. Before automatically committing the result, the cloud task path scans changed file paths and bounded file contents for common credential patterns. If it finds a sensitive path, likely token/private key, or change exceeding the scan limit, it blocks the automatic commit and keeps the worktree available for manual review. This is a safeguard, not a complete secret scanner. An authenticated, bounded `GET /api/jobs/:id/diff` endpoint and browser diff viewer expose committed patches and review-required changes without executing repository-provided diff drivers. The branch is not merged automatically. Tasks in separate worktrees can execute independently; non-isolated tasks retain a single-writer lock per workspace.

This is still a local-host implementation. It does not provision remote VMs or containers, and isolated sessions are intentionally one-shot in the browser UI for now. The next step is to generalize the worktree path into a task execution backend with persisted resumability, robust review/merge workflow, and container/hosted-worker options.

### P1 — true task isolation and concurrency

- Add a task scheduler with explicit states: queued, preparing, running, waiting_approval, verifying, completed, failed, cancelled, interrupted.
- Give each coding task a unique workspace/branch. For local Git projects, use a dedicated worktree; for non-Git projects, require an explicit copy/clone strategy rather than writing two jobs into the same workspace.
- Keep task/session/environment IDs separate. Prevent two jobs from silently writing to the same files.
- Add leases, heartbeats, cancellation acknowledgement, bounded retries, timeout/resource limits and idempotent recovery. An interrupted task must not be reported as successful.
- Replace the fixed in-memory-only limit with configurable concurrency and history retention. Keep a hard cap at every worker and provider boundary.

### P2 — execution backend abstraction

Define a small execution interface, then implement backends in stages:

1. **Local worktree backend** for development and self-hosted installs.
2. **Container backend** for reproducible isolated tasks.
3. **Hosted worker backend** for remote VMs/containers that can continue when the user's device is offline.

The control-plane web process must not execute untrusted repository scripts in its own privileged context. Workers should run unprivileged, mount only the task workspace and required toolchain, enforce CPU/memory/disk/time limits, and be disposable. The cloud backend needs a deployment target, credentials, and an actual worker service; adding a module alone cannot create cloud infrastructure.

### P3 — environment templates

- Reusable, versioned environment definitions: repository, runtime version, toolchain, setup commands, cache policy, allowed network destinations, and permitted secrets.
- A setup phase that can install declared dependencies, followed by an agent phase with only explicitly granted runtime credentials.
- Validate environment changes before publishing a new version. Existing tasks remain pinned to the environment version with which they began.
- Cache dependencies by lockfile and toolchain digest, not just by repository name.
- Make unavailable packages, setup failures and cache misses visible as events.

### P4 — verification and deliverable artifacts

Every finished task should produce a trustworthy result packet:

- Branch and changed-file summary, unified diff, commit SHA if committed, and optional pull-request URL.
- Commands/tests executed, exit codes, durations, and separate pass/fail/skipped states.
- Lint/typecheck/build/test output and relevant diagnostics.
- Optional browser screenshots/video for UI tasks, plus logs and a preview URL when a preview server is available.
- A final answer that separates **verified facts** from suggestions and never claims a test passed unless the exit code/result is recorded.

Verification should be a first-class lifecycle stage, not a final-prompt instruction alone.

### P5 — security and secrets

- Hosted worker isolation is mandatory, not an opt-in preference. Keep approval policy and technical sandboxing as separate layers.
- Default-deny network access for the agent phase; permit an explicit destination allowlist. The environment setup phase can have a different narrowly-scoped policy.
- Inject secrets only when required, never into prompts or persisted event payloads. Redact secrets from stdout/stderr, tool results, diffs, artifacts and errors before storage.
- Keep GitHub/provider credentials out of browser responses. Use short-lived, scoped credentials for a task and revoke them when the task ends.
- Treat repository instructions, skills, MCP servers, package scripts and tool output as untrusted input.
- Add cross-workspace and cross-task authorization tests, path/symlink/SSRF tests, origin checks, request-size/rate limits, and safe error responses.
- The current local bearer-token bridge is not, by itself, a multi-tenant hosted authentication system. A public deployment additionally requires account authentication, tenant isolation, secure secret storage, TLS, CSRF/origin defenses, quotas, audit logs and an incident-response process.

### P6 — Git and review workflow

- Create one task branch per isolated job; show diffs before merge.
- Offer commit/PR creation as a distinct, approval-gated action.
- Add a review stage that checks for regressions, security issues, missing tests, unwanted files and accidental secret inclusion.
- Support follow-up instructions against the same task/worktree instead of silently starting an unrelated workspace.
- Preserve the ability to apply reviewed changes back to the user's checkout.

### P7 — interfaces, reconnection and integration entry points

- Build the browser/mobile UI as a control surface for tasks, environments, approvals, logs, artifacts, diffs and review.
- Use a reconnectable event stream (SSE or WebSocket), event IDs/cursors, heartbeats, backoff and terminal status recovery.
- Surface pending approvals and task completion reliably when the user is away from the host device.
- Add GitHub issue/PR entry points first. Add other integrations through a common connector boundary with explicit scopes and reviewable actions; do not turn a large marketplace into the primary roadmap.
- Add schedules and webhook triggers only after leases, authorization, quotas, idempotency and task isolation are reliable.

### P8 — reliability and quality gates

- A benchmark matrix for task success, test repair, repository navigation, multi-file edits, context recovery, cancellation, concurrency and safe failure.
- Deterministic fixtures with mock providers; no API key required for the core test suite.
- Integration tests that start the runtime, disconnect/reconnect clients, restart it mid-task, and verify status/data recovery.
- Metrics for queue wait, preparation time, tool failures, provider retries, token/cost estimates, test outcomes and worker cleanup.
- A release gate: unit tests, integration tests, security regression tests and eval tasks must pass before promoting a worker/runtime version.

## Target service boundaries

Browser / mobile control surface
- Task list, events, approvals, diffs and artifacts
- Authenticated API plus reconnectable event stream

Task control plane
- Durable task store and event journal
- Scheduler, leases, limits and policy
- Environment registry and secret broker
- Execution backend interface

Execution backends
- Local Git worktree for development
- Container worker for self-hosting
- Hosted isolated worker for production

Each worker uses the existing Oasis agent/tool loop inside a task-specific environment, runs verification, then returns collected artifacts and a structured result to the control plane.

## Acceptance criteria for the first cloud-ready milestone

1. Completed and failed task status survives server restart.
2. A running task that cannot be recovered is explicitly marked interrupted, never completed.
3. Event IDs remain ordered and reconnect requests can resume after a known event ID.
4. Persisted task history is size-bounded, atomic, and uses restrictive permissions where supported.
5. Common credential formats are redacted before being written to durable history.
6. Each task exposes a stable ID, title, status, timestamps, associated session and workspace name.
7. The new history API requires the existing runtime authorization; it does not expose an unauthenticated task list.
8. Automated tests cover restart recovery, redaction, record bounds and API behavior.
9. A later isolated-worker milestone proves that two tasks cannot mutate each other's workspace.
10. Hosted deployment is not called complete until a real worker backend, secrets policy, tenancy boundaries and deployment tests exist.

## Important implementation boundary

The initial change in this branch adds durable local task history and recovery behavior. It intentionally does **not** pretend to provide remote virtual machines, a hosted queue, cloud object storage, multi-tenant auth, or mobile notifications. Those require a worker runtime and deployment infrastructure. The roadmap is designed to let Oasis progress from local-first to self-hosted containers to hosted workers without replacing the agent engine.
