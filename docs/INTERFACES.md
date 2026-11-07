# Interfaces and deployment

OASIS exposes several ways to use the same coding-agent runtime. Select an interface based on where the project lives and which capabilities are required.

## Interface comparison

| Interface | Where the runtime executes | Project access | Best suited for |
|---|---|---|---|
| CLI | The computer running the CLI | Local filesystem and configured additional directories | Direct development, scripts and headless tasks. |
| Connected browser workspace | The computer running the OASIS web server | The server host's configured workspace | Using a browser as the UI for a project on another computer. |
| Desktop application | The desktop host process | Local workspace selected by the user | A packaged desktop experience with local runtime integration. |
| VS Code-family extension | The editor host and connected OASIS runtime | Editor workspace and runtime-approved paths | Editor context, diagnostics and diff review. |
| Agent Client Protocol | The OASIS ACP process | Workspace passed by the ACP client | Editors and tools that implement ACP. |
| Node.js SDK | The embedding Node.js process | Paths and tools supplied to the SDK session | Building applications and integrations on the OASIS runtime. |
| GitHub Action | The GitHub Actions runner | The checked-out repository and permissions granted to the workflow | Repository automation initiated by configured events. |
| Messaging gateways | The configured gateway process | Whatever workspace and tools the gateway is configured to expose | Chat-based task intake and automation. |

The normal browser session and desktop application use the same host-connected runtime. The browser is only the interface; it does not turn OASIS into a hosted service or a browser-only agent.

## Desktop

Download platform packages from [GitHub Releases](https://github.com/FAHTHIZ/oasis/releases/latest). Check the release assets for the current platform and architecture; package availability can change between releases.

The desktop application is built with Electron and starts the OASIS runtime in the desktop host. Provider credentials are handled through the desktop secure-storage implementation where supported. See `desktop/secure-secrets.mjs` and `desktop/main.mjs` for the implementation.

## CLI

The CLI requires Node.js 22 or newer and Git.

Install from a source checkout:

```sh
git clone https://github.com/FAHTHIZ/oasis.git
cd oasis
npm install
npm install --global .
```

Run it in a project:

```sh
cd /path/to/your/project
oasis connect
oasis
```

For non-interactive execution, use `oasis exec`. Use `oasis doctor` to inspect the local environment.

## Normal browser session

Start the server on the computer that contains the project:

```sh
cd /path/to/your/project
oasis web --open
```

For a phone or another device on the same trusted private network, use the LAN mode described in [Mobile and tablet setup](../MOBILE.md). Keep the host computer running. Do not expose the connected workspace directly to the public internet.

The browser is the user interface; the agent process and project access remain on the host computer.

## Phone and tablet

There is no native Android APK or iOS App Store package in the current release.

- Install the PWA from the browser for a home-screen experience.
- Connect to a computer's OASIS runtime over a trusted private network when you need that computer's project.
- Advanced Android users can run the CLI manually in Termux with Node.js 22 or newer and Git. This is not a one-click mobile installer.

Follow [MOBILE.md](../MOBILE.md) for the setup details and network cautions.

## Editor, ACP and SDK integrations

- **Editor integration:** install the VS Code-family extension with `oasis ide install`. The extension provides editor context and review surfaces while the runtime handles agent execution.
- **ACP:** start `oasis acp` from a compatible client. OASIS uses newline-delimited JSON-RPC over standard input/output.
- **SDK:** import the Node.js API from the package entry point or `src/sdk.mjs`. The SDK exposes session, headless, tool and hook APIs; it is not a separate hosted service.

## Automation integrations

- **GitHub Action:** `action.yml` defines the composite action. It can respond to configured repository events and uses the workflow's configured model credentials and GitHub permissions.
- **Messaging gateways:** gateway modules live in `src/gateway-*.mjs`. They must be configured explicitly; their availability and permissions depend on the selected gateway.

Review credentials, event triggers and permissions before enabling automation in a repository.
