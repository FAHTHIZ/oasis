# Interfaces and deployment

OASIS has **two interfaces**: the terminal and the web app. Everything else packages one of them or connects OASIS to another tool.

| You want to… | Use | Start it with |
|---|---|---|
| Work in the terminal | **Terminal** (interactive TUI, plus `oasis -p` and `oasis exec` for scripts and CI) | `oasis` |
| Work in a browser, on this computer or a phone on your network | **Web app** | `oasis web --open` |

Both drive the same runtime, sessions and settings. A session started in the terminal shows up in the web app under **Chats → Earlier on this computer** and can be continued there.

The web app also comes in two wrappers, with the same code and the same screens:

- **Desktop app** (Windows, macOS, Linux): the web app in a native window, with the runtime started for you on the folder you pick.
- **`oasis app`**: opens the web app in your browser without a separate server window.

Integrations connect OASIS to other tools. They are not separate interfaces:

| Integration | How to start | Where it runs |
|---|---|---|
| VS Code, Cursor, Windsurf | `oasis ide install` | Editor plus a connected OASIS runtime |
| Agent Client Protocol (Zed, JetBrains) | `oasis acp` | The OASIS ACP process |
| Node.js SDK | Import `src/sdk.mjs` | Your Node.js process |
| GitHub Action | `action.yml` in a workflow | The Actions runner |
| Messaging gateways (Telegram, Slack, Discord) | `oasis gateway` | The gateway process |

The older single-page interface (`/classic`) was retired in November 2026. Old bookmarks to `/`, `/classic` or `/index.html` open the web app.

## Downloads

Download desktop installers from [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases/latest). Supported release targets include Windows x64, macOS Apple Silicon and Linux x64. Windows ARM64, macOS Intel and Linux ARM64 are optional builds and appear only when their CI jobs succeed.

See [Downloads and releases](RELEASES.md) for package formats and checksum verification.

## Terminal session

The CLI runs directly in the shell on the computer that owns the project.

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

## Web app

Start the server on the computer containing the project:

```sh
cd /path/to/your/project
oasis web --open
```

The browser is only the interface. The agent process, project access and command execution remain on the host. The default server is local-only. Browser job/event history is stored locally under the OASIS config directory. Completed tasks remain reviewable after restart; active tasks are marked interrupted because live processes and pending approvals cannot be restored. Saved chat sessions use their separate session store. For phone or another device, follow [Mobile and tablet setup](../MOBILE.md); use a trusted private network and never expose the workspace directly to the public internet.

### Working in the web app

| Action | How |
| --- | --- |
| Run a command or skill | Type `/` in the message box. Suggestions list built-in commands, your custom commands and skills. Arrow keys move, Tab or Enter accepts, Escape closes. |
| Point at a file | Type `@` and part of a file name, then Tab or Enter to insert the path. The file is attached to the message. |
| Switch permission mode | Use the mode chip, or press Shift+Tab in the message box: Ask first, Auto edit, Full auto and Plan. |
| Undo a turn | After a turn that changed files, select **Undo** under the reply. It runs `/undo`, which restores the files and rewinds the conversation. The undone turn stays visible, dimmed. |
| Download a chat | Press Ctrl+K and choose **Download this chat**. You get one HTML page with every tool step, with no scripts and with credentials redacted, the same page `/export FILE.html` writes. |
| Terminal | Press Ctrl+` (or Ctrl+K → **Open terminal**) and choose **Start terminal**. After you approve it, your shell (`$SHELL`, or PowerShell on Windows) runs in the workspace on the computer hosting OASIS. The agent cannot see or type into it, and it does not block chat. Common secret environment variables are removed. Reloading the page reconnects to the same shell and replays its recent output. |
| Resize the side panel | Drag the left edge of the Files panel, or focus it and use the arrow keys. Double-click resets the width. |
| Download a file | Open a file from the Files tab and choose **Download**. |
| Copy or reuse a message | Hover a message for **Copy** (the original Markdown) and, on your own messages, **Edit**, which puts the text back in the message box. Code blocks have their own Copy button. |
| Watch the context window | The ring beside the Send button shows how full the context window is. It turns amber at 70% and red at 90%; hover it for token counts. |
| Know when it's done | When the tab is in the background, the page title shows a badge when a task finishes or needs approval. Turn on desktop notifications under **Settings**. |
| Open everything else | Ctrl+K (Cmd+K on macOS) opens the command palette. Ctrl+/ lists every shortcut. |

## Desktop application

The Electron app starts the local runtime, asks you to select a project folder and opens the workspace in a native window. Provider credentials are handled through the desktop secure-storage implementation where supported.

The macOS packages are not currently code-signed. macOS may require an explicit first-launch confirmation in Privacy & Security.

## Phone and tablet

There is no native Android APK or iOS App Store package. Available options are:
- Connect to a computer's OASIS runtime over a trusted private network when you need that computer's project.
- Advanced Android users can run the CLI manually in Termux with Node.js 22.15 or newer and Git.

See [MOBILE.md](../MOBILE.md) for setup and network cautions.

## Editor, ACP and SDK integrations

- **Editor integration:** install the VS Code-family extension with oasis ide install.
- **ACP:** start oasis acp from a compatible client. OASIS uses newline-delimited JSON-RPC over standard input/output.
- **SDK:** import the Node.js API from the package entry point or src/sdk.mjs. The SDK exposes session, headless, tool and hook APIs; it is not a hosted service.

## Automation integrations

- **GitHub Action:** action.yml defines the composite action. It uses the workflow's configured model credentials and GitHub permissions.
- **Messaging gateways:** gateway modules live in src/gateway-*.mjs. They must be configured explicitly; their availability and permissions depend on the selected gateway.

Review credentials, event triggers and permissions before enabling automation in a repository.
