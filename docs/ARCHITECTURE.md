# OASIS architecture

**Last audited:** October 31, 2026  
**Implementation reference:** the current `main` source tree. This document explains the architecture that exists in code; it is not a promise that every platform or integration is release-certified.

OASIS is a local-first coding-agent runtime with several ways to interact with it. The CLI, connected browser workspace, Electron desktop app, VS Code-family extension, SDK, and GitHub Action are different entry points around shared agent and tool-execution code. OASIS is not itself a model or a hosted inference service. You choose the model/provider, and provider traffic follows that provider's data-handling terms.

For the feature inventory and release boundaries, see the [project plan](PROJECT_PLAN.md). For security-review findings and remaining risks, see the [security and reliability audit](SECURITY_RELIABILITY_AUDIT.md). For setup and command-level instructions, see the [user guide](USER_GUIDE.md).

## System map

The diagram separates runtime placement from the shared implementation. The GitHub Action runs its own OASIS process inside a GitHub Actions runner; it does not call back into the developer's machine. The static dashboard remains browser-only.

~~~mermaid
flowchart TB
  subgraph UserHost["User's computer"]
    subgraph Surfaces["Local entry points"]
      CLI["Terminal CLI / headless"]
      BROWSER["Browser client"]
      DESKTOP["Electron main + renderer"]
      IDE["VS Code-family extension host"]
      SDK["Node.js SDK consumer"]
      STATIC["Static dashboard / PWA shell"]
      LOCALDATA["Browser local storage<br/>Projects · Tasks · Notes"]
    end
    subgraph Runtime["OASIS runtime process"]
      WEB["Local HTTP(S) server<br/>oasis web"]
      CORE["Agent session and model/tool loop"]
      PROVIDER["Provider adapters"]
      POLICY["Permissions · approvals · risk checks"]
      TOOLS["Workspace tools · process tools · diagnostics"]
      CONTEXT["Instructions · memory · context · sessions"]
      INTEGRATIONS["MCP · hooks · plugins · skills · workflows"]
      EVENTS["Job events · task records · run monitor"]
    end
    IDEBRIDGE["Loopback IDE RPC bridge"]
    PROJECT["Selected project workspace"]
  end

  subgraph CIRunner["GitHub Actions runner"]
    ACTION["OASIS GitHub Action"]
    CI_SDK["OASIS Node.js SDK"]
    CI_CORE["Agent runtime in CI process"]
    CI_WORKSPACE["Checked-out repository"]
  end

  MODEL["Chosen model endpoint<br/>hosted or local"]
  EXT["External tools and services<br/>GitHub · MCP servers · OpenHands · LSP servers"]

  CLI --> CORE
  BROWSER <--> WEB
  WEB --> CORE
  DESKTOP --> WEB
  IDE <--> IDEBRIDGE
  IDEBRIDGE <--> CLI
  SDK --> CORE
  STATIC --> LOCALDATA

  ACTION --> CI_SDK --> CI_CORE
  CI_CORE <--> MODEL
  CI_CORE <--> CI_WORKSPACE
  CI_CORE <--> EXT

  CORE <--> PROVIDER
  PROVIDER <--> MODEL
  CORE <--> CONTEXT
  CORE --> POLICY
  POLICY --> TOOLS
  TOOLS <--> PROJECT
  TOOLS <--> EXT
  INTEGRATIONS <--> CORE
  INTEGRATIONS <--> EXT
  CORE --> EVENTS
  EVENTS --> WEB
~~~

The static dashboard is included as a separate surface because it is easy to confuse with the connected browser workspace. Opening `index.html` or the GitHub Pages site gives the Projects, Tasks, and Notes interface; it does not start the agent. The connected workspace requires the local `oasis web` process.

## Entry points and ownership

| Surface | Implementation | What it owns |
|---|---|---|
| Terminal CLI | `src/cli.mjs`, `src/headless.mjs` | Interactive terminal, one-shot tasks, setup, diagnostics, background commands, and non-interactive/script output. |
| Connected browser workspace | `src/web.mjs` plus the packaged static UI | Authenticated local HTTP API, chat jobs, approvals, project/tool integrations, terminal sessions, job history, and run monitoring. It calls the same session/agent functions as the CLI. |
| Electron desktop app | `desktop/main.mjs`, `desktop/secure-secrets.mjs` | Folder selection, desktop window lifecycle, local runtime startup/shutdown, renderer isolation, and OS-backed provider-key storage where available. It hosts the connected browser workspace; it is not a second agent engine. |
| VS Code-family extension | `ide/vscode/`, `src/ide.mjs` | Editor chat, selection context, native diff review, editor diagnostics, and a local bridge to the CLI. Cursor and Windsurf are supported editor targets through their VS Code-compatible interfaces. |
| Node.js SDK | `src/sdk.mjs` | In-process access to the agent/headless runtime, event streaming, custom tools, and tool servers. |
| GitHub Action | `action.yml`, `src/github-action.mjs` | Runs OASIS in a GitHub Actions checkout through the SDK, filters who can trigger mention-based tasks, verifies the result, and can commit/push a branch or open a pull request according to the event. |
| Static dashboard / PWA shell | `index.html`, `sw.js`, `manifest.webmanifest` | Local Projects, Tasks, and Notes data in browser storage, JSON export/import, and static offline assets. It has no model loop or host-side execution by itself. |

### Process and deployment boundaries

| Component | Process / location | Connection and responsibility |
|---|---|---|
| CLI and headless mode | Node.js process on the user's computer | Calls the agent runtime directly; interactive approvals and output are handled by the terminal surface. |
| Connected browser workspace | Local Node.js HTTP(S) server plus a browser client | The server owns sessions, agent jobs, approvals and terminal APIs. The browser connects with a runtime bearer token; it is not the agent process. |
| Electron desktop | Electron main process and isolated renderer | The main process starts the same local web server on loopback and opens the renderer against it. The renderer has context isolation, Node integration disabled and sandboxing enabled. Desktop provider keys use Electron OS-backed storage when available. |
| VS Code-family integration | Editor extension host plus CLI process | The extension hosts a token-authenticated loopback RPC bridge. The CLI discovers the bridge for its workspace and requests selection, diagnostics, file navigation and native diff approval. |
| Node.js SDK | The consuming Node.js process | Embeds OASIS in-process; it is not a remote service. `query()` streams events and `run()` provides a one-shot convenience API. |
| GitHub Action | Separate GitHub Actions runner | Uses the SDK inside the CI job against that runner's checkout and credentials. It does not share the developer's local sessions, browser server, processes or filesystem. |
| Static dashboard / PWA | Browser process only | Reads and writes its own browser storage. It does not connect to the agent API unless the separate connected workspace is opened. |

These are deployment boundaries, not separate product engines: the local surfaces reuse the same runtime modules where stated, while the GitHub Action starts a separate runtime in CI. The editor bridge and browser server are distinct loopback services with different tokens and responsibilities.

### Shared runtime request path

A normal coding-agent turn follows this shape:

1. An entry point creates or resumes a session for a selected project directory.
2. OASIS loads provider configuration, user/project instructions, memory, settings, tool definitions, and the session's permission context.
3. The selected model receives the conversation and the tools available in that session.
4. The model may return text, a tool call, or both. OASIS validates and routes each requested tool through the appropriate execution and permission checks.
5. The tool result is bounded, redacted where appropriate, recorded in the conversation, and returned to the model for the next step.
6. OASIS performs applicable post-edit diagnostics and completion checks, emits the final result, and persists the session/job state where enabled.

The browser's chat path uses `createSession` and `runAgentTurn`; CLI/headless and SDK paths use the same underlying runtime modules with different presentation and approval adapters. Streaming output is normalized across provider protocols. If a provider does not stream, supported paths can fall back to a completed response rather than requiring a streaming-only server.

~~~mermaid
sequenceDiagram
  participant U as User / surface
  participant A as Agent runtime
  participant M as Model provider
  participant P as Permission policy
  participant T as Tool executor
  participant W as Workspace / service

  U->>A: Prompt and session context
  A->>M: Messages + available tool schemas
  M-->>A: Text or proposed tool call
  A->>P: Validate tool and requested action
  alt Approval required
    P-->>U: Approval request
    U-->>P: Allow or deny
  else Allowed by policy
    P-->>A: Permission decision
  end
  P->>T: Approved tool execution
  T->>W: Bounded file, process, or integration operation
  W-->>T: Result / diagnostics
  T-->>A: Tool result
  A->>M: Continue with result
  M-->>A: Final response or next tool call
  A-->>U: Events, result, and verification state
~~~

The model proposes actions; OASIS owns the local policy decision and execution boundary. A model response is not itself proof that a file changed correctly or that a test passed.

## Model and provider boundary

The provider adapter code is primarily in `src/config.mjs`, `src/cloud-providers.mjs`, and the request/stream handling in `src/agent.mjs`.

| Provider protocol / route | How it is connected |
|---|---|
| OpenAI Responses | Native Responses API path. |
| OpenAI-compatible Chat Completions | Compatible gateways and local endpoints; the Gemini preset uses this protocol against Google's OpenAI-compatible endpoint. OmniRoute and OpenRouter are also configured through compatible endpoints. |
| Anthropic Messages | Native Anthropic Messages API path. |
| AWS Bedrock | Anthropic Messages-compatible request shape with Bedrock endpoint and AWS bearer-token or SigV4 authentication. Bedrock responses currently use the non-streaming invocation path. |
| Google Vertex AI | Anthropic Messages-compatible request shape with Vertex endpoint, project/region and Google access-token authentication. |
| Microsoft Foundry | Anthropic Messages-compatible request shape with Foundry deployment endpoint and Entra ID or API-key authentication. |

This is a protocol distinction, not a claim that every model on every provider has identical tool-calling, streaming, vision, context-window, or pricing behavior. The selected model and endpoint determine those capabilities. The Gemini setup is an OpenAI-compatible provider route; OASIS does not claim a separate native Gemini protocol adapter.

Provider setup tests a small inert tool-call schema before saving supported configurations. The probe response is checked but the proposed tool is not executed. A failed verification should not replace the previously working provider configuration. Optional easy/strong model routing is separate from provider selection, is off by default, and estimates cost from configured rates and observed usage; it does not guarantee savings or equal answer quality.

### Credential ownership

- CLI and ordinary local browser mode use user-level OASIS configuration and environment overrides. On POSIX hosts, configuration files are written with restrictive permissions where supported; this is file-permission protection, not OS-backed encryption.
- The Electron desktop provider form stores the API key separately using Electron `safeStorage`. It refuses to save a newly supplied key when the operating-system encryption facility is unavailable or is not considered secure by the host check.
- The browser does not return a saved key to the page after configuration. Provider credentials should not be supplied in chat prompts, project files, screenshots, or tool arguments.
- A local model endpoint can keep inference on the machine, but it does not change the privilege level of commands that OASIS launches.

## Workspace tools and execution

The principal tool catalog and execution boundary live in `src/tools.mjs`; related command helpers live in `src/power-tools.mjs`, `src/process-tree.mjs`, `src/installer.mjs`, and `src/permissions.mjs`.

### File operations

Workspace file tools include listing, globbing, literal search, bounded reads, exact-string edits, whole-file writes, notebook operations, and approved deletes. Paths are resolved against the selected workspace, with traversal and symlink checks and exclusions for common secret-bearing files. Additional directories can be granted explicitly in trusted settings. File reads and tool output have size limits.

Before supported OASIS file edits, writes, and deletes, the runtime can capture the original file state for `/rewind`. Separate backup snapshots are stored outside the project in the user's OASIS configuration area. Shell commands such as `npm install`, custom scripts, formatters, and arbitrary programs are not automatically reversible by OASIS file checkpoints; use Git or the backup tools for those operations.

### Command execution and approvals

- The general `run_command` path starts one executable with an argument array and `shell: false`; it does not implicitly parse shell operators, pipes, substitutions, or redirections.
- The optional `run_shell` path is a separate capability for shell syntax and is controlled by settings and permission policy.
- Command/package operations go through permission modes, allow/ask/deny rules, command-risk analysis, and approval prompts. High-impact or ambiguous command forms receive stricter handling; an explicit `--yes` setting is not a universal override for every destructive or high-risk action.
- Hooks can inspect, block, or rewrite tool requests. OASIS rechecks applicable permissions after pre-tool hooks have changed an input.
- Common credential variables are filtered from child-process environments by default. Extra variables should be allowlisted only when a specific command needs them.
- Process-tree management is used for cancellation and timeouts so child processes and descendants are not intentionally left running after a managed command is stopped.

An approval prompt is a user decision about an operation; it is not an operating-system sandbox. Unsandboxed child processes normally run with the operating-system permissions of the user who launched OASIS.

### Optional OS sandbox

The OS sandbox is implemented in `src/sandbox.mjs` and is disabled by default.

| Host | Mechanism | Boundary |
|---|---|---|
| Linux | bubblewrap (`bwrap`) | Read-only host view, writable workspace and explicitly configured additional directories, private temporary area, and network namespace disabled unless enabled. Requires a working bubblewrap/user-namespace setup. |
| macOS | `sandbox-exec` profile | Restricts writes outside permitted workspace/temp paths and can deny network access unless enabled. |
| Windows / other unsupported hosts | No OASIS-native OS sandbox | Approval and command controls remain available, but they are not equivalent to OS isolation. |

If the user explicitly enables the OS sandbox and the required mechanism is unavailable, OASIS refuses to run the command without the requested isolation. The sandbox is not full filesystem-read isolation. It should not be described as a hardened container or a guarantee that arbitrary project code is safe.

## Agent coordination and longer work

OASIS has multiple coordination mechanisms. They share concepts such as task records and worker events, but they are not one persistent distributed scheduler.

### Subagents and named teams

`src/subagents.mjs` and `src/agent-tasks.mjs` define child agents, the bounded parallel launch pool, background-worker records, named team rosters, and lifecycle events.

- A subagent receives its own context window and a bounded task description. Its final report is returned to the parent.
- Several subagent calls can run in parallel (the regular subagent pool is bounded at six). The separate background-agent registry has its own limit.
- Agents in the same workspace can share session-local task state and, when placed in a named team, can send coordination messages to teammates.
- By default, agents may share the same workspace. Parallel editing in a shared checkout can conflict; use read-only work, explicitly separated files, or `isolation: "worktree"`.
- Named teams have create/status/shutdown operations and a roster. Team metadata and in-memory worker processes are not a persistent service that survives a runtime restart.

### Shared task board and isolated dispatch

`src/shared-tasks.mjs` provides a dependency-aware task board for the current session. It validates identifiers, dependencies, cycles, ownership and status transitions. Claims use an exclusive expiring lease (default 15 minutes; configurable from 30 seconds to one hour). Workers can renew or release their own lease, save a bounded redacted task checkpoint, and claim a ready task after a previous lease expires.

`dispatch_ready_tasks` can send a bounded wave of ready tasks to background agents. Those dispatched workers use separate Git worktrees, must claim their assigned task, and do not merge their branches automatically. Optional auto-dispatch can keep filling available slots while the originating OASIS session remains alive; it pauses on failed/cancelled work or tasks left incomplete. It is not an always-on service, and a worktree merge remains a separate review/approval action.

The shared task board is persisted as sanitized session metadata. On session restoration, active leases are deliberately cleared because their worker processes did not survive. A task checkpoint can help a later worker continue, but it does not revive the original process or prove that work resumed.

### Dynamic workflow scripts

`src/workflows.mjs` and `src/workflow-sandbox.mjs` implement JavaScript orchestration scripts. A workflow can describe phases, call agents, fan work out through pipelines or parallel groups, collect structured results, and report progress. The workflow script runs in a restricted JavaScript environment: it does not receive general filesystem, shell, module-import, wall-clock, or random-number access. The agents it asks to do work use the normal OASIS session, permission and tool boundaries.

Workflow orchestration limits work and concurrency; it is not a replacement for the permission system on the worker agents. A failed child result is represented explicitly rather than being silently treated as successful completion.

### Background jobs and restart behavior

The browser run monitor observes existing job/agent records; it is not a second orchestrator. `src/cloud-task-store.mjs` is named for historical reasons: it is a local persistence layer under the user's private OASIS configuration directory, not a hosted cloud scheduler or remote database. It stores bounded, sanitized job metadata and event history using restrictive permissions and atomic replacement.

When the browser runtime restarts, the stored run record can be shown as interrupted. It does not restore the in-memory worker process, team registry, pending approval, or a live PTY. The monitor can reopen a validated saved parent conversation for user-directed follow-up on eligible workspace-mode runs; it does not revive a worker, replay an old approval, resolve worktree conflicts, or merge a branch.

A separate background-session facility can persist command/session records and can start a new process to continue an explicitly resumable CLI session. That is a new process using saved session context, not restoration of the original process identity or memory.

## Connected browser workspace

`src/web.mjs` hosts the local UI and its JSON API. By default it binds to loopback (`127.0.0.1`) on a selected port. The process creates a fresh random bearer token; API requests require that token in the Authorization header. API routes additionally validate the Host and same-origin Origin against localhost or a literal IP address, and request bodies are bounded. The service worker caches static app assets only; it must not cache authenticated `/api/*` responses.

For a non-loopback listener, HTTPS with a user-supplied certificate and private key is required by default. OASIS enforces TLS 1.2 or newer and checks private-key permissions on POSIX hosts. Plain HTTP on a non-loopback address requires the explicit `--allow-insecure-lan` opt-in and is not suitable for untrusted networks. The local bearer token is a connection credential for that runtime; it is not the provider's model API key. Do not expose the browser bridge to the public Internet.

### Chat and approvals

Browser chat jobs call the shared agent runtime and stream bounded events for assistant output, tool activity, usage, completion, and approval requests. Consequential operations can be approved or denied in the browser. Cancellation denies outstanding approvals, aborts supported model/command operations, and records a terminal state; it cannot undo changes that completed before cancellation.

### Terminal

The browser workspace has two execution shapes that should not be conflated:

- The ordinary command/job path launches an argv-based command through the normal OASIS execution controls.
- The interactive Terminal panel has a persistent PTY path managed by `src/pty-sessions.mjs`. It uses the optional native `node-pty` dependency, has bounded output/session limits, and exposes read, input, resize, interrupt and stop operations through authenticated API routes.

If the optional native PTY dependency is unavailable, normal command execution remains available but the interactive PTY path is not. Automated native PTY integration currently covers Linux/Node.js 22; the wider cross-platform browser-terminal lifecycle still needs additional testing. Android/Termux PTY support is not guaranteed.

### Browser state ownership

The Projects, Tasks and Notes dashboard data is stored in browser local storage and can be exported/imported as JSON. It is not the same store as CLI project instructions, agent conversations, shared agent tasks, or local job history. Agent sessions are stored in the host user's OASIS config directory. A browser page opened without the local runtime cannot execute agent tools.

## Integrations and extension boundaries

Integrations are separate trust domains. Enabling an integration makes its tool definitions available; it does not make the external code trustworthy.

| Integration | Implementation and behavior |
|---|---|
| MCP | `src/mcp.mjs` and related modules connect configured stdio and HTTP MCP servers, negotiate capabilities, discover tools, and map them into the agent session. Calls are permission-controlled; configuration and activation are explicit. |
| Hooks | `src/hooks.mjs` implements lifecycle hooks, including command, HTTP, MCP-tool, prompt and agent hook types. Hooks can block, rewrite, or add context. Hooks may execute code or send data externally and are loaded from user settings or trusted project settings. |
| Built-in capability bundles | `plugins/catalog.json` and `src/plugins.mjs` install reviewed bundles of workflow instructions. The bundle install itself does not silently run setup scripts, install dependencies, start servers, or grant credentials. |
| Compatible plugin marketplaces | `src/claude-plugins.mjs` supports a substantial set of Claude Code-compatible marketplace/plugin components, including commands, skills, hooks, MCP, LSP, monitors and executable plugin bins. This is feature-specific compatibility, not a guarantee that every third-party plugin works identically. Plugin hooks, MCP servers and executables can run with the user's permissions. |
| Native OASIS plugin packages | `src/native-plugins.mjs` validates local package manifests and explicit permissions, and supports staged installation/update/uninstall. Capability changes require explicit acceptance. This is a distinct package format from the compatible marketplace adapter. |
| GitHub extension import | `src/extensions.mjs` inspects a public GitHub repository, presents detected components, and pins import/update to a reviewed commit. Markdown agent/skill prompts and approved portable text resources can be imported with source/integrity metadata. It does not activate imported scripts, hooks, binaries, dependencies or MCP servers as part of prompt import. |
| OpenHands bridge | `delegate_openhands` connects to an already-running Agent Server and server-owned Agent Profile. Delegation requires OASIS approval; OASIS does not pass its own model credential to OpenHands and does not approve OpenHands tool confirmations. |
| Language servers | `src/lsp.mjs` manages configured LSP processes for symbol navigation and diagnostics. Servers start on demand with approval; an unavailable server is reported as unavailable, not as a clean check. |

### GitHub paths

There are two separate GitHub integrations:

1. The browser repository browser reuses the host's GitHub CLI authentication. It supports status, bounded repository listing and approved clone into the launch workspace's `.oasis/workspaces/` directory. It is not embedded OAuth or a browser UI for arbitrary branch/push/PR operations.
2. The GitHub Action runs in a GitHub Actions checkout using the OASIS SDK. It can react to authorized `@oasis` mentions on issues and pull requests, run a task, verify it, and publish changes. Depending on the triggering event, it can push to a PR branch or create a branch and open a PR for an issue/task. This CI automation is separate from the browser repository picker.

## Data stores and lifetimes

| Data | Location / owner | Lifetime and important boundary |
|---|---|---|
| Provider configuration | User-level OASIS config plus environment overrides | Not written into the project by normal CLI setup. CLI config-file storage is permission-restricted where supported, not encrypted by default. Desktop API keys use OS-backed Electron storage when available. |
| Saved agent sessions | User-level config, under a workspace-derived session directory | Bounded JSON records written atomically with restrictive POSIX permissions where supported. Message history is capped; image attachments are not saved. Sessions are workspace-bound and validated when loaded. |
| Rewind checkpoints | In-memory session state | Captures supported OASIS file-tool changes for recent turns. Not persisted as a durable restore point and does not capture arbitrary shell side effects. |
| Backup snapshots | User-level OASIS config directory | Separate recoverable copies of supported file changes; outside the project checkout. |
| Memory and instructions | User/project instruction files and OASIS memory directories | Layered text context. Imported/project instructions are data for the model, not a way to override OASIS's base policy. |
| Shared task board | Sanitized saved-session metadata | Tasks and progress checkpoints can persist; active leases are cleared on restore because worker processes are not restored. |
| Browser job history | User-level OASIS config directory | Bounded local metadata and event history. Restart converts unfinished browser jobs to interrupted records. |
| Browser Projects/Tasks/Notes | Browser local storage | Local to that browser profile; separate from CLI sessions and workspace files. |
| MCP / plugin configuration | User/project config and plugin directories | Activation may start third-party processes or execute hooks; review before enabling. |
| Telemetry | Disabled unless explicitly enabled | Optional OTLP/HTTP metrics, events and traces. Prompt text is not exported unless the relevant explicit opt-in is enabled. |

`oasis purge` removes selected project-scoped local state after confirmation; memory is kept unless the memory option is explicitly requested. It is not a secure-erasure tool for backups, external providers, system logs, or arbitrary files created by project commands.

## Trust boundaries

The important boundaries are:

1. **Model provider:** prompts, selected context, and tool results needed for the task may leave the machine when using a hosted model. Provider retention and processing are governed by the provider's own terms.
2. **Project workspace:** repository files and project instructions are untrusted input. Workspace path checks limit OASIS file tools, but they do not make project scripts benign.
3. **Operating-system process:** approved commands and installers execute code. Without the optional OS sandbox, they run with the launching user's OS privileges.
4. **Third-party integration:** MCP servers, hooks, plugins, imported skills, LSP servers, and OpenHands are distinct components with their own code and data access. Their permissions and network behavior must be reviewed.
5. **Browser client:** the local API is protected by a random bearer token and same-origin/host validation. Anyone who obtains that token and can reach the listener may be able to act through the local runtime; keep it private.
6. **Persisted local data:** sessions, job history, task metadata, and browser local storage contain project/workflow context. Restrictive file permissions are not the same as encryption.

Approval prompts, model instructions, imported skills, and this architecture document are not security boundaries. The enforcement boundary is the OASIS runtime's validated tool execution, permission policy, and—where supported and explicitly enabled—the OS sandbox.

## Quality and verification architecture

The repository uses several levels of verification; each answers a different question.

- Unit and integration tests exercise provider configuration, tool contracts, path handling, permission decisions, hooks, MCP, sessions, worktrees, task leases, PTY lifecycle, browser API behavior, and platform-specific code paths where available.
- The public-site checks validate the static dashboard and repository metadata.
- Installer checks exercise supported installer scripts on Windows, macOS and Ubuntu.
- Quality Checks run the test suite, Node/package-integrity matrix, evaluation-manifest validation and other repository gates.
- Desktop packaging builds platform artifacts in CI. A successful build does not prove clean-machine install, first-run, updates, publisher identity, or security certification.
- The evaluation harness validates pinned reference tasks and can compare saved reports. The current 33-task suite is a smoke/regression harness, not a representative repository-scale coding benchmark.

### Runtime verification gate

Inside a task, `src/agent.mjs` keeps a per-turn verification state and does not accept a final answer until it is satisfied or the agent has been asked once to finish it. It records which files the agent changed, whether their diff was reviewed, whether a recognized check passed after the latest edit, and LSP diagnostics per file (`src/lsp.mjs`). Two deterministic steps run outside the model before the gate is evaluated. If `autoTest` is configured, `src/auto-test.mjs` runs the user's test command and sends failures back as a new user turn, up to a fixed number of attempts. `src/test-tamper.mjs` compares the edited test files with `HEAD` and turns skips, `.only`, removed test cases or assertions, and deleted test files into blockers. Results are returned as `verification` in the CLI summary, JSON/stream-json output, the SDK and the web workspace.

CI passing is evidence for the exact commit and jobs that ran. A green older run is not verification of a newer commit. For current statuses and release gates, use the [project plan](PROJECT_PLAN.md).

## Current architectural limits

- OASIS is Beta software; no production security certification or universal platform qualification is claimed.
- The optional OS sandbox is Linux/macOS only, disabled by default, and not full filesystem-read isolation. There is no native Windows OS sandbox.
- Android has no native APK release. The CLI can be tried through Termux; native PTY and background behavior are not guaranteed.
- Browser Projects/Tasks/Notes data does not synchronize with CLI task/session state. There is no hosted account or cloud synchronization layer.
- Browser job records and task checkpoints can survive a runtime restart, but the live worker processes, in-memory team registry, PTY sessions and pending approvals do not.
- Parallel subagents that share one working tree can conflict. Worktree isolation separates edits, but branch merges remain separately reviewed; automatic conflict resolution is not provided.
- The browser GitHub repository picker is limited and uses host-side GitHub CLI authentication. It is not embedded OAuth or a complete GitHub project-management client.
- Plugin and extension compatibility is feature-specific; detected metadata is not proof that every component can run.
- Desktop packages are unsigned at this stage; signing, publisher provenance and automatic desktop updates are not configured.
- HTTPS remote access requires user-provided certificates and additional real-device/device-trust testing. Non-loopback plaintext is an explicit insecure opt-in, not a recommended deployment.
- The current evaluator does not establish head-to-head model parity, speed, accuracy, or guaranteed token savings.

These are current engineering boundaries, not statements that the corresponding work is impossible. Future proposals are tracked separately in [research notes](research/README.md) and must not be read as shipped architecture.

## Source map

| Concern | Primary implementation |
|---|---|
| CLI and headless runtime | `src/cli.mjs`, `src/headless.mjs` |
| Agent loop, sessions and verification | `src/agent.mjs`, `src/sessions.mjs`, `src/checkpoints.mjs` |
| Provider configuration and adapters | `src/config.mjs`, `src/cloud-providers.mjs` |
| Tool execution and workspace checks | `src/tools.mjs`, `src/power-tools.mjs`, `src/process-tree.mjs` |
| Permission policy and OS sandbox | `src/permissions.mjs`, `src/sandbox.mjs`, `src/settings.mjs` |
| Subagents, teams and task board | `src/subagents.mjs`, `src/agent-tasks.mjs`, `src/shared-tasks.mjs`, `src/session-messaging.mjs` |
| Dynamic workflows | `src/workflows.mjs`, `src/workflow-sandbox.mjs` |
| Browser API, terminal and monitoring | `src/web.mjs`, `src/pty-sessions.mjs`, `src/cloud-task-store.mjs` |
| MCP, hooks and extension ecosystem | `src/mcp.mjs`, `src/hooks.mjs`, `src/claude-plugins.mjs`, `src/native-plugins.mjs`, `src/extensions.mjs` |
| SDK and GitHub Action | `src/sdk.mjs`, `src/github-action.mjs`, `action.yml` |
| Electron desktop host | `desktop/main.mjs`, `desktop/secure-secrets.mjs` |
| VS Code-family extension | `ide/vscode/`, `src/ide.mjs` |
| Language-server integration | `src/lsp.mjs` |
| Verification helpers | `src/auto-test.mjs`, `src/test-tamper.mjs`, `src/lsp.mjs` |
| Repository map and watch mode | `src/repo-map.mjs`, `src/ai-comments.mjs` |
| Public URL fetching and SSRF guards | `src/public-fetch.mjs`, `src/browser-tool.mjs` |
| Slash commands and terminal rendering | `src/slash.mjs`, `src/terminal-ui.mjs`, `src/markdown.mjs` |
| Memory, backups, secure storage and telemetry | `src/memory.mjs`, `src/backups.mjs`, `src/secure-store.mjs`, `src/telemetry.mjs`, `desktop/secure-secrets.mjs` |

## Related references

- [User guide](USER_GUIDE.md) — commands, configuration, integrations and common workflows.
- [Project plan](PROJECT_PLAN.md) — implemented inventory, current Beta boundaries and release acceptance gates.
- [Security and reliability audit](SECURITY_RELIABILITY_AUDIT.md) — dated findings, mitigations and residual risks.
- [Privacy notes](PRIVACY.md) — provider data flows, local storage, credentials and integrations.
- [Workflows and skills](WORKFLOWS_AND_SKILLS.md) — reusable workflow and instruction model.
- [Documentation index](README.md) — all canonical guides, release notes and research archives.
