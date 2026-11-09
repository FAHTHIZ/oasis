# Interfaces and deployment

OASIS has **two interfaces**: the web app and the terminal. Both drive the same runtime, sessions and settings. Everything else connects OASIS to another tool.

| You want to… | Use | Start it with |
|---|---|---|
| Work in a browser, on this computer or from any device | **Web app** | `oasis web --open` |
| Work in the terminal | **Terminal** (interactive TUI, plus `oasis -p` and `oasis exec` for scripts and CI) | `oasis` |

A session started in the terminal shows up in the web app under **Chats → Earlier on this computer** and can be continued there.

There is no separate desktop or mobile app. The web app is the product: a phone, tablet or laptop opens it in any modern browser, and the agent, files, shell and model keys stay on the machine running `oasis web`.

Integrations connect OASIS to other tools. They are not separate interfaces:

| Integration | How to start | Where it runs |
|---|---|---|
| VS Code, Cursor, Windsurf | `oasis ide install` | Editor plus a connected OASIS runtime |
| Agent Client Protocol (Zed, JetBrains) | `oasis acp` | The OASIS ACP process |
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

Android users who want the CLI on the device itself can run it in Termux with Node.js 22.15 or newer and Git.

## Downloads

Release tarballs and `SHA256SUMS` are on [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases/latest). See [Downloads and releases](RELEASES.md).

## Editor, ACP and SDK integrations

- **Editor integration:** install the VS Code-family extension with `oasis ide install`.
- **ACP:** start `oasis acp` from a compatible client. OASIS uses newline-delimited JSON-RPC over standard input/output.
- **SDK:** import the Node.js API from the package entry point or `src/sdk.mjs`. The SDK exposes session, headless, tool and hook APIs; it is not a hosted service.

## Automation integrations

- **GitHub Action:** `action.yml` defines the composite action. It uses the workflow's configured model credentials and GitHub permissions.
- **Messaging gateways:** gateway modules live in `src/gateway-*.mjs`. They must be configured explicitly; their availability and permissions depend on the selected gateway.

Review credentials, event triggers and permissions before enabling automation in a repository.
