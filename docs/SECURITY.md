# Security model

This page describes what OASIS enforces, where in the code, and what falls
outside its controls. To report a vulnerability, see
[SECURITY.md](../SECURITY.md) in the repository root.

OASIS runs with the permissions of the user who started it. Its controls
narrow what the agent does by default. They are not a guarantee that a
malicious repository, extension or model cannot do harm.

## Controls OASIS enforces

| Control | What it does | Source |
| --- | --- | --- |
| Permission modes and rules | `allow` / `ask` / `deny` rules for tools, commands and paths; plan mode is read-only; edits and commands ask by default | `src/permissions.mjs`, `src/settings.mjs` |
| Command risk analysis | Parses shell commands and flags destructive, network, credential and privilege-changing forms before they run | `src/shell-risk.mjs`, `src/git-safety.mjs`, `src/network-safety.mjs` |
| OS sandbox (opt-in) | bubblewrap on Linux, `sandbox-exec` on macOS, or a Docker/Podman container: read-only host, writable workspace, network off unless enabled, common credential folders masked | `src/sandbox.mjs` |
| Unix-socket block (with the OS sandbox) | Sandboxed commands cannot connect to host Unix sockets such as `/var/run/docker.sock` or an SSH agent: a seccomp filter (the `apply-seccomp` helper from `@anthropic-ai/sandbox-runtime`) refuses `socket(AF_UNIX, …)` on Linux x64/arm64, and the macOS profile denies Unix-socket connects. `sandbox.network.allowAllUnixSockets` / `allowUnixSockets` (macOS only) reopen them and are read from your own settings, `--settings` or policy, never from a repository. On other Linux architectures there is no filter, and `oasis doctor` reports that as a problem | `src/sandbox.mjs` |
| Domain allow-list (opt-in) | With `sandbox.allowedDomains`, commands go through a proxy that allows only those hosts | `src/sandbox-runtime.mjs` |
| Secret shield (on by default) | Secrets found in tool output are replaced with placeholders before the model sees them; written logs, sessions and artifacts are redacted with the same rules (Gitleaks-derived) | `src/secret-shield.mjs` |
| Workspace trust | An untrusted workspace cannot enable its own hooks, MCP servers, or settings that loosen permissions or change where OASIS writes | `src/settings.mjs`, `src/agent.mjs` |
| MCP tool inspection | Tool descriptions with instruction-like or hidden content are withheld and need approval; tool definitions are pinned and a changed definition needs approval again | `src/mcp-trust.mjs` |
| MCP calls | Each MCP tool call asks for approval unless the mode or rules allow it; lazy servers re-check the live tool before calling it | `src/mcp.mjs`, `src/mcp-lazy.mjs` |
| Network servers | The web app binds to `127.0.0.1`, always needs its access token, and refuses a non-loopback address without TLS unless `--allow-insecure-lan` is given; the Codex app-server WebSocket refuses a non-loopback address without `--ws-auth` | `src/web.mjs`, `src/remote-access.mjs`, `src/codex-app-server-ws.mjs` |
| Spend limits | `--max-budget-usd`, `--max-requests`, `--max-total-tokens` and zero-budget mode, shared by subagents and reviews | `src/cost-policy.mjs`, `src/pricing.mjs` |

## What is outside these controls

Being explicit here matters more than claiming coverage:

- The sandbox is off unless you enable it (`"sandbox": { "enabled": true }`
  or `OASIS_SANDBOX=1`). Without it, approved commands run with your full
  permissions. On platforms without a backend, OASIS says so and relies on
  approvals.
- MCP servers, hooks and plugin commands run as normal processes on your
  machine, not inside the command sandbox. Treat installing one like
  installing any program.
- Approval prompts are a review step, not isolation. A command you approve
  can do anything your user can.
- Credential masking in the sandbox covers common folders (`~/.ssh`,
  `~/.aws`, `~/.config/gh` and others). It is defence in depth, not full
  read isolation.
- The secret shield recognises known secret formats. A secret in an
  unrecognised format can still reach the model.
- Spend limits apply to model requests OASIS sends itself. External CLIs,
  MCP servers and hooks that call paid APIs are not counted or blocked.
- Hosted model providers receive the prompts and tool output you send them.
  Use a local model when that is not acceptable.

## Recommended setup for untrusted code

1. Do not trust the workspace (`oasis trust` is not run), so its hooks, MCP
   servers and permission settings stay off.
2. Turn on the sandbox and leave its network off, or allow only the domains
   you need.
3. Keep the default `ask` behaviour for edits and commands, or use plan mode
   to read only.
4. Use `--zero-budget` or a local model when cost matters, and
   `--max-requests` to bound a long run.
