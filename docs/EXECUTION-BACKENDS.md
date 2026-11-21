# Execution backends

Where the agent's shell commands (`run_command`, `run_shell`, background jobs and terminal sessions) run is set by `sandbox.backend`. File reads and edits always happen in the local workspace; remote backends sync it before and after each command.

| Backend | Where commands run | Isolation | Setup |
| --- | --- | --- | --- |
| `os` (default) | This machine | bubblewrap on Linux, Seatbelt on macOS: read-only host, writable workspace, network off unless enabled | Nothing on macOS; `bubblewrap` on Linux |
| `docker` / `podman` | A container on this machine | The container; workspace mounted, network off unless enabled | Docker or Podman |
| `ssh` | Any machine you can reach over SSH (a bigger box, a GPU server, a VM) | Whatever that machine provides | Key-based SSH login, `rsync` on both sides |
| `daytona` | A [Daytona](https://www.daytona.io) cloud sandbox created for this workspace | A separate cloud VM | `DAYTONA_API_KEY` |
| `modal` | A [Modal](https://modal.com/docs/guide/sandboxes) sandbox created for this workspace, optionally with a GPU | A gVisor container in Modal's cloud | `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or `modal token new` |

Turn one on for a session with `/sandbox os`, `/sandbox docker [IMAGE]`, `/sandbox ssh USER@HOST [REMOTE_DIR]` `/sandbox daytona` or `/sandbox modal`, or make it permanent in settings:

```json
{ "sandbox": { "enabled": true, "backend": "docker", "image": "node:22-bookworm" } }
```

`OASIS_SANDBOX=1` and `OASIS_SANDBOX_BACKEND=NAME` do the same from the environment. `oasis doctor` states which backend is in force.

## SSH

```json
{
  "sandbox": {
    "enabled": true,
    "backend": "ssh",
    "ssh": { "host": "me@gpu-box", "remoteRoot": "~/work/app", "port": 22, "identityFile": "~/.ssh/id_ed25519", "sync": "rsync", "exclude": ["node_modules/", ".venv/"] }
  }
}
```

With `"sync": "rsync"` (the default) the workspace is pushed before every command (excluded paths untouched) and files the command changed are copied back afterwards; a newer local file is never overwritten, and remote deletions are not mirrored. With `"sync": "none"` the remote folder is used as is, for a shared disk or a checkout you manage. `OASIS_SSH_HOST`, `OASIS_SSH_REMOTE_ROOT`, `OASIS_SSH_PORT` and `OASIS_SSH_SYNC` override the settings.

## Daytona

Commands run in a Daytona sandbox: a fresh cloud machine per workspace, so heavy builds, untrusted code and long jobs never touch your computer.

1. Create an API key in the Daytona dashboard (Keys) and set `DAYTONA_API_KEY`.
2. Turn it on with `/sandbox daytona`, or in settings:

```json
{
  "sandbox": {
    "enabled": true,
    "backend": "daytona",
    "daytona": { "snapshot": "daytonaio/sandbox", "target": "us", "autoStopInterval": 30, "remoteRoot": "~/workspace" }
  }
}
```

All `daytona` keys are optional. `autoStopInterval` stops the sandbox after that many idle minutes (0 keeps it running); OASIS starts it again on the next command. `DAYTONA_API_URL` points at a self-hosted Daytona, and `DAYTONA_TARGET` picks the region.

On the first command OASIS creates the sandbox, waits for it to start and opens a 24-hour SSH token through Daytona's SSH gateway; from then on it works like the SSH backend, with rsync sync (installed in the sandbox if the image lacks it). The sandbox ID and token are kept in `.oasis/daytona/` with mode 600, and the token is passed to ssh through a private config file, so it never shows up in a process listing, an approval prompt or the model's context. That folder is never synced to the sandbox.

```
oasis daytona up       # create or start the sandbox now
oasis daytona status
oasis daytona stop     # stop billing; it starts again on the next command
oasis daytona delete   # remove it; files that were only in the sandbox are lost
```

## Modal

Commands run in a [Modal sandbox](https://modal.com/docs/guide/sandboxes): a container in Modal's cloud, started in seconds, with as many CPUs, as much memory or as big a GPU as you ask for. You pay per second it runs.

1. Create a token in the Modal dashboard (Settings → API tokens) and set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or run `modal token new`, which writes `~/.modal.toml`. `MODAL_ENVIRONMENT` picks a Modal environment.
2. Turn it on with `/sandbox modal`, or in settings:

```json
{
  "sandbox": {
    "enabled": true,
    "backend": "modal",
    "modal": { "image": "node:22-bookworm", "timeoutMinutes": 720, "cpu": 2, "memoryMiB": 4096, "gpu": "T4", "region": "us-east", "setup": ["pip install uv"] }
  }
}
```

All `modal` keys are optional. `image` is any public registry image based on Debian/Ubuntu, Alpine or Fedora (`OASIS_MODAL_IMAGE` overrides it); OASIS adds `openssh-server` and `rsync` to it, then runs each `setup` line as an extra build step. Modal caches the built image, so only the first start is slow. `timeoutMinutes` (5 to 1440) is how long the sandbox may live; `gpu` takes Modal's names such as `T4`, `A10G`, `A100` or `H100:2`; `appName` (default `oasis`) is the Modal app the sandboxes are grouped under.

On the first command OASIS generates an SSH key for the workspace, starts the sandbox running `sshd` with only that key allowed (no passwords, no forwarding), and connects through Modal's TCP tunnel; from then on it works like the SSH backend, with rsync sync. The key, sandbox ID, tunnel address and known_hosts are kept in `.oasis/modal/` with mode 600 and never synced. The Modal SDK is an optional dependency installed with OASIS; if it is missing, `npm install modal` in the OASIS folder adds it.

Modal sandboxes are temporary. When one reaches its timeout, the next command starts a fresh sandbox and syncs the workspace into it again; anything that existed only inside the old sandbox (installed packages, build caches) is gone, so put lasting setup in `setup`.

```
oasis modal up       # start the sandbox now
oasis modal status
oasis modal stop     # terminate it and stop billing; the next command starts a fresh one
```
