# New modules

Documentation for modules and settings added to OASIS beyond the original architecture.

## Append-only event stream (`src/event-stream.mjs`)

Records tool calls, tool results, approvals, recoveries, and verification outcomes as sequence-numbered JSONL events next to the session file.

- **Event types:** `tool_call`, `tool_result`, `approval`, `recovery`, `verification`, `session_saved`.
- **Location:** `<config>/sessions/<workspace-key>/<session-id>.events.jsonl`.
- **Redaction:** secrets are redacted with the same patterns as auto memory.
- **Integration:** `saveSession` appends a `session_saved` event after every successful save; failures never block the save.

## Provider circuit breaker (`src/circuit-breaker.mjs`)

Stops OASIS from hammering a model that keeps failing (rate-limited, out of credit, down, or overloaded). Built on [cockatiel](https://github.com/connor4312/cockatiel) 4.0.0.

- **API:** `runWithProviderBreaker(key, fn, { shouldTrip })`, `isOpen(key)`, `retryInSeconds(key)`, `isBreakerOpenError(error)`, `providerBreakerKey(config)`, `reset()`.
- **Scope:** one breaker per provider endpoint and model, used only when a fallback chain is configured. Only provider faults (`server`, `rate`, `credits`, `auth` from `fallbackReason`) count; bad requests and aborts never trip it.
- **Defaults:** opens after 2 consecutive provider faults; cooldown starts at 30 s and doubles after each failed probe, capped at 30 min. While open the chain skips that model; after the cooldown one probe request goes through.
- **Settings:** `OASIS_BREAKER_THRESHOLD`, `OASIS_BREAKER_COOLDOWN_SECONDS`.
- **Persistence:** in-memory only.

## Unified security posture report (`src/security-report.mjs`)

Aggregates secret-scan findings, permission-mode status, sandbox availability, and sensitive-path coverage into a single pass/warn/fail report.

- **API:** `buildSecurityReport({ env, sandboxSettings, permissionMode, scanFindings })`, `formatSecurityReport(report)`.
- **Severity rollup:** any `fail` dominates, then `warn`, then `pass`.
- **Checks:** `secret-scan`, `permission-mode`, `sandbox`, `sensitive-paths`.

## Sandbox read-only root (`sandbox.readOnlyRoot`)

Opt-in hardening for Docker/Podman backends.

- **Setting:** `"sandbox": { "readOnlyRoot": true }` (default `false`).
- **Effect:** mounts the container root filesystem read-only and provides an explicit `/tmp` tmpfs (`nosuid,nodev,noexec,512m`), preventing malware persistence in the container layer.
- **Compatibility:** workspace and extra directories remain writable via bind mounts; only the container's own root filesystem becomes read-only.
