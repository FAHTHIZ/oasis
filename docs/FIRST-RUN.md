# OASIS first-run guide

This guide takes you from a fresh checkout to a reviewed, verified coding task. It separates the OASIS interfaces because they do not all have the same access to files or commands.

## 1. Choose the right interface

| Goal | Start here | Execution boundary |
|---|---|---|
| Run an agent on the same machine as a project | CLI | Uses permissions of the local OASIS process |
| Work from a browser on this or any other device | Web app (`oasis web`) | Commands, project files and model keys stay on the host computer |
| Integrate with an editor or compatible client | IDE integration or ACP | Depends on the configured host/runtime |

## 2. Install from source

Requirements: Node.js 22.15 or newer and Git.

    git clone https://github.com/FAHTHIZ/oasis.git
    cd oasis
    npm install
    npm install --global .
    oasis doctor

Open your project and start OASIS:

    cd /path/to/your/project
    oasis connect
    oasis

The complete installation path is in the [README](../README.md#download-and-install).

## 3. Configure a model provider

OASIS is a runtime, not an inference service. Choose a provider and model that you are authorised to use. Depending on the interface, configure the endpoint, model identifier and credential in the provider setup flow or user configuration.

Before entering a credential, verify the provider URL, understand whether prompts and project context may be sent to it, and avoid committing credentials to project files, shell history, reports or screenshots. Start with a small, non-sensitive project.

See the [configuration reference](CONFIGURATION.md) for supported provider protocols and routing options.

## 4. Start with a bounded task

Choose one change with a clear outcome, such as explaining a function, fixing a reproducible bug or adding a focused test. State relevant constraints and the checks that should prove the change is correct.

For the first run, avoid granting broad permissions just to reduce prompts. Review the command and working directory before approving actions that need permission.

## 5. Review the work

1. Inspect the files the agent changed and read the diff.
2. Check that the change matches the task and contains no unrelated edits.
3. Run relevant tests and inspect their exit status and output.
4. Ask for corrections when a test fails or the result is incomplete.
5. Commit only after you understand and accept the final diff.

A model saying “done” is not a test result. See [benchmark methodology](BENCHMARKS.md) for the difference between test coverage, deterministic harness checks and live task evaluations.

## 6. Understand security boundaries

Approval prompts are not a replacement for operating-system isolation. Without an active sandbox backend, commands may run with the permissions of the OASIS process. Optional Linux, macOS and container sandbox backends have platform-specific prerequisites.

MCP servers, plugins, hooks and imported skills can expand the runtime's capabilities and may execute third-party code. Review what you install and what permissions it needs. Keep important projects under version control and maintain backups.

Read [SECURITY.md](../SECURITY.md) before connecting sensitive workspaces.

## 7. Use another device

Start the web app on the computer that holds the project, put HTTPS in front of it (Tailscale Serve, Cloudflare Tunnel, Caddy or nginx), and open the address in any browser:

    oasis web --public-url https://oasis.example.com --trust-proxy

Paste the link or access key once and tick **Remember this device** on hardware you own. The agent and project access stay on the host. See [Remote access](REMOTE-ACCESS.md).

## Troubleshooting

- **Provider connection fails:** verify the endpoint, model name, network access and provider credentials. Do not share API keys in logs or issues.
- **A command asks for approval:** inspect the command, arguments and working directory before deciding.
- **Sandbox unavailable:** do not assume isolation is active; see the security policy and architecture notes.
- **The result is not correct:** inspect the diff, ask for a narrow correction and run the relevant test again.
- **The browser asks for the link again:** tick **Remember this device**, or start with `--public-url` so the key survives restarts. `oasis web key` shows it.

## Useful project links

- [Configuration](CONFIGURATION.md)
- [Architecture](ARCHITECTURE.md)
- [Security](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
- [Support](../SUPPORT.md)
