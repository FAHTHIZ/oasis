# Interfaces and deployment

OASIS has **two interfaces**: the web app and the terminal. Both drive the same runtime, sessions and settings. Everything else connects OASIS to another tool.

| You want to… | Use | Start it with |
|---|---|---|
| Work in a browser, on this computer or from any device | **Web app** | `oasis web --open` |
| Work in the terminal | **Terminal** (interactive TUI, plus `oasis -p` and `oasis exec` for scripts and CI) | `oasis` |

A session started in the terminal shows up in the web app under **Chats → Earlier on this computer** and can be continued there.

The web app is the product: a phone, tablet or laptop opens it in any modern browser, and the agent, files, shell and model keys stay on the machine running `oasis web`. The [desktop app](DESKTOP.md) (Windows, macOS, Linux) is the same web app and runtime in its own window, with the model key in the operating system's key store and in-app updates. There is no separate mobile app.

Integrations connect OASIS to other tools. They are not separate interfaces:

| Integration | How to start | Where it runs |
|---|---|---|
| VS Code, Cursor, Windsurf | `oasis ide install` | Editor plus a connected OASIS runtime |
| Agent Client Protocol (Zed, JetBrains) | `oasis acp` | The OASIS ACP process |
| Codex App Server clients | `oasis app-server` | The OASIS app-server process |
| Cursor Cloud Agents API clients (REST, v1 and v0) | `oasis web --persistent-key` | The `oasis web` server, under `/v1` and `/v0` |
| Node.js SDK | Import `src/sdk.mjs` | Your Node.js process |
| GitHub Action | `action.yml` in a workflow | The Actions runner |
| Messaging gateways (Telegram, Slack, Discord) | `oasis gateway` | The gateway process |

Old bookmarks to `/`, `/classic` or `/index.html` open the web app.

## Web app

```sh
cd /path/to/your/project
oasis web --open
```

The browser is only the interface. The default server listens on `127.0.0.1`, needs the access key printed in the terminal, and makes a new key on every start.

### Deploy it for remote use

| Setup | Command | Notes |
|---|---|---|
| This computer only | `oasis web --open` | Default. Loopback, fresh key per start. |
| HTTPS reverse proxy or tunnel | `oasis web --public-url https://oasis.example.com --trust-proxy` | Recommended. Caddy, nginx, Tailscale Serve or Cloudflare Tunnel terminate TLS; the key persists. |
| Direct HTTPS | `oasis web --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem --persistent-key` | OASIS serves TLS itself. |
| Containers and secret managers | `OASIS_WEB_TOKEN=… oasis web --public-url …` | Supply your own 32+ character key. |
| Trusted LAN without TLS | `--allow-insecure-lan` | Not recommended: the key and traffic are readable on the network. |

`oasis web key` prints the saved key and `oasis web key --rotate` replaces it. Ten wrong keys from one address within a minute lock it out for five minutes. Host names outside localhost, literal IPs and `--public-url` / `--allow-host` are refused to block DNS rebinding. Provider keys, updates and hardware setup are accepted only from the same computer or over HTTPS. [Remote access](REMOTE-ACCESS.md) has the full security model and proxy recipes.

### Sessions and reconnects

Tasks run on the server, not in the tab. Reloading, closing the tab or losing the network does not stop a task. When the page comes back it reattaches to the running job, replays its timeline from the server and asks any open approval again. Switching to another task or starting a new one leaves the running task going; its sidebar entry says Working or Needs you, and opening it again reattaches. Tasks started from another browser or from `oasis` in a terminal appear under **Other devices and terminal**, and opening a running one follows it live. An approval answered in one browser closes in the others. If the connection drops, the page says it is reconnecting and retries with backoff for about a minute before giving up. Finished tasks stay reviewable after a server restart. A task that was running when the server itself stopped is marked interrupted, because live processes and pending approvals cannot be restored.

### Working in the web app

| Action | How |
| --- | --- |
| Run a command or skill | Type `/` in the message box. Arrow keys move, Tab or Enter accepts, Escape closes. |
| Point at a file | Type `@` and part of a file name, then Tab or Enter to insert the path. |
| Switch permission mode | Use the mode chip, or press Shift+Tab: Ask first, Auto edit, Full auto and Plan. |
| Inspect a step | Select an execution group to list its steps, then a step to see its exact input and output. |
| Undo a turn | Select **Undo** under the reply. It runs `/undo`, which restores the files and rewinds the conversation. The undone turn stays visible, dimmed. |
| Download a chat | Ctrl+K → **Download this chat**: one HTML page with every tool step, no scripts, credentials redacted. |
| Terminal | Press Ctrl+` (or Ctrl+K → **Open terminal**) and choose **Start terminal**. After you approve it, your shell (`$SHELL`, or PowerShell on Windows) runs in the workspace on the computer hosting OASIS. The agent cannot see or type into it, and it does not block chat. Common secret environment variables are removed. Reloading the page reconnects to the same shell and replays its recent output. |
| Task sidebar | On wide screens, the sidebar lists this project's tasks; Ctrl+B (Cmd+B) hides or shows it. |
| Resize the side panel | Drag the left edge of the Files panel, or focus it and use the arrow keys. Double-click resets the width. |
| Sign out | Ctrl+K → **Sign out of this browser** forgets the access key here. |
| Open everything else | Ctrl+K (Cmd+K on macOS) opens the command palette. Ctrl+/ lists every shortcut. |

## Terminal session

Requirements: Node.js 22.15 or newer and Git.

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
cd /path/to/your/project
oasis connect
oasis
```

Use `oasis -p` or `oasis exec` for non-interactive runs and `oasis doctor` to check the local environment. In text mode, `oasis -p` prints one dim progress line per step on stderr when stderr is a terminal; stdout carries only the answer. Set `OASIS_PROGRESS=0` to hide the lines or `OASIS_PROGRESS=1` to keep them when stderr is redirected. The terminal does not need the web app to be open.

`oasis exec --json` prints the Codex exec JSONL event stream (`thread.started`, `item.*`, `turn.completed`), so the OpenAI Codex TypeScript SDK can drive OASIS with `codexPathOverride` pointing at the `oasis` binary. Thread ids are OASIS session ids; `resume THREAD_ID` continues one. See CHANGELOG for the item and `--config` mapping.

Android users who want the CLI on the device itself can run it in Termux with Node.js 22.15 or newer and Git.

## Downloads

Release tarballs and `SHA256SUMS` are on [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases/latest). See [Downloads and releases](RELEASES.md).

## Editor, ACP and SDK integrations

- **Editor integration:** install the VS Code-family extension with `oasis ide install`.
- **Tab completion:** the extension shows ghost text as you type; Tab accepts it. It uses the model OASIS is set up with (or `completionModel` in the OASIS config), with fill-in-the-middle on Ollama and a short instruction prompt on other OpenAI-compatible or Anthropic endpoints. A small coder model such as `qwen2.5-coder:1.5b` keeps it fast. The OASIS item in the status bar, or **OASIS: Turn Tab Completion On or Off**, switches it; `oasis.completions.*` settings pick another model or endpoint, and a custom endpoint never receives the OASIS key.
- **ACP:** start `oasis acp` from a compatible client. OASIS uses newline-delimited JSON-RPC over standard input/output. It implements `session/new`, `session/load` (replays the chat), `session/resume` (no replay), `session/list`, `session/close`, `session/delete`, `session/prompt`, `session/cancel` (or `$/cancel_request` for the prompt request), `session/set_mode` and `session/set_config_option` for the `mode` and `model` options (models come from the configured model and `availableModels`). It sends `usage_update` (context used and window size, plus cost when the price is known) after each model step and `session_info_update` with a title after the first prompt. If the client's `initialize` advertises `clientCapabilities.elicitation.form`, `ask_user_question` is sent as `elicitation/create` (`mode: "form"`, session scope with the tool call ID); the schema has an `answer` field (`oneOf` choices, or an `anyOf` array for multi-select) and an optional free-text `other` field. Only `accept` counts as an answer.
- **Codex App Server protocol:** `oasis app-server` speaks JSON-RPC (one message per line, `jsonrpc` field optional) on standard input/output. Supported methods: `initialize`, `thread/start`, `thread/resume`, `thread/fork` (with `lastTurnId`), `thread/read`, `thread/list` (with `archived`, `searchTerm` and `excludedThreadIds`), `thread/name/set`, `thread/loaded/list`, `thread/unsubscribe`, `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/compact/start`, `thread/turns/list` (pages of turns, newest first by default, `summary`/`full`/`notLoaded` views), `skills/list` (scopes `system`, `repo`, `user`), `mcpServerStatus/list` (for a loaded thread), `turn/start`, `turn/steer`, `turn/interrupt`, `review/start` (inline: current changes, a base branch, a commit or custom instructions), `model/list`, the file methods `fs/readFile`, `fs/writeFile`, `fs/createDirectory`, `fs/getMetadata`, `fs/readDirectory`, `fs/remove`, `fs/copy`, `fs/watch` and `fs/unwatch` (sends `fs/changed`), and `command/exec` with `command/exec/write`, `command/exec/resize` and `command/exec/terminate` (streams `command/exec/outputDelta`; `tty: true` needs node-pty), and `fuzzyFileSearch` (up to 50 files and folders with match positions; a newer request with the same `cancellationToken` makes the older one return empty). `thread/shellCommand` runs your own shell command (pipes and redirects kept) in the thread's folder, shown as a `commandExecution` item with `source: "userShell"` in the running turn or in a turn of its own; the model sees the command and its output with the next request, and plan mode refuses it. `gitDiffToRemote` returns the nearest commit a remote already has and the diff from it to the working tree, untracked files included; the repository's top folder must be an allowed folder. `config/read` returns the effective configuration in Codex's `Config` shape (OASIS-only values under `oasis`) and, with `includeLayers`, the settings files that contributed, with secret-looking values replaced by `[redacted]`. `hooks/list` lists the active hooks for each folder or a loaded thread in Codex's shape (event, handler, matcher, timeout, source file, hash); hooks on events Codex has no name for, and HTTP hooks, are counted in `warnings`. `account/read` reports `requiresOpenaiAuth: false`, since OASIS uses provider keys or local servers, and a configured provider as `{ type: "apiKey" }`. File and command methods only reach the server's folder, folders of threads opened on the connection and folders in `OASIS_APP_SERVER_FS_ROOTS`; symlinks are resolved before the check. Commands run through the sandbox in OASIS settings, and a plan-mode server refuses writes and commands. OASIS sends `turn/*`, `item/*` and `thread/*` notifications and asks for approval with `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`. Clients that set `capabilities.experimentalApi` also get `ask_user_question` as `item/tool/requestUserInput` (answer with `{ answers: { q1: { answers: ["..."] } } }`). `sandbox: "read-only"` selects Plan mode. `approvalPolicy: "never"` selects Auto mode: risky actions still ask, and the protocol cannot turn approvals off. `--listen ws://IP:PORT` serves the same protocol over WebSocket, with one JSON-RPC message per text frame and separate protocol state for each connection. The same port answers `GET /readyz` and `GET /healthz`, and any request with an `Origin` header gets 403, so web pages cannot connect. `--ws-auth capability-token --ws-token-file /abs/path` (the file must be mode 600) or `--ws-token-sha256 HEX` requires `Authorization: Bearer TOKEN` in the handshake, before any JSON-RPC message is read. OASIS refuses a non-loopback listener without auth, while Codex allows one during its rollout. For TLS, put a proxy in front. `--listen unix://` (default `<config dir>/app-server-control/app-server-control.sock`) or `--listen unix://PATH` serves the same WebSocket protocol over a Unix domain socket (connect with a `ws+unix://` client). The folder is mode 700 and the socket mode 600, so it needs no token. A stale socket is removed on start, a live one is refused, and the socket is deleted on shutdown. `--ws-auth signed-bearer-token --ws-shared-secret-file /abs/path` (mode 600, at least 32 bytes) instead accepts an HS256 JWT signed with that secret, as Codex does: `exp` is required, `nbf` is honoured, `--ws-issuer` and `--ws-audience` pin `iss` and `aud`, and `--ws-max-clock-skew-seconds` (default 30) allows for clock drift.
- **SDK:** import the Node.js API from the package entry point or `src/sdk.mjs`. The SDK exposes session, headless, tool and hook APIs; it is not a hosted service.

## Cursor Cloud Agents API

`oasis web` also answers the REST API of [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent/api/endpoints), so a script or tool written for it can drive OASIS agents on your own computer or server with whatever model OASIS is configured to use. Point the client's base URL at the OASIS server instead of `https://api.cursor.com` and use the web access key as the API key.

```sh
oasis web --persistent-key          # a key that survives restarts; `oasis web key` prints it
curl -u "$OASIS_KEY:" http://127.0.0.1:3917/v1/agents \
  -H 'content-type: application/json' \
  -d '{"prompt":{"text":"Add a README section on testing"}}'
```

- **Auth:** the same access key, host checks and lockout as the web app (ten wrong keys from one address in a minute lock it out for five minutes). Send it as `Authorization: Bearer KEY`, or as Basic auth with the key as the username and an empty password, as Cursor's API takes it. Basic auth works only on `/v1` and `/v0`. Errors use Cursor's shape, `{"error":{"code":"…","message":"…"}}`.
- **Mapping:** an agent (`bc-<uuid>`) is an OASIS conversation in the folder the server serves, and a run (`run-<uuid>`) is one agent turn. Run statuses are `RUNNING`, `FINISHED`, `ERROR`, `CANCELLED` and `EXPIRED` (a run whose history is gone); agents are `ACTIVE` or `ARCHIVED`. Agent and run records are kept under the OASIS config folder (`cursor-agents/`, mode 600), so they survive a restart. Each run also carries an `oasis` object with the web job ID and session ID.
- **v1 endpoints:** `POST /v1/agents` (returns `{agent, run}`), `GET /v1/agents` (`limit`, `cursor`, `includeArchived`; `nextCursor` is left out on the last page), `GET` and `DELETE /v1/agents/{id}`, `POST /v1/agents/{id}/archive` and `/unarchive`, `POST /v1/agents/{id}/runs` (a follow-up returns `201 {run}`, or `409 agent_busy` while a run is active; `delivery: "steer"` returns `202` with `steered` and the `runId` when the running turn took it, or `queued` when it becomes the next follow-up), `GET /v1/agents/{id}/runs` and `/runs/{runId}` (with `durationMs` and `result`), `POST /runs/{runId}/cancel` (`409 run_not_cancellable` if it is not active), `GET /runs/{runId}/stream` (Server-Sent Events: `status`, `assistant`, `tool_call`, `heartbeat`, `result`, `done`; resume with `Last-Event-ID`, `400 invalid_last_event_id` for another run's ID), `GET /v1/agents/{id}/usage` (input, output, cache-read and cache-write tokens per run), `GET /v1/models`, `GET /v1/me` and `GET /v1/repositories`.
- **v0 (legacy) endpoints:** `POST /v0/agents`, `GET /v0/agents`, `GET` and `DELETE /v0/agents/{id}`, `GET /v0/agents/{id}/conversation`, `POST /v0/agents/{id}/followup`, `POST /v0/agents/{id}/stop`, `GET /v0/me`, `GET /v0/models` and `GET /v0/repositories`. v0 has no cancelled status, so a stopped agent reports `FINISHED`.
- **Webhooks (v0):** `webhook.url` gets a `statusChange` POST when a run finishes or fails, with `X-Webhook-Signature: sha256=<HMAC-SHA256 of the raw body with webhook.secret>`, `X-Webhook-ID`, `X-Webhook-Event: statusChange` and `User-Agent: Cursor-Agent-Webhook/1.0`, as [Cursor documents](https://cursor.com/docs/cloud-agent/api/webhooks). Network errors, 408, 429 and 5xx answers are retried three times. The URL must be HTTPS (plain HTTP only for localhost) and the secret, when given, 32 to 256 characters. The secret is stored with the agent record and never returned.
- **Repository:** `repos[0].url` (v1) or `source.repository` (v0) must be the folder this server serves: its `origin` remote (HTTPS or SSH form) or its `file://` URL, as `GET /v1/repositories` lists it. Another repository returns `400 repository_access`; OASIS does not clone through this API. `startingRef` / `source.ref` must be the folder's current branch or commit (`400 invalid_branch_name` otherwise). With no repository, the agent uses the served folder. OASIS works in the folder's current checkout, so agents report `workOnCurrentBranch: true`. Only one task runs in a folder at a time: creating an agent while another is working returns `409 workspace_busy`.
- **Model:** `model.id` (v1) or `model` (v0) is passed to the configured provider as the model name; omitted or `default` uses the configured model. `GET /v1/models` lists only the configured model. A follow-up cannot switch an agent to another model, and `model.params` is refused.
- **Not supported (refused with a 4xx that names the field):** pull requests (`autoCreatePR`, `target.autoCreatePr`, `prUrl`, `source.prUrl`), new branches (`target.branchName`), Cursor cloud environments (`env` other than `{"type":"machine"}`), `envVars`, inline `mcpServers` (OASIS uses the MCP servers configured on the computer), `customSubagents`, image URLs (send base64 `data` with `mimeType`; up to four images), artifacts, and the environment, secret and sub-token endpoints. `mode: "plan"` runs the turn in OASIS plan mode.
- **Approvals still apply:** an API run that needs an approval waits, reported as `RUNNING` with `oasis.waitingForApproval: true`, until someone answers it in the web app or with `POST /api/jobs/{jobId}/approval`. Permission rules and modes from OASIS settings decide what needs one; the API cannot turn approvals off.

This is an independent implementation of Cursor's published API reference; nothing runs on Cursor's servers.

## Automation integrations

- **GitHub Action:** `action.yml` defines the composite action. It uses the workflow's configured model credentials and GitHub permissions.
- **Messaging gateways:** gateway modules live in `src/gateway-*.mjs`. They must be configured explicitly; their availability and permissions depend on the selected gateway.

Review credentials, event triggers and permissions before enabling automation in a repository.
