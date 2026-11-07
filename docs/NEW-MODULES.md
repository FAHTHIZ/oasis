# New modules

Documentation for modules and settings added to OASIS beyond the original architecture.

## Semantic code search (`src/semantic-search.mjs`)

Finds files and functions relevant to a natural-language query using local embeddings, fused with lexical (ripgrep) and structural (repo-map) signals.

- **Tool:** `semantic_search` (read-only, low risk).
- **Embedding provider:** Ollama `/api/embeddings` by default (`http://localhost:11434`), model `nomic-embed-text`.
- **Configuration:** pass `embeddingConfig: { baseURL, embeddingModel }` via the tool context.
- **Privacy:** vectors are cached locally under `<config>/cache/semantic-search/`; no code leaves the machine unless a hosted embedding provider is explicitly configured.
- **Fusion:** `0.6 * semantic + 0.25 * lexical + 0.15 * repo-map` when lexical/repo-map signals are supplied.

## Append-only event stream (`src/event-stream.mjs`)

Records tool calls, tool results, approvals, recoveries, and verification outcomes as sequence-numbered JSONL events next to the session file.

- **Event types:** `tool_call`, `tool_result`, `approval`, `recovery`, `verification`, `session_saved`.
- **Location:** `<config>/sessions/<workspace-key>/<session-id>.events.jsonl`.
- **Redaction:** secrets are redacted with the same patterns as auto memory.
- **Integration:** `saveSession` appends a `session_saved` event after every successful save; failures never block the save.

## Provider circuit breaker (`src/circuit-breaker.mjs`)

Prevents hammering a provider that is repeatedly failing (rate-limited, down, or overloaded).

- **API:** `recordFailure(provider)`, `recordSuccess(provider)`, `isOpen(provider)`.
- **Defaults:** threshold 3 failures, cooldown 60 seconds.
- **Behavior:** after the threshold, `isOpen` returns true until the cooldown expires; a success resets the count.
- **Scope:** in-memory only; no persistence across restarts.

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
