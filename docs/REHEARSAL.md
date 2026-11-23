# Command rehearsal

An approval prompt for a command used to show the command line and nothing else. Whether `python3 gen.py`, `make`, `npm run build` or `tar xf bundle.tar` touches two files or two hundred was a guess. With rehearsal on, OASIS runs the command once in a throwaway copy-on-write view of the workspace first, and the prompt lists the files it would create, modify and delete, measured, not predicted:

```text
Run this command in the workspace?
  python3 "gen.py"
Rehearsal (network off, nothing kept): exit 0 in 89 ms.
  would create (3): generated/m0.py, generated/m1.py, generated/m2.py
```

It is on by default when the OS sandbox runs on bubblewrap (`"sandbox": { "enabled": true }` on Linux): there the only commands that still prompt are the high-risk ones, where the exact change list matters most. Elsewhere turn it on with `OASIS_REHEARSE=1` or `"rehearse": true` in your own settings; `OASIS_REHEARSE=0` or `"rehearse": false` turns it off. A repository's settings can turn it off but not on, since a rehearsal starts the command before anyone approved it. It applies to `run_command` and `run_shell` calls that need approval. Linux only; elsewhere, and when bubblewrap cannot mount an overlay, prompts look as before.

Under the sandbox, the rehearsal also hides the sandbox's own masks (`sandbox.filesystem.denyRead`), so it sees no more than the real run.

## How it works

bubblewrap (0.11 or later) mounts an overlay on the workspace path. The real workspace is the read-only lower layer and a private directory is the upper layer, so every write lands in the upper layer. Around it:

- the rest of the file system is read-only and `/tmp` is a fresh tmpfs;
- the network, PID, IPC and UTS namespaces are private (no network unless `oasis rehearse --network`);
- `/run`, `/var/run`, `/dev/shm` and `$XDG_RUNTIME_DIR` are empty, and where the seccomp helper from `@anthropic-ai/sandbox-runtime` is present, Unix sockets cannot be opened at all, so host daemons (Docker, an SSH agent, D-Bus) are out of reach;
- the command is stopped after 30 seconds and reports what it changed so far.
- the command has not been approved yet, so it sees no more than a sandboxed command would: the credential folders and files the OS sandbox hides (`~/.ssh`, `~/.aws`, `~/.netrc`, `~/.config/oasis` and the rest) are empty, and secret environment variables are removed as for a real run. Otherwise it could read a key and put it into the name of a file it creates, and that name goes into the prompt and the tool result the model sees.

When the command exits, the upper layer is the exact change set: a file or symlink is created, or modified when it differs from the lower one (content, mode or link target); a character device 0/0 is a whiteout, so the path was deleted. A directory that replaced a lower one (`rm -r d; mkdir d`) is opaque; instead of reading overlay extended attributes, a small helper lists the merged directory from inside the sandbox before it exits, and the names missing from it were deleted. Changes inside `.git` are counted separately.

After the person approves, the command runs for real as before. Effect contracts ([EFFECTS.md](EFFECTS.md)) observe what it actually changed. If it changed a file its rehearsal did not show, the result carries `rehearsal.divergence` naming those files and the session log records a `rehearsal_divergence` event: the person approved one thing and the command did another (clocks, randomness, the network).

Rehearsal never runs a command held because of suspected prompt injection, and is skipped when commands go to SSH or a container, where the overlay would not be the place the command runs. The home directory and `/` are never rehearsed as the workspace.

## Apply the rehearsal instead of running again

In the terminal, the approval prompt for a rehearsed command offers a third answer, "Apply the rehearsed changes only (do not run it again)" (`r` in line mode). It copies exactly the files the rehearsal showed into the workspace and does not start the command a second time, so a command whose output depends on time or randomness lands what you read, not a new variant. The same conflict check as `oasis rehearse --apply` runs first: if any file the rehearsal touched changed while you were deciding, nothing is applied, the command is not run, and the result names the files. The model is told the changes came from the rehearsal (network off) and sees its output.

It is offered only when the rehearsal exited 0, changed at least one file, wrote nothing outside the workspace and left `.git` alone, and never for a high-risk command (those are approved by reading the command) or for a command headed to the editor's terminal. Hooks and auto mode answer yes or no as before.

The app's approval card has the same answer as an **Apply rehearsal** button, shown only when the agent offered it. The web server sends `rehearsal: true` with `approval_required`, and the card answers with `{ "approved": true, "rehearsal": true }` on `POST /api/jobs/<id>/approval`; a rehearsal answer to an approval that did not offer one counts as a plain yes. The rehearsal's result (exit code and the files it would create, modify or delete) and the reason a command is high risk are part of the approval text in both the terminal and the app.

## By hand: `oasis rehearse`

```sh
oasis rehearse -- npm run build
oasis rehearse --shell 'find . -name "*.orig" -delete'
oasis rehearse --apply -- python3 scripts/migrate.py
```

`--apply` copies the rehearsed changes into the workspace instead of running the command a second time, so what lands is exactly what was shown. Before writing anything it re-checks every path the rehearsal touched (content and mode); if any of them changed since, it applies nothing and names them. It refuses to apply changes inside `.git`. Exit status is 0 when the rehearsed command exited 0 (and the apply succeeded), 1 otherwise, 2 when rehearsal is unavailable. `--json` prints the result as JSON.

## Measured

`node scripts/rehearsal-bench.mjs` runs 16 commands three ways on identical fresh fixtures: for real (ground truth), rehearsed, and through the static prediction effect contracts make from the command line. Results on Linux 6.1, bubblewrap 0.11.1, Node 22.21:

| Command | Files really changed | Static prediction | Static exact | Rehearsal exact | Real ms | Rehearsal ms |
| --- | --- | --- | --- | --- | --- | --- |
| sed-in-place | 1 | covers | yes | yes | 3 | 118 |
| redirect | 1 | covers | yes | yes | 13 | 70 |
| append | 1 | covers | yes | yes | 7 | 65 |
| rm-tree | 2 | covers | no | yes | 2 | 65 |
| mv-rename | 2 | covers | yes | yes | 3 | 43 |
| cp-into-dir | 1 | covers | no | yes | 14 | 39 |
| git-checkout-dot | 1 | covers | no | yes | 24 | 62 |
| tar-extract | 2 | broad | no | yes | 2 | 47 |
| python-generator | 3 | broad | no | yes | 30 | 89 |
| node-formatter | 2 | broad | no | yes | 32 | 83 |
| find-delete | 2 | covers | no | yes | 9 | 46 |
| xargs-sed | 2 | broad | no | yes | 28 | 57 |
| make-build | 1 | broad | no | yes | 7 | 48 |
| npm-script | 3 | broad | no | yes | 142 | 171 |
| random-content | 1 | broad | no | yes | 27 | 60 |
| timestamped-name | 1 | broad | no | no | 20 | 79 |

The static prediction gives an exact file list for 4 of 16 commands and says "broad" (cannot tell) for 8. Rehearsal gives the exact file list for 15 of 16, at a median cost of about 50 ms over running the command. The miss is honest: a command that names its output after the clock writes `build-<time>.txt` with a different name each run, and the post-run divergence check reports exactly that file.

The benchmark also found a gap in the static prediction: before this change it predicted that `find … -delete`, `… | xargs sed -i` and `npm run build` change nothing at all, so their real changes were flagged as unexpected. They are now bounded (`find -delete` to its start points) or marked broad (`find -exec`, `xargs` with a writing command, package scripts, `perl` without `-i`).

## Servers it tried to reach

The rehearsal has no network, but it still shows where a command would have gone. Inside the sandbox, the rehearsal starts a small HTTP proxy on its own loopback interface and points `HTTP_PROXY`, `HTTPS_PROXY` (both cases), `npm_config_proxy`, `npm_config_https_proxy`, `PIP_PROXY`, `NODE_USE_ENV_PROXY=1` and git's `http.proxy` (including URL-specific proxies passed in `GIT_CONFIG_*`) at it. Every request gets a 403 and nothing leaves the sandbox; the host and port each one asked for are recorded and the prompt adds a line such as:

```
  It tried to reach registry.npmjs.org (refused: nothing was sent).
```

`NO_PROXY` is set to `localhost,127.0.0.1,::1`, so a test that starts a local server and connects to it works as before. Up to 20 hosts are kept; the result for the model carries them as `contacted`. A rehearsal that tried to reach a server is not offered for "apply the rehearsal", because without the network it may have produced something different.

Measured in this repository's sandbox: `curl`, `git ls-remote`, Node's `fetch`, `pip download`, `npm install` and Python's `urllib` each reported the right host (6 of 6); a command that only used a local server reported none; a listener on the host saw no request. The proxy adds about 6 ms to a rehearsal (median of 12 runs of `true`: 35 ms before, 41 ms after).

Not recorded: clients that ignore proxy variables and open sockets directly (raw TCP, some Go and Rust binaries, DNS lookups), and SOCKS (`ALL_PROXY` is removed). The request body is never seen, because nothing is sent: the record is where a command wanted to go, not what it would have said.

Git settings passed in the environment (`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`) that carry credentials (a proxy URL with a password, an `extraHeader`, a token in an `insteadOf` URL) are removed for the rehearsal, so unapproved code cannot copy them into a file name.

## Limits

- Effects outside the file system are not rehearsed: the network is off, so a command that downloads fails in rehearsal (the prompt says so and names the servers it tried, see above) and a command that talks to a server has not talked to it.
- Writes outside the workspace are refused in rehearsal (read-only); the prompt says when the command tried. The real run may succeed there.
- A command can still read files the user can read. Without network or sockets it cannot send them anywhere during the rehearsal, but rehearsal does run unapproved code, which is why it is off by default. With rehearsal on, treat the approval prompt as "run this, isolated, then decide", the same trust boundary as `sandbox.autoAllowCommands` with the OS sandbox.
- Non-deterministic commands can differ between rehearsal and the real run; the divergence check catches the file-level difference, not differences in content.
- Large copy-ups cost what they cost: modifying a 1 GB file copies it into the upper layer.

## Compared with other tools

[try](https://github.com/binpash/try) (binpash) introduced running a shell command over an overlay and committing the upper directory; OASIS takes the same file-system idea. The differences are in what surrounds it: try is explicitly not a sandbox (network is on unless `-x`, host sockets are reachable), its commit does not check whether live files changed since the run, and it reads opaque-directory markers through `user.overlay` extended attributes. Rehearsal here is network-less and socket-less by default, its apply is conflict-checked, it needs no xattr tools, and it is built into the agent's approval flow with a post-run check against the observed effects. Tool-specific dry runs (`make -n`, `rsync --dry-run`, `terraform plan`, `git apply --check`) are exact for their own tool and say nothing about arbitrary programs; Claude Code and Codex checkpoints restore files after the fact rather than showing effects before approval ([Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)). Overlay semantics: [Linux overlayfs documentation](https://docs.kernel.org/filesystems/overlayfs.html); [bubblewrap](https://github.com/containers/bubblewrap) (overlay options since [0.11.0](https://github.com/containers/bubblewrap/blob/main/NEWS.md); not available when bubblewrap is installed setuid).

`/insights` (and `oasis insights`) counts commands whose real run changed more than their rehearsal, per command, and suggests reviewing a command from its text when its rehearsal misses repeatedly.
