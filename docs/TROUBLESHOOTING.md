# Troubleshooting

Start with the built-in checks. They explain most problems and suggest the fix.

```sh
oasis doctor                  # Node, Git, provider, sandbox, config
oasis doctor --test-provider  # sends one real tool call to your model
oasis doctor --network        # proxy, DNS and TLS to the provider, MCP servers and GitHub
oasis quota                   # today's requests, reported limits and cooldowns per model
```

Inside a session, `/doctor` checks the live session and `/debug` shows where the
debug log is. `oasis --debug api,tools,mcp` writes a detailed log to the `debug/`
folder in the OASIS config folder (`--debug-file PATH` to choose the file).

## Install and start-up

| Problem | What to do |
| --- | --- |
| `oasis: command not found` | The npm global `bin` folder is not on `PATH`. Run `npm prefix -g` and add its `bin` (or the folder itself on Windows) to `PATH` |
| "Node.js 22.19 or later is required" | Install a current Node.js LTS (22 or 24) and reinstall |
| Native terminal panel unavailable | `node-pty` is optional; the web terminal falls back to line mode. On Linux install a C++ toolchain and run `npm rebuild node-pty` |
| `-C DIR` or `--workspace DIR` fails | The folder must exist; OASIS does not create it |

## Model provider

| Problem | What to do |
| --- | --- |
| "No model provider is configured" | Run `oasis connect` (paste a key, model page link or local server address) or `oasis setup --auto` |
| 401 or 403 from the provider | The key is wrong, expired or lacks access to the model. `oasis auth status`, then `oasis connect` again |
| 404 model not found | The model was renamed or withdrawn. `oasis models` lists what the provider serves; `/model` switches |
| 429 or "quota" errors | Free tiers have per-minute and per-day limits. `oasis quota` shows the cooldown; add a backup with `--fallback-model` or a second key |
| A local model never calls tools | Small local models sometimes reply with text instead of a tool call. Use a tool-capable model (`oasis setup --auto` picks one that fits the machine) |
| Behind a corporate proxy | Set `HTTPS_PROXY` (and `NO_PROXY` for local servers). Extra CA certificates: `NODE_EXTRA_CA_CERTS=/path/ca.pem`. Check with `oasis doctor --network` |
| `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` set in your shell | OASIS honours them; unset them if requests go to the wrong host |

Provider details: [Configuration](CONFIGURATION.md#model-providers) and
[Inference](INFERENCE.md).

## Web app

| Problem | What to do |
| --- | --- |
| "Paste your OASIS link" on every visit | Tick **Remember this device**, or start with `--persistent-key` so the key survives restarts |
| "The saved access key no longer works" | The key was rotated or OASIS restarted without `--persistent-key`. `oasis web key` prints the current one |
| `421 Misdirected Request` | The host name is not allowed. Pass `--public-url` or `--allow-host` |
| Provider setup refused from another device | Keys are accepted only from the same computer or over HTTPS |
| "This folder is busy" | Another task is running in that folder. Wait, stop it, or open a worktree |
| Port already in use | `oasis web --port 0` picks a free port |

Remote setups: [Remote access](REMOTE-ACCESS.md).

## Agent behaviour

| Problem | What to do |
| --- | --- |
| It keeps asking for approval | Add an allow rule: `oasis permissions add allow "run_command(npm test:*)"`, or use `accept-edits` mode |
| Project settings, hooks or `.mcp.json` are ignored | They load only in a trusted workspace: `oasis trust` |
| A wrong change | `/rewind` (or <kbd>Esc</kbd> <kbd>Esc</kbd>) restores the files; `oasis backups` and `oasis restore ID` reach older snapshots |
| The context is full | `/compact` summarises older turns; `/context` shows what takes space |
| It said something was done but it was not | Ask it to show the evidence. With `-p`, `--require-verified` fails the run when OASIS could not verify the change |
| It stopped mid-task | `oasis -c` continues the session |

## Sandbox

| Problem | What to do |
| --- | --- |
| "bubblewrap not found" | Install `bubblewrap` (Debian/Ubuntu `apt install bubblewrap`) |
| bubblewrap fails inside a container | Unprivileged user namespaces are often disabled in containers. Use the Docker or Podman backend, or run on the host |
| The sandbox reports off | Never assume isolation is active; `oasis doctor` states which backend is in force |

See [Security](SECURITY.md) for what the sandbox does and does not cover.

## Starting over

```sh
oasis purge --dry-run         # list OASIS state for this project
oasis purge                   # delete it (sessions, checkpoints, memory with --memory)
oasis sessions prune --older-than 30
```

The OASIS config folder is `~/.config/oasis` on Linux and macOS (respecting
`XDG_CONFIG_HOME`) and `%APPDATA%\oasis` on Windows. `OASIS_CONFIG_DIR` overrides
it. Deleting it removes saved keys, settings and sessions.

## Reporting a bug

Use the [bug report form](https://github.com/FAHTHIZ/oasis/issues/new?template=bug_report.yml)
with the OASIS version (`oasis --version`), operating system, steps and the exact
error. Remove API keys, tokens and private paths from logs first. Security issues go
to [SECURITY.md](../SECURITY.md), not a public issue.
