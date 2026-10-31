> **Research/archive document:** proposals only. These designs are not shipped capabilities. For current product scope and release status, see [the project plan](../PROJECT_PLAN.md).

# OASIS future architecture designs — proposal archive

> **Design documents only.** The concepts below are not shipped OASIS features. Do not describe remote-runner hosting, phone pairing or Tor/onion access as implemented until code, tests and same-commit CI evidence exist.

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

---

**Status: design note only. Phone pairing and remote access are not implemented by this document.**

The browser workspace defaults to loopback access, but the CLI also has explicit options for non-loopback access with TLS and an opt-in for insecure LAN HTTP. Those existing network options are not a phone-pairing system. Connecting a phone through a dedicated pairing flow would expand the trust boundary: someone who can reach the service may be able to read project context, request edits, or ask the agent to run commands. Treat this as a security-sensitive feature, not just a networking option.

## Assets to protect

- Project files and source code.
- Provider API keys, access tokens, session cookies, and pairing credentials.
- Agent conversations, tool output, task history, and diffs.
- Approval decisions and commands that can change or delete files.
- The user's ability to stop work and revoke access.

## Threats

1. **Untrusted device on the same Wi-Fi:** another device scans for open ports and tries to reach the workspace.
2. **Guessable or replayed pairing:** an attacker reuses an old QR code or guesses a pairing secret.
3. **Stolen paired phone:** a lost device continues to access project data.
4. **Network interception:** a person between the phone and computer reads or alters traffic.
5. **Browser-origin abuse / CSRF:** a malicious website attempts to make the browser issue authenticated requests.
6. **Approval fatigue:** a phone UI hides what a command will do or makes accidental approval easy.
7. **Secret leakage:** credentials appear in QR codes, URLs, logs, screenshots, crash reports, or model-visible output.
8. **Tunnel misconfiguration:** a user exposes a local service to the public internet without understanding the consequences.
9. **Stale or interrupted work:** the phone shows a pending approval or running job that no longer exists.

## Minimum requirements before implementation

- Keep phone access **off by default**. Do not bind a public interface or open a public port automatically.
- Require an explicit local opt-in and one-time pairing code with sufficient randomness, short expiry, and single use.
- Exchange the pairing code for a per-device random token. Store only what is needed, avoid putting tokens in URLs, and never log them.
- Provide a paired-device list, last-used information where available, and immediate revocation. Revocation must invalidate the token server-side.
- Authenticate every API and event-stream request; apply CSRF/origin protections and rate limits to pairing attempts.
- Prefer a private network or a private tunnel chosen and configured by the user. Explain that a tunnel changes who can reach the service.
- Refuse plaintext HTTP over the public internet. Do not claim that ordinary LAN HTTP is end-to-end encrypted.
- Preserve existing workspace authentication and approval checks. A phone must not gain broader permissions than the desktop session.
- Show the exact target and consequence for destructive actions and installs. Keep Allow and Deny separate, large, and keyboard/screen-reader accessible.
- Include an always-visible **Pause everything** control that cancels active work and blocks new actions until resumed.
- Make expired, revoked, disconnected, and interrupted states explicit. Never show a stale approval as actionable.
- Keep provider keys out of the phone UI unless a separate, reviewed design explicitly requires them.
- Test hostile origins, token expiry/revocation, replay, unauthorized API calls, disconnect/reconnect, and destructive-action denial.

## Release gate

Do not implement or announce phone pairing until the core safety brief is completed and reviewed, the threat cases above have tests, and the implementation has been tested on a real phone. Passing unit tests alone is not evidence that network exposure is safe.

## Not covered

This note is not a penetration test, a complete security audit, or approval to expose the server remotely. Keep loopback as the default. Existing non-loopback CLI options must remain explicit and documented; they must not be mistaken for secure phone pairing.

---

## Status

**Design specification only — not implemented yet.** OASIS currently fetches public HTTP/HTTPS URLs directly and blocks local/private destinations. It does not currently connect to Tor or fetch `.onion` addresses. Do not describe onion access as working until code, tests, and CI prove it.

## What this feature means

OASIS should be able to optionally read a user-supplied onion URL through a Tor SOCKS proxy, while keeping the normal public-web fetcher and independent search/index architecture separate. Tor is a transport/network path; it is not a search engine and it does not provide OASIS with an index of onion sites. Onion services are reachable only through Tor (Tor Project documentation: https://support.torproject.org/about-tor/onion-services/what-is-a-dot-onion/).

## Proposed boundaries

- **Transport:** a dedicated onion transport adapter connects only to a configured local Tor SOCKS endpoint. It must use remote hostname resolution through SOCKS; never attempt ordinary DNS resolution of a `.onion` name.
- **Target allowlist:** accept only valid v3 onion hostnames under `.onion`, with HTTP/HTTPS schemes and no embedded credentials. Reject IP literals, ordinary hostnames, malformed onion names, and alternate schemes in this adapter.
- **Proxy configuration:** explicit opt-in via an environment/config setting; never silently route all traffic through Tor. The adapter must fail closed when the proxy is unavailable. Never fall back to direct connections for an onion URL.
- **Isolation:** never send an onion URL or its content to Tavily, Brave, Exa, Firecrawl, SearXNG, analytics, telemetry, or other third-party services. Do not silently follow redirects from an onion host to the public web or vice versa.
- **Resource limits:** bounded request time, response bytes, redirects (prefer none in the first version), content types, and concurrent requests. Keep credentials and cookies out of logs and tool output.
- **Crawling:** onion crawling is disabled by default. Initial access is explicit URL fetch only; any later crawler must require user-selected seeds, strict page/depth budgets, per-host pacing, and a separate index namespace from the clearnet index.
- **User safety:** display a clear notice that Tor transport does not guarantee anonymity of the whole OASIS process, model provider, operating system, or other network traffic. Avoid claims of being “anonymous” or “untraceable.” Users remain responsible for legality and site safety.

## Implementation sequence

1. Add a transport interface so public HTTP(S) and Tor-routed onion requests cannot accidentally share unsafe assumptions.
2. Implement SOCKS5 remote-DNS connection handling for onion-only targets, with certificate validation for HTTPS and strict time/size limits.
3. Add unit tests for v3 hostname validation, proxy failure, no direct fallback, redirect rejection, and no ordinary DNS lookup for onion hostnames.
4. Add an explicit read-only MCP tool such as `oasis_fetch_onion_url`; do not expose it as a generic proxy for arbitrary destinations.
5. Add a local integration test that runs only when a developer explicitly provides a Tor SOCKS endpoint. Never make CI depend on a live onion service.
6. Only after the fetch path is verified, consider a user-seeded, opt-in onion index. Do not imply that it can search “the entire dark web.”

## Relationship to OASIS Search

OASIS's goal remains its own crawler, persistent index, lexical/semantic retrieval, and ranking/evaluation. Third-party web search providers are optional baselines, not the core index. Onion URLs form a separate, explicitly opt-in corpus and must not be sent to external providers.

## Reference

- Tor Project, “What is a .onion?”: https://support.torproject.org/about-tor/onion-services/what-is-a-dot-onion/
