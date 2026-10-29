# Oasis Remote Runner Design

**Status:** Design baseline; runner implementation is not yet complete.  
**Principle:** self-hosted by default, local execution remains the source of truth, and remote execution never bypasses Oasis permission policy.

## Goals and non-goals

The runner executes an explicitly requested Oasis task on a local or user-controlled machine while streaming observable events and honoring the same approval/policy checks as local execution. A managed runner may be added later, but must remain optional. This design does not authorize unrestricted remote shell access, public listener defaults, silent workspace synchronization, or secrets in model prompts.

## Deployment modes

| Mode | Execution location | Network default | Ownership |
|---|---|---|---|
| Local runner | Current Oasis process or child process | No listener required | User's machine |
| Self-hosted runner | User-controlled host/container | Loopback until explicitly configured; remote access requires authenticated transport | User/team |
| Managed runner (future) | Optional service operated by a provider | Explicit opt-in and authenticated | User chooses provider and retention |

Local execution remains the default. A self-hosted runner must be explicitly configured. Managed execution is a future adapter, not a prerequisite for the protocol.

## Architecture

1. **CLI/session controller:** creates a task envelope and owns cancellation, approvals and the authoritative session record.
2. **Runner process:** receives a validated envelope, opens only allowlisted workspace roots, executes through the existing agent/runtime and permission layer, and emits typed events.
3. **Policy gate:** re-evaluates every command, file mutation, MCP action and tool call using the same deterministic permission rules as local execution. Remote mode cannot raise permissions.
4. **Event stream:** bounded, ordered events with task ID, monotonic sequence number, timestamp, type and a size-limited payload. Disconnects may reconnect from a sequence cursor; replayed events are idempotent.
5. **Artifact/log store:** local-first, bounded, redacted, inspectable and deletable by the user.

The runner is an execution transport, not a second authority for permissions.

## Task envelope

A task envelope should contain a schema version, opaque task ID, requested working directory, explicitly approved workspace roots, user task text, non-secret configuration references, timeout/resource limits, and an idempotency nonce. Reject unknown schema versions, absolute paths outside allowlisted roots, malformed IDs, excessive payloads, and unsupported options. Do not include raw credentials.

## Authentication and transport

- Local mode does not open a network listener.
- Self-hosted remote connections require authenticated, encrypted transport and explicit pairing. Tokens must be high entropy, scoped to a runner/task, revocable and stored with restrictive permissions; never log them.
- Bind to loopback by default. A non-loopback bind must require an explicit configuration flag and display a clear exposure warning.
- Validate origin/host where applicable, rate-limit authentication failures, cap request sizes, expire pairing credentials, and reject replayed task submissions.
- Do not implement custom cryptography. Use established TLS and platform credential storage where available.

## Workspace sync and filesystem boundary

The local machine remains the source of truth. Start with a self-hosted runner operating on a pre-existing workspace on the runner host; do not silently upload a workspace. If synchronization is added later, make direction and file set explicit, show a preview, exclude secrets and ignored files by default, and require user confirmation.

Every filesystem operation must resolve to an approved root after canonicalization. Reject traversal and symlink escapes; re-check paths at operation time to reduce time-of-check/time-of-use races. Do not mount the host root or home directory by default. Container isolation is defense in depth, not a replacement for path checks.

## Secrets

- The model receives neither secret values nor runner authentication credentials.
- Use opaque secret references resolved only at the final tool boundary, where required.
- Never include secret values in task envelopes, prompts, event payloads, snapshots, errors or logs.
- Redact known secret patterns before persistence and before rendering; avoid treating redaction as a substitute for not collecting secrets.
- Do not store secrets in plaintext. Prefer OS credential stores or an encrypted secret store with user-controlled keys. If unavailable, refuse persistent secret storage rather than silently writing plaintext.

## Approval flow

The runner asks the session controller for approval before executing any action that current policy marks as approval-required. The task pauses until approval, denial or timeout. Approval binds to the specific action and relevant arguments; a change in command, path or arguments requires a new approval. The runner cannot self-approve, change the permission mode, bypass PreToolUse hooks, or promote a denied action. Record decisions and their policy source in the local audit trail.

## Streaming event protocol

Initial event types:

- `task.accepted`, `task.started`
- `status.changed`
- `tool.started`, `tool.output`, `tool.completed`, `tool.failed`
- `approval.requested`, `approval.resolved`
- `workspace.changed`
- `checkpoint.created`
- `task.warning`, `task.error`
- `task.cancelled`, `task.completed`

Each event has a versioned schema, task ID, sequence, timestamp and bounded data. Output chunks are capped and truncated with an explicit marker. The controller must not expose raw environment variables, credentials, or unredacted command output.

## Cancellation and timeouts

Cancellation is an authenticated, idempotent request. Stop scheduling new work, cancel active model/tool calls when supported, terminate spawned process trees, and record whether termination was confirmed. Enforce per-command and per-task deadlines, output limits and configurable resource limits. A timeout or lost connection must not implicitly approve an action or silently detach a destructive process.

## Data retention and revocation

- Retain only the minimum task state and redacted event history required for the active task.
- Make retention limits visible and configurable.
- Provide inspect, export, revoke and delete operations.
- Revocation blocks new connections and tasks and invalidates credentials; it does not claim to erase external copies.
- Deletion removes runner-owned task data and logs, with any unavoidable system-level residue documented.
- No telemetry or session upload by default.

## Threat model

Protect against a malicious task prompt, compromised plugin/MCP server, untrusted workspace content, unauthorized network client, path traversal/symlink escape, replay, log injection, secret leakage, resource exhaustion, stale approvals, and a runner attempting privilege escalation.

## Minimum implementation sequence

1. **Protocol primitives:** schema validation, event types, bounded serialization and tests.
2. **Local subprocess runner:** task lifecycle, stream events, cancellation, no network listener.
3. **Approval bridge:** pause/resume around existing policy approval, with action-bound decisions.
4. **Workspace confinement:** canonical root allowlist and symlink/traversal tests.
5. **Redaction and retention:** redact before event persistence, bounded logs, inspect/delete.
6. **Self-hosted transport:** explicit pairing, encrypted authenticated connection, revocation, replay protection and exposure warnings.
7. **Optional managed adapter:** only after self-hosted security tests pass; explicit provider and retention consent.

## Acceptance tests

- Task starts and emits ordered status/tool/output/completion events.
- Approval-required action pauses until an action-bound approval arrives.
- Denial never executes the action; a modified action requires fresh approval.
- Cancellation terminates active work and prevents pending work from starting.
- Paths outside allowlisted roots, including symlink escapes, are denied.
- Secrets are absent from model context, event payloads, logs and snapshots.
- Unauthenticated/replayed requests are rejected; credentials can be revoked.
- Default mode opens no listener; non-loopback exposure requires explicit opt-in.
- Output, event count, duration and stored data are bounded.
- User can inspect and delete runner data.

## Open decisions

- Which established transport library best fits supported Node versions and packaging?
- Whether encrypted workspace synchronization belongs in the first runner release or a separate opt-in component.
- Exact platform-specific process-tree cancellation behavior on Windows, macOS and Linux.

These decisions must be resolved by reading the existing runtime and dependency constraints before implementing the runner.
